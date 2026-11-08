import { formatNumber } from '../../i18n'

/**
 * Shared helpers for the video viewer: time formatting, clamping, and
 * the zoom math that maps (time in seconds) ↔ (pixels on the CodeTrack).
 */

/** Format a duration in seconds as H:MM:SS (or M:SS when under an hour). */
export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Format a duration in seconds with tenths (M:SS.t) — used on track labels
 *  where sub-second precision matters for code boundary placement. */
export function formatTimeDecimal(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  // The decimal separator is the interface language's ("1:02.5", "1:02,5").
  const secStr = formatNumber(s, { minimumIntegerDigits: 2, minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false })
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${secStr}`
  return `${m}:${secStr}`
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/** Snap a time in seconds to a whole second (floor). We snap every code
 *  boundary on create/drag so the HH:MM:SS timestamps shown in the
 *  transcript gutter exactly match the boundaries on the video track —
 *  no sub-second drift that would push a bracket a row off from its
 *  track sibling. Flooring matches formatTimestamp's rounding. */
export function snapTimeToSecond(t: number): number {
  if (!isFinite(t) || t < 0) return 0
  return Math.floor(t)
}

/** Default pixels-per-second for the CodeTrack when a video first loads.
 *  Picked so a typical 10-minute interview shows ~3 seconds of context per
 *  centimetre on a standard-density display. */
export const DEFAULT_PX_PER_SECOND = 60
export const MIN_PX_PER_SECOND = 4
export const MAX_PX_PER_SECOND = 600

/** Height of a single horizontal bracket on the track. */
export const LANE_HEIGHT = 14
/** Vertical gap between stacked lanes. */
export const LANE_GAP = 2
/** Top padding above the first lane (leaves space for the time ruler). */
export const TRACK_TOP_PADDING = 16

/**
 * Given the transcript's per-line timestamps and a code's time range,
 * return the transcript line-index range the bracket should span.
 *
 * Semantics: each transcript line i is tagged with the playhead time T[i]
 * at which it was typed. A code that covers the time range [S, E) should
 * bracket every line whose tagged time falls inside that range. The
 * bracket's startLine and endLine are then the MIN and MAX line indexes
 * in that set — which correctly handles both:
 *   - chronological transcripts (line times monotonically increase), and
 *   - non-chronological transcripts (user scrubbed back/forth while
 *     transcribing, so line indexes and time values don't correlate).
 *
 * If no line falls inside [S, E) — e.g. the code was placed at a moment
 * before any transcribed line, or in a gap between transcribed moments —
 * the bracket collapses to a single line: the closest line whose time is
 * ≤ S (the "most recently transcribed thought before this moment"). When
 * even that is absent, we fall back to line 0 so the bracket stays
 * visible for the user to drag into place.
 *
 * Returns { startLine: 0, endLine: 0 } when no lineTimes are available.
 */
export function deriveLineAnchorsFromTimeRange(
  startTime: number,
  endTime: number,
  lineTimes: Record<string, number> | undefined
): { startLine: number; endLine: number } {
  if (!lineTimes) return { startLine: 0, endLine: 0 }
  const covered: number[] = []
  for (const [k, v] of Object.entries(lineTimes)) {
    if (v >= startTime && v < endTime) covered.push(parseInt(k, 10))
  }
  if (covered.length > 0) {
    let min = covered[0]
    let max = covered[0]
    for (const i of covered) {
      if (i < min) min = i
      if (i > max) max = i
    }
    return { startLine: min, endLine: max }
  }
  // No line falls inside the range — pick the closest preceding line by
  // time value (last line the user typed before the coded moment).
  let fallback = -1
  let fallbackTime = -Infinity
  for (const [k, v] of Object.entries(lineTimes)) {
    if (v <= startTime && v > fallbackTime) {
      fallbackTime = v
      fallback = parseInt(k, 10)
    }
  }
  if (fallback >= 0) return { startLine: fallback, endLine: fallback }
  return { startLine: 0, endLine: 0 }
}

/**
 * Forward of the above: derive a video coding's time range from the
 * CHARACTER span it covers in the transcript. A video transcript coding is
 * character-precise but also projects onto the CodeTrack — its in/out times
 * come from the line times of the first and last lines its text spans
 * (line-granular timing). Returns undefined when there are no line times
 * (the coding still highlights its text; it just isn't on the timeline).
 *
 * Adjusting the selection within a single line leaves the time range
 * unchanged; extending it onto another line moves the in/out.
 */
/** Codepoint offset of each transcript line start, plus a trailing total —
 *  line i spans [offsets[i], offsets[i+1]). */
export function lineStartOffsets(text: string): number[] {
  const offsets: number[] = []
  let cp = 0
  for (const line of (text || '').split('\n')) {
    offsets.push(cp)
    cp += [...line].length + 1
  }
  offsets.push(cp)
  return offsets
}

/** The transcript line a character offset falls on, given line offsets. */
export function lineForChar(offsets: number[], pos: number): number {
  let ln = 0
  for (let i = 0; i < offsets.length - 1; i++) {
    if (pos >= offsets[i]) ln = i
    else break
  }
  return ln
}

export function deriveVideoTimeRange(
  text: string,
  startCp: number,
  endCp: number,
  lineTimes: Record<string, number> | undefined
): { startTime: number; endTime: number } | undefined {
  if (!lineTimes || Object.keys(lineTimes).length === 0) return undefined
  const offsets = lineStartOffsets(text)
  const startLine = lineForChar(offsets, startCp)
  const endLine = lineForChar(offsets, Math.max(endCp - 1, startCp))
  const at = (line: number): number | undefined => {
    const v = lineTimes[String(line)]
    return typeof v === 'number' ? v : undefined
  }
  const startTime = at(startLine)
  if (startTime == null) return undefined
  const endTime = at(endLine + 1) ?? at(endLine) ?? startTime
  return { startTime, endTime: Math.max(endTime, startTime) }
}

