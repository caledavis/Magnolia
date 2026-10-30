/**
 * Sentence boundaries, shared by the word analysis tools and the query
 * engine's Same Sentence operator so both agree on what a sentence is: a
 * sentence ends at . ! or ? followed by whitespace, or at a line break.
 * Whitespace around a sentence isn't part of it.
 */

const BREAK_RE = /(?<=[.!?])\s+|\n+/g

/** Each sentence's [start, end) as UTF-16 offsets. */
export function sentenceRanges(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  const push = (start: number, end: number) => {
    while (start < end && /\s/.test(text[start])) start++
    while (end > start && /\s/.test(text[end - 1])) end--
    if (end > start) out.push({ start, end })
  }
  let from = 0
  for (const m of text.matchAll(BREAK_RE)) {
    push(from, m.index!)
    from = m.index! + m[0].length
  }
  push(from, text.length)
  return out
}

/** Each sentence's [start, end) as codepoint offsets, the units selections
 *  use. */
export function sentenceSpans(text: string): { start: number; end: number }[] {
  let cp = 0
  let at = 0
  const toCp = (i: number) => {
    for (; at < i; at++) {
      const c = text.charCodeAt(at)
      // A high surrogate and its low surrogate are one codepoint.
      if (c < 0xdc00 || c > 0xdfff) cp++
    }
    return cp
  }
  return sentenceRanges(text).map((r) => ({ start: toCp(r.start), end: toCp(r.end) }))
}
