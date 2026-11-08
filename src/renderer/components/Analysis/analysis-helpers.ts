import type { PlainTextSelection, AnalysisInitData, SurveyEntityRef } from '../../models/types'
import { resolveTagCellScope } from '../../utils/survey-cell-scope'
import { formatPercent } from '../../i18n'

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

/** Check if two selections overlap.
 *
 *  Survey-cell selections store CELL-RELATIVE offsets, so two selections
 *  only share a coordinate space when they're in the SAME cell. Without
 *  this guard every cell's selections — all starting near offset 0 —
 *  falsely overlap every other cell's, which inflated co-occurrence counts
 *  to roughly (instances × answer length). */
export function selectionsOverlap(a: PlainTextSelection, b: PlainTextSelection): boolean {
  if (a.surveyCell || b.surveyCell) {
    if (!a.surveyCell || !b.surveyCell) return false
    if (
      a.surveyCell.respondentId !== b.surveyCell.respondentId ||
      a.surveyCell.questionId !== b.surveyCell.questionId
    ) {
      return false
    }
  }
  return a.startPosition < b.endPosition && b.startPosition < a.endPosition
}

/** Count co-occurrences of two codes across specified sources.
 *  Counts each instance where code A and code B overlap, including
 *  when both codes are applied to the same selection. */
export function countCoOccurrences(
  data: AnalysisInitData,
  sourceGuids: string[],
  codeGuidA: string,
  codeGuidB: string
): number {
  let count = 0
  for (const sg of sourceGuids) {
    const sels = data.sourceSelections[sg] || []
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
 *  number 0..100. The denominator depends on the source kind so the
 *  metric is meaningful across mixed-media projects:
 *
 *    - text / markdown: % of characters covered (union of char ranges).
 *    - audio / video:   % of duration covered (union of timeRange
 *                       selections; needs source.duration).
 *    - pdf:             % of extracted-text characters covered. PDFs
 *                       coded purely via region selections (and any
 *                       PDF without extracted text) fall back to the
 *                       count-based metric below.
 *    - image:           % of selections coded with this code. Image
 *                       pixel dimensions aren't persisted, so true
 *                       area coverage isn't computable; selection
 *                       count is the meaningful proxy.
 *
 *  When a meaningful denominator can't be determined, the function
 *  falls back to (selections-coded-with-code / total-selections) ×
 *  100, which gives a usable comparative metric for any kind of
 *  source instead of returning 0. */
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
    const duration = source?.duration ?? 0
    if (duration <= 0) {
      // No duration recorded — fall back to count-based.
      return sels.length > 0 ? (codeSels.length / sels.length) * 100 : 0
    }
    const ranges = codeSels
      .filter((s) => s.timeRange)
      .map((s) => ({ start: s.timeRange!.startTime, end: s.timeRange!.endTime }))
    const covered = unionLength(ranges)
    return (covered / duration) * 100
  }

  if (sourceType === 'image') {
    // Image dimensions aren't persisted in formatData, so use the
    // count-based metric. Hooking up real pixel-area coverage would
    // require persisting image width/height when the source is
    // imported (and the same for PDF page dimensions).
    return sels.length > 0 ? (codeSels.length / sels.length) * 100 : 0
  }

  if (sourceType === 'pdf') {
    // PDFs may be coded via text-range selections, region-only
    // selections, or a mix. Compute each metric independently and
    // blend them by their selection counts so mixed PDFs reflect
    // both contributions:
    //   text % = union(char ranges) / total characters
    //   region % = code-coded regions / total regions
    //   blended = (text% × textSels + region% × regionSels) /
    //             (textSels + regionSels)
    const content = data.sourceContents[sourceGuid]
    const totalCp = content ? Array.from(content).length : 0
    const textSels = sels.filter((s) => s.endPosition > s.startPosition)
    const regionSels = sels.filter((s) => s.endPosition === s.startPosition)
    const codeTextSels = codeSels.filter((s) => s.endPosition > s.startPosition)
    const codeRegionSels = codeSels.filter((s) => s.endPosition === s.startPosition)

    let textPct: number | null = null
    if (totalCp > 0 && textSels.length > 0) {
      const ranges = codeTextSels.map((s) => ({ start: s.startPosition, end: s.endPosition }))
      textPct = (unionLength(ranges) / totalCp) * 100
    }
    let regionPct: number | null = null
    if (regionSels.length > 0) {
      regionPct = (codeRegionSels.length / regionSels.length) * 100
    }

    if (textPct !== null && regionPct !== null) {
      // Both kinds present — weighted average by selection count so
      // a mostly-text PDF reads close to its text%, mostly-region
      // close to its region%, and a 50/50 mix sits in between.
      const wText = textSels.length
      const wRegion = regionSels.length
      return (textPct * wText + regionPct * wRegion) / (wText + wRegion)
    }
    if (textPct !== null) return textPct
    if (regionPct !== null) return regionPct
    return 0
  }

  // text / markdown / fallback
  const content = data.sourceContents[sourceGuid]
  if (!content) {
    return sels.length > 0 ? (codeSels.length / sels.length) * 100 : 0
  }
  const totalCp = Array.from(content).length
  if (totalCp === 0) return 0
  const ranges = codeSels.map((s) => ({ start: s.startPosition, end: s.endPosition }))
  const covered = unionLength(ranges)
  return (covered / totalCp) * 100
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
  for (const c of cells) totalCp += cpLen(c.text)
  if (totalCp === 0) return 0
  const sels = selectionsWithCode(data.sourceSelections[sourceGuid] || [], codeGuid)
  // Group coded ranges by cell, union within each cell, then sum.
  const byCell = new Map<string, { start: number; end: number }[]>()
  for (const s of sels) {
    if (!s.surveyCell) continue
    const key = s.surveyCell.respondentId + ' ' + s.surveyCell.questionId
    let arr = byCell.get(key)
    if (!arr) { arr = []; byCell.set(key, arr) }
    arr.push({ start: s.startPosition, end: s.endPosition })
  }
  let covered = 0
  for (const ranges of byCell.values()) covered += unionLength(ranges)
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

/** Common English stop words */
export const STOP_WORDS = new Set([
  'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i',
  'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at',
  'this', 'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her', 'she',
  'or', 'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what',
  'so', 'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me',
  'when', 'make', 'can', 'like', 'time', 'no', 'just', 'him', 'know', 'take',
  'people', 'into', 'year', 'your', 'good', 'some', 'could', 'them', 'see',
  'other', 'than', 'then', 'now', 'look', 'only', 'come', 'its', 'over',
  'think', 'also', 'back', 'after', 'use', 'two', 'how', 'our', 'work',
  'first', 'well', 'way', 'even', 'new', 'want', 'because', 'any', 'these',
  'give', 'day', 'most', 'us', 'is', 'am', 'are', 'was', 'were', 'been',
  'being', 'has', 'had', 'did', 'does', 'doing', 'done', 'should', 'may',
  'might', 'must', 'shall', 'very', 'much', 'more', 'such', 'those',
  'own', 'same', 'able', 'just', 'each', 'every', 'both', 'few', 'many',
  'where', 'while', 'here', 'through', 'during', 'before', 'between',
  'under', 'again', 'further', 'once', 'why', 'how', 'too', 'still'
])
