/**
 * Waveform peak extraction for the media seek bar.
 *
 * Audio is processed incrementally so memory stays flat regardless of
 * duration; each batch is folded into peak buckets and dropped.
 *  - MP4/MOV/M4A: mp4box parses the container, then compressed audio
 *    (AAC etc.) is decoded a batch at a time by WebCodecs' AudioDecoder,
 *    and uncompressed audio (QuickTime lpcm/sowt/twos/…, common in .mov
 *    screen recordings) is read straight from the file by chunk.
 *  - WAV: PCM read straight from the data chunk.
 *  - MP3, ADTS AAC, FLAC, Ogg: the file is cut into ~1 MB slices at frame
 *    boundaries (FLAC/Ogg slices get the stream headers prepended) and
 *    each slice goes through decodeAudioData on its own.
 *
 * Why not AudioContext.decodeAudioData on the whole file: it materialises
 * the whole track as float PCM at its native rate before any resampling
 * — ~1 GB for 20 minutes of 48 kHz stereo — which crashes the renderer on
 * long recordings.
 */
import { createFile, MP4BoxBuffer } from 'mp4box'

/** Peaks kept per file; bars are aggregated down from these at draw time. */
export const PEAK_BUCKETS = 2000
/** Compressed frames handed to the decoder before waiting for it to drain. */
const DECODE_BATCH = 256
/** Bytes per decodeAudioData slice for MP3/AAC/FLAC/Ogg. */
const SLICE_BYTES = 1 << 20
/** PCM frames per WAV read. */
const WAV_CHUNK_FRAMES = 1 << 16
const PROGRESS_INTERVAL_MS = 250
/** Top-level box types an MP4/MOV file can open with. */
const MP4_FIRST_BOXES = new Set(['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'])

interface DecodeOptions {
  buckets?: number
  signal?: AbortSignal
  /** Called periodically with the (normalised) peaks decoded so far. */
  onProgress?: (peaks: Float32Array) => void
}

/**
 * Decode a media file's first audio track into normalised peaks (0..1).
 * Rejects for unrecognised containers (e.g. AVI), files without audio,
 * and codecs the platform can't decode.
 */
export async function decodePeaks(buffer: ArrayBuffer, opts: DecodeOptions = {}): Promise<Float32Array> {
  const { buckets = PEAK_BUCKETS, signal, onProgress } = opts
  let acc: PeakAccumulator | PeakTimeline | null = null
  let lastProgress = performance.now()
  // Between batches: bail if cancelled, report progress, and (via the
  // awaits around it) let the UI breathe.
  const checkpoint = () => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (acc && onProgress && performance.now() - lastProgress > PROGRESS_INTERVAL_MS) {
      lastProgress = performance.now()
      onProgress(acc.result())
    }
  }

  const bytes = new Uint8Array(buffer)
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') {
    const wav = parseWav(new DataView(buffer))
    acc = new PeakAccumulator(buckets, wav.duration)
    await accumulatePcm(buffer, wav, acc, checkpoint)
  } else if (MP4_FIRST_BOXES.has(ascii(bytes, 4, 4))) {
    const audio = demuxAudio(buffer)
    acc = new PeakAccumulator(buckets, audio.duration)
    if (audio.kind === 'pcm') await accumulatePcm(buffer, audio, acc, checkpoint)
    else await accumulateCoded(audio, acc, checkpoint)
  } else {
    const layout = sliceLayout(bytes)
    if (!layout) throw new Error('Unrecognised audio format')
    const timeline = new PeakTimeline(buckets)
    acc = timeline
    await accumulateSliced(bytes, layout, timeline, checkpoint)
  }
  return acc.result()
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

async function accumulateCoded(audio: CodedAudio, acc: PeakAccumulator, checkpoint: () => void): Promise<void> {
  const { config, samples } = audio
  const support = await AudioDecoder.isConfigSupported(config)
  if (!support.supported) throw new Error(`Unsupported audio codec: ${config.codec}`)

  let decodeError: unknown = null
  const decoder = new AudioDecoder({
    output: (data) => {
      try {
        const frames = data.numberOfFrames
        const channels: Float32Array[] = []
        for (let c = 0; c < data.numberOfChannels; c++) {
          const plane = new Float32Array(frames)
          data.copyTo(plane, { planeIndex: c, format: 'f32-planar' })
          channels.push(plane)
        }
        acc.add(channels, data.timestamp / 1e6, data.sampleRate)
      } finally {
        data.close()
      }
    },
    error: (e) => { decodeError = e }
  })

  try {
    decoder.configure(config)
    for (let i = 0; i < samples.length; i += DECODE_BATCH) {
      checkpoint()
      for (const s of samples.slice(i, i + DECODE_BATCH)) {
        decoder.decode(new EncodedAudioChunk({
          type: s.key ? 'key' : 'delta',
          timestamp: s.time * 1e6,
          duration: s.duration * 1e6,
          data: s.data
        }))
      }
      await decoder.flush()
      if (decodeError) throw decodeError
    }
  } finally {
    if (decoder.state !== 'closed') decoder.close()
  }
}

async function accumulatePcm(buffer: ArrayBuffer, audio: PcmAudio, acc: PeakAccumulator, checkpoint: () => void): Promise<void> {
  const { format, chunks } = audio
  const view = new DataView(buffer)
  let time = 0
  for (let i = 0; i < chunks.length; i++) {
    const { offset, frames } = chunks[i]
    acc.add(readPcm(view, offset, frames, format), time, format.sampleRate)
    time += frames / format.sampleRate
    if (i % 16 === 15) {
      await new Promise((r) => setTimeout(r, 0))
      checkpoint()
    }
  }
}

interface SliceLayout {
  /** Stream headers to prepend to every slice but the first. */
  header: Uint8Array
  /** Offset of the first audio frame. */
  dataStart: number
  /** Index of the first frame boundary at or after `pos` (or length). */
  align: (pos: number) => number
}

/** Recognise MP3 / ADTS AAC / FLAC / Ogg and describe how to slice it. */
export function sliceLayout(bytes: Uint8Array): SliceLayout | null {
  const n = bytes.length
  const find = (from: number, match: (i: number) => boolean) => {
    for (let i = from; i < n - 4; i++) if (match(i)) return i
    return n
  }

  if (ascii(bytes, 0, 4) === 'fLaC') {
    // Metadata blocks: 1 byte (last-flag | type) + 24-bit length.
    let pos = 4
    for (;;) {
      if (pos + 4 > n) return null
      const last = bytes[pos] & 0x80
      pos += 4 + ((bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3])
      if (last) break
    }
    return { header: bytes.slice(0, pos), dataStart: pos, align: (p) => find(p, (i) => isFlacFrame(bytes, i)) }
  }

  if (ascii(bytes, 0, 4) === 'OggS') {
    // Header pages (Vorbis/Opus/FLAC identification, comments, setup)
    // carry granule position 0; audio starts at the first page that doesn't.
    let pos = 0
    while (pos + 27 <= n && ascii(bytes, pos, 4) === 'OggS' && bytes.subarray(pos + 6, pos + 14).every((b) => b === 0)) {
      const segments = bytes[pos + 26]
      let size = 27 + segments
      for (let i = 0; i < segments; i++) size += bytes[pos + 27 + i]
      pos += size
    }
    const isPage = (i: number) => bytes[i] === 0x4f && bytes[i + 1] === 0x67 && bytes[i + 2] === 0x67 && bytes[i + 3] === 0x53
    return { header: bytes.slice(0, pos), dataStart: pos, align: (p) => find(p, isPage) }
  }

  // MP3 or ADTS AAC, optionally behind an ID3v2 tag (syncsafe size).
  let dataStart = 0
  if (ascii(bytes, 0, 3) === 'ID3' && n >= 10) {
    dataStart = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]) + (bytes[5] & 0x10 ? 10 : 0)
  }
  // A frame is only trusted if another frame header follows it (or it
  // runs to end of file) — two-byte syncs occur by chance in audio data.
  const confirmed = (frameLength: (b: Uint8Array, i: number) => number) => (i: number) => {
    const len = frameLength(bytes, i)
    return len > 0 && (i + len >= n - 4 || frameLength(bytes, i + len) > 0)
  }
  const isAdts = confirmed(adtsFrameLength)
  const isMpeg = confirmed(mpegFrameLength)
  // A tagged file's frames should start right after the tag; an untagged
  // one at (or very near) the start.
  const first = find(dataStart, (i) => isAdts(i) || isMpeg(i))
  if (first - dataStart > 4096 || first >= n) return null
  const isFrame = isAdts(first) ? isAdts : isMpeg
  return { header: new Uint8Array(0), dataStart: first, align: (p) => find(p, isFrame) }
}

/** ADTS (AAC) frame length from the header at `i`, or 0 if none. */
export function adtsFrameLength(b: Uint8Array, i: number): number {
  if (i + 7 > b.length || b[i] !== 0xff || (b[i + 1] & 0xf6) !== 0xf0) return 0
  if (((b[i + 2] >> 2) & 0x0f) > 12) return 0 // sampling frequency index
  const len = ((b[i + 3] & 0x03) << 11) | (b[i + 4] << 3) | (b[i + 5] >> 5)
  return len >= 7 ? len : 0
}

const MPEG_BITRATES_KBPS: Record<string, number[]> = {
  // [MPEG version 1 | 2 (incl. 2.5)] + layer
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
}

/** MPEG audio (MP3/MP2/MP1) frame length from the header at `i`, or 0. */
export function mpegFrameLength(b: Uint8Array, i: number): number {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return 0
  const versionBits = (b[i + 1] >> 3) & 3 // 0: 2.5, 2: 2, 3: 1
  const layerBits = (b[i + 1] >> 1) & 3 // 1: III, 2: II, 3: I
  const bitrateIndex = b[i + 2] >> 4
  const rateIndex = (b[i + 2] >> 2) & 3
  if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return 0
  const layer = 4 - layerBits
  const mpeg1 = versionBits === 3
  const bitrate = MPEG_BITRATES_KBPS[`${mpeg1 ? 1 : 2}-${layer}`][bitrateIndex] * 1000
  const sampleRate = [44100, 48000, 32000][rateIndex] / (mpeg1 ? 1 : versionBits === 2 ? 2 : 4)
  const padding = (b[i + 2] >> 1) & 1
  if (layer === 1) return (Math.floor((12 * bitrate) / sampleRate) + padding) * 4
  const coefficient = layer === 3 && !mpeg1 ? 72 : 144
  return Math.floor((coefficient * bitrate) / sampleRate) + padding
}

/** True if a FLAC frame header with a valid CRC-8 starts at `i`. */
export function isFlacFrame(b: Uint8Array, i: number): boolean {
  if (i + 6 > b.length || b[i] !== 0xff || (b[i + 1] & 0xfe) !== 0xf8) return false
  const blockSizeCode = b[i + 2] >> 4
  const rateCode = b[i + 2] & 0x0f
  const channels = b[i + 3] >> 4
  const sampleSize = (b[i + 3] >> 1) & 7
  if (blockSizeCode === 0 || rateCode === 15 || channels > 10 || sampleSize === 3 || (b[i + 3] & 1)) return false
  // Frame/sample number: UTF-8-style coded, 1–7 bytes.
  let p = i + 4
  const lead = b[p]
  let extra = 0
  if (lead < 0x80) extra = 0
  else if ((lead & 0xe0) === 0xc0) extra = 1
  else if ((lead & 0xf0) === 0xe0) extra = 2
  else if ((lead & 0xf8) === 0xf0) extra = 3
  else if ((lead & 0xfc) === 0xf8) extra = 4
  else if ((lead & 0xfe) === 0xfc) extra = 5
  else if (lead === 0xfe) extra = 6
  else return false
  p += 1 + extra
  if (blockSizeCode === 6) p += 1
  else if (blockSizeCode === 7) p += 2
  if (rateCode === 12) p += 1
  else if (rateCode === 13 || rateCode === 14) p += 2
  if (p >= b.length) return false
  let crc = 0
  for (let j = i; j < p; j++) {
    crc ^= b[j]
    for (let k = 0; k < 8; k++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff
  }
  return crc === b[p]
}

async function accumulateSliced(bytes: Uint8Array, layout: SliceLayout, acc: PeakTimeline, checkpoint: () => void): Promise<void> {
  const { header, dataStart, align } = layout
  const total = bytes.length - dataStart
  if (total <= 0) throw new Error('No audio data')
  // decodeAudioData resamples to the context rate. 44.1 kHz is the common
  // native rate, so usually no resampling — which measured ~2× faster
  // than a lower rate, with identical peaks.
  const ctx = new OfflineAudioContext(1, 1, 44100)
  let decoded = 0
  let lastError: unknown = null
  // Slices are placed by decoded duration, not byte offset: VBR streams
  // (FLAC, most AAC/MP3) spend bytes unevenly over time. Slices start on
  // frame boundaries, so no audio is lost between them and time doesn't drift.
  let time = 0
  for (let start = dataStart; start < bytes.length; ) {
    checkpoint()
    let end = start + SLICE_BYTES >= bytes.length ? bytes.length : align(start + SLICE_BYTES)
    if (end <= start) end = bytes.length
    // The first slice keeps its own leading tags/headers.
    const from = start === dataStart ? 0 : start
    const prefix = start === dataStart ? new Uint8Array(0) : header
    const piece = new Uint8Array(prefix.length + end - from)
    piece.set(prefix)
    piece.set(bytes.subarray(from, end), prefix.length)
    try {
      const audio = await ctx.decodeAudioData(piece.buffer)
      const channels: Float32Array[] = []
      for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c))
      acc.add(channels, time, audio.sampleRate)
      time += audio.duration
      decoded++
    } catch (err) {
      // One bad slice shouldn't cost the whole waveform; it shows as a gap.
      lastError = err
    }
    start = end
    // Extrapolate the total from the share of the file decoded so far.
    acc.estimatedDuration = time * (total / Math.max(1, end - dataStart))
  }
  if (decoded === 0) throw lastError ?? new Error('Could not decode audio')
  acc.estimatedDuration = time
}

/** Locate a WAV file's PCM data and describe it as chunked PcmAudio. */
export function parseWav(view: DataView): PcmAudio {
  let format: PcmFormat | null = null
  let dataOffset = -1
  let dataSize = 0
  for (let pos = 12; pos + 8 <= view.byteLength; ) {
    const id = String.fromCharCode(view.getUint8(pos), view.getUint8(pos + 1), view.getUint8(pos + 2), view.getUint8(pos + 3))
    const size = view.getUint32(pos + 4, true)
    const body = pos + 8
    if (id === 'fmt ') {
      let tag = view.getUint16(body, true)
      const channels = view.getUint16(body + 2, true)
      const sampleRate = view.getUint32(body + 4, true)
      const blockAlign = view.getUint16(body + 12, true)
      // WAVE_FORMAT_EXTENSIBLE: the real tag leads the SubFormat GUID.
      if (tag === 0xfffe && size >= 26) tag = view.getUint16(body + 24, true)
      const bytes = channels > 0 ? blockAlign / channels : 0
      const float = tag === 3
      if ((tag === 1 && [1, 2, 3, 4].includes(bytes)) || (float && (bytes === 4 || bytes === 8))) {
        // 8-bit WAV is unsigned; wider PCM is signed.
        format = { sampleRate, channels, bytes, float, signed: float || bytes > 1, bigEndian: false, framesPerSample: 1 }
      }
    } else if (id === 'data') {
      dataOffset = body
      // Streaming writers leave the size 0 / 0xFFFFFFFF; take the rest.
      dataSize = size === 0 || size === 0xffffffff ? view.byteLength - body : Math.min(size, view.byteLength - body)
      break
    }
    pos = body + size + (size & 1)
  }
  if (!format) throw new Error('Unsupported WAV encoding')
  if (dataOffset < 0) throw new Error('WAV has no data chunk')
  const frameBytes = format.bytes * format.channels
  const totalFrames = Math.floor(dataSize / frameBytes)
  const chunks: Array<{ offset: number; frames: number }> = []
  for (let f = 0; f < totalFrames; f += WAV_CHUNK_FRAMES) {
    chunks.push({ offset: dataOffset + f * frameBytes, frames: Math.min(WAV_CHUNK_FRAMES, totalFrames - f) })
  }
  if (totalFrames === 0) throw new Error('WAV has no audio')
  return { kind: 'pcm', format, chunks, duration: totalFrames / format.sampleRate }
}

/** One compressed audio frame, times in seconds. */
interface AudioFrame {
  data: Uint8Array
  time: number
  duration: number
  key: boolean
}

interface CodedAudio {
  kind: 'coded'
  config: AudioDecoderConfig
  samples: AudioFrame[]
  duration: number
}

export interface PcmAudio {
  kind: 'pcm'
  format: PcmFormat
  /** File offset and frame count of each chunk, in playback order. */
  chunks: Array<{ offset: number; frames: number }>
  duration: number
}

/** Pull the first audio track's frames (compressed) or chunk map (PCM). */
function demuxAudio(buffer: ArrayBuffer): CodedAudio | PcmAudio {
  const file = createFile()
  const view = new DataView(buffer)
  let trackId: number | null = null
  let codec = ''
  let pcm: PcmFormat | null = null
  let parseError: string | null = null
  const samples: AudioFrame[] = []

  // Extraction must be set up inside onReady: mp4box emits samples while
  // the buffer is being parsed, not after.
  file.onReady = (info) => {
    // Find the sound track by handler: mp4box files sample entries it
    // doesn't recognise (e.g. QuickTime 'lpcm') under metadataTracks.
    const track = info.tracks.find((t) => file.getTrackById(t.id)?.mdia?.hdlr?.handler === 'soun')
    if (!track) return
    trackId = track.id
    codec = track.codec
    const entry = file.getTrackById(track.id).mdia.minf.stbl.stsd.entries[0]
    pcm = entry.start === undefined ? null : parsePcmFormat(view, entry.start, entry.type)
    // PCM has one "sample" per audio frame — far too many objects to
    // extract; it's read by chunk instead.
    if (pcm) return
    file.setExtractionOptions(track.id, undefined, { nbSamples: 1000 })
    file.start()
  }
  file.onSamples = (id, _user, batch) => {
    // Keep our own reference to each frame's bytes: releaseUsedSamples
    // clears `data` on mp4box's sample objects.
    for (const s of batch) {
      if (s.data) samples.push({ data: s.data, time: s.cts / s.timescale, duration: s.duration / s.timescale, key: s.is_sync })
    }
    file.releaseUsedSamples(id, batch[batch.length - 1].number)
  }
  file.onError = (_module, message) => { parseError = message }
  file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buffer, 0))
  file.flush()
  if (parseError) throw new Error(parseError)
  if (trackId === null) throw new Error('No audio track (or not an MP4/MOV file)')

  const trak = file.getTrackById(trackId)
  if (pcm) {
    const format: PcmFormat = pcm
    const chunks = pcmChunks(trak.mdia.minf.stbl, format)
    const frames = chunks.reduce((n, c) => n + c.frames, 0)
    if (frames === 0) throw new Error('Audio track has no samples')
    return { kind: 'pcm', format, chunks, duration: frames / format.sampleRate }
  }

  if (samples.length === 0) throw new Error('Audio track has no samples')
  // AAC needs its AudioSpecificConfig (esds → DecoderConfig → DecSpecificInfo)
  // as the decoder description; other codecs go without.
  const entry: any = trak.mdia.minf.stbl.stsd.entries[0]
  const description: Uint8Array | undefined = entry?.esds?.esd?.descs?.[0]?.descs?.[0]?.data
  const last = samples[samples.length - 1]
  return {
    kind: 'coded',
    config: {
      codec,
      sampleRate: entry.samplerate,
      numberOfChannels: entry.channel_count,
      ...(description ? { description } : {})
    },
    samples,
    duration: last.time + last.duration
  }
}

/** Expand stsc/stco runs into one entry per chunk. */
function pcmChunks(stbl: any, format: PcmFormat): Array<{ offset: number; frames: number }> {
  const offsets: ArrayLike<number> = (stbl.stco ?? stbl.co64)?.chunk_offsets ?? []
  const firstChunk: ArrayLike<number> = stbl.stsc?.first_chunk ?? []
  const perChunk: ArrayLike<number> = stbl.stsc?.samples_per_chunk ?? []
  const chunks: Array<{ offset: number; frames: number }> = []
  for (let run = 0; run < firstChunk.length; run++) {
    const from = firstChunk[run] - 1 // 1-based
    const to = run + 1 < firstChunk.length ? firstChunk[run + 1] - 1 : offsets.length
    for (let c = from; c < to && c < offsets.length; c++) {
      chunks.push({ offset: offsets[c], frames: perChunk[run] * format.framesPerSample })
    }
  }
  return chunks
}

export interface PcmFormat {
  sampleRate: number
  channels: number
  /** Bytes per sample per channel. */
  bytes: number
  float: boolean
  signed: boolean
  bigEndian: boolean
  /** Audio frames per container "sample" (stsc/stsz unit). */
  framesPerSample: number
}

/**
 * Read an uncompressed QuickTime/ISO sound sample entry, or null if the
 * entry isn't a PCM format we handle. `start` is the entry box's offset.
 *
 * Layouts (offsets from box start): v0/v1 have channels @24 (u16),
 * sample size @26 (u16), rate @32 (16.16). v2 ('lpcm', or any type
 * with version 2) has rate @40 (f64), channels @48, bits @56,
 * format flags @60, bytes/packet @64, frames/packet @68.
 */
export function parsePcmFormat(view: DataView, start: number, type: string): PcmFormat | null {
  const version = view.getUint16(start + 16)
  let sampleRate: number, channels: number, bits: number, framesPerSample = 1
  let flags: number | null = null
  if (version === 2) {
    sampleRate = view.getFloat64(start + 40)
    channels = view.getUint32(start + 48)
    bits = view.getUint32(start + 56)
    flags = view.getUint32(start + 60)
    framesPerSample = view.getUint32(start + 68) || 1
  } else {
    channels = view.getUint16(start + 24)
    bits = view.getUint16(start + 26)
    sampleRate = view.getUint32(start + 32) / 65536
  }

  let f: Pick<PcmFormat, 'float' | 'signed' | 'bigEndian'> & { bits?: number }
  switch (type) {
    case 'lpcm':
      if (flags === null) return null
      // kAudioFormatFlagIsFloat 0x1, IsBigEndian 0x2, IsSignedInteger 0x4
      f = { float: !!(flags & 1), bigEndian: !!(flags & 2), signed: !!(flags & 4) }
      break
    case 'sowt': f = { float: false, signed: true, bigEndian: false }; break
    case 'twos': f = { float: false, signed: true, bigEndian: true }; break
    case 'raw ': f = { float: false, signed: false, bigEndian: true, bits: 8 }; break
    case 'in24': f = { float: false, signed: true, bigEndian: true, bits: 24 }; break
    case 'in32': f = { float: false, signed: true, bigEndian: true, bits: 32 }; break
    case 'fl32': f = { float: true, signed: true, bigEndian: true, bits: 32 }; break
    case 'fl64': f = { float: true, signed: true, bigEndian: true, bits: 64 }; break
    default: return null
  }
  const bytes = (f.bits ?? bits) / 8
  const validInt = !f.float && [1, 2, 3, 4].includes(bytes)
  const validFloat = f.float && (bytes === 4 || bytes === 8)
  if (!(validInt || validFloat) || channels < 1 || !(sampleRate > 0)) return null
  return { sampleRate, channels, bytes, float: f.float, signed: f.signed, bigEndian: f.bigEndian, framesPerSample }
}

/** Interleaved PCM bytes → one Float32Array per channel, in [-1, 1]. */
export function readPcm(view: DataView, offset: number, frames: number, fmt: PcmFormat): Float32Array[] {
  const { channels, bytes, float, signed, bigEndian } = fmt
  const le = !bigEndian
  // Clamp to the buffer in case the chunk table overruns a truncated file.
  frames = Math.max(0, Math.min(frames, Math.floor((view.byteLength - offset) / (bytes * channels))))
  const out: Float32Array[] = []
  for (let c = 0; c < channels; c++) out.push(new Float32Array(frames))
  let p = offset
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++, p += bytes) {
      let v: number
      if (float) v = bytes === 4 ? view.getFloat32(p, le) : view.getFloat64(p, le)
      else if (bytes === 2) v = (signed ? view.getInt16(p, le) : view.getUint16(p, le) - 0x8000) / 0x8000
      else if (bytes === 1) v = (signed ? view.getInt8(p) : view.getUint8(p) - 0x80) / 0x80
      else if (bytes === 4) v = (signed ? view.getInt32(p, le) : view.getUint32(p, le) - 0x80000000) / 0x80000000
      else {
        const b0 = view.getUint8(p), b1 = view.getUint8(p + 1), b2 = view.getUint8(p + 2)
        let n = le ? b0 | (b1 << 8) | (b2 << 16) : (b0 << 16) | (b1 << 8) | b2
        n = signed ? (n << 8) >> 8 : n - 0x800000
        v = n / 0x800000
      }
      out[c][i] = v
    }
  }
  return out
}

/** Folds decoded PCM into fixed time buckets (max absolute amplitude). */
export class PeakAccumulator {
  private peaks: Float32Array

  constructor(private buckets: number, private duration: number) {
    this.peaks = new Float32Array(buckets)
  }

  add(channels: Float32Array[], startTime: number, sampleRate: number): void {
    if (this.duration > 0) foldPeaks(this.peaks, channels, startTime, sampleRate, this.buckets / this.duration)
  }

  /** Copy of the peaks so far, normalised so the loudest bucket is 1. */
  result(): Float32Array {
    return normalise(this.peaks.slice())
  }
}

/**
 * Peaks at a fixed time resolution for streams whose duration is only
 * known once decoding finishes; reduced to `buckets` on `result()`.
 */
export class PeakTimeline {
  private bins = new Float32Array(4096)
  private used = 0
  /** Total duration to lay the result out over while still decoding. */
  estimatedDuration = 0

  constructor(private buckets: number, private binsPerSecond = 100) {}

  add(channels: Float32Array[], startTime: number, sampleRate: number): void {
    const frames = channels[0]?.length ?? 0
    if (frames === 0) return
    const needed = Math.ceil((startTime + frames / sampleRate) * this.binsPerSecond) + 1
    if (needed > this.bins.length) {
      const grown = new Float32Array(Math.max(needed, this.bins.length * 2))
      grown.set(this.bins)
      this.bins = grown
    }
    foldPeaks(this.bins, channels, startTime, sampleRate, this.binsPerSecond)
    this.used = Math.max(this.used, Math.min(needed, Math.ceil((startTime + frames / sampleRate) * this.binsPerSecond)))
  }

  /** Normalised peaks over max(decoded, estimated) duration. */
  result(): Float32Array {
    const span = Math.max(this.used, Math.ceil(this.estimatedDuration * this.binsPerSecond))
    const padded = new Float32Array(span)
    padded.set(this.bins.subarray(0, Math.min(this.used, span)))
    return normalise(resamplePeaks(padded, this.buckets))
  }
}

/** Max |sample| across channels into `peaks[floor(t * scale)]`. */
function foldPeaks(peaks: Float32Array, channels: Float32Array[], startTime: number, sampleRate: number, scale: number): void {
  const frames = channels[0]?.length ?? 0
  let i = 0
  while (i < frames) {
    const bucket = Math.floor((startTime + i / sampleRate) * scale)
    // First frame index past this bucket.
    const bucketEnd = Math.min(frames, Math.ceil(((bucket + 1) / scale - startTime) * sampleRate))
    const end = Math.max(i + 1, bucketEnd)
    if (bucket >= 0 && bucket < peaks.length) {
      let max = peaks[bucket]
      for (const data of channels) {
        for (let j = i; j < end; j++) {
          const v = Math.abs(data[j])
          if (v > max) max = v
        }
      }
      peaks[bucket] = max
    }
    i = end
  }
}

function normalise(peaks: Float32Array): Float32Array {
  let max = 0
  for (const v of peaks) if (v > max) max = v
  if (max > 0) for (let i = 0; i < peaks.length; i++) peaks[i] /= max
  return peaks
}

/** Quietest level drawn above the floor, relative to the loudest peak. */
const DISPLAY_FLOOR_DB = -45

/**
 * Map a normalised peak (0..1, linear) to a bar height fraction (0..1) on
 * a decibel scale. Speech is spiky — on a linear scale most bars sit at a
 * few percent of the loudest one and the waveform reads as flat.
 */
export function peakToHeight(peak: number): number {
  if (peak <= 0) return 0
  const db = 20 * Math.log10(peak)
  return Math.max(0, Math.min(1, 1 - db / DISPLAY_FLOOR_DB))
}

/** Aggregate peaks down (max) or up (nearest) to exactly `count` bars. */
export function resamplePeaks(peaks: Float32Array, count: number): Float32Array {
  const out = new Float32Array(Math.max(0, count))
  if (peaks.length === 0 || count <= 0) return out
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * peaks.length) / count)
    const end = Math.max(start + 1, Math.floor(((i + 1) * peaks.length) / count))
    let max = 0
    for (let j = start; j < end && j < peaks.length; j++) if (peaks[j] > max) max = peaks[j]
    out[i] = max
  }
  return out
}
