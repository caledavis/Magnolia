/**
 * Unicode codepoint utilities.
 * The REFI-QDA standard requires text positions as Unicode codepoint offsets (0-indexed).
 * JavaScript strings use UTF-16 code units, so characters outside the BMP
 * (e.g. emoji, some CJK) take 2 code units but count as 1 codepoint.
 */

/** Returns the number of Unicode codepoints in a string */
export function codepointLength(text: string): number {
  return [...text].length
}

/** Extracts a substring by codepoint positions (0-indexed, exclusive end) */
export function codepointSlice(text: string, start: number, end: number): string {
  return [...text].slice(start, end).join('')
}

/**
 * Converts a codepoint position to a JavaScript string character index.
 * Needed because JS string indices count UTF-16 code units.
 */
export function codepointToCharIndex(text: string, codepointPos: number): number {
  const codepoints = [...text]
  let charIndex = 0
  for (let i = 0; i < codepointPos && i < codepoints.length; i++) {
    charIndex += codepoints[i].length // .length in JS gives code units
  }
  return charIndex
}

/**
 * Number of codepoints in text.slice(from, to), without copying it —
 * each surrogate pair counts once.
 */
export function codepointCount(text: string, from: number, to: number): number {
  let n = 0
  for (let i = from; i < to; i++) {
    const c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < to) {
      const d = text.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) i++
    }
    n++
  }
  return n
}

/**
 * Converts a JavaScript character index to a codepoint position.
 */
export function charIndexToCodepoint(text: string, charIndex: number): number {
  let cpCount = 0
  let ci = 0
  for (const cp of text) {
    if (ci >= charIndex) break
    ci += cp.length
    cpCount++
  }
  return cpCount
}

/**
 * Get context around a selection: up to `chars` codepoints before and after.
 */
export function getContext(
  text: string,
  start: number,
  end: number,
  chars: number = 120
): { before: string; after: string } {
  const codepoints = [...text]
  const beforeStart = Math.max(0, start - chars)
  const afterEnd = Math.min(codepoints.length, end + chars)
  return {
    before: codepoints.slice(beforeStart, start).join(''),
    after: codepoints.slice(end, afterEnd).join('')
  }
}
