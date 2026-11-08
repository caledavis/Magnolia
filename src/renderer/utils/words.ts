/**
 * What a word is, for every tool that reads words: text search's whole
 * words, Word Frequencies, Word Combinations and the Word Tree. Words are
 * found by the Unicode word-break rules (Intl.Segmenter), which handle
 * every script alike: letters with their combining marks (accents, Arabic
 * vowel marks), inner apostrophes ("don't", "zo'n"), and, for scripts
 * written without spaces (Chinese, Japanese, Thai), a dictionary that
 * finds where one word ends and the next begins ("我们的学生" → 我们 / 的
 * / 学生).
 */

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' })
const HAS_LETTER = /\p{L}/u
const WORD_CHAR_RE = /[\p{L}\p{M}\p{Nd}']/u
/** Scripts written without spaces between words, where only the
 *  dictionary can say where a word ends. */
const NO_SPACE_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u

export interface WordToken {
  word: string
  start: number
  end: number
}

/** The words of `text` (runs with at least one letter; numbers aren't
 *  words), with their UTF-16 offsets. */
export function wordTokens(text: string): WordToken[] {
  const out: WordToken[] = []
  for (const s of SEGMENTER.segment(text)) {
    if (s.isWordLike && HAS_LETTER.test(s.segment)) out.push({ word: s.segment, start: s.index, end: s.index + s.segment.length })
  }
  return out
}

/** The words of `text` (numbers included) and each punctuation mark on
 *  its own, for the Word Tree, whose branches run on past a comma. */
export function wordAndMarkTokens(text: string): WordToken[] {
  const out: WordToken[] = []
  for (const s of SEGMENTER.segment(text)) {
    if (s.isWordLike) {
      out.push({ word: s.segment, start: s.index, end: s.index + s.segment.length })
      continue
    }
    let i = s.index
    for (const ch of s.segment) {
      if (!/\s/u.test(ch)) out.push({ word: ch, start: i, end: i + ch.length })
      i += ch.length
    }
  }
  return out
}

/** Whether `ch` is outside any word (or is the text's start or end). */
export function isWordBoundary(ch: string | undefined): boolean {
  return !ch || !WORD_CHAR_RE.test(ch)
}

const edgeCache = new Map<string, Set<number>>()

/** Where the words of `text` start and end, by the word-break rules.
 *  Kept for the last few texts, since a search asks about one text many
 *  times. */
function segmentEdges(text: string): Set<number> {
  let edges = edgeCache.get(text)
  if (!edges) {
    edges = new Set([0, text.length])
    for (const s of SEGMENTER.segment(text)) {
      edges.add(s.index)
      edges.add(s.index + s.segment.length)
    }
    if (edgeCache.size >= 8) edgeCache.delete(edgeCache.keys().next().value!)
    edgeCache.set(text, edges)
  }
  return edges
}

/** Whether a word can start or end at UTF-16 offset `index` of `text`:
 *  beside a space or punctuation, or, between letters of a script
 *  written without spaces, where the dictionary puts a word break. */
export function isWordEdge(text: string, index: number): boolean {
  const before = index > 0 ? text[index - 1] : undefined
  const after = index < text.length ? text[index] : undefined
  if (isWordBoundary(before) || isWordBoundary(after)) return true
  if (!NO_SPACE_RE.test(before!) && !NO_SPACE_RE.test(after!)) return false
  return segmentEdges(text).has(index)
}

const STRONG_RE = /[\p{L}]/u
const RTL_RE = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Adlam}\p{Script=Samaritan}\p{Script=Mandaic}]/u

/** Whether `text` reads right to left, by its first letter (as the
 *  Unicode bidirectional algorithm picks a paragraph's direction). */
export function isRtlText(text: string): boolean {
  for (const ch of text) if (STRONG_RE.test(ch)) return RTL_RE.test(ch)
  return false
}
