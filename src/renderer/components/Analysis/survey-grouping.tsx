import type { AnalysisInitData, SurveyEntityRef } from '../../models/types'
import type { GroupByEntry, GroupedHeader } from './group-by'
import { tagColumnSources } from './analysis-helpers'

/** One slot produced by the "Respondents" grouping: a single respondent
 *  of a survey, or the whole-survey subtotal. Tools map these into their
 *  own column / row / series shape. */
export interface RespondentSlot {
  id: string
  label: string
  surveyGuid: string
  /** undefined for the whole-survey subtotal slot. */
  respondentId?: string
  isSubtotal?: boolean
}

/** Of the given source guids, which are surveys. */
export function surveyGuidsAmong(
  sourceGuids: string[],
  data: Pick<AnalysisInitData, 'sources'>
): string[] {
  const surveys = new Set(data.sources.filter((s) => s.sourceType === 'survey').map((s) => s.guid))
  return sourceGuids.filter((g) => surveys.has(g))
}

/** Expand each in-scope survey into a band of respondent slots (one per
 *  respondent) plus an optional whole-survey subtotal. The header band
 *  carries the survey name. Surveys with no respondents are skipped. */
export function expandRespondentSlots(
  surveyGuids: string[],
  data: Pick<AnalysisInitData, 'sources' | 'surveyEntityLabels'>,
  includeSubtotals: boolean
): { slots: RespondentSlot[]; headers: GroupedHeader[] } {
  const slots: RespondentSlot[] = []
  const headers: GroupedHeader[] = []
  for (const sg of surveyGuids) {
    const respondents = data.surveyEntityLabels?.[sg]?.respondents ?? {}
    const ids = Object.keys(respondents)
    if (ids.length === 0) continue
    const surveyName = data.sources.find((s) => s.guid === sg)?.name || 'Survey'
    const before = slots.length
    for (const rid of ids) {
      slots.push({ id: `resp:${sg}:${rid}`, label: respondents[rid] || 'Respondent', surveyGuid: sg, respondentId: rid })
    }
    if (includeSubtotals) {
      slots.push({ id: `resp:${sg}:subtotal`, label: 'Subtotal', surveyGuid: sg, isSubtotal: true })
    }
    headers.push({ id: `survey:${sg}`, label: surveyName, span: slots.length - before })
  }
  return { slots, headers }
}

/** One analysis column/row produced from the group-by list. Shared by
 *  the grid tools (Codes in Documents, Results in Documents, Code
 *  Frequencies). `tagScopeGuids` narrows survey cells to a tag column;
 *  `respondentRef` narrows them to a single respondent column. */
export interface AnalysisColumn {
  id: string
  label: string
  sourceGuids: string[]
  isSubtotal?: boolean
  tagScopeGuids?: string[]
  respondentRef?: SurveyEntityRef
}

function descendantFolderGuids(folders: AnalysisInitData['folders'], rootGuid: string): Set<string> {
  const set = new Set<string>([rootGuid])
  let added = true
  while (added) {
    added = false
    for (const f of folders || []) {
      if (f.parentGuid && set.has(f.parentGuid) && !set.has(f.guid)) {
        set.add(f.guid)
        added = true
      }
    }
  }
  return set
}

/** The single, survey-aware column builder shared by every grid tool.
 *  Expands the group-by list into columns + spanning header bands:
 *    - tag → one column; category/folder → a band of columns (+ optional
 *      subtotal).
 *    - respondents is INVERTED and per survey: when a survey's entry is
 *      PRESENT that survey collapses to a single whole-survey total
 *      column; when it's ABSENT the survey expands into per-respondent
 *      bands (+ optional whole-survey subtotal). Entries are auto-added
 *      as surveys enter scope, so the default view is the collapsed
 *      total and removing a survey's chip reveals its respondents. Non-survey docs
 *      are unaffected and handled by the remaining grouping (or as
 *      individual columns).
 *  Each tool maps these columns into its own cell computation. */
export function buildSurveyAwareColumns(
  groupBy: GroupByEntry[],
  data: AnalysisInitData,
  candidateSourceGuids: string[],
  sourceMap: Map<string, string>,
  opts?: { includeSubtotals?: boolean }
): { columns: AnalysisColumn[]; headerGroups: GroupedHeader[]; hasGroupedHeader: boolean } {
  const includeSubtotals = opts?.includeSubtotals !== false
  const columns: AnalysisColumn[] = []
  const groups: GroupedHeader[] = []
  // Inverted Respondents semantics, per survey: a survey's entry
  // COLLAPSES it into a single total column; its absence EXPANDS the
  // survey into per-respondent bands (the detailed view). Entries are
  // auto-added as surveys enter scope, so the collapsed total is the
  // default. An entry without a surveyGuid collapses every survey.
  const collapseAll = groupBy.some((e) => e.kind === 'respondents' && !e.surveyGuid)
  const collapsed = new Set(groupBy.flatMap((e) => (e.kind === 'respondents' && e.surveyGuid ? [e.surveyGuid] : [])))
  const surveyGuids = collapseAll ? [] : surveyGuidsAmong(candidateSourceGuids, data).filter((g) => !collapsed.has(g))
  const expandSurveys = surveyGuids.length > 0
  const surveySet = new Set(surveyGuids)
  const docCandidates = candidateSourceGuids.filter((g) => !surveySet.has(g))
  // Notebook chips are folder entries, but they work like Respondents
  // (below), not like an ordinary folder's band.
  const notebooks = (data.folders || []).filter((f) => f.kind === 'notebook')
  const notebookGuids = new Set(notebooks.map((f) => f.guid))
  const isNotebookEntry = (e: GroupByEntry) => e.kind === 'folder' && notebookGuids.has(e.folderGuid)
  const otherEntries = groupBy.filter((e) => e.kind !== 'respondents' && !isNotebookEntry(e))

  if (expandSurveys) {
    const { slots, headers } = expandRespondentSlots(surveyGuids, data, includeSubtotals)
    for (const s of slots) {
      columns.push({
        id: s.id,
        label: s.label,
        sourceGuids: [s.surveyGuid],
        isSubtotal: s.isSubtotal,
        respondentRef: s.respondentId ? { sourceGuid: s.surveyGuid, id: s.respondentId } : undefined
      })
    }
    groups.push(...headers)
  }
  // Notebooks group their notes the way surveys group respondents: a
  // notebook's chip COLLAPSES it into one total column; without the chip
  // it EXPANDS into a band of its notes (newest first — a note's name
  // starts with its YYMMDD HH:MM stamp) under the notebook's name, with
  // an optional subtotal.
  const collapsedNotebooks = new Set(groupBy.flatMap((e) => (e.kind === 'folder' && notebookGuids.has(e.folderGuid) ? [e.folderGuid] : [])))
  for (const nb of notebooks) {
    const notes = candidateSourceGuids
      .filter((g) => data.sourceFolder?.[g] === nb.guid)
      .sort((a, b) => (sourceMap.get(b) || '').localeCompare(sourceMap.get(a) || ''))
    if (notes.length === 0) continue
    if (collapsedNotebooks.has(nb.guid)) {
      columns.push({ id: `notebook:${nb.guid}`, label: nb.name, sourceGuids: notes })
      groups.push({ id: `notebook:${nb.guid}`, label: null, span: 1 })
      continue
    }
    const before = columns.length
    for (const g of notes) {
      columns.push({ id: `notebook:${nb.guid}:note:${g}`, label: sourceMap.get(g) || 'Note', sourceGuids: [g] })
    }
    if (includeSubtotals) {
      columns.push({ id: `notebook:${nb.guid}:subtotal`, label: 'Subtotal', sourceGuids: notes, isSubtotal: true })
    }
    groups.push({ id: `notebook:${nb.guid}`, label: nb.name, span: columns.length - before })
  }
  for (const entry of otherEntries) {
    if (entry.kind === 'tag') {
      const tag = data.tags.find((t) => t.guid === entry.tagGuid)
      if (!tag) continue
      const members = tagColumnSources(data, entry.tagGuid, docCandidates)
      columns.push({ id: `tag:${entry.tagGuid}`, label: tag.value || tag.name || 'Tag', sourceGuids: members, tagScopeGuids: [entry.tagGuid] })
      groups.push({ id: `tag:${entry.tagGuid}`, label: null, span: 1 })
    } else if (entry.kind === 'category') {
      const cat = data.categories.find((c) => c.guid === entry.categoryGuid)
      if (!cat) continue
      const childTags = data.tags.filter((t) => t.categoryGuid === entry.categoryGuid)
      if (childTags.length === 0) continue
      const before = columns.length
      for (const tag of childTags) {
        const members = tagColumnSources(data, tag.guid, docCandidates)
        columns.push({ id: `cat:${entry.categoryGuid}:tag:${tag.guid}`, label: tag.value || tag.name || 'Tag', sourceGuids: members, tagScopeGuids: [tag.guid] })
      }
      if (includeSubtotals) {
        const subtotalSet = new Set<string>()
        for (const tag of childTags) for (const g of tagColumnSources(data, tag.guid, docCandidates)) subtotalSet.add(g)
        columns.push({ id: `cat:${entry.categoryGuid}:subtotal`, label: 'Subtotal', sourceGuids: [...subtotalSet], isSubtotal: true, tagScopeGuids: childTags.map((t) => t.guid) })
      }
      groups.push({ id: `cat:${entry.categoryGuid}`, label: cat.name, span: columns.length - before })
    } else if (entry.kind === 'folder') {
      const folder = (data.folders || []).find((f) => f.guid === entry.folderGuid)
      if (!folder) continue
      const folderSet = descendantFolderGuids(data.folders || [], entry.folderGuid)
      const folderDocs = docCandidates.filter((g) => {
        const fg = data.sourceFolder?.[g]
        return fg ? folderSet.has(fg) : false
      })
      if (folderDocs.length === 0) continue
      const before = columns.length
      for (const docGuid of folderDocs) {
        columns.push({ id: `folder:${entry.folderGuid}:doc:${docGuid}`, label: sourceMap.get(docGuid) || 'Document', sourceGuids: [docGuid] })
      }
      if (includeSubtotals) {
        columns.push({ id: `folder:${entry.folderGuid}:subtotal`, label: 'Subtotal', sourceGuids: [...folderDocs], isSubtotal: true })
      }
      groups.push({ id: `folder:${entry.folderGuid}`, label: folder.name, span: columns.length - before })
    }
  }
  // Documents that landed in no group. Only a grouping the user chose — a
  // tag, category or ordinary folder — gathers them into one "Other"
  // column; notebook and Respondents chips leave them as individual
  // columns, so a project's notebooks and surveys don't change how its
  // other documents are laid out. A collapsed survey always keeps its own
  // total column. Notes are always shown with their notebook (above).
  const grouped = new Set(columns.filter((c) => !c.isSubtotal && !c.respondentRef).flatMap((c) => c.sourceGuids))
  const ungrouped = docCandidates.filter((g) => !grouped.has(g) && !notebookGuids.has(data.sourceFolder?.[g] ?? ''))
  const gatherOther = otherEntries.length > 0
  const surveysLeft = new Set(surveyGuidsAmong(ungrouped, data))
  const otherGuids: string[] = []
  for (const g of ungrouped) {
    if (gatherOther && !surveysLeft.has(g)) {
      otherGuids.push(g)
      continue
    }
    columns.push({ id: g, label: sourceMap.get(g) || 'Document', sourceGuids: [g] })
    groups.push({ id: g, label: null, span: 1 })
  }
  if (otherGuids.length > 0) {
    columns.push({ id: '__other', label: 'Other', sourceGuids: otherGuids })
    groups.push({ id: '__other', label: null, span: 1 })
  }
  const hasGroupedHeader = groups.some((g) => g.label !== null)
  return { columns, headerGroups: groups, hasGroupedHeader }
}

/** A question the analysis is scoped to. `label` is a drag-time snapshot
 *  used as a fallback when the live survey snapshot can't resolve it. */
export interface QuestionScopeRef extends SurveyEntityRef {
  label?: string
}

/** Read a drag event and return the survey-question(s) it carries. The
 *  Document Browser emits `{ kind: 'survey-question', entityGuid,
 *  surveyGuid, label }` as application/json. */
export function parseQuestionDrop(e: React.DragEvent): QuestionScopeRef[] {
  const raw = e.dataTransfer.getData('application/json')
  if (!raw) return []
  try {
    const p = JSON.parse(raw) as { kind?: string; entityGuid?: string; surveyGuid?: string; label?: string }
    if (p.kind === 'survey-question' && p.surveyGuid && p.entityGuid) {
      return [{ sourceGuid: p.surveyGuid, id: p.entityGuid, label: p.label }]
    }
  } catch { /* ignore */ }
  return []
}

/** Read a drag event and return the survey-respondent(s) it carries. The
 *  Document Browser emits `{ kind: 'survey-respondent', entityGuid,
 *  surveyGuid, label }` as application/json (same envelope as a
 *  question, distinguished by `kind`). */
export function parseRespondentDrop(e: React.DragEvent): QuestionScopeRef[] {
  const raw = e.dataTransfer.getData('application/json')
  if (!raw) return []
  try {
    const p = JSON.parse(raw) as { kind?: string; entityGuid?: string; surveyGuid?: string; label?: string }
    if (p.kind === 'survey-respondent' && p.surveyGuid && p.entityGuid) {
      return [{ sourceGuid: p.surveyGuid, id: p.entityGuid, label: p.label }]
    }
  } catch { /* ignore */ }
  return []
}
