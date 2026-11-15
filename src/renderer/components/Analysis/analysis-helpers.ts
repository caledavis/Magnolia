import type { PlainTextSelection, AnalysisInitData, SurveyEntityRef } from '../../models/types'
import { resolveTagCellScope } from '../../utils/survey-cell-scope'
import { formatPercent } from '../../i18n'
import { deriveVideoTimeRange, transcriptTimeRange } from '../DocumentViewer/video-time-utils'
import { selectionsOverlap, placeInTime } from '../../utils/query-engine'

/** Build a cell predicate from a list of (survey, entity) refs. A survey
 *  that appears in the list is restricted to its listed entities; a
 *  survey NOT in the list is left untouched (all its cells pass). This
 *  matches the "global per question/respondent node; others = all"
 *  semantics used by the Questions scope box and Respondents grouping.
 *  Returns null when there's no constraint. */
function entityScopePredicate(
  refs: SurveyEntityRef[] | undefined
): ((sourceGuid: string, entityId: string) => boolean) | null {
  if (!refs || refs.length === 0) return null
  const bySurvey = new Map<string, Set<string>>()
  for (const r of refs) {
    let set = bySurvey.get(r.sourceGuid)
    if (!set) { set = new Set(); bySurvey.set(r.sourceGuid, set) }
    set.add(r.id)
  }
  return (sourceGuid, entityId) => {
    const set = bySurvey.get(sourceGuid)
    return set ? set.has(entityId) : true
  }
}

/** Truncate a string to maxLen chars, adding ellipsis */
export function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '\u2026' : s
}

/** Format `value` as a percentage of `total` to one decimal place, as
 *  the interface language writes it ("72.7%", "72,7 %"). Returns '' when
 *  the denominator is zero so callers can fall back to a muted
 *  placeholder (no codings to take a percentage of). */
export function pctOfTotal(value: number, total: number): string {
  if (!total) return ''
  return formatPercent((value / total) * 100)
}

/** `pctOfTotal` for CSV files: always "72.7%", since a decimal comma
 *  would clash with the CSV's own commas. */
export function csvPctOfTotal(value: number, total: number): string {
  if (!total) return ''
  return ((value / total) * 100).toFixed(1) + '%'
}

/** Get all selections for a source that have a given code */
export function selectionsWithCode(
  selections: PlainTextSelection[],
  codeGuid: string
): PlainTextSelection[] {
  return selections.filter((sel) =>
    sel.codings.some((c) => c.codeGuid === codeGuid)
  )
}

/** Count co-occurrences of two codes across specified sources.
 *  Counts each instance where code A and code B overlap, including
 *  when both codes are applied to the same selection. Overlap is judged
 *  as the query's overlap operator judges it (selectionsOverlap): text by
 *  its characters, boxes by their rectangles, and a recording's codings
 *  made on the timeline by time. */
export function countCoOccurrences(
  data: AnalysisInitData,
  sourceGuids: string[],
  codeGuidA: string,
  codeGuidB: string
): number {
  let count = 0
  for (const sg of sourceGuids) {
    // A recording's timeline codings are compared by time.
    const src = data.sources?.find((s) => s.guid === sg)
    const sels = placeInTime(data.sourceSelections[sg] || [], { sourceType: src?.sourceType, lineTimes: src?.lineTimes, duration: src?.duration }, data.sourceContents?.[sg] ?? '')
    const secsA = selectionsWithCode(sels, codeGuidA)
    const secsB = selectionsWithCode(sels, codeGuidB)
    const counted = new Set<string>()
    for (const a of secsA) {
      for (const b of secsB) {
        // Same selection with both codes counts as a co-occurrence
        if (a.guid === b.guid) {
          if (!counted.has(a.guid)) {
            counted.add(a.guid)
            count++
          }
        } else if (selectionsOverlap(a, b)) {
          // Different selections that overlap — use sorted pair key to avoid double-counting
          const pairKey = a.guid < b.guid ? `${a.guid}:${b.guid}` : `${b.guid}:${a.guid}`
          if (!counted.has(pairKey)) {
            counted.add(pairKey)
            count++
          }
        }
      }
    }
  }
  return count
}

/** Count occurrences of a code in a source */
export function countCodeInSource(
  data: AnalysisInitData,
  sourceGuid: string,
  codeGuid: string
): number {
  const sels = data.sourceSelections[sourceGuid] || []
  return selectionsWithCode(sels, codeGuid).length
}

/** Sum the union length of a sorted-by-start ranges array (covering
 *  intervals that may overlap; no double-counting of overlap). */
function unionLength(ranges: { start: number; end: number }[]): number {
  if (ranges.length === 0) return 0
  const sorted = ranges.slice().sort((a, b) => a.start - b.start)
  const merged: { start: number; end: number }[] = []
  for (const r of sorted) {
    if (merged.length > 0 && r.start <= merged[merged.length - 1].end) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, r.end)
    } else {
      merged.push({ ...r })
    }
  }
  return merged.reduce((sum, r) => sum + (r.end - r.start), 0)
}

/** Calculate the percentage of a source covered by a code. Returns a
 *  number 0..100. Where the code's selections overlap, the overlap counts
 *  once. What 100% is depends on the kind of document:
 *
 *    - text / markdown: its characters.
 *    - survey: the text of its open-ended answers.
 *    - audio / video: the recording's length. A coding made on the
 *                     timeline counts for its time; one made on the
 *                     transcript for its lines' times. If any coding
 *                     can't be placed in time, or the length is unknown:
 *                     the transcript's characters.
 *    - image:         its area (pixels).
 *    - pdf:           its text, for text selections; the area of all its
 *                     pages, for box selections. A code with both in one
 *                     PDF takes the average of the two.
 *
 *  An image's or page's size comes from data.pageSizes; until it's read
 *  (or if it can't be), it's estimated from the furthest corner of any box
 *  on it, and a recording's unknown length from the latest moment coded
 *  in it — see sizeEstimated. */
export function codeFrequencyInSource(
  data: AnalysisInitData,
  sourceGuid: string,
  codeGuid: string
): number {
  const sels = data.sourceSelections[sourceGuid] || []
  const codeSels = selectionsWithCode(sels, codeGuid)
  if (codeSels.length === 0) return 0

  const source = data.sources.find((s) => s.guid === sourceGuid)
  const sourceType = source?.sourceType ?? 'text'

  if (sourceType === 'survey') {
    // 100% of a survey = all codable (open-ended) answer text, NOT the
    // raw CSV. Computed per-cell to respect cell-relative offsets.
    return surveyCodeFrequency(data, sourceGuid, codeGuid)
  }

  if (sourceType === 'audio' || sourceType === 'video') {
    const duration = recordingLength(data, sourceGuid)
    const content = data.sourceContents[sourceGuid] ?? ''
    const times = codeSels.map((s) => {
      const own = s.timeRange && s.timeRange.endTime > s.timeRange.startTime ? s.timeRange : undefined
      if (own && !isTranscriptCoding(s, content, source?.lineTimes)) return own
      // Coded on the transcript: its lines' times, the last line running
      // to the end of the recording.
      if (s.endPosition > s.startPosition) return transcriptTimeRange(content, s.startPosition, s.endPosition, source?.lineTimes, duration) ?? own
      return own
    })
    if (duration > 0 && times.every((t) => !!t)) {
      const ranges = times.map((t) => ({ start: t!.startTime, end: t!.endTime }))
      return (unionLength(clipRanges(ranges, duration)) / duration) * 100
    }
    const totalCp = content ? Array.from(content).length : 0
    if (totalCp > 0) {
      const ranges = codeSels.map((s) => ({ start: s.startPosition, end: s.endPosition }))
      return (unionLength(clipRanges(ranges, totalCp)) / totalCp) * 100
    }
    return 0
  }

  if (sourceType === 'image') return boxCoverage(data, sourceGuid, codeSels)

  if (sourceType === 'pdf') {
    const codeBoxes = codeSels.filter((s) => !!s.pdfRegion)
    const codeText = codeSels.filter((s) => !s.pdfRegion && s.endPosition > s.startPosition)
    const content = data.sourceContents[sourceGuid]
    const totalCp = content ? Array.from(content).length : 0
    const parts: number[] = []
    if (codeText.length > 0 && totalCp > 0) {
      parts.push((unionLength(clipRanges(codeText.map((s) => ({ start: s.startPosition, end: s.endPosition })), totalCp)) / totalCp) * 100)
    }
    if (codeBoxes.length > 0) parts.push(boxCoverage(data, sourceGuid, codeBoxes))
    return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0
  }

  // text / markdown / fallback
  const content = data.sourceContents[sourceGuid]
  const totalCp = content ? Array.from(content).length : 0
  if (totalCp === 0) return 0
  const ranges = codeSels.map((s) => ({ start: s.startPosition, end: s.endPosition }))
  const covered = unionLength(clipRanges(ranges, totalCp))
  return (covered / totalCp) * 100
}

/** A recording's length in seconds: its own, or — when unknown — the
 *  latest moment coded in it (see sizeEstimated). */
function recordingLength(data: AnalysisInitData, sourceGuid: string): number {
  const own = data.sources.find((s) => s.guid === sourceGuid)?.duration ?? 0
  if (own > 0) return own
  let latest = 0
  for (const s of data.sourceSelections[sourceGuid] || []) if (s.timeRange) latest = Math.max(latest, s.timeRange.endTime)
  return latest
}

/** A recording's coding made on its transcript: its time range is the one
 *  its text derives (as when the project is loaded), not one of its own. */
function isTranscriptCoding(s: PlainTextSelection, content: string, lineTimes: Record<string, number> | undefined): boolean {
  if (!s.timeRange || s.endPosition <= s.startPosition) return false
  const d = deriveVideoTimeRange(content, s.startPosition, s.endPosition, lineTimes)
  return !!d && Math.abs(d.startTime - s.timeRange.startTime) < 5e-4 && Math.abs(d.endTime - s.timeRange.endTime) < 5e-4
}

/** Each page's size: read from the file, or estimated from the furthest
 *  corner of any box on it. */
function pageSizesOf(data: AnalysisInitData, sourceGuid: string): { sizes: Record<string, { w: number; h: number }>; estimated: boolean } {
  const read = data.pageSizes?.[sourceGuid]
  if (read && Object.keys(read).length > 0) return { sizes: read, estimated: false }
  const sizes: Record<string, { w: number; h: number }> = {}
  for (const s of data.sourceSelections[sourceGuid] || []) {
    const r = s.pdfRegion
    if (!r) continue
    const k = `p${r.page}`
    const c = sizes[k] ?? { w: 0, h: 0 }
    sizes[k] = { w: Math.max(c.w, r.x + r.width), h: Math.max(c.h, r.y + r.height) }
  }
  return { sizes, estimated: true }
}

/** Whether Code Frequencies estimates a document's size — an image's or
 *  page's area, or a recording's length — because it couldn't be read, so
 *  its percentages are approximate. */
export function sizeEstimated(data: AnalysisInitData, sourceGuid: string): boolean {
  const src = data.sources.find((s) => s.guid === sourceGuid)
  const st = src?.sourceType
  if (st === 'audio' || st === 'video') return !((src?.duration ?? 0) > 0) && (data.sourceSelections[sourceGuid] || []).some((s) => !!s.timeRange)
  if (st !== 'image' && st !== 'pdf') return false
  if (!(data.sourceSelections[sourceGuid] || []).some((s) => !!s.pdfRegion)) return false
  return pageSizesOf(data, sourceGuid).estimated
}

/** % of a document's area (all its pages) covered by the given boxes,
 *  overlaps counted once and each box cut to its page. */
function boxCoverage(data: AnalysisInitData, sourceGuid: string, boxes: PlainTextSelection[]): number {
  const { sizes } = pageSizesOf(data, sourceGuid)
  const total = Object.values(sizes).reduce((sum, p) => sum + p.w * p.h, 0)
  if (total <= 0) return 0
  const byPage = new Map<string, { x0: number; y0: number; x1: number; y1: number }[]>()
  for (const s of boxes) {
    const r = s.pdfRegion
    if (!r) continue
    const k = `p${r.page}`
    const page = sizes[k]
    if (!page) continue
    const rect = { x0: Math.max(0, r.x), y0: Math.max(0, r.y), x1: Math.min(page.w, r.x + r.width), y1: Math.min(page.h, r.y + r.height) }
    if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) continue
    let arr = byPage.get(k)
    if (!arr) byPage.set(k, (arr = []))
    arr.push(rect)
  }
  let covered = 0
  for (const rects of byPage.values()) covered += rectUnionArea(rects)
  return (covered / total) * 100
}

/** Area covered by a set of rectangles, overlaps counted once. */
export function rectUnionArea(rects: { x0: number; y0: number; x1: number; y1: number }[]): number {
  const xs = [...new Set(rects.flatMap((r) => [r.x0, r.x1]))].sort((a, b) => a - b)
  let area = 0
  for (let i = 0; i + 1 < xs.length; i++) {
    const xm = (xs[i] + xs[i + 1]) / 2
    const spans = rects.filter((r) => r.x0 < xm && xm < r.x1).map((r) => ({ start: r.y0, end: r.y1 }))
    area += (xs[i + 1] - xs[i]) * unionLength(spans)
  }
  return area
}

/** Ranges cut to [0, length]: a coding past the end of its document (an
 *  edited or foreign file) mustn't push coverage over 100%. */
function clipRanges(ranges: { start: number; end: number }[], length: number): { start: number; end: number }[] {
  return ranges
    .map((r) => ({ start: Math.max(0, r.start), end: Math.min(length, r.end) }))
    .filter((r) => r.end > r.start)
}

/** Binary (incidence) view of a numeric grid: every cell becomes 1 if
 *  it has any hits (>= 1) or 0 otherwise. Used by the analysis tables'
 *  "Binary" toggle; row/column margins are then re-summed from the
 *  result so a total reads as "present in N cells". */
export function binarizeGrid(grid: number[][]): number[][] {
  return grid.map((row) => row.map((v) => (v >= 1 ? 1 : 0)))
}

/** Generate CSV from a 2D string array */
export function toCsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
            return `"${cell.replace(/"/g, '""')}"`
          }
          return cell
        })
        .join(',')
    )
    .join('\n')
}

/** Resolve which source guids are active based on the doc filter (union/inclusive, then exclude) */
export function resolveFilteredSources(
  data: AnalysisInitData,
  selectedSourceGuids: string[],
  selectedTagGuids: string[],
  tagExcludeGuids?: string[],
  typeInclude?: string[],
  typeExclude?: string[]
): string[] {
  const allGuids = data.sources.map((s) => s.guid)

  const includeTags = selectedTagGuids.filter((g) => !(tagExcludeGuids || []).includes(g))
  const includeTypeSet = typeInclude
    ? new Set(typeInclude.filter((t) => !(typeExclude || []).includes(t)))
    : new Set<string>()

  const hasInclusiveFilter = selectedSourceGuids.length > 0 ||
    includeTags.length > 0 ||
    includeTypeSet.size > 0

  // Union: each inclusive filter adds documents to the result
  let result: Set<string>
  if (!hasInclusiveFilter) {
    result = new Set(allGuids)
  } else {
    result = new Set<string>()

    // Explicit documents
    for (const g of selectedSourceGuids) result.add(g)

    // Tags (include docs that belong to any included tag) — plus surveys
    // tagged only via a respondent / question, so the survey enters the
    // set; its cells are narrowed separately by applySurveyCellScope.
    const allGuidSet = new Set(allGuids)
    for (const tagGuid of includeTags) {
      for (const g of data.tagMembers[tagGuid] || []) if (allGuidSet.has(g)) result.add(g)
      for (const r of data.respondentTagMembers?.[tagGuid] || []) if (allGuidSet.has(r.sourceGuid)) result.add(r.sourceGuid)
      for (const q of data.questionTagMembers?.[tagGuid] || []) if (allGuidSet.has(q.sourceGuid)) result.add(q.sourceGuid)
    }

    // Types (include docs matching any included type)
    if (includeTypeSet.size > 0) {
      for (const s of data.sources) {
        const ext = s.name.includes('.') ? '.' + s.name.split('.').pop()!.toLowerCase() : ''
        if (includeTypeSet.has(ext)) result.add(s.guid)
      }
    }
  }

  // Exclusions: remove docs matching excluded tags
  if (tagExcludeGuids && tagExcludeGuids.length > 0) {
    for (const tagGuid of tagExcludeGuids) {
      const members = new Set(data.tagMembers[tagGuid] || [])
      for (const g of members) result.delete(g)
    }
  }

  // Exclusions: remove docs matching excluded types
  if (typeExclude && typeExclude.length > 0) {
    const excludeSet = new Set(typeExclude)
    for (const s of data.sources) {
      const ext = s.name.includes('.') ? '.' + s.name.split('.').pop()!.toLowerCase() : ''
      if (excludeSet.has(ext)) result.delete(s.guid)
    }
  }

  return Array.from(result)
}

/**
 * Return a copy of `data` whose sourceSelections have out-of-scope
 * survey cells removed, according to the tag cell scope implied by the
 * document filter. Non-survey selections and non-survey sources are
 * untouched. When no tag constraint is active, returns `data` unchanged
 * (cheap no-op for the common case).
 *
 * Counting helpers (countCodeInSource, codeFrequencyInSource,
 * countCoOccurrences, …) read sourceSelections, so feeding them the
 * scoped data makes every analysis metric cell-precise for free —
 * a survey tagged via one respondent counts only that respondent's
 * coded cells, not the whole survey.
 */
export function applySurveyCellScope(
  data: AnalysisInitData,
  filter: {
    tagGuids?: string[]
    tagExcludeGuids?: string[]
    /** Restrict listed surveys to these respondents (per the
     *  Respondents grouping — one ref per respondent column). */
    respondentScope?: SurveyEntityRef[]
    /** Restrict listed surveys to these questions (the Questions
     *  scope box — applied globally to the analysis). */
    questionScope?: SurveyEntityRef[]
  }
): AnalysisInitData {
  const scope = resolveTagCellScope(filter, {
    sourceMembersByTag: data.tagMembers,
    respondentMembersByTag: data.respondentTagMembers ?? {},
    questionMembersByTag: data.questionTagMembers ?? {}
  })
  const respondentPred = entityScopePredicate(filter.respondentScope)
  const questionPred = entityScopePredicate(filter.questionScope)
  // Nothing to do — common fast path.
  if (!scope.hasConstraint && !respondentPred && !questionPred) return data

  // A survey cell is kept only if it satisfies every active scope: the
  // tag scope AND the respondent scope AND the question scope.
  const cellKept = (sg: string, respondentId: string, questionId: string): boolean => {
    if (scope.hasConstraint && !scope.cellInScope(sg, respondentId, questionId)) return false
    if (respondentPred && !respondentPred(sg, respondentId)) return false
    if (questionPred && !questionPred(sg, questionId)) return false
    return true
  }

  const scoped: Record<string, PlainTextSelection[]> = {}
  for (const sg of Object.keys(data.sourceSelections)) {
    const sels = data.sourceSelections[sg]
    scoped[sg] = sels.filter(
      (sel) => !sel.surveyCell || cellKept(sg, sel.surveyCell.respondentId, sel.surveyCell.questionId)
    )
  }
  // Scope the codable-cell denominator the same way, so "% of survey"
  // is relative to the in-scope cells (not the whole survey) when a
  // filter narrows to specific respondents/questions.
  let scopedCells = data.surveyCodableCells
  if (scopedCells) {
    const next: NonNullable<AnalysisInitData['surveyCodableCells']> = {}
    for (const sg of Object.keys(scopedCells)) {
      next[sg] = scopedCells[sg].filter((c) => cellKept(sg, c.respondentId, c.questionId))
    }
    scopedCells = next
  }
  return { ...data, sourceSelections: scoped, surveyCodableCells: scopedCells }
}

/** Codepoint length (surrogate-pair-safe), matching how cell offsets
 *  are counted in the survey viewer. */
function cpLen(s: string): number {
  return Array.from(s).length
}

/** Coverage % of a survey source: union of coded character ranges
 *  WITHIN each codable cell (offsets are cell-relative, so ranges from
 *  different cells must not be merged), summed, over the total length of
 *  the codable (open-ended) cells. This is the survey-correct denominator
 *  — "100%" means every codable answer fully coded, not the raw CSV. */
function surveyCodeFrequency(
  data: AnalysisInitData,
  sourceGuid: string,
  codeGuid: string
): number {
  const cells = data.surveyCodableCells?.[sourceGuid] || []
  let totalCp = 0
  const cellLen = new Map<string, number>()
  for (const c of cells) {
    const len = cpLen(c.text)
    cellLen.set(c.respondentId + '\u0000' + c.questionId, len)
    totalCp += len
  }
  if (totalCp === 0) return 0
  const sels = selectionsWithCode(data.sourceSelections[sourceGuid] || [], codeGuid)
  // Group coded ranges by cell, union within each cell, then sum.
  const byCell = new Map<string, { start: number; end: number }[]>()
  for (const s of sels) {
    if (!s.surveyCell) continue
    const key = s.surveyCell.respondentId + '\u0000' + s.surveyCell.questionId
    let arr = byCell.get(key)
    if (!arr) { arr = []; byCell.set(key, arr) }
    arr.push({ start: s.startPosition, end: s.endPosition })
  }
  // Each cell's ranges cut to that cell (a coding on a cell that's out
  // of scope, or past its end, counts for nothing beyond it).
  let covered = 0
  for (const [key, ranges] of byCell) covered += unionLength(clipRanges(ranges, cellLen.get(key) ?? 0))
  return (covered / totalCp) * 100
}

/**
 * The source guids a tag resolves to for a GROUPING column: tagged
 * documents/surveys PLUS surveys tagged only via a respondent/question
 * (so the column includes them). Intersected with the candidate set.
 * The column's cells are narrowed to the tag separately, by passing the
 * tag to applySurveyCellScope when counting (see the tools' grids).
 */
export function tagColumnSources(
  data: AnalysisInitData,
  tagGuid: string,
  candidates: string[] | Set<string>
): string[] {
  const cand = candidates instanceof Set ? candidates : new Set(candidates)
  const out = new Set<string>()
  for (const g of data.tagMembers[tagGuid] || []) if (cand.has(g)) out.add(g)
  for (const r of data.respondentTagMembers?.[tagGuid] || []) if (cand.has(r.sourceGuid)) out.add(r.sourceGuid)
  for (const q of data.questionTagMembers?.[tagGuid] || []) if (cand.has(q.sourceGuid)) out.add(q.sourceGuid)
  return [...out]
}

/** The data each grid column counts in: a respondent column only that
 *  respondent's survey cells, a tag column only the cells the tag covers
 *  (a survey tagged through some respondents or questions), any other
 *  column everything. */
export function columnData(col: { tagScopeGuids?: string[]; respondentRef?: SurveyEntityRef }, data: AnalysisInitData): AnalysisInitData {
  return col.respondentRef
    ? applySurveyCellScope(data, { respondentScope: [col.respondentRef] })
    : col.tagScopeGuids
      ? applySurveyCellScope(data, { tagGuids: col.tagScopeGuids })
      : data
}

/** columnData for every column, by column id. */
export function columnScopedData(
  columns: { id: string; tagScopeGuids?: string[]; respondentRef?: SurveyEntityRef }[],
  data: AnalysisInitData
): Map<string, AnalysisInitData> {
  return new Map(columns.map((col) => [col.id, columnData(col, data)]))
}

/** A row's Total in Codes in Documents: the selections coded with the
 *  code across the table's (non-subtotal) columns, each counted once — a
 *  document in two of the groups shown is in two columns, but its
 *  selections are only coded once. */
export function codeRowTotal(
  columns: { id: string; sourceGuids: string[]; isSubtotal?: boolean }[],
  colData: Map<string, AnalysisInitData>,
  data: AnalysisInitData,
  codeGuid: string
): number {
  const seen = new Set<string>()
  for (const col of columns) {
    if (col.isSubtotal) continue
    const cd = colData.get(col.id) || data
    for (const sg of col.sourceGuids) {
      for (const sel of selectionsWithCode(cd.sourceSelections[sg] || [], codeGuid)) seen.add(`${sg}\u0000${sel.guid}`)
    }
  }
  return seen.size
}

/** The query results that fall in a grid column: its documents, and for a
 *  survey only the cells the column covers (one respondent, or the cells a
 *  tag covers). */
export function resultsInColumn<R extends { sourceGuid: string; surveyCell?: { respondentId: string; questionId: string } }>(
  results: R[],
  col: { sourceGuids: string[]; tagScopeGuids?: string[]; respondentRef?: SurveyEntityRef },
  data: Pick<AnalysisInitData, 'tagMembers' | 'respondentTagMembers' | 'questionTagMembers'>
): R[] {
  if (col.respondentRef) {
    const { sourceGuid, id } = col.respondentRef
    return results.filter((r) => r.sourceGuid === sourceGuid && r.surveyCell?.respondentId === id)
  }
  const docs = new Set(col.sourceGuids)
  const scope = col.tagScopeGuids
    ? resolveTagCellScope({ tagGuids: col.tagScopeGuids }, {
      sourceMembersByTag: data.tagMembers,
      respondentMembersByTag: data.respondentTagMembers ?? {},
      questionMembersByTag: data.questionTagMembers ?? {}
    })
    : null
  return results.filter((r) =>
    docs.has(r.sourceGuid) &&
    (!scope || !r.surveyCell || scope.cellInScope(r.sourceGuid, r.surveyCell.respondentId, r.surveyCell.questionId)))
}

/** A row's Total in Results in Documents: the query's results across the
 *  (non-subtotal) columns, each counted once. */
export function resultRowTotal<R extends { sourceGuid: string; selectionGuid?: string; startPosition: number; endPosition: number; surveyCell?: { respondentId: string; questionId: string } }>(
  results: R[],
  columns: { sourceGuids: string[]; isSubtotal?: boolean; tagScopeGuids?: string[]; respondentRef?: SurveyEntityRef }[],
  data: Pick<AnalysisInitData, 'tagMembers' | 'respondentTagMembers' | 'questionTagMembers'>
): number {
  const seen = new Set<R>()
  for (const col of columns) {
    if (col.isSubtotal) continue
    for (const r of resultsInColumn(results, col, data)) seen.add(r)
  }
  return seen.size
}

/** Whether a Code Frequencies column holds several documents, so its
 *  value is the average of their percentages (one per document). */
export function isAverageColumn(col: { sourceGuids: string[] }): boolean {
  return col.sourceGuids.length > 1
}
