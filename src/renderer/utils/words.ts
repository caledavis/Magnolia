/**
 * What a word is, for every tool that reads words: text search's whole
 * words, Word Frequencies, Word Combinations and the Word Tree. A word is
 * a run of letters in any script, with their combining marks (accents,
 * Arabic vowel marks), and may hold inner apostrophes ("don't", "zo'n").
 *
 * Scripts written without spaces between words (Chinese, Japanese, Thai)
 * read here as one long word per run; they'll need a dictionary segmenter
 * (Intl.Segmenter) when Magnolia supports them.
 */

/** Regex class contents (use with the u flag) for a word's letters. */
export const LETTER = '\\p{L}\\p{M}'
/** Letters and digits: what joins on to a word, so a word can't start or
 *  end beside one. */
export const WORD_CHAR = '\\p{L}\\p{M}\\p{Nd}'

const WORD_CHAR_RE = new RegExp(`[${WORD_CHAR}']`, 'u')

/** Whether `ch` is outside any word (or is the text's start or end). */
export function isWordBoundary(ch: string | undefined): boolean {
  return !ch || !WORD_CHAR_RE.test(ch)
}

const STRONG_RE = /[\p{L}]/u
const RTL_RE = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Adlam}\p{Script=Samaritan}\p{Script=Mandaic}]/u

/** Whether `text` reads right to left, by its first letter (as the
 *  Unicode bidirectional algorithm picks a paragraph's direction). */
export function isRtlText(text: string): boolean {
  for (const ch of text) if (STRONG_RE.test(ch)) return RTL_RE.test(ch)
  return false
}
