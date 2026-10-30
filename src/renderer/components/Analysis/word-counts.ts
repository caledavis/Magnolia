/**
 * Word counting shared by the word analysis tools (Word Frequencies,
 * Word Combinations) and their report sections, so they always read the
 * same text.
 *
 * Words are counted in one of two kinds of text:
 *   - a document's analysable text (sourceTexts): its content with
 *     formatting syntax stripped, or a survey's open-ended answers; or
 *   - the passages coded with a set of codes (codedPassageTexts).
 */
import type { AnalysisInitData, CodeCondition, PlainTextSelection } from '../../models/types'
import { stripFormatting } from '../../utils/strip-formatting'
import { sourceTypeFromFilename } from '../../utils/format-registry'
import { sentenceRanges } from '../../utils/sentences'

export interface WordFilter {
  exclude: Set<string>
  /** Null counts every word that isn't excluded. */
  include: Set<string> | null
}

/** Parse a comma- or newline-separated word list (the Include / Exclude
 *  words boxes) into a lower-case set. */
export function parseWordList(s: string): Set<string> {
  return new Set((s || '').split(/[,\n]+/).map((w) => w.trim().toLowerCase()).filter(Boolean))
}

export function wordFilter(includeWords: string, excludeWords: string): WordFilter {
  const include = parseWordList(includeWords)
  return { exclude: parseWordList(excludeWords), include: include.size > 0 ? include : null }
}

/** Add the words of `texts` to `freq` (a new map when omitted). */
export function countWords(texts: Iterable<string>, filter: WordFilter, freq = new Map<string, number>()): Map<string, number> {
  for (const text of texts) {
    const words = text.toLowerCase().match(/\b[a-zA-ZÀ-ɏ']+\b/g) || []
    for (const w of words) {
      if (w.length < 2) continue
      if (filter.exclude.has(w)) continue
      if (filter.include && !filter.include.has(w)) continue
      freq.set(w, (freq.get(w) || 0) + 1)
    }
  }
  return freq
}

function sourceTypeOf(d: AnalysisInitData, sourceGuid: string) {
  const src = d.sources.find((s) => s.guid === sourceGuid)
  if (!src) return undefined
  return src.sourceType ?? sourceTypeFromFilename(src.name)
}

/** A source's analysable text. A survey's is its codable (open-ended)
 *  answers, not the raw CSV (which holds headers, metadata and closed
 *  answers); other documents' is their content without formatting
 *  syntax, so only content words are counted. */
export function sourceTexts(d: AnalysisInitData, sourceGuid: string): string[] {
  const st = sourceTypeOf(d, sourceGuid)
  if (st === 'survey') return (d.surveyCodableCells?.[sourceGuid] || []).map((c) => c.text)
  const text = d.sourceContents[sourceGuid]
  if (!text) return []
  return [stripFormatting(text, st)]
}

/** Merge overlapping or touching [start, end) ranges. */
function mergeRanges(ranges: { start: number; end: number }[]): { start: number; end: number }[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const out: { start: number; end: number }[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else out.push({ ...r })
  }
  return out
}

/** A stretch of text and the source it came from. */
export interface SourceText {
  sourceGuid: string
  text: string
}

export interface CodedPassages {
  passages: SourceText[]
  /** Box codings (regions on PDFs and images) among the passages. They
   *  have no text, so they're left out of the count. */
  boxCount: number
}

/** The text of every passage coded with any of `codeGuids` in the given
 *  sources. Passages that overlap (the same text coded twice, or with two
 *  of the codes) are merged first, so each stretch of text is counted
 *  once. Survey passages are read from their cell's text, since their
 *  offsets are cell-relative. */
export function codedPassageTexts(d: AnalysisInitData, sourceGuids: string[], codeGuids: Set<string>): CodedPassages {
  const passages: SourceText[] = []
  let boxCount = 0
  for (const sg of sourceGuids) {
    const sels = (d.sourceSelections[sg] || []).filter((sel) => sel.codings.some((c) => codeGuids.has(c.codeGuid)))
    if (sels.length === 0) continue
    // Ranges grouped by the text they index into: '' for the document,
    // or a survey cell's key.
    const byText = new Map<string, { start: number; end: number }[]>()
    for (const sel of sels) {
      if (sel.pdfRegion) { boxCount++; continue }
      const key = cellKey(sel)
      let arr = byText.get(key)
      if (!arr) { arr = []; byText.set(key, arr) }
      arr.push({ start: sel.startPosition, end: sel.endPosition })
    }
    if (byText.size === 0) continue
    const st = sourceTypeOf(d, sg)
    const cellTexts = new Map<string, string>()
    for (const c of d.surveyCodableCells?.[sg] || []) cellTexts.set(`${c.respondentId}\n${c.questionId}`, c.text)
    for (const [key, ranges] of byText) {
      const base = key ? cellTexts.get(key) : d.sourceContents[sg]
      if (!base) continue
      // Offsets are codepoints: split once per text, not once per passage.
      const cps = Array.from(base)
      for (const r of mergeRanges(ranges)) {
        const passage = cps.slice(r.start, r.end).join('')
        if (passage) passages.push({ sourceGuid: sg, text: key ? passage : stripFormatting(passage, st) })
      }
    }
  }
  return { passages, boxCount }
}

function cellKey(sel: PlainTextSelection): string {
  return sel.surveyCell ? `${sel.surveyCell.respondentId}\n${sel.surveyCell.questionId}` : ''
}

/** Which coded passages a word search is limited to. */
export interface WordQueryCodes {
  codeGuids: string[]
  includeSubcodes: boolean
}

/** The query condition that finds `word` as a whole word, or — with
 *  `codes` — finds it inside passages coded with any of those codes. */
export function wordCondition(word: string, codes?: WordQueryCodes): CodeCondition {
  const text: CodeCondition = { type: 'text', searchText: word, caseSensitive: false, wholeWord: true }
  if (!codes || codes.codeGuids.length === 0) return text
  const codeConds: CodeCondition[] = codes.codeGuids.map((codeGuid) => ({ type: 'code', codeGuid, includeSubcodes: codes.includeSubcodes }))
  return { type: 'inside', condition1: text, condition2: codeConds.length === 1 ? codeConds[0] : { type: 'or', conditions: codeConds } }
}

/** The query condition that finds the sentences containing both words
 *  (each inside the codes' passages, with `codes`). */
export function sentenceCondition(word1: string, word2: string, codes?: WordQueryCodes): CodeCondition {
  return { type: 'sameSentence', condition1: wordCondition(word1, codes), condition2: wordCondition(word2, codes) }
}

/** A code plus, when `withSubcodes`, all of its descendants. */
export function codeSet(codes: AnalysisInitData['codes'], codeGuid: string, withSubcodes: boolean): Set<string> {
  const out = new Set([codeGuid])
  if (!withSubcodes) return out
  // Repeat until no new children turn up, so deeper levels are reached
  // whatever order the flat list is in.
  let grew = true
  while (grew) {
    grew = false
    for (const c of codes) {
      if (c.parentGuid && out.has(c.parentGuid) && !out.has(c.guid)) {
        out.add(c.guid)
        grew = true
      }
    }
  }
  return out
}

// ── Word combinations ──────────────────────────────────────────────
// Phrases and associations read words the way text search does, so a
// phrase found here is found again when the user clicks it: letters
// (with accents) and inner apostrophes, bounded by anything that isn't
// a letter, digit or straight apostrophe (query-engine isWordBoundary).

const LETTER = 'a-z\\u00C0-\\u024F'
const TOKEN = `(?<![${LETTER}'\\d])[${LETTER}]+(?:['\u2019][${LETTER}]+)*(?![${LETTER}'\\d])`
const TOKEN_RE = new RegExp(TOKEN, 'g')
/** Runs of words joined by single spaces. A phrase never spans
 *  punctuation, a line break or a double space, so its text appears
 *  verbatim in the document. */
const RUN_RE = new RegExp(`${TOKEN}(?: ${TOKEN})*`, 'g')

export interface PhraseRow {
  phrase: string
  count: number
}

/** Count the phrases of `length` words in `texts`. A phrase is dropped if
 *  it starts or ends with an excluded word (so "quality of life" stays
 *  but "of the" goes), or — with an include list — if it contains none
 *  of the included words. */
export function countPhrases(texts: Iterable<string>, length: number, filter: WordFilter, minCount: number): PhraseRow[] {
  const counts = new Map<string, number>()
  for (const text of texts) {
    for (const run of text.toLowerCase().match(RUN_RE) || []) {
      const words = run.split(' ')
      for (let i = 0; i + length <= words.length; i++) {
        const gram = words.slice(i, i + length)
        if (filter.exclude.has(gram[0]) || filter.exclude.has(gram[length - 1])) continue
        if (filter.include && !gram.some((w) => filter.include!.has(w))) continue
        const phrase = gram.join(' ')
        counts.set(phrase, (counts.get(phrase) || 0) + 1)
      }
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= minCount)
    .map(([phrase, count]) => ({ phrase, count }))
    .sort((a, b) => b.count - a.count || a.phrase.localeCompare(b.phrase))
}

/** Split text into sentences: at . ! ? and line breaks. */
export function sentencesOf(text: string): string[] {
  return sentenceRanges(text).map((r) => text.slice(r.start, r.end))
}

/** The distinct words of a sentence, lower-cased. */
function sentenceWords(sentence: string): Set<string> {
  return new Set(sentence.toLowerCase().match(TOKEN_RE) || [])
}

export interface AssociationRow {
  word: string
  /** Sentences containing both the focus word and this word. */
  together: number
  /** Log-likelihood (G²) of the two words sharing sentences. */
  g2: number
  /** Share of the focus word's sentences that also contain this word. */
  share: number
}

export interface Associations {
  /** Sentences counted (those with at least one word). */
  sentences: number
  /** Sentences containing the focus word. */
  focusSentences: number
  rows: AssociationRow[]
}

/** G² for a 2×2 table of observed counts. */
function logLikelihood(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d
  const cell = (o: number, rowTotal: number, colTotal: number) => {
    const e = (rowTotal * colTotal) / n
    return o > 0 && e > 0 ? o * Math.log(o / e) : 0
  }
  return 2 * (cell(a, a + b, a + c) + cell(b, a + b, b + d) + cell(c, c + d, a + c) + cell(d, c + d, b + d))
}

/** The words that share sentences with `focus` more often than chance
 *  would explain, strongest first. Each sentence counts once per word
 *  however often the word repeats in it. The focus word is matched even
 *  when it's on the exclude list; the associated words honour the
 *  include and exclude lists and must be at least two letters long. */
export function wordAssociations(texts: Iterable<string>, focus: string, filter: WordFilter, minTogether: number): Associations {
  const target = focus.trim().toLowerCase()
  let sentences = 0
  let focusSentences = 0
  const withWord = new Map<string, number>()
  const together = new Map<string, number>()
  for (const text of texts) {
    for (const sentence of sentencesOf(text)) {
      const words = sentenceWords(sentence)
      if (words.size === 0) continue
      sentences++
      const hasFocus = words.has(target)
      if (hasFocus) focusSentences++
      for (const w of words) {
        if (w === target || w.length < 2 || filter.exclude.has(w)) continue
        if (filter.include && !filter.include.has(w)) continue
        withWord.set(w, (withWord.get(w) || 0) + 1)
        if (hasFocus) together.set(w, (together.get(w) || 0) + 1)
      }
    }
  }
  const rows: AssociationRow[] = []
  for (const [word, a] of together) {
    if (a < minTogether) continue
    const b = focusSentences - a
    const c = withWord.get(word)! - a
    const d = sentences - a - b - c
    // Keep only words that share sentences MORE often than expected.
    if (a * sentences <= focusSentences * (a + c)) continue
    rows.push({ word, together: a, g2: logLikelihood(a, b, c, d), share: a / focusSentences })
  }
  rows.sort((x, y) => y.g2 - x.g2 || y.together - x.together)
  return { sentences, focusSentences, rows }
}
