import { describe, it, expect } from 'vitest'
import {
  PeakAccumulator, PeakTimeline, adtsFrameLength, isFlacFrame, mpegFrameLength, parsePcmFormat, parseWav,
  peakToHeight, readPcm, resamplePeaks, sliceLayout, type PcmFormat
} from '../../src/renderer/utils/waveform-peaks'

function hex(s: string): DataView {
  const bytes = s.replace(/\s+/g, '').match(/../g)!.map((b) => parseInt(b, 16))
  return new DataView(new Uint8Array(bytes).buffer)
}

describe('PeakAccumulator', () => {
  it('folds samples into time buckets by max absolute value across channels', () => {
    // 2 s of audio at 2 Hz into 2 buckets of 1 s each.
    const acc = new PeakAccumulator(2, 2)
    acc.add([new Float32Array([0.1, -0.2, 0.05, 0.0]), new Float32Array([0, 0.1, -0.4, 0.1])], 0, 2)
    expect(Array.from(acc.result())).toEqual([0.5, 1])
  })

  it('places later chunks by their start time', () => {
    const acc = new PeakAccumulator(4, 4)
    acc.add([new Float32Array([0.5])], 0, 1)
    acc.add([new Float32Array([1])], 3, 1)
    expect(Array.from(acc.result())).toEqual([0.5, 0, 0, 1])
  })

  it('splits one chunk across several buckets', () => {
    const acc = new PeakAccumulator(3, 3)
    acc.add([new Float32Array([0.2, 0.2, 0.4, 0.4, 0.8, 0.8])], 0, 2)
    expect(Array.from(acc.result())).toEqual([0.25, 0.5, 1])
  })

  it('ignores audio past the expected duration and handles silence', () => {
    const acc = new PeakAccumulator(2, 2)
    acc.add([new Float32Array([0, 0, 0.9])], 0, 1)
    expect(Array.from(acc.result())).toEqual([0, 0])
  })
})

describe('resamplePeaks', () => {
  it('aggregates down using the max', () => {
    expect(Array.from(resamplePeaks(new Float32Array([0.1, 0.5, 0.25, 1]), 2))).toEqual([0.5, 1])
  })

  it('stretches up and handles zero counts', () => {
    expect(Array.from(resamplePeaks(new Float32Array([0.5, 1]), 4))).toEqual([0.5, 0.5, 1, 1])
    expect(resamplePeaks(new Float32Array([1]), 0).length).toBe(0)
  })
})

describe('parsePcmFormat', () => {
  it('reads a QuickTime v2 lpcm entry (16-bit signed little-endian stereo, 48 kHz)', () => {
    // Sample entry from a QuickTime screen-recording .mov.
    const view = hex(`00000048 6c70636d 00000000 00000001 00020000 00000000 00030010 fffe0000
      00010000 00000048 40e77000 00000000 00000002 7f000000 00000010 0000000c 00000004 00000001`)
    expect(parsePcmFormat(view, 0, 'lpcm')).toEqual({
      sampleRate: 48000, channels: 2, bytes: 2, float: false, signed: true, bigEndian: false, framesPerSample: 1
    })
  })

  it('reads a v0 sowt entry', () => {
    // v0: channels 1 @24, 16 bits @26, rate 44100 (16.16) @32.
    const view = hex(`00000024 736f7774 00000000 00000001 00000000 00000000 00010010 00000000 ac440000`)
    expect(parsePcmFormat(view, 0, 'sowt')).toEqual({
      sampleRate: 44100, channels: 1, bytes: 2, float: false, signed: true, bigEndian: false, framesPerSample: 1
    })
  })

  it('rejects compressed and unknown entries', () => {
    const view = hex(`00000024 6d703461 00000000 00000001 00000000 00000000 00020010 00000000 bb800000`)
    expect(parsePcmFormat(view, 0, 'mp4a')).toBeNull()
  })
})

describe('readPcm', () => {
  const fmt = (o: Partial<PcmFormat>): PcmFormat => ({
    sampleRate: 1, channels: 2, bytes: 2, float: false, signed: true, bigEndian: false, framesPerSample: 1, ...o
  })

  it('de-interleaves 16-bit little-endian samples', () => {
    // L=0x4000 (0.5), R=0xC000 (-0.5); L=0x7fff, R=0x8000 (-1)
    const [l, r] = readPcm(hex('0040 00c0 ff7f 0080'), 0, 2, fmt({}))
    expect(Array.from(l)).toEqual([0.5, 0x7fff / 0x8000])
    expect(Array.from(r)).toEqual([-0.5, -1])
  })

  it('handles big-endian 24-bit', () => {
    const [m] = readPcm(hex('400000 c00000'), 0, 2, fmt({ channels: 1, bytes: 3, bigEndian: true }))
    expect(Array.from(m)).toEqual([0.5, -0.5])
  })

  it('handles 32-bit float', () => {
    const view = new DataView(new ArrayBuffer(8))
    view.setFloat32(0, 0.25, true); view.setFloat32(4, -0.75, true)
    expect(Array.from(readPcm(view, 0, 2, fmt({ channels: 1, bytes: 4, float: true }))[0])).toEqual([0.25, -0.75])
  })

  it('clamps frames to the end of the buffer', () => {
    expect(readPcm(hex('0040 00c0'), 0, 10, fmt({}))[0].length).toBe(1)
  })
})

describe('peakToHeight', () => {
  it('maps peaks onto a -45 dB..0 dB scale', () => {
    expect(peakToHeight(1)).toBe(1)
    expect(peakToHeight(0)).toBe(0)
    expect(peakToHeight(10 ** (-45 / 20))).toBeCloseTo(0)
    expect(peakToHeight(10 ** (-22.5 / 20))).toBeCloseTo(0.5)
    expect(peakToHeight(1e-6)).toBe(0)
  })
})

describe('PeakTimeline', () => {
  it('lays peaks out over the decoded duration', () => {
    const t = new PeakTimeline(2, 10)
    t.add([new Float32Array([0.5, 0.5])], 0, 2) // 0–1 s
    t.add([new Float32Array([1, 1])], 1, 2) // 1–2 s
    expect(Array.from(t.result())).toEqual([0.5, 1])
  })

  it('leaves room for the estimated remainder while decoding', () => {
    const t = new PeakTimeline(4, 10)
    t.add([new Float32Array([1, 1])], 0, 2)
    t.estimatedDuration = 4
    expect(Array.from(t.result())).toEqual([1, 0, 0, 0])
  })
})

// Frame headers below are taken from real files (afconvert / libsndfile).
describe('frame headers', () => {
  it('reads an MPEG-1 Layer III frame length', () => {
    // 128 kbps, 44.1 kHz, no padding: floor(144 * 128000 / 44100) = 417
    expect(mpegFrameLength(new Uint8Array(hex('fffb9064').buffer), 0)).toBe(417)
    expect(mpegFrameLength(new Uint8Array(hex('fffbf064').buffer), 0)).toBe(0) // bitrate index 15 is invalid
  })

  it('reads an ADTS frame length', () => {
    expect(adtsFrameLength(new Uint8Array(hex('fff950a001a00021').buffer), 0)).toBe(13)
    expect(adtsFrameLength(new Uint8Array(hex('fffb9064 00000000').buffer), 0)).toBe(0)
  })

  it('accepts a FLAC frame header only with a valid CRC-8', () => {
    const bytes = new Uint8Array(hex('fff8591c003f0000').buffer)
    expect(isFlacFrame(bytes, 0)).toBe(true)
    bytes[5] ^= 1
    expect(isFlacFrame(bytes, 0)).toBe(false)
  })
})

describe('sliceLayout', () => {
  /** n MP3 frames of 417 bytes (128 kbps, 44.1 kHz), optionally behind an ID3 tag. */
  function mp3(frames: number, id3 = 0): Uint8Array {
    const out = new Uint8Array(id3 + frames * 417)
    if (id3) out.set([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, (id3 - 10) >> 7, (id3 - 10) & 0x7f])
    for (let f = 0; f < frames; f++) out.set([0xff, 0xfb, 0x90, 0x64], id3 + f * 417)
    return out
  }

  it('finds MP3 frames after an ID3 tag and aligns to frame starts', () => {
    const layout = sliceLayout(mp3(5, 138))!
    expect(layout.dataStart).toBe(138)
    expect(layout.header.length).toBe(0)
    expect(layout.align(139)).toBe(138 + 417)
  })

  it('skips FLAC metadata blocks and keeps them as the slice header', () => {
    // 'fLaC' + last-block STREAMINFO of 34 bytes, then a frame.
    const bytes = new Uint8Array(4 + 4 + 34 + 8)
    bytes.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34])
    bytes.set([0xff, 0xf8, 0x59, 0x1c, 0x00, 0x3f], 42)
    const layout = sliceLayout(bytes)!
    expect(layout.dataStart).toBe(42)
    expect(layout.header.length).toBe(42)
    expect(layout.align(0)).toBe(42)
  })

  it('treats granule-0 Ogg pages as headers', () => {
    const page = (granule: number, body: number) => {
      const p = new Uint8Array(27 + 1 + body)
      p.set([0x4f, 0x67, 0x67, 0x53])
      p[6] = granule
      p[26] = 1
      p[27] = body
      return p
    }
    const pages = [page(0, 19), page(0, 30), page(5, 40), page(9, 40)]
    const bytes = new Uint8Array(pages.reduce((n, p) => n + p.length, 0))
    let o = 0
    for (const p of pages) { bytes.set(p, o); o += p.length }
    const layout = sliceLayout(bytes)!
    const headerEnd = pages[0].length + pages[1].length
    expect(layout.dataStart).toBe(headerEnd)
    expect(layout.align(headerEnd + 1)).toBe(headerEnd + pages[2].length)
  })

  it('rejects unrecognised data', () => {
    expect(sliceLayout(new Uint8Array(10000).fill(0x41))).toBeNull()
  })
})

describe('parseWav', () => {
  function wav(fmt: number[], data: number[]): DataView {
    const fmtBytes = new Uint8Array(fmt)
    const bytes = new Uint8Array(12 + 8 + fmtBytes.length + 8 + data.length)
    const v = new DataView(bytes.buffer)
    bytes.set([0x52, 0x49, 0x46, 0x46], 0); bytes.set([0x57, 0x41, 0x56, 0x45], 8)
    bytes.set([0x66, 0x6d, 0x74, 0x20], 12); v.setUint32(16, fmtBytes.length, true); bytes.set(fmtBytes, 20)
    const d = 20 + fmtBytes.length
    bytes.set([0x64, 0x61, 0x74, 0x61], d); v.setUint32(d + 4, data.length, true); bytes.set(data, d + 8)
    return v
  }
  const le16 = (n: number) => [n & 0xff, n >> 8]
  const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24]

  it('reads 16-bit stereo PCM', () => {
    // tag 1, 2 ch, 8000 Hz, byte rate, block align 4, 16 bits
    const view = wav([...le16(1), ...le16(2), ...le32(8000), ...le32(32000), ...le16(4), ...le16(16)], [0, 0x40, 0, 0xc0, 0, 0, 0, 0])
    const audio = parseWav(view)
    expect(audio.format).toMatchObject({ sampleRate: 8000, channels: 2, bytes: 2, float: false, signed: true })
    expect(audio.duration).toBe(2 / 8000)
    const [l, r] = readPcm(view, audio.chunks[0].offset, audio.chunks[0].frames, audio.format)
    expect(Array.from(l)).toEqual([0.5, 0])
    expect(Array.from(r)).toEqual([-0.5, 0])
  })

  it('treats 8-bit PCM as unsigned and reads WAVE_FORMAT_EXTENSIBLE float', () => {
    const u8 = parseWav(wav([...le16(1), ...le16(1), ...le32(8000), ...le32(8000), ...le16(1), ...le16(8)], [0x80]))
    expect(u8.format.signed).toBe(false)
    const ext = [...le16(0xfffe), ...le16(1), ...le32(48000), ...le32(192000), ...le16(4), ...le16(32),
      ...le16(22), ...le16(32), ...le32(4), ...le16(3), ...new Array(14).fill(0)]
    expect(parseWav(wav(ext, [0, 0, 0, 0])).format).toMatchObject({ float: true, bytes: 4 })
  })
})
