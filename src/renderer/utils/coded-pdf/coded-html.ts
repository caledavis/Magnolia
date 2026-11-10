/**
 * HTML for a coded document's PDF export: text with each coded segment
 * highlighted in its code's colour and the code names in a right-hand
 * margin beside where the segment starts, and page images (PDF pages,
 * images) with their coded areas drawn on and labelled the same way.
 *
 * Nothing here measures layout. The print engine lays the page out again
 * at its own width, so margin labels for text are right floats with a
 * negative margin (the "sidenote" technique): each one sits on the line
 * where its segment starts, and `clear: right` stacks labels that would
 * otherwise overlap.
 *
 * A float goes on the line where the engine meets it, and a float in the
 * margin always fits, so one placed just before a word that then wraps
 * would sit a line too high. Each label is therefore placed after the
 * segment's first character, inside a no-wrap span around that first
 * word (WebKit would otherwise break the word at the label).
 */
import { escHtml } from '../pdf-export'

export interface CodeRef {
  guid: string
  name: string
  color: string
}

/** One coded segment of a text, in codepoint offsets. */
export interface TextSegment {
  start: number
  end: number
  codes: CodeRef[]
  /** Extra line under the code names, e.g. a video time range. */
  detail?: string
}

export const DEFAULT_CODE_COLOUR = '#888888'

/** `#rgb` / `#rrggbb` → `rgba(…)`. Anything else falls back to grey. */
export function colourWithAlpha(color: string, alpha: number): string {
  let hex = (color || '').trim().replace(/^#/, '')
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = hex.split('').map((c) => c + c).join('')
  if (!/^[0-9a-f]{6}$/i.test(hex)) hex = DEFAULT_CODE_COLOUR.slice(1)
  const n = parseInt(hex, 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/** Merge codes from several segments into one list, first seen first. */
function mergeCodes(lists: CodeRef[][]): CodeRef[] {
  const seen = new Set<string>()
  const out: CodeRef[] = []
  for (const list of lists) {
    for (const c of list) {
      if (seen.has(c.guid)) continue
      seen.add(c.guid)
      out.push(c)
    }
  }
  return out
}

function labelHtml(codes: CodeRef[], details: string[], cls: string, style = ''): string {
  const names = codes
    .map((c) => `<span class="cl-code" style="border-color:${escHtml(c.color)}">${escHtml(c.name)}</span>`)
    .join('')
  const extra = details.map((d) => `<span class="cl-detail">${escHtml(d)}</span>`).join('')
  return `<span class="${cls}"${style ? ` style="${style}"` : ''}>${names}${extra}</span>`
}

function firstSegmentLength(text: string, granularity: 'grapheme' | 'word'): number {
  if (typeof Intl === 'undefined' || !('Segmenter' in Intl)) return 1
  const first = new Intl.Segmenter(undefined, { granularity }).segment(text)[Symbol.iterator]().next().value
  return first ? [...first.segment].length : 1
}

/** Longest first word kept on one line; longer runs (a URL, or text
 *  without spaces such as Chinese) keep only their first word together. */
const MAX_GLUED = 24

/**
 * Where a segment's label goes (see the note at the top): after the first
 * character that isn't white space, with the word around it kept on one
 * line (`glue`). A segment of only white space has its label at the start.
 */
function labelPlace(cps: string[], start: number, end: number): { at: number; glue?: [number, number] } {
  let i = start
  while (i < end && /\s/.test(cps[i])) i++
  if (i >= end) return { at: start }
  const sample = cps.slice(i, i + MAX_GLUED + 8).join('')
  const at = Math.min(end, i + firstSegmentLength(sample, 'grapheme'))
  let wordEnd = i
  while (wordEnd < cps.length && wordEnd - i <= MAX_GLUED && !/\s/.test(cps[wordEnd])) wordEnd++
  if (wordEnd - i > MAX_GLUED) wordEnd = i + Math.min(MAX_GLUED, firstSegmentLength(sample, 'word'))
  return { at, glue: [i, Math.max(at, wordEnd)] }
}

/**
 * Text with coded segments highlighted and labelled. `linePrefixes` adds
 * a display-only prefix (a transcript timestamp) at the start of the
 * given 0-based lines; it doesn't shift any offsets.
 */
export function codedTextHtml(
  text: string,
  segments: TextSegment[],
  linePrefixes?: Map<number, string>
): string {
  const cps = [...text]
  const n = cps.length
  const segs = segments
    .filter((s) => s.codes.length > 0)
    .map((s) => {
      const start = Math.max(0, Math.min(n, s.start))
      return { ...s, start, end: Math.max(start, Math.min(n, s.end)) }
    })

  const boundaries = new Set<number>([0, n])
  const startsAt = new Map<number, typeof segs>()
  const endsAt = new Map<number, typeof segs>()
  const labelsAt = new Map<number, typeof segs>()
  const glued: [number, number][] = []
  for (const s of segs) {
    boundaries.add(s.start)
    boundaries.add(s.end)
    startsAt.set(s.start, [...(startsAt.get(s.start) ?? []), s])
    if (s.end > s.start) endsAt.set(s.end, [...(endsAt.get(s.end) ?? []), s])
    const { at, glue } = labelPlace(cps, s.start, s.end)
    boundaries.add(at)
    labelsAt.set(at, [...(labelsAt.get(at) ?? []), s])
    if (glue) {
      glued.push(glue)
      boundaries.add(glue[0])
      boundaries.add(glue[1])
    }
  }
  const isGlued = (at: number) => glued.some(([a, b]) => a <= at && at < b)
  // Line starts, so each line's prefix can be placed.
  const lineAt = new Map<number, number>()
  if (linePrefixes && linePrefixes.size > 0) {
    let line = 0
    lineAt.set(0, 0)
    for (let i = 0; i < n; i++) {
      if (cps[i] === '\n') {
        line++
        lineAt.set(i + 1, line)
        boundaries.add(i + 1)
      }
    }
  }

  const sorted = [...boundaries].sort((a, b) => a - b)
  const active = new Set<(typeof segs)[number]>()
  let html = ''
  let inGlue = false
  for (let i = 0; i < sorted.length; i++) {
    const at = sorted[i]
    for (const s of endsAt.get(at) ?? []) active.delete(s)
    // A label ends the character before it, so it goes before a glued
    // word closes; glued words never span a line, so they never hold a
    // line prefix.
    const labelled = labelsAt.get(at)
    if (labelled) {
      const details = labelled.map((s) => s.detail).filter((d): d is string => !!d)
      html += labelHtml(mergeCodes(labelled.map((s) => s.codes)), [...new Set(details)], 'cl')
    }
    const glue = at < n && isGlued(at)
    if (inGlue && !glue) html += '</span>'
    const line = lineAt.get(at)
    if (line !== undefined && at < n) {
      const prefix = linePrefixes?.get(line)
      html += `<span class="ts">${escHtml(prefix ?? '')}</span>`
    }
    if (glue && !inGlue) html += '<span class="cw">'
    inGlue = glue
    for (const s of startsAt.get(at) ?? []) if (s.end > s.start) active.add(s)
    const next = sorted[i + 1]
    if (next === undefined || next <= at) continue
    let frag = escHtml(cps.slice(at, next).join(''))
    // Nested translucent backgrounds over the same text blend where
    // codes overlap.
    for (const s of active) {
      for (const c of s.codes) {
        frag = `<span class="hl" style="background:${colourWithAlpha(c.color, 0.22)}">${frag}</span>`
      }
    }
    html += frag
  }
  return `<div class="coded">${html}</div>`
}

/** A coded area on a page image, as fractions of the page's height. */
export interface PageLabel {
  y: number
  codes: CodeRef[]
  detail?: string
}

/** Assumed width of the printed content, in CSS px, for spacing labels. */
const ASSUMED_CONTENT_WIDTH = 720
const LABEL_LINE = 12
const LABEL_GAP = 6
/** Rough width of a label character (9px, partly bold), for wrapping. */
const LABEL_CHAR_WIDTH = 5.4
/** Gap between a page image and its labels (.pg-row), plus the bar. */
const LABEL_INSET = 22
/** Tallest page image, as a fraction of the content width: low enough
 *  that the first page fits under the title and the list of codes on
 *  Letter paper (A4 is taller). */
const MAX_PAGE_HEIGHT = 0.88

/**
 * A page image with its labels beside it. `aspect` is height / width.
 * Tall pages are narrowed so that a page fits on one printed page.
 * `wide` lets the image take the labels' room, for an export without codes.
 */
export function pageFigureHtml(
  imageSrc: string,
  aspect: number,
  labels: PageLabel[],
  caption: string,
  breakBefore: boolean,
  wide = false
): string {
  const widthPct = Math.min(wide ? 100 : 74, (MAX_PAGE_HEIGHT * 100) / Math.max(aspect, 0.01))
  const imageHeight = (widthPct / 100) * ASSUMED_CONTENT_WIDTH * aspect
  // Lines a label takes, counting code names that wrap.
  const charsPerLine = Math.max(8, Math.floor((((100 - widthPct) / 100) * ASSUMED_CONTENT_WIDTH - LABEL_INSET) / LABEL_CHAR_WIDTH))
  const lineCount = (l: PageLabel) =>
    l.codes.reduce((n, c) => n + Math.max(1, Math.ceil([...c.name].length / charsPerLine)), 0) + (l.detail ? 1 : 0)
  // Merge labels at the same height, then push each one below the last.
  const merged: PageLabel[] = []
  for (const l of [...labels].sort((a, b) => a.y - b.y)) {
    const prev = merged[merged.length - 1]
    if (prev && Math.abs(prev.y - l.y) < 0.002 && prev.detail === l.detail) {
      prev.codes = mergeCodes([prev.codes, l.codes])
    } else {
      merged.push({ ...l })
    }
  }
  let nextFree = 0
  const placed = merged.map((l) => {
    const top = Math.max(l.y * imageHeight, nextFree)
    const height = lineCount(l) * LABEL_LINE + LABEL_GAP
    nextFree = top + height
    return labelHtml(l.codes, l.detail ? [l.detail] : [], 'pl', `top:${((top / imageHeight) * 100).toFixed(2)}%`)
  })
  return `<div class="pg${breakBefore ? ' pg-break' : ''}">
<div class="pg-caption">${escHtml(caption)}</div>
<div class="pg-row"><div class="pg-img" style="width:${widthPct.toFixed(2)}%"><img src="${imageSrc}" alt="" /></div>
<div class="pg-labels">${placed.join('')}</div></div></div>`
}

/** Codes used in the document with how many segments each codes. */
export function legendHtml(heading: string, entries: { code: CodeRef; count: number }[]): string {
  if (entries.length === 0) return ''
  const items = entries
    .map(({ code, count }) =>
      `<span class="lg-item"><span class="lg-swatch" style="background:${escHtml(code.color)}"></span>${escHtml(code.name)} <span class="muted">(${count})</span></span>`)
    .join('')
  return `<div class="legend"><div class="section-heading">${escHtml(heading)}</div>${items}</div>`
}

/** CSS for everything above, appended to the shared PDF base. */
export const CODED_PDF_CSS = `
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .legend { margin: 0 0 18px; }
  .legend .section-heading { margin-top: 0; }
  .lg-item { display: inline-block; margin: 0 14px 4px 0; font-size: 10.5px; }
  .lg-swatch { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-inline-end: 5px; vertical-align: -1px; }
  .coded { display: flow-root; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; padding-right: 172px; font-size: 11.5px; line-height: 1.8; }
  .coded .hl { border-radius: 2px; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
  .coded .ts { display: inline-block; width: 62px; font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 9.5px; color: #999; }
  .coded .cw { white-space: nowrap; }
  .no-codes { margin-top: 16px; }
  .no-codes .coded { padding-right: 0; }
  .cl, .pl { white-space: normal; font-size: 9px; line-height: ${LABEL_LINE}px; text-indent: 0; font-weight: normal; }
  .cl { float: right; clear: right; width: 156px; margin: 3px -172px 3px 0; }
  .cl-code { display: block; border-left: 3px solid; padding-left: 5px; color: #333; font-weight: 600; }
  .cl-detail { display: block; padding-left: 8px; color: #888; font-family: 'SF Mono', Menlo, Consolas, monospace; }
  .pg { break-inside: avoid; page-break-inside: avoid; margin: 0 0 18px; }
  .pg-break { break-before: page; page-break-before: always; }
  .pg-caption { font-size: 10px; color: #888; margin-bottom: 4px; }
  .pg-row { display: flex; gap: 14px; align-items: stretch; }
  .pg-img { flex: none; }
  .pg-img img { display: block; width: 100%; border: 1px solid #ddd; }
  .pg-labels { position: relative; flex: 1; min-width: 0; }
  .pl { position: absolute; left: 0; right: 0; }
  .nb-note { margin: 0 0 22px; padding-top: 12px; border-top: 1px solid #ddd; }
  .nb-note:first-child { border-top: none; padding-top: 0; }
  .nb-head { display: flex; align-items: baseline; gap: 12px; margin: 0 0 6px; break-after: avoid; page-break-after: avoid; }
  .nb-title { font-size: 14px; font-weight: 600; }
  .nb-date { font-size: 10.5px; color: #888; }
  .resp { font-size: 14px; font-weight: 600; margin: 22px 0 6px; padding-bottom: 3px; border-bottom: 1px solid #ddd; break-after: avoid; page-break-after: avoid; }
  .q { font-size: 10.5px; font-weight: 600; color: #555; margin: 10px 0 2px; break-after: avoid; page-break-after: avoid; }
`
