import { t } from '../i18n'
/**
 * Timestamp utilities for audio transcription.
 *
 * Canonical format: HH:MM:SS at the start of lines (no brackets to avoid
 * markdown escaping conflicts with Tiptap).
 * Supports parsing various input formats for transcript import.
 */

// Regex for canonical timestamps at the start of lines: "HH:MM:SS " or "[HH:MM:SS] " (legacy/import)
// Also matches escaped brackets from Tiptap: "\[HH:MM:SS\]"
const TIMESTAMP_LINE_REGEX = /^(?:\\?\[)?(\d{1,2}):(\d{2}):(\d{2})(?:\\?\])? /gm

/** Format seconds as "HH:MM:SS" (no brackets — safe for markdown) */
export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** Parse a timestamp string to seconds. Returns null if not a valid timestamp. */
export function parseTimestamp(text: string): number | null {
  // HH:MM:SS or HH:MM:SS.mmm (with or without brackets, with or without escapes)
  let m = text.match(/^(?:\\?\[)?(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:\\?\])?$/)
  if (m) return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + (m[4] ? parseInt(m[4]) / Math.pow(10, m[4].length) : 0)

  // MM:SS
  m = text.match(/^(?:\\?\[)?(\d{1,2}):(\d{2})(?:\\?\])?$/)
  if (m) return parseInt(m[1]) * 60 + parseInt(m[2])

  // (HH:MM:SS) or (MM:SS) parenthesized
  m = text.match(/^\((\d{1,2}):(\d{2}):(\d{2})\)$/)
  if (m) return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3])

  m = text.match(/^\((\d{1,2}):(\d{2})\)$/)
  if (m) return parseInt(m[1]) * 60 + parseInt(m[2])

  return null
}

/** Extract all timestamps from full transcript text with their codepoint positions. */
export function extractTimestamps(text: string): { seconds: number; cpStart: number; cpEnd: number }[] {
  const results: { seconds: number; cpStart: number; cpEnd: number }[] = []

  // Match timestamps at start of lines — handles:
  // "HH:MM:SS " (canonical)
  // "[HH:MM:SS] " (bracketed)
  // "\[HH:MM:SS\] " (escaped brackets from Tiptap)
  const regex = /^(?:\\?\[)?(\d{1,2}):(\d{2}):(\d{2})(?:\\?\])? /gm
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const seconds = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3])
    const charIdx = match.index
    const cpStart = [...text.slice(0, charIdx)].length
    const cpEnd = cpStart + [...match[0]].length
    results.push({ seconds, cpStart, cpEnd })
  }

  return results
}

/**
 * Extract timestamps mapped to their line indices (0-based).
 * Used to render a timestamp column alongside line-based text views.
 */
export function extractTimestampsPerLine(text: string): { lineIndex: number; seconds: number; tsText: string }[] {
  const results: { lineIndex: number; seconds: number; tsText: string }[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:\\?\[)?(\d{1,2}):(\d{2}):(\d{2})(?:\\?\])? /)
    if (m) {
      const seconds = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3])
      const h = Math.floor(seconds / 3600)
      const min = Math.floor((seconds % 3600) / 60)
      const sec = seconds % 60
      const tsText = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      results.push({ lineIndex: i, seconds, tsText })
    }
  }
  return results
}

/**
 * Find which timestamp is active at a given playback time.
 * Returns the line index of the active timestamp.
 */
export function findActiveTimestampLine(text: string, currentTime: number): number | null {
  const timestamps = extractTimestampsPerLine(text)
  if (timestamps.length === 0) return null
  let activeIdx = -1
  for (let i = 0; i < timestamps.length; i++) {
    if (timestamps[i].seconds <= currentTime) activeIdx = i
    else break
  }
  return activeIdx >= 0 ? timestamps[activeIdx].lineIndex : null
}

/**
 * Find the timestamp segment active at a given playback time.
 * Returns the codepoint range of the text between this timestamp and the next.
 */
export function findActiveSegment(
  text: string,
  currentTime: number
): { cpStart: number; cpEnd: number } | null {
  const timestamps = extractTimestamps(text)
  if (timestamps.length === 0) return null

  let activeIdx = -1
  for (let i = 0; i < timestamps.length; i++) {
    if (timestamps[i].seconds <= currentTime) activeIdx = i
    else break
  }

  if (activeIdx === -1) return null

  const start = timestamps[activeIdx].cpStart
  const end = activeIdx + 1 < timestamps.length
    ? timestamps[activeIdx + 1].cpStart
    : [...text].length

  return { cpStart: start, cpEnd: end }
}

/**
 * Strip inline "[HH:MM:SS] " / "HH:MM:SS " prefixes from a transcript and
 * return them as a lineTimes map plus the cleaned text. Used once when
 * loading a legacy audio transcript that still stores timestamps inline —
 * from then on the per-line times live in formatData.lineTimes the same
 * way the video transcript does.
 *
 * Returns null when no inline timestamps are found, so callers can skip
 * writing a migration no-op.
 */
export function migrateInlineTimestamps(
  text: string
): { content: string; lineTimes: Record<string, number> } | null {
  const lines = text.split('\n')
  const lineTimes: Record<string, number> = {}
  const cleaned: string[] = []
  let matched = false
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:\\?\[)?(\d{1,2}):(\d{2}):(\d{2})(?:\\?\])?\s?(.*)$/)
    if (m) {
      const seconds = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3])
      lineTimes[String(i)] = seconds
      cleaned.push(m[4])
      matched = true
    } else {
      cleaned.push(lines[i])
    }
  }
  if (!matched) return null
  return { content: cleaned.join('\n'), lineTimes }
}

/** Parse a subtitle clock time to seconds (fractional preserved). Accepts
 *  `HH:MM:SS.mmm`, `MM:SS.mmm`, SRT's comma decimal (`HH:MM:SS,mmm`), and a
 *  non-standard / truncated fraction (e.g. noScribe's `00:00:10.01`) — the
 *  fraction is read as a literal decimal, so `.01` → 0.01s. Returns null when
 *  the string isn't a clock time. */
function parseClockTime(s: string): number | null {
  const m = s.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d+))?$/)
  if (!m) return null
  const h = m[1] ? parseInt(m[1], 10) : 0
  const min = parseInt(m[2], 10)
  const sec = parseInt(m[3], 10)
  const frac = m[4] ? parseInt(m[4], 10) / Math.pow(10, m[4].length) : 0
  return h * 3600 + min * 60 + sec + frac
}

/** Strip WebVTT/SRT cue payload markup: voice/class/formatting tags
 *  (`<v Speaker>`, `<c>`, `<i>`, inline `<00:00:01.000>` timestamps) and the
 *  handful of HTML entities the formats use. */
function stripCueMarkup(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lrm;|&rlm;/g, '')
    .trim()
}

/** One transcript line's timing + speaker, as recovered from the source file.
 *  `segments[i]` describes content line `i`. */
export interface TranscriptSegment {
  /** The speaker label/name (e.g. "S00", "Roger Bingham"), or null when the
   *  format doesn't identify one. */
  speaker: string | null
  startTime: number
  endTime: number
}

/** The result of parsing a structured transcript (subtitles or noScribe HTML).
 *  `segments` runs parallel to the content's lines. */
export interface ParsedTranscript {
  content: string
  lineTimes: Record<string, number>
  notes: string[]
  segments: TranscriptSegment[]
}

/**
 * Parse a WebVTT or SRT subtitle file into Magnolia's transcript model: clean
 * text (one line per cue) plus a `lineTimes` map (line index → start seconds,
 * fractional preserved). Returns null when the text isn't a subtitle file, so
 * the caller can fall back to the inline-timestamp path.
 *
 * Handles real-world VTT (e.g. noScribe): a `WEBVTT <title>` header, `NOTE` /
 * `STYLE` / `REGION` blocks, cue identifier lines, voice tags, multi-line cue
 * payloads (joined into one line), and malformed millisecond fields.
 *
 * `notes` collects the text of any `NOTE` comment blocks (transcription tool,
 * source media path, language settings, …) so the caller can preserve that
 * provenance — e.g. as a document memo — instead of discarding it. `segments`
 * carries each cue's speaker (from a `<v Speaker>` tag) and time range.
 */
export function parseSubtitleTranscript(raw: string): ParsedTranscript | null {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const firstLine = (text.split('\n').find((l) => l.trim() !== '') ?? '').trim()
  const isVtt = /^WEBVTT(\s|$)/.test(firstLine)
  const isSrt = /\d{1,2}:\d{2}:\d{2}[.,]\d+\s*-->\s*\d{1,2}:\d{2}:\d{2}/.test(text)
  if (!isVtt && !isSrt) return null

  // Cues are separated by one or more blank lines.
  const blocks = text.split(/\n[ \t]*\n+/)
  const lines: string[] = []
  const lineTimes: Record<string, number> = {}
  const notes: string[] = []
  const segments: TranscriptSegment[] = []
  for (const block of blocks) {
    const blockLines = block.split('\n')
    const head = (blockLines.find((l) => l.trim() !== '') ?? '').trim()
    if (head === '') continue
    // Skip the file header and style/region blocks.
    if (/^WEBVTT(\s|$)/.test(head)) continue
    if (/^(STYLE|REGION)(\s|$)/.test(head)) continue
    // Keep NOTE comment text (provenance) rather than discarding it.
    if (/^NOTE(\s|$)/.test(head)) {
      const note = block.replace(/^[ \t]*NOTE[ \t]?/, '').trim()
      if (note) notes.push(note)
      continue
    }
    // The timing line carries the cue's start/end; lines after it are payload.
    const ti = blockLines.findIndex((l) => l.includes('-->'))
    if (ti === -1) continue
    const halves = blockLines[ti].split('-->')
    const start = parseClockTime(halves[0])
    if (start == null) continue
    // End may be followed by cue settings (e.g. "align:start"); take the first
    // token after the arrow.
    const end = parseClockTime((halves[1] ?? '').trim().split(/\s+/)[0] ?? '')
    const rawPayload = blockLines.slice(ti + 1).join('\n')
    const voice = rawPayload.match(/<v\s+([^>]*)>/i)
    const speaker = voice && voice[1].trim() !== '' ? voice[1].trim() : null
    const payload = blockLines
      .slice(ti + 1)
      .map(stripCueMarkup)
      .filter((l) => l !== '')
      .join(' ')
    if (payload === '') continue
    lineTimes[String(lines.length)] = start
    segments.push({ speaker, startTime: start, endTime: end ?? start })
    lines.push(payload)
  }
  if (lines.length === 0) return null
  return { content: lines.join('\n'), lineTimes, notes, segments }
}

/** Decode the handful of HTML entities a noScribe export uses. */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&amp;/g, '&') // last, so we don't double-decode
}

/**
 * Parse a noScribe HTML transcript export into Magnolia's transcript model —
 * the same `{ content, lineTimes, notes }` shape as parseSubtitleTranscript,
 * so the importer treats it uniformly. Returns null when the text isn't a
 * noScribe HTML file.
 *
 * Each segment is an anchor `<a name="ts_<startMs>_<endMs>_<speaker>">…</a>`
 * whose name carries millisecond-precise timing (the visible `[HH:MM:SS]` is
 * only a rounded display, so it's dropped). The speaker label (e.g. `S00:`)
 * is kept — it's meaningful turn-taking content in a multi-speaker transcript.
 * The gray provenance block (transcription tool, source audio, language
 * settings) is returned as a note for the caller to keep as a document memo.
 */
export function parseNoScribeHtmlTranscript(raw: string): ParsedTranscript | null {
  // The defining feature of a noScribe HTML export is its timed segment anchors.
  if (!/<a\s+name="ts_\d+_\d+/i.test(raw)) return null

  const anchorRe = /<a\s+name="ts_(\d+)_(\d+)(?:_([^"]*))?"\s*>([\s\S]*?)<\/a>/gi
  const lines: string[] = []
  const lineTimes: Record<string, number> = {}
  const segments: TranscriptSegment[] = []
  let m: RegExpExecArray | null
  while ((m = anchorRe.exec(raw)) !== null) {
    const startSec = parseInt(m[1], 10) / 1000
    const endSec = parseInt(m[2], 10) / 1000
    const speaker = m[3] && m[3].trim() !== '' ? m[3].trim() : null
    const text = decodeHtmlEntities(
      m[4]
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, '') // strip the [HH:MM:SS] span and any other tags
    )
      .replace(/\[\d{1,2}:\d{2}:\d{2}\]/g, ' ') // drop the redundant visible timestamp
      .replace(/\s+/g, ' ')
      .trim()
    if (text === '') continue
    lineTimes[String(lines.length)] = startSec
    segments.push({ speaker, startTime: startSec, endTime: endSec })
    lines.push(text)
  }
  if (lines.length === 0) return null

  // Provenance: the gray metadata block, else the audio_source meta tag.
  const notes: string[] = []
  const meta = raw.match(/<span\b[^>]*>([\s\S]*?Transcribed with noScribe[\s\S]*?)<\/span>/i)
  if (meta) {
    const note = decodeHtmlEntities(
      meta[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    ).trim()
    if (note) notes.push(note)
  } else {
    const audio = raw.match(/<meta\s+name="audio_source"\s+content="([^"]*)"/i)
    if (audio && audio[1]) notes.push(t('transcript.audioFileNote', { file: audio[1] }))
  }

  return { content: lines.join('\n'), lineTimes, notes, segments }
}

/**
 * Detect various timestamp formats in imported text and convert to canonical HH:MM:SS.
 * Handles SRT, VTT, and plain timestamp formats.
 */
export function detectAndConvertTimestamps(text: string): string {
  const lines = text.split('\n')
  const result: string[] = []

  // Detect SRT format
  const isSrt = lines.some((l) => /^\d+\s*$/.test(l.trim())) &&
    lines.some((l) => /\d{2}:\d{2}:\d{2}[,.]?\d*\s*-->\s*\d{2}:\d{2}:\d{2}/.test(l))

  // Detect VTT format
  const isVtt = lines[0]?.trim() === 'WEBVTT' ||
    lines.some((l) => /\d{2}:\d{2}[:.]\d{2}[.,]\d+\s*-->\s*\d{2}:\d{2}[:.]\d{2}/.test(l))

  if (isSrt || isVtt) {
    return convertSubtitleFormat(lines, isVtt)
  }

  for (const line of lines) {
    result.push(convertLineTimestamp(line))
  }

  return result.join('\n')
}

function convertSubtitleFormat(lines: string[], isVtt: boolean): string {
  const result: string[] = []
  let i = 0

  if (isVtt && lines[0]?.trim() === 'WEBVTT') i = 1
  while (i < lines.length && lines[i]?.trim() === '') i++

  while (i < lines.length) {
    const line = lines[i].trim()
    if (/^\d+$/.test(line)) { i++; continue }
    if (line === '') { i++; continue }

    const timingMatch = line.match(/(\d{1,2}):(\d{2}):(\d{2})[,.]?\d*\s*-->/)
    if (timingMatch) {
      const seconds = parseInt(timingMatch[1]) * 3600 + parseInt(timingMatch[2]) * 60 + parseInt(timingMatch[3])
      const ts = formatTimestamp(seconds)
      i++
      const contentLines: string[] = []
      while (i < lines.length && lines[i].trim() !== '' && !/\d{2}:\d{2}:\d{2}.*-->/.test(lines[i]) && !/^\d+$/.test(lines[i].trim())) {
        contentLines.push(lines[i].trim())
        i++
      }
      result.push(`${ts} ${contentLines.join(' ')}`)
      continue
    }

    result.push(line)
    i++
  }

  return result.join('\n')
}

function convertLineTimestamp(line: string): string {
  // Already canonical HH:MM:SS at start
  if (/^\d{1,2}:\d{2}:\d{2}\s/.test(line)) return line

  // [HH:MM:SS] or \[HH:MM:SS\] at start → strip brackets
  let m = line.match(/^\\?\[(\d{1,2}:\d{2}:\d{2})\]\\?\s*(.*)$/)
  if (m) return `${m[1]} ${m[2]}`

  // [MM:SS] at start
  m = line.match(/^\\?\[(\d{1,2}):(\d{2})\\?\]\s*(.*)$/)
  if (m) {
    const seconds = parseInt(m[1]) * 60 + parseInt(m[2])
    return `${formatTimestamp(seconds)} ${m[3]}`
  }

  // (HH:MM:SS) at start
  m = line.match(/^\((\d{1,2}):(\d{2}):(\d{2})\)\s*(.*)$/)
  if (m) {
    const seconds = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3])
    return `${formatTimestamp(seconds)} ${m[4]}`
  }

  // (MM:SS) at start
  m = line.match(/^\((\d{1,2}):(\d{2})\)\s*(.*)$/)
  if (m) {
    const seconds = parseInt(m[1]) * 60 + parseInt(m[2])
    return `${formatTimestamp(seconds)} ${m[3]}`
  }

  // MM:SS at start (no brackets)
  m = line.match(/^(\d{1,2}):(\d{2})\s+(.*)$/)
  if (m && parseInt(m[1]) < 60) {
    const seconds = parseInt(m[1]) * 60 + parseInt(m[2])
    return `${formatTimestamp(seconds)} ${m[3]}`
  }

  return line
}
