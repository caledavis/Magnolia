import { useState } from 'react'
import type { AnalysisInitData, SurveyEntityRef } from '../../models/types'
import type { GroupByEntry, GroupedHeader } from './group-by'
import { Icon, faXmark, faQuestion, faUser } from '../Icon'
import { truncate, tagColumnSources } from './analysis-helpers'

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

/** True when any of the given source guids is a survey — used to decide
 *  whether to auto-add Respondents grouping / show the Questions box. */
export function hasSurveyInScope(
  sourceGuids: string[],
  data: Pick<AnalysisInitData, 'sources'>
): boolean {
  return surveyGuidsAmong(sourceGuids, data).length > 0
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
 *    - respondents is INVERTED: when the entry is PRESENT each in-scope
 *      survey collapses to a single whole-survey total column; when it's
 *      ABSENT the survey expands into per-respondent bands (+ optional
 *      whole-survey subtotal). The entry is auto-added when a survey
 *      enters scope, so the default view is the collapsed total and
 *      removing it reveals the individual respondents. Non-survey docs
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
  // Inverted Respondents semantics: the entry COLLAPSES each in-scope
  // survey into a single total column; its absence EXPANDS the survey
  // into per-respondent bands (the detailed view). It's auto-added when
  // a survey enters scope, so the collapsed total is the default.
  const respondentsGrouped = groupBy.some((e) => e.kind === 'respondents')
  const expandSurveys = !respondentsGrouped
  const surveyGuids = expandSurveys ? surveyGuidsAmong(candidateSourceGuids, data) : []
  const surveySet = new Set(surveyGuids)
  const docCandidates = candidateSourceGuids.filter((g) => !surveySet.has(g))
  const otherEntries = groupBy.filter((e) => e.kind !== 'respondents')

  if (expandSurveys && surveyGuids.length > 0) {
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
  if (otherEntries.length > 0) {
    // "Other" catch-all for non-survey docs that landed in no group.
    const taggedGuids = new Set(columns.filter((c) => !c.isSubtotal && !c.respondentRef).flatMap((c) => c.sourceGuids))
    const otherGuids = docCandidates.filter((g) => !taggedGuids.has(g))
    if (otherGuids.length > 0) {
      columns.push({ id: '__other', label: 'Other', sourceGuids: otherGuids })
      groups.push({ id: '__other', label: null, span: 1 })
    }
  } else {
    // No tag/category/folder grouping: each remaining candidate becomes
    // its own column. With surveys collapsed (Respondents grouped) this
    // yields one survey-total column per survey; with surveys expanded
    // only the non-survey docs remain here.
    for (const g of docCandidates) {
      columns.push({ id: g, label: sourceMap.get(g) || 'Document', sourceGuids: [g] })
      groups.push({ id: g, label: null, span: 1 })
    }
  }
  const hasGroupedHeader = groups.some((g) => g.label !== null)
  return { columns, headerGroups: groups, hasGroupedHeader }
}

/** A question the analysis is scoped to. `label` is a drag-time snapshot
 *  used as a fallback when the live survey snapshot can't resolve it. */
export interface QuestionScopeRef extends SurveyEntityRef {
  label?: string
}

/** Stable key for a question scope ref. */
export function questionScopeKey(r: SurveyEntityRef): string {
  return `${r.sourceGuid}:${r.id}`
}

/** True if the drag could be a survey-question (payload is JSON; the
 *  actual kind is only readable on drop, so this is permissive for the
 *  drag-over highlight). */
export function isQuestionDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes('application/json')
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

/** Drop zone for scoping a survey analysis to specific questions. Empty
 *  = all questions. Drag question nodes from the Document Browser in.
 *  Mirrors the "Group by" section's styling and drag-over overlay. */
export function QuestionScopeBox({
  value,
  onChange,
  data
}: {
  value: QuestionScopeRef[]
  onChange: (next: QuestionScopeRef[]) => void
  data: Pick<AnalysisInitData, 'surveyEntityLabels'>
}) {
  const [over, setOver] = useState(false)
  const remove = (r: SurveyEntityRef) =>
    onChange(value.filter((v) => questionScopeKey(v) !== questionScopeKey(r)))
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setOver(false)
    const fresh = parseQuestionDrop(e)
    if (fresh.length === 0) return
    const seen = new Set(value.map(questionScopeKey))
    const additions = fresh.filter((f) => !seen.has(questionScopeKey(f)))
    if (additions.length > 0) onChange([...value, ...additions])
  }
  return (
    <div
      className="analysis-section"
      style={{ marginBottom: 14, position: 'relative' }}
      onDragOver={(e) => {
        if (isQuestionDrag(e)) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setOver(true)
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: value.length > 0 ? 8 : 0, position: 'relative', zIndex: 1 }}>
        <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--text-secondary)' }}>Questions</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {value.length > 0 ? 'Analysis limited to these questions' : 'Drag survey questions here to scope (default: all)'}
        </span>
      </div>
      {value.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', position: 'relative', zIndex: 1 }}>
          {value.map((r) => {
            const live = data.surveyEntityLabels?.[r.sourceGuid]?.questions?.[r.id]
            return (
              <span key={questionScopeKey(r)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, background: 'var(--bg-tertiary)', padding: '2px 8px', borderRadius: 'var(--radius-sm)' }}>
                <Icon icon={faQuestion} style={{ fontSize: 10, color: 'var(--text-muted)' }} />
                {truncate(live || r.label || 'Question', 40)}
                <span onClick={() => remove(r)} style={{ fontSize: 9, color: 'var(--text-muted)', cursor: 'pointer' }}><Icon icon={faXmark} /></span>
              </span>
            )
          })}
        </div>
      )}
      {over && (
        <div style={{
          position: 'absolute', inset: 0,
          background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
          border: '2px dashed var(--accent)',
          borderRadius: 'var(--radius-md)',
          pointerEvents: 'none'
        }} />
      )}
    </div>
  )
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

/** Drop zone for scoping a query to specific survey respondents. Empty =
 *  all respondents. Drag respondent nodes from the Document Browser in.
 *  Mirrors QuestionScopeBox; reuses QuestionScopeRef (a labelled
 *  SurveyEntityRef) and the shared scope-key/drag helpers. */
export function RespondentScopeBox({
  value,
  onChange,
  data
}: {
  value: QuestionScopeRef[]
  onChange: (next: QuestionScopeRef[]) => void
  data: Pick<AnalysisInitData, 'surveyEntityLabels'>
}) {
  const [over, setOver] = useState(false)
  const remove = (r: SurveyEntityRef) =>
    onChange(value.filter((v) => questionScopeKey(v) !== questionScopeKey(r)))
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setOver(false)
    const fresh = parseRespondentDrop(e)
    if (fresh.length === 0) return
    const seen = new Set(value.map(questionScopeKey))
    const additions = fresh.filter((f) => !seen.has(questionScopeKey(f)))
    if (additions.length > 0) onChange([...value, ...additions])
  }
  return (
    <div
      className="analysis-section"
      style={{ marginBottom: 14, position: 'relative' }}
      onDragOver={(e) => {
        if (isQuestionDrag(e)) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setOver(true)
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: value.length > 0 ? 8 : 0, position: 'relative', zIndex: 1 }}>
        <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--text-secondary)' }}>Respondents</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {value.length > 0 ? 'Limited to these respondents' : 'Drag survey respondents here to scope (default: all)'}
        </span>
      </div>
      {value.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', position: 'relative', zIndex: 1 }}>
          {value.map((r) => {
            const live = data.surveyEntityLabels?.[r.sourceGuid]?.respondents?.[r.id]
            return (
              <span key={questionScopeKey(r)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, background: 'var(--bg-tertiary)', padding: '2px 8px', borderRadius: 'var(--radius-sm)' }}>
                <Icon icon={faUser} style={{ fontSize: 10, color: 'var(--text-muted)' }} />
                {truncate(live || r.label || 'Respondent', 40)}
                <span onClick={() => remove(r)} style={{ fontSize: 9, color: 'var(--text-muted)', cursor: 'pointer' }}><Icon icon={faXmark} /></span>
              </span>
            )
          })}
        </div>
      )}
      {over && (
        <div style={{
          position: 'absolute', inset: 0,
          background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
          border: '2px dashed var(--accent)',
          borderRadius: 'var(--radius-md)',
          pointerEvents: 'none'
        }} />
      )}
    </div>
  )
}
