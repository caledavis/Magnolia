/**
 * Inter-coder Agreement — the pure model. Matches documents and codes
 * across two or more coders' projects, pulls each coder's coded segments
 * out of them, and computes both measures:
 *
 *  - Characters (NVivo-style): every unit of a document — a character of
 *    text, a millisecond of audio/video, a point² of a PDF page or a
 *    pixel of an image — is coded or not by each coder. Per code and
 *    document that gives a 2×2 table per pair of coders, from which come
 *    % agreement and Cohen's kappa, and (3+ coders) Krippendorff's alpha
 *    across everyone.
 *  - Segments (MAXQDA-style): each coded segment either is or isn't
 *    matched by a segment of the same code from the other coder that
 *    overlaps it by at least the threshold (intersection ÷ union).
 *    % agreement = matched segments ÷ all segments, and over all codes
 *    Brennan & Prediger's kappa with chance = 1 ÷ number of codes.
 *
 * A document can hold up to three kinds of unit ("channels") that can't
 * be added to one another: text (incl. survey cells and transcripts),
 * time ranges, and regions. Counts are kept per channel in its own units.
 * A code is compared only in the channels it was applied in; its total
 * over documents pools the units (every character counts once, wherever
 * it is), and when a code spans more than one channel the channels'
 * proportions are averaged. "All codes" is de Vries et al.'s (2008)
 * pooled kappa — the mean observed and mean chance agreement over codes —
 * and likewise for alpha with the mean observed and expected
 * disagreement.
 *
 * No store or React imports, so it runs headless in tests and reports.
 */
import type { Code, TextSource, PlainTextSelection, SurveyFormatData } from '../../../models/types'
import { buildCellText } from '../../../utils/survey/cell-text'
import { codepointLength } from '../../../utils/unicode'

// ── Inputs ────────────────────────────────────────────────────────────

/** One coder's project, as loaded from a .qdpx (or the open project). */
export interface CoderProject {
  /** Stable id within the analysis: the file path, or OPEN_PROJECT_ID. */
  id: string
  /** Who coded it: the last editor's name if the file records one, else
   *  the file name. */
  label: string
  fileName: string
  /** null for the open project. */
  filePath: string | null
  codes: Code[]
  sources: TextSource[]
  sourceContents: Record<string, string>
}

export const OPEN_PROJECT_ID = 'open'

export type Channel = 'text' | 'time' | 'region'
export type Measure = 'characters' | 'segments'

// ── Matching ──────────────────────────────────────────────────────────

export interface MatchedDoc {
  /** The first guid seen for the document. */
  key: string
  name: string
  sourceType?: string
  /** projectId → that project's guid for the document. */
  members: Record<string, string>
  /** The document's text isn't the same in every project, so text
   *  positions can't be compared (time ranges and regions still can). */
  textDiffers: boolean
}

export interface MatchedCode {
  key: string
  name: string
  /** "Parent > Child" — what name-matching compares. */
  path: string
  color?: string
  depth: number
  members: Record<string, string>
}

const typeOf = (s: { sourceType?: string }): string => s.sourceType ?? 'text'

/** Match documents by guid, then by name and type — the same document
 *  imported separately into each project gets a new guid each time. */
export function matchDocuments(projects: CoderProject[]): MatchedDoc[] {
  const docs: MatchedDoc[] = []
  const byGuid = new Map<string, MatchedDoc>()
  for (const p of projects) {
    for (const s of p.sources) {
      let d = byGuid.get(s.guid)
      if (d && d.members[p.id]) d = undefined
      if (!d) d = docs.find((x) => !x.members[p.id] && x.name === s.name && (x.sourceType ?? 'text') === typeOf(s))
      if (!d) {
        d = { key: s.guid, name: s.name, sourceType: s.sourceType, members: {}, textDiffers: false }
        docs.push(d)
      }
      d.members[p.id] = s.guid
      byGuid.set(s.guid, d)
    }
  }
  const projectById = new Map(projects.map((p) => [p.id, p]))
  for (const d of docs) {
    const texts = new Set<string>()
    for (const [pid, guid] of Object.entries(d.members)) {
      const p = projectById.get(pid)!
      const s = p.sources.find((x) => x.guid === guid)
      if (s) texts.add(comparableText(p, s))
    }
    d.textDiffers = texts.size > 1
  }
  return docs
}

/** The text that positions index into: the codable survey cells, or the
 *  document text (a PDF's text layer, a transcript). */
function comparableText(p: CoderProject, s: TextSource): string {
  if (s.sourceType === 'survey') return JSON.stringify(surveyCells(s))
  return p.sourceContents[s.guid] ?? ''
}

interface FlatCode { code: Code; depth: number; path: string }

function flattenCodes(codes: Code[], depth = 0, prefix = ''): FlatCode[] {
  const out: FlatCode[] = []
  for (const c of codes) {
    const path = prefix ? `${prefix} > ${c.name}` : c.name
    out.push({ code: c, depth, path })
    out.push(...flattenCodes(c.children ?? [], depth + 1, path))
  }
  return out
}

/** Match codes by guid, then by their path of names. Ordered by the first
 *  project's tree, with codes only later projects have appended. */
export function matchCodes(projects: CoderProject[]): MatchedCode[] {
  const codes: MatchedCode[] = []
  const byGuid = new Map<string, MatchedCode>()
  for (const p of projects) {
    for (const f of flattenCodes(p.codes)) {
      let m = byGuid.get(f.code.guid)
      if (m && m.members[p.id]) m = undefined
      if (!m) m = codes.find((x) => !x.members[p.id] && x.path === f.path)
      if (!m) {
        m = { key: f.code.guid, name: f.code.name, path: f.path, color: f.code.color, depth: f.depth, members: {} }
        codes.push(m)
      }
      m.members[p.id] = f.code.guid
      byGuid.set(f.code.guid, m)
    }
  }
  return codes
}

// ── Segments ──────────────────────────────────────────────────────────

/** One coded segment. `line` separates units that never overlap: a
 *  survey cell ('cell:<respondent>:<question>'), a page ('p<n>'), or ''
 *  for a document's one text or timeline. Intervals are [start, end) in
 *  code points or milliseconds; regions are boxes. */
export type Segment =
  | { ch: 'text' | 'time'; line: string; start: number; end: number; asTime?: { start: number; end: number } }
  | { ch: 'region'; line: string; x: number; y: number; w: number; h: number }

/** What a document's codings are read against: its text (a transcript,
 *  for audio / video) and, for a transcript, its per-line start times. */
export interface SegmentContext {
  text: string
  lineTimes?: Record<string, number>
}

/** Code-point offset of the start of each line, plus the total. */
function lineOffsets(text: string): number[] {
  const out = [0]
  let cp = 0
  for (const line of text.split('\n')) {
    cp += codepointLength(line) + 1
    out.push(cp)
  }
  return out
}

function lineForChar(offsets: number[], cp: number): number {
  let n = 0
  for (let i = 0; i < offsets.length - 1 && cp >= offsets[i]; i++) n = i
  return n
}

/** The time range a project load gives a coded transcript span — the start
 *  line's time to the following line's time. Mirrors
 *  derive_line_time_range in magnolia-core (qdpx/transcript_refi.rs). */
export function derivedTranscriptTime(text: string, start: number, end: number, lineTimes: Record<string, number>): { startTime: number; endTime: number } | null {
  const offsets = lineOffsets(text)
  const startLine = lineForChar(offsets, start)
  const endLine = lineForChar(offsets, Math.max(end - 1, start))
  const at = (line: number): number | undefined => {
    const v = lineTimes[String(line)]
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
  }
  const startTime = at(startLine)
  if (startTime === undefined) return null
  const endTime = at(endLine + 1) ?? at(endLine) ?? startTime
  return { startTime, endTime: Math.max(endTime, startTime) }
}

/**
 * A selection as a segment. Audio / video codings come in two kinds:
 *  - made on the transcript's text: character offsets. A video's gain a
 *    time range when the project is loaded, derived from those offsets
 *    (whole lines), so they're recognised by that range matching what
 *    the offsets derive — and compared by their text.
 *  - made on the timeline: a time range of its own, with the covered
 *    transcript lines' offsets in startPosition / endPosition. Compared
 *    by time.
 */
export function segmentOf(sel: PlainTextSelection, ctx?: SegmentContext): Segment | null {
  if (sel.timeRange && !isTranscriptTextCoding(sel, ctx)) {
    const start = Math.round(sel.timeRange.startTime * 1000)
    const end = Math.round(sel.timeRange.endTime * 1000)
    return end > start ? { ch: 'time', line: '', start, end } : null
  }
  if (sel.pdfRegion) {
    const r = sel.pdfRegion
    return r.width > 0 && r.height > 0 ? { ch: 'region', line: `p${r.page}`, x: r.x, y: r.y, w: r.width, h: r.height } : null
  }
  if (sel.endPosition <= sel.startPosition) return null
  const line = sel.surveyCell ? `cell:${sel.surveyCell.respondentId}:${sel.surveyCell.questionId}` : ''
  return { ch: 'text', line, start: sel.startPosition, end: sel.endPosition }
}

function isTranscriptTextCoding(sel: PlainTextSelection, ctx?: SegmentContext): boolean {
  if (!sel.timeRange || !ctx?.lineTimes || !ctx.text || sel.endPosition <= sel.startPosition) return false
  const d = derivedTranscriptTime(ctx.text, sel.startPosition, sel.endPosition, ctx.lineTimes)
  return !!d && Math.abs(d.startTime - sel.timeRange.startTime) < 5e-4 && Math.abs(d.endTime - sel.timeRange.endTime) < 5e-4
}

/** A coder's segments of one code in one document. A coder who lacks the
 *  document or the code has coded nothing there. */
export function segmentsFor(p: CoderProject, doc: MatchedDoc, code: MatchedCode): Segment[] {
  const sourceGuid = doc.members[p.id]
  const codeGuid = code.members[p.id]
  if (!sourceGuid || !codeGuid) return []
  const s = sourceIndex(p).get(sourceGuid)
  if (!s) return []
  const ctx: SegmentContext = {
    text: p.sourceContents[s.guid] ?? '',
    lineTimes: (s.formatData as { lineTimes?: Record<string, number> } | undefined)?.lineTimes
  }
  const isRecording = s.sourceType === 'audio' || s.sourceType === 'video'
  const duration = (s.formatData as { duration?: number } | undefined)?.duration
  const out: Segment[] = []
  for (const sel of selectionsByCode(s).get(codeGuid) ?? []) {
    const seg = segmentOf(sel, ctx)
    if (!seg) continue
    if (seg.ch === 'text' && doc.textDiffers) continue
    if (seg.ch === 'text' && isRecording && ctx.lineTimes) {
      const asTime = transcriptTime(ctx.text, seg.start, seg.end, ctx.lineTimes, duration)
      if (asTime) seg.asTime = asTime
    }
    out.push(seg)
  }
  return out
}

/** A transcript span's time in ms — its lines' times, the last line
 *  running to the end of the recording. null when it can't be placed. */
function transcriptTime(text: string, start: number, end: number, lineTimes: Record<string, number>, duration?: number): { start: number; end: number } | null {
  const d = derivedTranscriptTime(text, start, end, lineTimes)
  if (!d) return null
  let endTime = d.endTime
  if (endTime <= d.startTime && duration && duration > d.startTime) endTime = duration
  const out = { start: Math.round(d.startTime * 1000), end: Math.round(endTime * 1000) }
  return out.end > out.start ? out : null
}

/**
 * Every coder's segments of one code in one document, made comparable.
 * Where coders coded a recording both on its transcript and on its
 * timeline, the transcript codings are compared by time (their lines'
 * times) — otherwise the same moment coded the two ways would count as
 * two disagreements. Where everyone coded the transcript, it stays
 * character by character.
 */
export function codeSegments(projects: CoderProject[], doc: MatchedDoc, code: MatchedCode): Segment[][] {
  const per = projects.map((p) => segmentsFor(p, doc, code))
  const all = per.flat()
  if (!all.some((s) => s.ch === 'time') || !all.some((s) => s.ch === 'text' && s.asTime)) return per
  return per.map((segs) => segs.map((s) => (s.ch === 'text' && s.asTime ? { ch: 'time', line: '', start: s.asTime.start, end: s.asTime.end } : s)))
}

// Lookups built once per project / document (weakly held, so a reloaded
// project gets fresh ones).
const sourceIndexes = new WeakMap<TextSource[], Map<string, TextSource>>()
const codeIndexes = new WeakMap<PlainTextSelection[], Map<string, PlainTextSelection[]>>()

function sourceIndex(p: CoderProject): Map<string, TextSource> {
  let m = sourceIndexes.get(p.sources)
  if (!m) sourceIndexes.set(p.sources, (m = new Map(p.sources.map((s) => [s.guid, s]))))
  return m
}

function selectionsByCode(s: TextSource): Map<string, PlainTextSelection[]> {
  let m = codeIndexes.get(s.selections)
  if (!m) {
    m = new Map()
    for (const sel of s.selections) {
      for (const c of sel.codings) {
        let arr = m.get(c.codeGuid)
        if (!arr) m.set(c.codeGuid, (arr = []))
        if (!arr.includes(sel)) arr.push(sel)
      }
    }
    codeIndexes.set(s.selections, m)
  }
  return m
}

/** Every codable survey cell, keyed as segment lines are. */
export function surveyCells(s: TextSource): Record<string, string> {
  const survey = (s.formatData as SurveyFormatData | undefined)?.survey
  const out: Record<string, string> = {}
  if (!survey) return out
  const openEnded = survey.questions.filter((q) => q.type === 'open-ended')
  for (const r of survey.respondents) {
    for (const q of openEnded) {
      const text = buildCellText(r.answers[q.id])
      if (text) out[`cell:${r.id}:${q.id}`] = text
    }
  }
  return out
}

// ── Extents ───────────────────────────────────────────────────────────

/** How many units each line of a document holds, per channel. Region
 *  extents (page areas) need the file itself, so they come from
 *  loadRegionExtents and may be missing. */
export interface DocExtents {
  text?: Record<string, number>
  time?: number
  /** page line ('p<n>') → area, for every page. */
  region?: Record<string, number>
}

export function syncExtents(p: CoderProject, doc: MatchedDoc): DocExtents {
  const s = p.sources.find((x) => x.guid === doc.members[p.id])
  if (!s) return {}
  const out: DocExtents = {}
  if (s.sourceType === 'survey') {
    out.text = Object.fromEntries(Object.entries(surveyCells(s)).map(([k, v]) => [k, codepointLength(v)]))
  } else {
    out.text = { '': codepointLength(p.sourceContents[s.guid] ?? '') }
  }
  const duration = (s.formatData as { duration?: number } | undefined)?.duration
  if ((s.sourceType === 'audio' || s.sourceType === 'video') && duration) out.time = Math.round(duration * 1000)
  return out
}

/** The channel a document is coded in when nobody has coded it at all. */
function defaultChannel(doc: MatchedDoc): Channel {
  switch (doc.sourceType) {
    case 'audio':
    case 'video':
      return 'time'
    case 'image':
      return 'region'
    default:
      return 'text'
  }
}

// ── Coverage ──────────────────────────────────────────────────────────

/** A piece of a line covered by exactly the coders in `mask` (bit i =
 *  coder i), with its size in the line's units. */
interface Piece { weight: number; mask: number }

function intervalCoverage(byCoder: Segment[][]): Piece[] {
  const edges: { at: number; coder: number; delta: number }[] = []
  byCoder.forEach((segs, i) => {
    for (const s of segs) {
      if (s.ch === 'region') continue
      edges.push({ at: s.start, coder: i, delta: 1 }, { at: s.end, coder: i, delta: -1 })
    }
  })
  edges.sort((a, b) => a.at - b.at)
  const depth = new Array(byCoder.length).fill(0)
  const out: Piece[] = []
  let prev = 0
  for (let k = 0; k < edges.length; ) {
    const at = edges[k].at
    if (k > 0 && at > prev) {
      let mask = 0
      depth.forEach((d, i) => { if (d > 0) mask |= 1 << i })
      if (mask) out.push({ weight: at - prev, mask })
    }
    while (k < edges.length && edges[k].at === at) {
      depth[edges[k].coder] += edges[k].delta
      k++
    }
    prev = at
  }
  return out
}

function regionCoverage(byCoder: Segment[][]): Piece[] {
  const rects: { x0: number; y0: number; x1: number; y1: number; coder: number }[] = []
  byCoder.forEach((segs, i) => {
    for (const s of segs) if (s.ch === 'region') rects.push({ x0: s.x, y0: s.y, x1: s.x + s.w, y1: s.y + s.h, coder: i })
  })
  const xs = [...new Set(rects.flatMap((r) => [r.x0, r.x1]))].sort((a, b) => a - b)
  const ys = [...new Set(rects.flatMap((r) => [r.y0, r.y1]))].sort((a, b) => a - b)
  const byMask = new Map<number, number>()
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2
      const cy = (ys[j] + ys[j + 1]) / 2
      let mask = 0
      for (const r of rects) if (cx > r.x0 && cx < r.x1 && cy > r.y0 && cy < r.y1) mask |= 1 << r.coder
      if (mask) byMask.set(mask, (byMask.get(mask) ?? 0) + (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]))
    }
  }
  return [...byMask].map(([mask, weight]) => ({ mask, weight }))
}

function groupByLine(segs: Segment[]): Map<string, Segment[]> {
  const m = new Map<string, Segment[]>()
  for (const s of segs) {
    const k = `${s.ch}\u0000${s.line}`
    let arr = m.get(k)
    if (!arr) m.set(k, (arr = []))
    arr.push(s)
  }
  return m
}

// ── Statistics ────────────────────────────────────────────────────────

/** A pair's 2×2 table as proportions: both coded, only the first, only
 *  the second, neither. */
export interface PairTable { a: number; b: number; c: number; d: number }

/** Krippendorff's coincidences (binary, nominal) in units: o01 = the
 *  coded/uncoded coincidences, n0 / n1 = pairable uncoded / coded values. */
export interface AlphaTable { o01: number; n0: number; n1: number }

export function percentAgreement(t: PairTable): number | null {
  const n = t.a + t.b + t.c + t.d
  return n > 0 ? (t.a + t.d) / n : null
}

/** Cohen's kappa. null when it's undefined — chance agreement is total,
 *  as when neither coder applied the code at all. */
export function cohensKappa(t: PairTable): number | null {
  const n = t.a + t.b + t.c + t.d
  if (n <= 0) return null
  const po = (t.a + t.d) / n
  const pe = ((t.a + t.b) * (t.a + t.c) + (t.c + t.d) * (t.b + t.d)) / (n * n)
  if (pe >= 1 - 1e-12) return null
  return (po - pe) / (1 - pe)
}

/** Krippendorff's alpha, binary nominal: 1 − (n − 1)·o01 ÷ (n0·n1).
 *  null when nobody — or everybody — coded everything. */
export function krippendorffAlpha(t: AlphaTable): number | null {
  const n = t.n0 + t.n1
  if (n <= 1 || t.n0 <= 1e-12 || t.n1 <= 1e-12) return null
  return 1 - ((n - 1) * t.o01) / (t.n0 * t.n1)
}

/** Observed and chance agreement of a pair's table. */
export function agreementParts(t: PairTable): { po: number; pe: number } | null {
  const n = t.a + t.b + t.c + t.d
  if (n <= 0) return null
  return {
    po: (t.a + t.d) / n,
    pe: ((t.a + t.b) * (t.a + t.c) + (t.c + t.d) * (t.b + t.d)) / (n * n)
  }
}

/** Observed and expected disagreement of an alpha table. */
export function disagreementParts(t: AlphaTable): { do: number; de: number } | null {
  const n = t.n0 + t.n1
  if (n <= 1) return null
  return { do: (2 * t.o01) / n, de: (2 * t.n0 * t.n1) / (n * (n - 1)) }
}

/** De Vries et al.'s (2008) pooled kappa: (mean po − mean pe) ÷ (1 − mean pe). */
export function pooledKappa(p: { po: number; pe: number }): number | null {
  return p.pe >= 1 - 1e-12 ? null : (p.po - p.pe) / (1 - p.pe)
}

/** Alpha pooled the same way: 1 − mean Do ÷ mean De. */
export function pooledAlpha(p: { do: number; de: number }): number | null {
  return p.de <= 1e-12 ? null : 1 - p.do / p.de
}

export interface SegmentCount { agree: number; total: number }

export function segmentAgreement(s: SegmentCount): number | null {
  return s.total > 0 ? s.agree / s.total : null
}

/** Brennan & Prediger's kappa over all codes: chance = 1 / codes. */
export function brennanPredigerKappa(s: SegmentCount, codeCount: number): number | null {
  if (codeCount < 2 || s.total === 0) return null
  const po = s.agree / s.total
  const pc = 1 / codeCount
  return (po - pc) / (1 - pc)
}

// ── Results ───────────────────────────────────────────────────────────

/** Counts in one channel's own units. */
export interface ChannelCounts {
  pairs: (PairTable | null)[]
  alpha: AlphaTable | null
  /** Per coder (3+ coders): alpha over everyone else. */
  alphaWithout?: (AlphaTable | null)[]
}

export interface CellResult {
  /** Per channel, in its units (code points, ms, point² or px²). */
  units: Partial<Record<Channel, ChannelCounts>>
  /** Per pair, in the order of `pairs`: the channel's table, or with more
   *  than one channel the mean of their proportions. null where the pair
   *  can't be compared (one of them lacks the document). */
  chars: (PairTable | null)[]
  alpha: AlphaTable | null
  /** Per coder (3+ coders): the alpha table with that coder left out —
   *  "alpha without this coder". null where fewer than two others
   *  have the document. */
  alphaWithout?: (AlphaTable | null)[]
  segs: (SegmentCount | null)[]
  /** "All codes" only: mean observed / chance agreement over codes per
   *  pair, and mean observed / expected disagreement — the pooled
   *  kappa and alpha. */
  pooled?: ({ po: number; pe: number } | null)[]
  pooledAlpha?: { do: number; de: number } | null
  pooledAlphaWithout?: ({ do: number; de: number } | null)[]
}

export interface AgreementResults {
  coders: { id: string; label: string }[]
  pairs: [number, number][]
  codeKeys: string[]
  docKeys: string[]
  /** codeKey → docKey → cell. */
  cells: Record<string, Record<string, CellResult>>
  /** codeKey → totals over documents. */
  codeTotals: Record<string, CellResult>
  overall: CellResult
  /** Documents left out: text differs and nothing else to compare, or
   *  in fewer than two projects. */
  skippedDocs: { key: string; reason: 'textDiffers' | 'singleProject' }[]
  /** Documents whose region extents weren't available, so their page
   *  area was estimated from the regions coded on it. */
  approxDocs: string[]
  threshold: number
}

export function pairsOf(n: number): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out.push([i, j])
  return out
}

/** IoU of two segments on the same line. */
export function overlapRatio(s: Segment, t: Segment): number {
  if (s.ch === 'region' && t.ch === 'region') {
    const ix = Math.max(0, Math.min(s.x + s.w, t.x + t.w) - Math.max(s.x, t.x))
    const iy = Math.max(0, Math.min(s.y + s.h, t.y + t.h) - Math.max(s.y, t.y))
    const inter = ix * iy
    const union = s.w * s.h + t.w * t.h - inter
    return union > 0 ? inter / union : 0
  }
  if (s.ch !== 'region' && t.ch !== 'region') {
    const inter = Math.max(0, Math.min(s.end, t.end) - Math.max(s.start, t.start))
    const union = s.end - s.start + (t.end - t.start) - inter
    return union > 0 ? inter / union : 0
  }
  return 0
}

export function segmentsMatch(s: Segment, t: Segment, threshold: number): boolean {
  return s.ch === t.ch && s.line === t.line && overlapRatio(s, t) >= threshold - 1e-9
}

function countSegments(a: Segment[], b: Segment[], threshold: number): SegmentCount {
  let agree = 0
  for (const s of a) if (b.some((t) => segmentsMatch(s, t, threshold))) agree++
  for (const t of b) if (a.some((s) => segmentsMatch(t, s, threshold))) agree++
  return { agree, total: a.length + b.length }
}

/** Extent of a channel line (0 when it holds nothing codable). */
function lineExtent(ext: DocExtents, ch: Channel, line: string): number {
  if (ch === 'text') return ext.text?.[line] ?? 0
  if (ch === 'time') return ext.time ?? 0
  return ext.region?.[line] ?? 0
}

function channelExtentTotal(ext: DocExtents, ch: Channel): number {
  if (ch === 'text') return Object.values(ext.text ?? {}).reduce((x, y) => x + y, 0)
  if (ch === 'time') return ext.time ?? 0
  return Object.values(ext.region ?? {}).reduce((x, y) => x + y, 0)
}

/** Fills in what the files couldn't tell: a recording's length (from the
 *  latest moment anyone coded) and the area of a page or image (from the
 *  furthest corner anyone coded on it), over every coder and chosen code,
 *  so the document is the same size for every code. `estimated` says
 *  whether anything was. */
function completeExtents(ext: DocExtents, all: Segment[]): { ext: DocExtents; estimated: boolean } {
  let estimated = false
  const out: DocExtents = { ...ext, region: ext.region ? { ...ext.region } : undefined }
  const timeEnds = all.flatMap((s) => (s.ch === 'time' ? [s.end] : []))
  if (timeEnds.length > 0 && !((out.time ?? 0) > 0)) {
    out.time = Math.max(...timeEnds)
    estimated = true
  }
  const corners = new Map<string, { w: number; h: number }>()
  for (const s of all) {
    if (s.ch !== 'region' || out.region?.[s.line]) continue
    const c = corners.get(s.line) ?? { w: 0, h: 0 }
    corners.set(s.line, { w: Math.max(c.w, s.x + s.w), h: Math.max(c.h, s.y + s.h) })
  }
  if (corners.size > 0) {
    out.region = { ...(out.region ?? {}) }
    for (const [line, c] of corners) out.region[line] = c.w * c.h
    estimated = true
  }
  return { ext: out, estimated }
}

function clipIntervals(segs: Segment[], extent: number): Segment[] {
  const out: Segment[] = []
  for (const s of segs) {
    if (s.ch === 'region') { out.push(s); continue }
    const start = Math.max(0, s.start)
    const end = Math.min(extent, s.end)
    if (end > start) out.push({ ...s, start, end })
  }
  return out
}

const zeroPair = (): PairTable => ({ a: 0, b: 0, c: 0, d: 0 })
const zeroAlpha = (): AlphaTable => ({ o01: 0, n0: 0, n1: 0 })

function addPair(into: PairTable, t: PairTable, scale = 1): void {
  into.a += t.a * scale; into.b += t.b * scale; into.c += t.c * scale; into.d += t.d * scale
}
function addAlpha(into: AlphaTable, t: AlphaTable, scale = 1): void {
  into.o01 += t.o01 * scale; into.n0 += t.n0 * scale; into.n1 += t.n1 * scale
}

function popcount(m: number): number {
  let n = 0
  while (m) { n += m & 1; m >>>= 1 }
  return n
}

/** A piece's coincidences among the m coders in `mask`. */
function addCoincidences(t: AlphaTable, pc: Piece, mask: number, m: number): void {
  const k = popcount(pc.mask & mask)
  t.o01 += (pc.weight * k * (m - k)) / (m - 1)
  t.n1 += pc.weight * k
  t.n0 += pc.weight * (m - k)
}

/** What nobody coded: the rest of the channel's units, uncoded by all m. */
function addUncoded(t: AlphaTable, total: number, m: number): void {
  t.n0 += Math.max(0, total * m - (t.n1 + t.n0))
}

/**
 * One code in one document: the character tables (per channel, as
 * proportions, averaged over the channels in use) and the segment counts.
 * `present` = indices of the coders whose project has the document.
 */
function computeCell(
  segsByCoder: Segment[][],
  present: number[],
  pairs: [number, number][],
  channels: Channel[],
  ext: DocExtents,
  threshold: number,
  withAlpha: boolean
): CellResult {
  const m = present.length
  let presentMask = 0
  for (const i of present) presentMask |= 1 << i
  const units: CellResult['units'] = {}

  for (const ch of channels) {
    const total = channelExtentTotal(ext, ch)
    if (total <= 0) continue
    const lines = new Map<string, Segment[][]>()
    segsByCoder.forEach((segs, i) => {
      for (const [k, arr] of groupByLine(segs.filter((s) => s.ch === ch))) {
        const line = k.slice(k.indexOf('\u0000') + 1)
        let per = lines.get(line)
        if (!per) lines.set(line, (per = segsByCoder.map(() => [])))
        per[i].push(...arr)
      }
    })
    const chPairs: (PairTable | null)[] = pairs.map(([i, j]) => (present.includes(i) && present.includes(j) ? zeroPair() : null))
    const chAlpha = withAlpha && m >= 2 ? zeroAlpha() : null
    // The same with each coder left out in turn (of those who have the
    // document; two or more must remain).
    const without = withAlpha ? segsByCoder.map((_, k) => {
      const mask = presentMask & ~(1 << k)
      const mk = popcount(mask)
      return mk >= 2 ? { mask, m: mk, t: zeroAlpha() } : null
    }) : null
    for (const [line, raw] of lines) {
      // A coding can't cover more than the document holds (one past the
      // end of a trimmed text, a recording's last frame, a cell with no
      // codable text).
      const per = ch === 'region' ? raw : raw.map((segs) => clipIntervals(segs, lineExtent(ext, ch, line)))
      const pieces = ch === 'region' ? regionCoverage(per) : intervalCoverage(per)
      pairs.forEach(([i, j], p) => {
        const t = chPairs[p]
        if (!t) return
        const bi = 1 << i
        const bj = 1 << j
        for (const pc of pieces) {
          const hi = (pc.mask & bi) !== 0
          const hj = (pc.mask & bj) !== 0
          if (hi && hj) t.a += pc.weight
          else if (hi) t.b += pc.weight
          else if (hj) t.c += pc.weight
        }
      })
      if (chAlpha) for (const pc of pieces) addCoincidences(chAlpha, pc, presentMask, m)
      if (without) for (const w of without) if (w) for (const pc of pieces) addCoincidences(w.t, pc, w.mask, w.m)
    }
    for (const t of chPairs) {
      // Regions can reach past a page's edge (an estimated or cropped
      // page); clamp rather than go negative.
      if (t) t.d = Math.max(0, total - t.a - t.b - t.c)
    }
    if (chAlpha) addUncoded(chAlpha, total, m)
    if (without) for (const w of without) if (w) addUncoded(w.t, total, w.m)
    units[ch] = { pairs: chPairs, alpha: chAlpha, ...(without ? { alphaWithout: without.map((w) => w?.t ?? null) } : {}) }
  }

  const segs: (SegmentCount | null)[] = pairs.map(([i, j]) =>
    present.includes(i) && present.includes(j) ? countSegments(segsByCoder[i], segsByCoder[j], threshold) : null
  )
  return { units, ...combineChannels(units, pairs.length), segs }
}

/** One table per pair (and one alpha table) from per-channel counts: the
 *  channel's own when there's one; with more, each channel's proportions
 *  weighted equally (alpha's rescaled to the channels' mean size, so its
 *  n − 1 correction still means something). */
function combineChannels(units: CellResult['units'], pairCount: number): { chars: (PairTable | null)[]; alpha: AlphaTable | null; alphaWithout?: (AlphaTable | null)[] } {
  const used = (['text', 'time', 'region'] as Channel[]).filter((c) => units[c])
  const chars: (PairTable | null)[] = []
  for (let p = 0; p < pairCount; p++) {
    const tabs = used.map((c) => units[c]!.pairs[p]).filter((t): t is PairTable => !!t && t.a + t.b + t.c + t.d > 0)
    if (tabs.length === 0) chars.push(null)
    else if (tabs.length === 1) chars.push({ ...tabs[0] })
    else {
      const out = zeroPair()
      for (const t of tabs) addPair(out, t, 1 / ((t.a + t.b + t.c + t.d) * tabs.length))
      chars.push(out)
    }
  }
  const alpha = combineAlphas(used.map((c) => units[c]!.alpha))
  const coderCount = Math.max(0, ...used.map((c) => units[c]!.alphaWithout?.length ?? 0))
  if (coderCount === 0) return { chars, alpha }
  const alphaWithout = Array.from({ length: coderCount }, (_, k) => combineAlphas(used.map((c) => units[c]!.alphaWithout?.[k] ?? null)))
  return { chars, alpha, alphaWithout }
}

function combineAlphas(tables: (AlphaTable | null)[]): AlphaTable | null {
  const alphas = tables.filter((t): t is AlphaTable => !!t && t.n0 + t.n1 > 0)
  if (alphas.length === 0) return null
  if (alphas.length === 1) return { ...alphas[0] }
  const meanN = alphas.reduce((x, t) => x + t.n0 + t.n1, 0) / alphas.length
  const alpha = zeroAlpha()
  for (const t of alphas) addAlpha(alpha, t, meanN / (t.n0 + t.n1))
  return alpha
}

/** Per-channel counts summed (pooled) over cells. */
function sumUnits(cells: CellResult[], pairCount: number): CellResult['units'] {
  const out: CellResult['units'] = {}
  for (const cell of cells) {
    for (const ch of Object.keys(cell.units) as Channel[]) {
      const src = cell.units[ch]!
      let dst = out[ch]
      if (!dst) out[ch] = dst = { pairs: Array.from({ length: pairCount }, () => null), alpha: null }
      src.pairs.forEach((t, p) => {
        if (!t) return
        if (!dst!.pairs[p]) dst!.pairs[p] = zeroPair()
        addPair(dst!.pairs[p]!, t)
      })
      if (src.alpha) {
        if (!dst.alpha) dst.alpha = zeroAlpha()
        addAlpha(dst.alpha, src.alpha)
      }
      src.alphaWithout?.forEach((t, k) => {
        if (!t) return
        if (!dst!.alphaWithout) dst!.alphaWithout = []
        while (dst!.alphaWithout.length <= k) dst!.alphaWithout.push(null)
        if (!dst!.alphaWithout[k]) dst!.alphaWithout[k] = zeroAlpha()
        addAlpha(dst!.alphaWithout[k]!, t)
      })
    }
  }
  return out
}

function channelsOf(segs: Segment[]): Channel[] {
  const used = new Set<Channel>(segs.map((s) => s.ch))
  return (['text', 'time', 'region'] as Channel[]).filter((c) => used.has(c))
}

/** Channels a document can be compared in: those where anyone applied any
 *  of the chosen codes, else the one its kind is normally coded in. None
 *  when that's text that differs between the projects. */
function channelsInUse(doc: MatchedDoc, allSegs: Segment[]): Channel[] {
  const out = channelsOf(allSegs)
  if (out.length > 0) return out
  const d = defaultChannel(doc)
  return d === 'text' && doc.textDiffers ? [] : [d]
}

/** Channels one code is compared in within a document: those where
 *  someone applied it there — so a code used only on the timeline isn't
 *  diluted by the transcript's text (or a PDF text code by the page
 *  areas). Where nobody applied it, the document still counts towards
 *  the code's total, as agreement, but only in the kinds of unit the code
 *  was applied in elsewhere (`codeChannels`): a photo nobody coded mustn't
 *  add a channel of its own to a code only ever applied to text. A code
 *  applied nowhere is all agreement; it takes the document's first
 *  channel. */
function channelsForCode(codeSegs: Segment[], codeChannels: Channel[], doc: MatchedDoc, ext: DocExtents, docChannels: Channel[]): Channel[] {
  const own = channelsOf(codeSegs)
  if (own.length > 0) return own
  if (codeChannels.length === 0) return docChannels.slice(0, 1)
  return codeChannels.filter((c) => channelExtentTotal(ext, c) > 0 && !(c === 'text' && doc.textDiffers))
}

export interface ComputeInput {
  projects: CoderProject[]
  docs: MatchedDoc[]
  codes: MatchedCode[]
  /** Extents per doc key (text/time from syncExtents, plus any region
   *  areas loaded from the files). */
  extents: Record<string, DocExtents>
  threshold: number
}

export function computeAgreement({ projects, docs, codes, extents, threshold }: ComputeInput): AgreementResults {
  const pairs = pairsOf(projects.length)
  const cells: AgreementResults['cells'] = {}
  const codeTotals: AgreementResults['codeTotals'] = {}
  const skippedDocs: AgreementResults['skippedDocs'] = []
  const approxDocs = new Set<string>()

  // Segments per doc × code × coder, and the channels each doc uses.
  const segs = new Map<string, Segment[][]>()
  const docChannels = new Map<string, Channel[]>()
  const docPresent = new Map<string, number[]>()
  const docExtents = new Map<string, DocExtents>()
  for (const doc of docs) {
    const present = projects.map((p, i) => (doc.members[p.id] ? i : -1)).filter((i) => i >= 0)
    docPresent.set(doc.key, present)
    const all: Segment[] = []
    for (const code of codes) {
      const per = codeSegments(projects, doc, code)
      segs.set(`${doc.key}|${code.key}`, per)
      all.push(...per.flat())
    }
    const channels = channelsInUse(doc, all)
    docChannels.set(doc.key, channels)
    const done = completeExtents(extents[doc.key] ?? {}, all)
    docExtents.set(doc.key, done.ext)
    if (done.estimated && present.length >= 2) approxDocs.add(doc.key)
    if (present.length < 2) skippedDocs.push({ key: doc.key, reason: 'singleProject' })
    else if (channels.length === 0) skippedDocs.push({ key: doc.key, reason: 'textDiffers' })
  }
  const skipped = new Set(skippedDocs.map((s) => s.key))
  const usedDocs = docs.filter((d) => !skipped.has(d.key))

  const withAlpha = projects.length >= 3
  for (const code of codes) {
    cells[code.key] = {}
    const used: CellResult[] = []
    const codeChannels = channelsOf(usedDocs.flatMap((d) => segs.get(`${d.key}|${code.key}`)!.flat()))
    for (const doc of usedDocs) {
      const codeSegs = segs.get(`${doc.key}|${code.key}`)!
      const cell = computeCell(
        codeSegs,
        docPresent.get(doc.key)!,
        pairs,
        channelsForCode(codeSegs.flat(), codeChannels, doc, docExtents.get(doc.key)!, docChannels.get(doc.key)!),
        docExtents.get(doc.key)!,
        threshold,
        withAlpha
      )
      cells[code.key][doc.key] = cell
      used.push(cell)
    }
    // Pooled over documents: every unit counts once.
    const units = sumUnits(used, pairs.length)
    codeTotals[code.key] = {
      units,
      ...combineChannels(units, pairs.length),
      segs: pairs.map((_, p) => {
        const parts = used.map((c) => c.segs[p]).filter((x): x is SegmentCount => !!x)
        return parts.length ? parts.reduce((x, y) => ({ agree: x.agree + y.agree, total: x.total + y.total }), { agree: 0, total: 0 }) : null
      })
    }
  }

  // All codes: pooled kappa / alpha over the codes; segments add up.
  const totals = codes.map((c) => codeTotals[c.key])
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  const pooled = pairs.map((_, p) => {
    const parts = totals.map((t) => (t.chars[p] ? agreementParts(t.chars[p]!) : null)).filter((x): x is { po: number; pe: number } => !!x)
    return parts.length ? { po: mean(parts.map((x) => x.po)), pe: mean(parts.map((x) => x.pe)) } : null
  })
  const alphaParts = totals.map((t) => (t.alpha ? disagreementParts(t.alpha) : null)).filter((x): x is { do: number; de: number } => !!x)
  const overall: CellResult = {
    units: {},
    chars: pairs.map(() => null),
    alpha: null,
    segs: pairs.map((_, p) => {
      const parts = totals.map((t) => t.segs[p]).filter((s): s is SegmentCount => !!s)
      return parts.length ? parts.reduce((x, y) => ({ agree: x.agree + y.agree, total: x.total + y.total }), { agree: 0, total: 0 }) : null
    }),
    pooled,
    pooledAlpha: withAlpha && alphaParts.length ? { do: mean(alphaParts.map((x) => x.do)), de: mean(alphaParts.map((x) => x.de)) } : null,
    ...(withAlpha ? {
      pooledAlphaWithout: projects.map((_, k) => {
        const parts = totals.map((t) => (t.alphaWithout?.[k] ? disagreementParts(t.alphaWithout[k]!) : null)).filter((x): x is { do: number; de: number } => !!x)
        return parts.length ? { do: mean(parts.map((x) => x.do)), de: mean(parts.map((x) => x.de)) } : null
      })
    } : {})
  }

  return {
    coders: projects.map((p) => ({ id: p.id, label: p.label })),
    pairs,
    codeKeys: codes.map((c) => c.key),
    docKeys: usedDocs.map((d) => d.key),
    cells,
    codeTotals,
    overall,
    skippedDocs,
    approxDocs: [...approxDocs],
    threshold
  }
}

// ── Drill-down ────────────────────────────────────────────────────────

/** A stretch where either coder coded: the union of overlapping
 *  segments from the two, on one line. */
export interface Passage {
  ch: Channel
  line: string
  /** Interval passages: the span; region passages: the bounding box. */
  start: number
  end: number
  box?: { x: number; y: number; w: number; h: number }
  first: Segment[]
  second: Segment[]
  agreed: boolean
}

function touches(s: Segment, t: Segment): boolean {
  if (s.ch !== t.ch || s.line !== t.line) return false
  if (s.ch === 'region' && t.ch === 'region') {
    return s.x < t.x + t.w && t.x < s.x + s.w && s.y < t.y + t.h && t.y < s.y + s.h
  }
  if (s.ch !== 'region' && t.ch !== 'region') return s.start < t.end && t.start < s.end
  return false
}

/** Group two coders' segments into passages, ordered through the
 *  document, each marked agreed or not under the chosen measure. */
export function passagesFor(a: Segment[], b: Segment[], measure: Measure, threshold: number): Passage[] {
  const all = [...a.map((s) => ({ s, who: 0 })), ...b.map((s) => ({ s, who: 1 }))]
  // Union-find over overlapping segments.
  const parent = all.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (touches(all[i].s, all[j].s)) parent[find(i)] = find(j)
    }
  }
  const groups = new Map<number, typeof all>()
  all.forEach((x, i) => {
    const r = find(i)
    let g = groups.get(r)
    if (!g) groups.set(r, (g = []))
    g.push(x)
  })
  const out: Passage[] = []
  for (const g of groups.values()) {
    const first = g.filter((x) => x.who === 0).map((x) => x.s)
    const second = g.filter((x) => x.who === 1).map((x) => x.s)
    const s0 = g[0].s
    let agreed: boolean
    if (measure === 'segments') {
      agreed = first.every((s) => second.some((t) => segmentsMatch(s, t, threshold))) &&
        second.every((t) => first.some((s) => segmentsMatch(t, s, threshold)))
    } else {
      const pieces = s0.ch === 'region' ? regionCoverage([first, second]) : intervalCoverage([first, second])
      agreed = pieces.every((p) => p.mask === 3)
    }
    if (s0.ch === 'region') {
      const rs = g.map((x) => x.s).filter((s): s is Extract<Segment, { ch: 'region' }> => s.ch === 'region')
      const x0 = Math.min(...rs.map((r) => r.x))
      const y0 = Math.min(...rs.map((r) => r.y))
      const x1 = Math.max(...rs.map((r) => r.x + r.w))
      const y1 = Math.max(...rs.map((r) => r.y + r.h))
      out.push({ ch: 'region', line: s0.line, start: y0, end: y1, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, first, second, agreed })
    } else {
      const iv = g.map((x) => x.s).filter((s): s is Extract<Segment, { ch: 'text' | 'time' }> => s.ch !== 'region')
      out.push({ ch: s0.ch, line: s0.line, start: Math.min(...iv.map((s) => s.start)), end: Math.max(...iv.map((s) => s.end)), first, second, agreed })
    }
  }
  const pageNum = (line: string): number => Number(line.slice(1)) || 0
  return out.sort((x, y) =>
    x.ch !== y.ch ? CHANNEL_ORDER[x.ch] - CHANNEL_ORDER[y.ch]
      : x.line !== y.line ? (x.ch === 'region' ? pageNum(x.line) - pageNum(y.line) : x.line < y.line ? -1 : 1)
        : x.start - y.start
  )
}

const CHANNEL_ORDER: Record<Channel, number> = { text: 0, time: 1, region: 2 }
