import type {
  Query,
  QueryResult,
  CodeCondition,
  TextSource,
  PlainTextSelection,
  Code,
  QDASet,
  SurveyFormatData
} from '../models/types'
import { codepointSlice, getContext } from './unicode'
import { buildCellText } from './survey/cell-text'
import { resolveTagCellScope, tagMembershipFromTags, type TagCellScope } from './survey-cell-scope'

/** Resolve the text a selection actually points into.
 *
 *  Survey-cell selections store cell-relative codepoint offsets, not
 *  document-relative ones — the source's `plainTextContent` is the
 *  raw CSV, but the selection's startPosition/endPosition index into
 *  the CLEANED text of one cell. Apply the same cleaning the viewer
 *  applied at coding time so the offsets land on the right bytes. */
function textForSelection(
  source: TextSource,
  selection: PlainTextSelection,
  documentContent: string
): string {
  if (selection.surveyCell) {
    return surveyCellText(source, selection.surveyCell.respondentId, selection.surveyCell.questionId)
  }
  return documentContent
}

function surveyCellText(source: TextSource, respondentId: string, questionId: string): string {
  const survey = (source.formatData as SurveyFormatData | undefined)?.survey
  if (!survey) return ''
  const respondent = survey.respondents.find((r) => r.id === respondentId)
  if (!respondent) return ''
  return buildCellText(respondent.answers[questionId])
}

/** A code guid plus all of its descendant guids, from the code tree. */
function codeWithDescendants(codeGuid: string, codeMap: Map<string, Code>): string[] {
  const out: string[] = [codeGuid]
  const code = codeMap.get(codeGuid)
  if (code) {
    const walk = (children: Code[]) => {
      for (const c of children) {
        out.push(c.guid)
        walk(c.children)
      }
    }
    walk(code.children)
  }
  return out
}

/** Replace every "include subcodes" code condition with an OR of the code +
 *  its descendants, recursing through compound and spatial conditions. Used
 *  at execution time only — the stored condition keeps the compact
 *  includeSubcodes form so the graph and the auto-generated name preserve
 *  intent. A parent with no subcodes degrades to a plain code condition. */
function expandSubcodeConditions(cond: CodeCondition, codeMap: Map<string, Code>): CodeCondition {
  switch (cond.type) {
    case 'code': {
      if (!cond.includeSubcodes) return cond
      const guids = codeWithDescendants(cond.codeGuid, codeMap)
      if (guids.length <= 1) return { type: 'code', codeGuid: cond.codeGuid }
      return { type: 'or', conditions: guids.map((g) => ({ type: 'code' as const, codeGuid: g })) }
    }
    case 'and':
    case 'or':
    case 'xor':
      return { ...cond, conditions: cond.conditions.map((c) => expandSubcodeConditions(c, codeMap)) }
    case 'not':
      return { type: 'not', condition: expandSubcodeConditions(cond.condition, codeMap) }
    case 'overlap':
    case 'inside':
    case 'outside':
    case 'before':
    case 'followedBy':
      return {
        ...cond,
        condition1: expandSubcodeConditions(cond.condition1, codeMap),
        condition2: expandSubcodeConditions(cond.condition2, codeMap)
      }
    default:
      return cond
  }
}

export function executeQuery(
  query: Query,
  sources: TextSource[],
  sourceContents: Record<string, string>,
  codes: Code[],
  tags: QDASet[],
  sourceFolder?: Record<string, string>,
  folders?: { guid: string; parentGuid: string | null }[]
): QueryResult[] {
  const results: QueryResult[] = []

  // Filter documents
  let filteredSources = sources
  if (query.documentFilter.sourceGuids && query.documentFilter.sourceGuids.length > 0) {
    const guids = new Set(query.documentFilter.sourceGuids)
    filteredSources = filteredSources.filter((s) => guids.has(s.guid))
  }
  // Tags scope documents AND survey cells in one pass. Build the unified
  // scope from the full tags the engine already holds (with survey
  // membership). Include narrows the source set to tagged docs/surveys
  // PLUS surveys that have any tagged respondent/question (so a survey
  // tagged only via a respondent is still pulled in); exclude drops
  // wholly-excluded docs. Cell-level narrowing happens per selection /
  // per cell below via cellScope.cellInScope.
  const cellScope = resolveTagCellScope(query.documentFilter, tagMembershipFromTags(tags))
  if (cellScope.hasIncludeConstraint) {
    filteredSources = filteredSources.filter((s) => cellScope.includedSourceGuids.has(s.guid))
  }
  if (cellScope.hasExcludeConstraint) {
    filteredSources = filteredSources.filter((s) => !cellScope.excludedSourceGuids.has(s.guid))
  }
  if (
    query.documentFilter.folderGuids &&
    query.documentFilter.folderGuids.length > 0 &&
    sourceFolder &&
    folders
  ) {
    // Collect all selected folder guids and their descendants
    const allFolderGuids = new Set<string>()
    const collectDescendants = (parentGuid: string) => {
      allFolderGuids.add(parentGuid)
      for (const f of folders) {
        if (f.parentGuid === parentGuid && !allFolderGuids.has(f.guid)) {
          collectDescendants(f.guid)
        }
      }
    }
    for (const fg of query.documentFilter.folderGuids) {
      collectDescendants(fg)
    }
    filteredSources = filteredSources.filter((s) => {
      const sf = sourceFolder[s.guid]
      return sf && allFolderGuids.has(sf)
    })
  }

  const codeMap = new Map<string, Code>()
  for (const c of codes) {
    codeMap.set(c.guid, c)
  }

  // Expand any "include subcodes" code conditions into an OR of the code +
  // all its descendants, for evaluation only. The condition is STORED compact
  // (a single code node carrying `includeSubcodes`) so the graph and the
  // query name keep the user's intent; the run-time expansion here keeps
  // matching behaviour identical to the old pre-expanded form.
  const codeCondition = expandSubcodeConditions(query.codeCondition, codeMap)

  // Evaluate each source
  for (const source of filteredSources) {
    const content = sourceContents[source.guid] ?? source.plainTextContent ?? ''

    // Within a survey under a cell constraint, only keep selections whose
    // cell is in scope; non-survey selections always pass. Used as both
    // the iteration set and the allSelections set for spatial operators.
    const scopedSelections = cellScope.hasConstraint
      ? source.selections.filter(
          (sel) =>
            !sel.surveyCell ||
            cellScope.cellInScope(source.guid, sel.surveyCell.respondentId, sel.surveyCell.questionId)
        )
      : source.selections

    const condType = codeCondition.type

    // Standalone text search: find all occurrences in the full document text
    if (condType === 'text') {
      results.push(...textSearchDocument(codeCondition as { type: 'text'; searchText: string; caseSensitive?: boolean }, source, content, cellScope))
      continue
    }

    // OR conditions containing text children need document-wide text search
    // (per-selection evaluation would miss text occurrences outside coded selections)
    if (condType === 'or' && containsTextCondition(codeCondition)) {
      const flatChildren = flattenOr(codeCondition)
      const seen = new Set<string>()
      for (const child of flatChildren) {
        if (child.type === 'text') {
          // Document-wide text search for this branch
          for (const r of textSearchDocument(child, source, content, cellScope)) {
            const key = `${r.startPosition}:${r.endPosition}`
            if (!seen.has(key)) { seen.add(key); results.push(r) }
          }
        } else {
          // Selection-based evaluation for non-text branches
          for (const selection of scopedSelections) {
            const codeGuids = new Set(selection.codings.map((c) => c.codeGuid))
            const selSource = textForSelection(source, selection, content)
            const selText = codepointSlice(selSource, selection.startPosition, selection.endPosition)
            if (evaluateCondition(child, codeGuids, selText, selection, scopedSelections, content)) {
              const key = `${selection.startPosition}:${selection.endPosition}`
              if (!seen.has(key)) {
                seen.add(key)
                results.push(buildResult(source, selection, content, codeGuids, codeMap))
              }
            }
          }
        }
      }
      continue
    }

    for (const selection of scopedSelections) {
      const codeGuidsOnSelection = new Set(selection.codings.map((c) => c.codeGuid))

      if (condType === 'overlap') {
        const cond = codeCondition as { type: 'overlap'; condition1: CodeCondition; condition2: CodeCondition }
        const overlapResults = findOverlapIntersections(cond, selection, scopedSelections, source, content, codeMap)
        results.push(...overlapResults)
      } else if (condType === 'inside') {
        const cond = codeCondition as { type: 'inside'; condition1: CodeCondition; condition2: CodeCondition }
        const insideResults = findInsideSelections(cond, selection, scopedSelections, source, content, codeMap)
        results.push(...insideResults)
      } else if (condType === 'outside') {
        const cond = codeCondition as { type: 'outside'; condition1: CodeCondition; condition2: CodeCondition }
        const outsideResults = findOutsideSelections(cond, selection, scopedSelections, source, content, codeMap)
        results.push(...outsideResults)
      } else if (condType === 'before') {
        const cond = codeCondition as { type: 'before'; condition1: CodeCondition; condition2: CodeCondition }
        const beforeResults = findBeforeSelections(cond, selection, scopedSelections, source, content, codeMap)
        results.push(...beforeResults)
      } else if (condType === 'followedBy') {
        const cond = codeCondition as { type: 'followedBy'; condition1: CodeCondition; condition2: CodeCondition }
        const followedByResults = findFollowedBySelections(cond, selection, scopedSelections, source, content, codeMap)
        results.push(...followedByResults)
      } else {
        const selSource = textForSelection(source, selection, content)
        const selText = codepointSlice(selSource, selection.startPosition, selection.endPosition)
        if (evaluateCondition(codeCondition, codeGuidsOnSelection, selText, selection, scopedSelections, content)) {
          results.push(
            buildResult(source, selection, content, codeGuidsOnSelection, codeMap)
          )
        }
      }
    }
  }

  return results
}

/* ═══════════════════════════════════════════════════
   Text search helpers
   ═══════════════════════════════════════════════════ */

/** Check if a character is a word boundary character */
function isWordBoundary(ch: string | undefined): boolean {
  if (!ch) return true // start/end of string
  return !/[a-zA-Z\u00C0-\u024F'\d]/.test(ch)
}

/** Search full document for text occurrences */
function textSearchDocument(
  cond: { type: 'text'; searchText: string; caseSensitive?: boolean; wholeWord?: boolean },
  source: TextSource,
  content: string,
  cellScope?: TagCellScope
): QueryResult[] {
  const results: QueryResult[] = []
  if (!cond.searchText) return results

  // Surveys store their answers in formatData.survey, NOT in the
  // source's content (which is the raw CSV). Searching the CSV would
  // surface matches against header text and metadata cells, so scan
  // each cell's cleaned text instead — that's what the user actually
  // sees and codes against.
  const survey = (source.formatData as SurveyFormatData | undefined)?.survey
  if (survey) {
    for (const respondent of survey.respondents) {
      for (const question of survey.questions) {
        if (cellScope && !cellScope.cellInScope(source.guid, respondent.id, question.id)) continue
        const cellText = buildCellText(respondent.answers[question.id])
        if (!cellText) continue
        for (const hit of findTextMatches(cellText, cond)) {
          results.push({
            sourceGuid: source.guid,
            sourceName: source.name,
            // Text-match selection guids are synthetic — make them
            // unique across (respondent × question × position) so
            // dedupe maps don't collapse different cells together.
            selectionGuid: `text-match-${source.guid}-${respondent.id}-${question.id}-${hit.start}`,
            startPosition: hit.start,
            endPosition: hit.end,
            matchedText: hit.matched,
            contextBefore: hit.before,
            contextAfter: hit.after,
            matchedCodes: [],
            surveyCell: { respondentId: respondent.id, questionId: question.id }
          })
        }
      }
    }
    return results
  }

  for (const hit of findTextMatches(content, cond)) {
    results.push({
      sourceGuid: source.guid,
      sourceName: source.name,
      selectionGuid: `text-match-${source.guid}-${hit.start}`,
      startPosition: hit.start,
      endPosition: hit.end,
      matchedText: hit.matched,
      contextBefore: hit.before,
      contextAfter: hit.after,
      matchedCodes: []
    })
  }
  return results
}

interface TextMatch {
  start: number
  end: number
  matched: string
  before: string
  after: string
}

function findTextMatches(
  text: string,
  cond: { searchText: string; caseSensitive?: boolean; wholeWord?: boolean }
): TextMatch[] {
  const out: TextMatch[] = []
  const haystack = cond.caseSensitive ? text : text.toLowerCase()
  const needle = cond.caseSensitive ? cond.searchText : cond.searchText.toLowerCase()
  let pos = 0
  while (true) {
    const idx = haystack.indexOf(needle, pos)
    if (idx === -1) break
    if (cond.wholeWord) {
      const charBefore = idx > 0 ? haystack[idx - 1] : undefined
      const charAfter = idx + needle.length < haystack.length ? haystack[idx + needle.length] : undefined
      if (!isWordBoundary(charBefore) || !isWordBoundary(charAfter)) {
        pos = idx + 1
        continue
      }
    }
    const cpStart = Array.from(text.slice(0, idx)).length
    const cpEnd = cpStart + Array.from(cond.searchText).length
    const matched = codepointSlice(text, cpStart, cpEnd)
    const { before, after } = getContext(text, cpStart, cpEnd)
    out.push({ start: cpStart, end: cpEnd, matched, before, after })
    pos = idx + (cond.searchText.length || 1)
  }
  return out
}

/** Check if any leaf in a condition tree is a text condition */
function containsTextCondition(cond: CodeCondition): boolean {
  switch (cond.type) {
    case 'text': return true
    case 'code': case 'any': return false
    case 'and': case 'or': case 'xor':
      return cond.conditions.some((c) => containsTextCondition(c))
    case 'not':
      return containsTextCondition(cond.condition)
    case 'overlap': case 'inside': case 'outside': case 'before': case 'followedBy':
      return containsTextCondition(cond.condition1) || containsTextCondition(cond.condition2)
  }
}

/** Check if ALL leaves in a condition tree are text conditions */
function isAllTextCondition(cond: CodeCondition): boolean {
  switch (cond.type) {
    case 'text': return true
    case 'code': return false
    case 'and': case 'or': case 'xor':
      return cond.conditions.every((c) => isAllTextCondition(c))
    case 'not':
      return isAllTextCondition(cond.condition)
    default: return false
  }
}

/** Flatten nested OR trees into a flat list of children */
function flattenOr(cond: CodeCondition): CodeCondition[] {
  if (cond.type === 'or') {
    return cond.conditions.flatMap((c) => flattenOr(c))
  }
  return [cond]
}

/** Validate a condition tree; returns an error message or null */
export function validateCondition(cond: CodeCondition): string | null {
  if (cond.type === 'and' || cond.type === 'xor') {
    if (cond.conditions.every((c) => isAllTextCondition(c))) {
      return 'Text-only inputs can only be combined with the OR operator. AND, EITHER/OR, and BUT NOT are not valid for multiple text inputs.'
    }
    for (const c of cond.conditions) {
      const err = validateCondition(c)
      if (err) return err
    }
  }
  if (cond.type === 'or') {
    for (const c of cond.conditions) {
      const err = validateCondition(c)
      if (err) return err
    }
  }
  if (cond.type === 'not') {
    return validateCondition(cond.condition)
  }
  if ('condition1' in cond && 'condition2' in cond) {
    const c = cond as { condition1: CodeCondition; condition2: CodeCondition }
    return validateCondition(c.condition1) || validateCondition(c.condition2)
  }
  return null
}

function evaluateCondition(
  condition: CodeCondition,
  codeGuids: Set<string>,
  selectionText?: string,
  /** Required for evaluating nested spatial conditions */
  selection?: PlainTextSelection,
  allSelections?: PlainTextSelection[],
  content?: string
): boolean {
  switch (condition.type) {
    case 'code':
      return codeGuids.has(condition.codeGuid)
    case 'any':
      return codeGuids.size > 0
    case 'text': {
      if (!selectionText || !condition.searchText) return false
      const hay = condition.caseSensitive ? selectionText : selectionText.toLowerCase()
      const ndl = condition.caseSensitive ? condition.searchText : condition.searchText.toLowerCase()
      if (condition.wholeWord) {
        // Use word-boundary regex for whole-word matching
        const escaped = ndl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const re = new RegExp(`\\b${escaped}\\b`, condition.caseSensitive ? '' : 'i')
        return re.test(selectionText)
      }
      return hay.includes(ndl)
    }
    case 'and':
      return condition.conditions.every((c) => evaluateCondition(c, codeGuids, selectionText, selection, allSelections, content))
    case 'or':
      return condition.conditions.some((c) => evaluateCondition(c, codeGuids, selectionText, selection, allSelections, content))
    case 'xor': {
      // Exactly one input must be true
      const trueCount = condition.conditions.filter((c) => evaluateCondition(c, codeGuids, selectionText, selection, allSelections, content)).length
      return trueCount === 1
    }
    case 'not':
      return !evaluateCondition(condition.condition, codeGuids, selectionText, selection, allSelections, content)
    case 'overlap':
    case 'inside':
    case 'outside':
    case 'before':
    case 'followedBy':
      // Delegate to selectionMatchesCondition which handles spatial evaluation
      if (selection && allSelections && content) {
        return selectionMatchesCondition(selection, condition, content, allSelections)
      }
      return false
  }
}

/** Collect all code guids referenced in a condition tree */
function collectReferencedCodes(condition: CodeCondition, out: Set<string>): void {
  switch (condition.type) {
    case 'code':
      out.add(condition.codeGuid)
      break
    case 'any':
      break // wildcard — no specific code to reference
    case 'and':
    case 'or':
    case 'xor':
      for (const c of condition.conditions) collectReferencedCodes(c, out)
      break
    case 'not':
      collectReferencedCodes(condition.condition, out)
      break
    case 'overlap':
    case 'inside':
    case 'outside':
    case 'before':
    case 'followedBy':
      collectReferencedCodes(condition.condition1, out)
      collectReferencedCodes(condition.condition2, out)
      break
  }
}

/** Check if a selection matches a condition (works for code, logical, text, etc.) */
/**
 * Check if a selection matches a condition. For simple conditions (code, text, and/or/not/xor),
 * uses per-selection boolean evaluation. For spatial conditions (inside, outside, overlap, etc.),
 * evaluates the full spatial query and checks if this selection is in the result set.
 */
function selectionMatchesCondition(
  selection: PlainTextSelection,
  condition: CodeCondition,
  content: string,
  allSelections?: PlainTextSelection[]
): boolean {
  // Spatial conditions need full evaluation against all selections
  if (
    allSelections &&
    (condition.type === 'overlap' || condition.type === 'inside' ||
     condition.type === 'outside' || condition.type === 'before' || condition.type === 'followedBy')
  ) {
    const cond = condition as { condition1: CodeCondition; condition2: CodeCondition }
    // Find all selections that match condition via the spatial operator
    for (const sel of allSelections) {
      if (sel.startPosition !== selection.startPosition || sel.endPosition !== selection.endPosition) continue
      // Check if this selection would be returned by the spatial operator
      if (condition.type === 'inside') {
        if (!selectionMatchesCondition(sel, cond.condition1, content, allSelections)) continue
        for (const container of allSelections) {
          if (container === sel) continue // a selection cannot be "inside" itself
          if (!selectionMatchesCondition(container, cond.condition2, content, allSelections)) continue
          if (sel.startPosition >= container.startPosition && sel.endPosition <= container.endPosition) return true
        }
      } else if (condition.type === 'outside') {
        if (!selectionMatchesCondition(sel, cond.condition1, content, allSelections)) continue
        let hasOverlap = false
        for (const other of allSelections) {
          if (!selectionMatchesCondition(other, cond.condition2, content, allSelections)) continue
          if (Math.max(sel.startPosition, other.startPosition) < Math.min(sel.endPosition, other.endPosition)) {
            hasOverlap = true; break
          }
        }
        if (!hasOverlap) return true
      } else if (condition.type === 'overlap') {
        if (!selectionMatchesCondition(sel, cond.condition1, content, allSelections)) continue
        for (const other of allSelections) {
          if (!selectionMatchesCondition(other, cond.condition2, content, allSelections)) continue
          if (Math.max(sel.startPosition, other.startPosition) < Math.min(sel.endPosition, other.endPosition)) return true
        }
      }
      // before/followedBy: simplified — just check position
      if (condition.type === 'before') {
        if (!selectionMatchesCondition(sel, cond.condition1, content, allSelections)) continue
        // Must not overlap any Condition 2
        let overlapsAny = false
        for (const other of allSelections) {
          if (!selectionMatchesCondition(other, cond.condition2, content, allSelections)) continue
          if (Math.max(sel.startPosition, other.startPosition) < Math.min(sel.endPosition, other.endPosition)) { overlapsAny = true; break }
        }
        if (overlapsAny) continue
        for (const other of allSelections) {
          if (!selectionMatchesCondition(other, cond.condition2, content, allSelections)) continue
          if (sel.endPosition <= other.startPosition) return true
        }
      }
      if (condition.type === 'followedBy') {
        if (!selectionMatchesCondition(sel, cond.condition1, content, allSelections)) continue
        // Must not overlap any Condition 2
        let overlapsAny = false
        for (const other of allSelections) {
          if (!selectionMatchesCondition(other, cond.condition2, content, allSelections)) continue
          if (Math.max(sel.startPosition, other.startPosition) < Math.min(sel.endPosition, other.endPosition)) { overlapsAny = true; break }
        }
        if (overlapsAny) continue
        for (const other of allSelections) {
          if (!selectionMatchesCondition(other, cond.condition2, content, allSelections)) continue
          if (sel.startPosition >= other.endPosition) return true
        }
      }
    }
    return false
  }

  const codeGuids = new Set(selection.codings.map((c) => c.codeGuid))
  const selText = content
    ? codepointSlice(content, selection.startPosition, selection.endPosition)
    : undefined
  return evaluateCondition(condition, codeGuids, selText, selection, allSelections, content)
}

/** Collect all matched code info from a condition tree (for display in results) */
function collectMatchedCodes(
  condition: CodeCondition,
  codeGuids: Set<string>,
  codeMap: Map<string, Code>
): QueryResult['matchedCodes'] {
  const matched: QueryResult['matchedCodes'] = []
  const seen = new Set<string>()
  for (const guid of codeGuids) {
    if (!seen.has(guid)) {
      seen.add(guid)
      const code = codeMap.get(guid)
      if (code) matched.push({ guid: code.guid, name: code.name, color: code.color })
    }
  }
  return matched
}

/**
 * For an overlap query, find the actual intersection ranges where both conditions apply.
 */
function findOverlapIntersections(
  condition: { type: 'overlap'; condition1: CodeCondition; condition2: CodeCondition },
  selection: PlainTextSelection,
  allSelections: PlainTextSelection[],
  source: TextSource,
  content: string,
  codeMap: Map<string, Code>
): QueryResult[] {
  if (!selectionMatchesCondition(selection, condition.condition1, content, allSelections)) return []

  const results: QueryResult[] = []
  const seenRanges = new Set<string>()

  for (const other of allSelections) {
    if (!selectionMatchesCondition(other, condition.condition2, content, allSelections)) continue
    // Compute intersection
    const intStart = Math.max(selection.startPosition, other.startPosition)
    const intEnd = Math.min(selection.endPosition, other.endPosition)
    if (intStart >= intEnd) continue

    // Deduplicate: same intersection range in the same source
    const rangeKey = `${source.guid}:${intStart}:${intEnd}`
    if (seenRanges.has(rangeKey)) continue
    seenRanges.add(rangeKey)

    const matchedText = codepointSlice(content, intStart, intEnd)
    const { before, after } = getContext(content, intStart, intEnd)
    const allCodes = new Set([
      ...selection.codings.map((c) => c.codeGuid),
      ...other.codings.map((c) => c.codeGuid)
    ])

    results.push({
      sourceGuid: source.guid,
      sourceName: source.name,
      selectionGuid: selection.guid,
      startPosition: intStart,
      endPosition: intEnd,
      matchedText,
      contextBefore: before,
      contextAfter: after,
      matchedCodes: collectMatchedCodes(condition.condition1, allCodes, codeMap)
    })
  }

  return results
}

/**
 * INSIDE: Condition 1 selections that are fully contained within a Condition 2 selection.
 */
function findInsideSelections(
  condition: { type: 'inside'; condition1: CodeCondition; condition2: CodeCondition },
  selection: PlainTextSelection,
  allSelections: PlainTextSelection[],
  source: TextSource,
  content: string,
  codeMap: Map<string, Code>
): QueryResult[] {
  if (!selectionMatchesCondition(selection, condition.condition1, content, allSelections)) return []

  for (const other of allSelections) {
    if (other === selection) continue // a selection cannot be "inside" itself
    if (!selectionMatchesCondition(other, condition.condition2, content, allSelections)) continue
    // Check if selection is fully inside other
    if (selection.startPosition >= other.startPosition && selection.endPosition <= other.endPosition) {
      return [buildResult(source, selection, content, new Set(selection.codings.map((c) => c.codeGuid)), codeMap)]
    }
  }
  return []
}

/**
 * OUTSIDE: Condition 1 selections that do NOT overlap with any Condition 2 selection.
 */
function findOutsideSelections(
  condition: { type: 'outside'; condition1: CodeCondition; condition2: CodeCondition },
  selection: PlainTextSelection,
  allSelections: PlainTextSelection[],
  source: TextSource,
  content: string,
  codeMap: Map<string, Code>
): QueryResult[] {
  if (!selectionMatchesCondition(selection, condition.condition1, content, allSelections)) return []

  for (const other of allSelections) {
    if (!selectionMatchesCondition(other, condition.condition2, content, allSelections)) continue
    // Check if there's any overlap
    const intStart = Math.max(selection.startPosition, other.startPosition)
    const intEnd = Math.min(selection.endPosition, other.endPosition)
    if (intStart < intEnd) return [] // overlaps, so not "outside"
  }
  return [buildResult(source, selection, content, new Set(selection.codings.map((c) => c.codeGuid)), codeMap)]
}

/**
 * BEFORE: Condition 1 selections that start before some Condition 2 selection starts.
 */
function findBeforeSelections(
  condition: { type: 'before'; condition1: CodeCondition; condition2: CodeCondition },
  selection: PlainTextSelection,
  allSelections: PlainTextSelection[],
  source: TextSource,
  content: string,
  codeMap: Map<string, Code>
): QueryResult[] {
  if (!selectionMatchesCondition(selection, condition.condition1, content, allSelections)) return []

  // First check: Condition 1 must not overlap with ANY Condition 2 selection
  for (const other of allSelections) {
    if (!selectionMatchesCondition(other, condition.condition2, content, allSelections)) continue
    const overlapStart = Math.max(selection.startPosition, other.startPosition)
    const overlapEnd = Math.min(selection.endPosition, other.endPosition)
    if (overlapStart < overlapEnd) return [] // overlaps — not "before"
  }

  // Second check: there must exist a Condition 2 selection that starts after Condition 1 ends
  for (const other of allSelections) {
    if (!selectionMatchesCondition(other, condition.condition2, content, allSelections)) continue
    if (selection.endPosition <= other.startPosition) {
      return [buildResult(source, selection, content, new Set(selection.codings.map((c) => c.codeGuid)), codeMap)]
    }
  }
  return []
}

/**
 * FOLLOWED BY: Condition 1 selections that come after some Condition 2 selection
 * (i.e. Input 2 appears first in the document, then Input 1 follows).
 */
function findFollowedBySelections(
  condition: { type: 'followedBy'; condition1: CodeCondition; condition2: CodeCondition },
  selection: PlainTextSelection,
  allSelections: PlainTextSelection[],
  source: TextSource,
  content: string,
  codeMap: Map<string, Code>
): QueryResult[] {
  if (!selectionMatchesCondition(selection, condition.condition1, content, allSelections)) return []

  // First check: Condition 1 must not overlap with ANY Condition 2 selection
  for (const other of allSelections) {
    if (!selectionMatchesCondition(other, condition.condition2, content, allSelections)) continue
    const overlapStart = Math.max(selection.startPosition, other.startPosition)
    const overlapEnd = Math.min(selection.endPosition, other.endPosition)
    if (overlapStart < overlapEnd) return [] // overlaps — not "after"
  }

  // Second check: there must exist a Condition 2 selection that ends before Condition 1 starts
  for (const other of allSelections) {
    if (!selectionMatchesCondition(other, condition.condition2, content, allSelections)) continue
    if (selection.startPosition >= other.endPosition) {
      return [buildResult(source, selection, content, new Set(selection.codings.map((c) => c.codeGuid)), codeMap)]
    }
  }
  return []
}

function buildResult(
  source: TextSource,
  selection: PlainTextSelection,
  content: string,
  codeGuids: Set<string>,
  codeMap: Map<string, Code>
): QueryResult {
  // Video-anchored selections store startPosition/endPosition as LINE
  // INDEXES, not codepoint offsets, so a plain codepointSlice would read
  // a nonsensical byte range. Compute matchedText from transcript lines
  // whose recorded lineTimes fall inside the selection's time range —
  // that's the canonical "text this code covers" for a video.
  let matchedText: string
  let before = ''
  let after = ''
  if (selection.timeRange) {
    const lineTimes = (source.formatData as { lineTimes?: Record<string, number> } | undefined)?.lineTimes
    const lines = content.split('\n')
    const matched: string[] = []
    if (lineTimes) {
      for (let i = 0; i < lines.length; i++) {
        const t = lineTimes[String(i)]
        if (t === undefined) continue
        // Half-open [startTime, endTime): a line whose time equals
        // endTime exactly belongs to the next code, not this one.
        if (t >= selection.timeRange.startTime && t < selection.timeRange.endTime - 1e-4) {
          matched.push(lines[i])
        }
      }
    }
    matchedText = matched.join('\n')
  } else {
    // Survey-cell selections: read from the cleaned cell text (the
    // text the user actually coded), not the raw CSV. Otherwise the
    // result snippet shows whatever bytes happen to live at those
    // offsets in the CSV — typically the file's header row.
    const sliceSource = textForSelection(source, selection, content)
    matchedText = codepointSlice(sliceSource, selection.startPosition, selection.endPosition)
    const ctx = getContext(sliceSource, selection.startPosition, selection.endPosition)
    before = ctx.before
    after = ctx.after
  }
  const matchedCodes: QueryResult['matchedCodes'] = []
  for (const guid of codeGuids) {
    const code = codeMap.get(guid)
    if (code) {
      matchedCodes.push({ guid: code.guid, name: code.name, color: code.color })
    }
  }
  return {
    sourceGuid: source.guid,
    sourceName: source.name,
    selectionGuid: selection.guid,
    startPosition: selection.startPosition,
    endPosition: selection.endPosition,
    matchedText,
    contextBefore: before,
    contextAfter: after,
    matchedCodes,
    timeRange: selection.timeRange,
    surveyCell: (selection as { surveyCell?: { respondentId: string; questionId: string } }).surveyCell
  }
}
