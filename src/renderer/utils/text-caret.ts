/**
 * Moving a caret through a read-only text with the keyboard, so text can
 * be selected (and coded) without a mouse. Positions are code points;
 * `lineStarts` are where each line begins.
 *
 *  ← →            a character (Alt/Ctrl: a word)
 *  ↑ ↓            a line, keeping the column
 *  Home End       the line's start or end (Cmd/Ctrl: the text's)
 *  Cmd/Ctrl+↑ ↓   the text's start or end
 *  Shift + any    extend the selection instead of moving
 *
 * Returns the caret's new place and the text the move went over (for a
 * screen reader to say), or null for a key that isn't a move.
 */

export interface Caret {
  /** Where the selection started (it stays put while Shift extends it). */
  anchor: number
  /** Where the caret is. */
  focus: number
}

export interface CaretKey {
  key: string
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}

const WORD = /[\p{L}\p{N}_'’]/u

function lineOf(lineStarts: number[], cp: number): number {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid] <= cp) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** The end of line `i` (before its line break). */
function lineEnd(cps: string[], lineStarts: number[], i: number): number {
  const next = i + 1 < lineStarts.length ? lineStarts[i + 1] : cps.length
  return next > lineStarts[i] && cps[next - 1] === '\n' ? next - 1 : next
}

function wordStep(cps: string[], pos: number, dir: 1 | -1): number {
  let p = pos
  if (dir > 0) {
    while (p < cps.length && !WORD.test(cps[p])) p++
    while (p < cps.length && WORD.test(cps[p])) p++
  } else {
    while (p > 0 && !WORD.test(cps[p - 1])) p--
    while (p > 0 && WORD.test(cps[p - 1])) p--
  }
  return p
}

export function moveCaret(
  caret: Caret,
  e: CaretKey,
  cps: string[],
  lineStarts: number[],
  /** In a right-to-left text, ← moves forward. */
  rtl = false
): { caret: Caret; passed: string } | null {
  const mod = e.metaKey || e.ctrlKey
  const word = e.altKey || (e.ctrlKey && !e.metaKey)
  const len = cps.length
  const at = caret.focus
  // A move without Shift from a selection starts at its near end.
  const from = (dir: 1 | -1) => (e.shiftKey || caret.anchor === caret.focus
    ? at
    : dir > 0 ? Math.max(caret.anchor, caret.focus) : Math.min(caret.anchor, caret.focus))
  let to: number
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowLeft': {
      const dir: 1 | -1 = (e.key === 'ArrowRight') !== rtl ? 1 : -1
      const start = from(dir)
      if (!e.shiftKey && caret.anchor !== caret.focus && !word) { to = start; break }
      to = word ? wordStep(cps, start, dir) : Math.min(len, Math.max(0, start + dir))
      break
    }
    case 'ArrowDown':
    case 'ArrowUp': {
      const dir: 1 | -1 = e.key === 'ArrowDown' ? 1 : -1
      if (mod && !e.ctrlKey) { to = dir > 0 ? len : 0; break }
      const start = from(dir)
      const line = lineOf(lineStarts, start)
      const target = line + dir
      if (target < 0) { to = 0; break }
      if (target >= lineStarts.length) { to = len; break }
      const column = start - lineStarts[line]
      to = Math.min(lineStarts[target] + column, lineEnd(cps, lineStarts, target))
      break
    }
    case 'Home':
      to = mod ? 0 : lineStarts[lineOf(lineStarts, at)]
      break
    case 'End':
      to = mod ? len : lineEnd(cps, lineStarts, lineOf(lineStarts, at))
      break
    default:
      return null
  }
  to = Math.min(len, Math.max(0, to))
  const next: Caret = e.shiftKey ? { anchor: caret.anchor, focus: to } : { anchor: to, focus: to }
  // What a screen reader says: the text gone over (a character, a word),
  // or for a line move the line arrived on.
  let passed: string
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const line = lineOf(lineStarts, to)
    passed = cps.slice(lineStarts[line], lineEnd(cps, lineStarts, line)).join('')
  } else {
    passed = cps.slice(Math.min(at, to), Math.max(at, to)).join('')
  }
  return { caret: next, passed }
}
