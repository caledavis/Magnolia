/**
 * Where each memo lives, for the Memos window: the group it is listed
 * under (the project, a document, saved queries, saved analyses or a
 * relationship map) and a short description of what it is attached to.
 *
 * Pure, so the main window can work it out and send it with the memos:
 * the Memos window has no project stores of its own.
 */
import type { Memo, SavedAnalysis, SavedQuery, SurveyData, TextSource } from '../models/types'

export interface MemoPlace {
  /** Memos with the same key are listed together. */
  groupKey: string
  groupLabel: string
  /** Groups are listed by this, then by label. */
  groupOrder: number
  /** What the memo is attached to, e.g. "Selection: “I worked two jobs…”". */
  detail: string
  /** Whether Show can take the user to it in the main window. */
  canShow: boolean
}

export interface MemoLookups {
  sources: Pick<TextSource, 'guid' | 'name' | 'plainTextContent' | 'formatData'>[]
  savedQueries: Pick<SavedQuery, 'guid' | 'name'>[]
  savedAnalyses: Pick<SavedAnalysis, 'guid' | 'name' | 'toolType'>[]
  /** Each document's text, by guid (the document store keeps it apart
   *  from the sources), for the excerpts of selection memos. */
  contents?: Record<string, string>
}

export const GROUP_ORDER = { project: 0, document: 1, query: 2, analysis: 3, map: 4, other: 5 } as const

const EXCERPT = 60

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > EXCERPT ? flat.slice(0, EXCERPT - 1).trimEnd() + '…' : flat
}

function surveyOf(source: MemoLookups['sources'][number] | undefined): SurveyData | undefined {
  return source?.formatData?.survey
}

/** Builds the lookups once and returns a function giving each memo's place. */
export function memoPlacer(lookups: MemoLookups): (memo: Memo) => MemoPlace {
  const sources = new Map(lookups.sources.map((s) => [s.guid, s]))
  const queries = new Map(lookups.savedQueries.map((q) => [q.guid, q.name]))
  const analyses = new Map(lookups.savedAnalyses.map((a) => [a.guid, a]))

  const inDocument = (sourceGuid: string | undefined, detail: string, canShow = true): MemoPlace => {
    const source = sourceGuid ? sources.get(sourceGuid) : undefined
    if (!source) return { groupKey: 'missing', groupLabel: 'Deleted documents', groupOrder: GROUP_ORDER.other, detail, canShow: false }
    return { groupKey: `doc:${source.guid}`, groupLabel: source.name, groupOrder: GROUP_ORDER.document, detail, canShow }
  }
  const question = (survey: SurveyData | undefined, id: string | undefined) =>
    survey?.questions.find((q) => q.id === id)?.text || 'a question'
  const respondent = (survey: SurveyData | undefined, id: string | undefined) =>
    survey?.respondents.find((r) => r.id === id)?.displayName || 'a respondent'

  return (memo) => {
    switch (memo.type) {
      case 'project':
        return { groupKey: 'project', groupLabel: 'Project', groupOrder: GROUP_ORDER.project, detail: 'Project memo', canShow: false }
      case 'document': {
        const [first, ...rest] = memo.sourceGuids ?? []
        const also = rest.length ? ` (also on ${rest.length} other document${rest.length === 1 ? '' : 's'})` : ''
        return inDocument(first, `Document memo${also}`)
      }
      case 'survey-question': {
        const survey = surveyOf(sources.get(memo.sourceGuid ?? ''))
        return inDocument(memo.sourceGuid, `Question: ${excerpt(question(survey, memo.questionGuid))}`)
      }
      case 'survey-respondent': {
        const survey = surveyOf(sources.get(memo.sourceGuid ?? ''))
        return inDocument(memo.sourceGuid, `Respondent: ${respondent(survey, memo.respondentId)}`)
      }
      case 'survey-cell':
      case 'content': {
        const source = sources.get(memo.sourceGuid ?? '')
        if (memo.surveyCell) {
          const survey = surveyOf(source)
          const who = respondent(survey, memo.surveyCell.respondentId)
          const what = excerpt(question(survey, memo.surveyCell.questionId))
          return inDocument(memo.sourceGuid, `${memo.type === 'content' ? 'Selection in the answer' : 'Answer'} of ${who} to ${what}`)
        }
        if (memo.pdfRegion) return inDocument(memo.sourceGuid, `Region on page ${memo.pdfRegion.page}`)
        const text = lookups.contents?.[memo.sourceGuid ?? ''] ?? source?.plainTextContent
        const start = memo.startPosition, end = memo.endPosition
        const chosen = text && start !== undefined && end !== undefined && end > start ? excerpt(text.slice(start, end)) : ''
        return inDocument(memo.sourceGuid, chosen ? `Selection: “${chosen}”` : 'Selection')
      }
      case 'saved-query': {
        const name = queries.get(memo.queryGuid ?? '')
        return { groupKey: 'queries', groupLabel: 'Saved Queries', groupOrder: GROUP_ORDER.query, detail: name ? `Query: ${name}` : 'A deleted query', canShow: false }
      }
      case 'saved-analysis': {
        const name = analyses.get(memo.analysisGuid ?? '')?.name
        return { groupKey: 'analyses', groupLabel: 'Saved Analyses', groupOrder: GROUP_ORDER.analysis, detail: name ? `Analysis: ${name}` : 'A deleted analysis', canShow: false }
      }
      case 'analysis': {
        const map = analyses.get(memo.analysisGuid ?? '')
        const name = map?.name?.trim() || 'Untitled map'
        return { groupKey: `map:${memo.analysisGuid ?? ''}`, groupLabel: `Map: ${name}`, groupOrder: GROUP_ORDER.map, detail: 'Relationship map memo', canShow: false }
      }
      default:
        return { groupKey: 'other', groupLabel: 'Other', groupOrder: GROUP_ORDER.other, detail: 'Memo', canShow: false }
    }
  }
}

export interface MemoGroup {
  key: string
  label: string
  memos: Memo[]
}

/** The memos in their groups: groups in order, memos newest first. */
export function groupMemos(memos: Memo[], places: Record<string, MemoPlace>): MemoGroup[] {
  const groups = new Map<string, { label: string; order: number; memos: Memo[] }>()
  for (const m of memos) {
    const p = places[m.guid]
    if (!p) continue
    let g = groups.get(p.groupKey)
    if (!g) groups.set(p.groupKey, (g = { label: p.groupLabel, order: p.groupOrder, memos: [] }))
    g.memos.push(m)
  }
  const newest = (m: Memo) => m.modifiedDateTime ?? m.createdDateTime
  return [...groups.entries()]
    .sort(([, a], [, b]) => a.order - b.order || a.label.localeCompare(b.label))
    .map(([key, g]) => ({ key, label: g.label, memos: g.memos.sort((a, b) => newest(b).localeCompare(newest(a))) }))
}

/** Whether a memo matches the search: in its title, its text or what it
 *  is attached to. */
export function memoMatches(memo: Memo, place: MemoPlace | undefined, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [memo.title || 'Untitled Memo', memo.content, place?.detail ?? '', place?.groupLabel ?? '']
    .some((s) => s.toLowerCase().includes(q))
}
