/**
 * Framework Matrix — pure model shared by the on-screen tool and the
 * report renderer. Rows are documents / survey respondents / survey
 * questions, either
 * dropped individually or nested under a dropped tag, tag category or
 * folder; columns are codes. Each cell holds the user's free-text
 * summary of what that code looks like in that row.
 *
 * Summaries are keyed by ROW IDENTITY (a document, respondent, question, or
 * group), not by where the row appears, so a document listed under two
 * tags shares one set of cells.
 *
 * Group membership is resolved live from the tag / folder data, so the
 * nested rows follow later tagging changes. A member that has had a
 * summary written for it is remembered on its group entry (`kept`); if
 * it later leaves the group while its summaries still have text, it
 * stays in the group as an orphaned row instead of silently vanishing.
 */
import type { AnalysisInitData, SurveyCellScopeArgs, SurveyEntityRef } from '../../models/types'

/** One thing the user dropped into the rows area. A group's
 *  `sourceGuids`, when set, limits it to those documents — set when the
 *  matrix is opened from a Codes in Documents grid whose document
 *  selection left some of the group's members out. */
export type SummaryRowEntry =
  | { kind: 'doc'; sourceGuid: string; name?: string }
  | { kind: 'respondent'; sourceGuid: string; respondentId: string; name?: string }
  | { kind: 'question'; sourceGuid: string; questionId: string; name?: string }
  | { kind: 'tag'; tagGuid: string; name?: string; kept?: string[]; sourceGuids?: string[] }
  | { kind: 'category'; categoryGuid: string; name?: string; kept?: string[]; sourceGuids?: string[] }
  | { kind: 'folder'; folderGuid: string; name?: string; kept?: string[]; sourceGuids?: string[] }

export interface FrameworkMatrixConfig {
  rows: SummaryRowEntry[]
  codeGuids: string[]
  /** Cell text keyed by summaryKey(rowKey, codeGuid). */
  summaries: Record<string, string>
  /** Display paths of collapsed groups. */
  collapsed: string[]
}

export type RowIcon = 'doc' | 'respondent' | 'question' | 'tag' | 'category' | 'folder'

export type GroupKind = 'tag' | 'category' | 'folder'

/** The documents and survey cells a row covers. A survey listed in
 *  `docs` is covered whole; `respondents` and `questions` only ever name
 *  entities of surveys NOT in `docs`, and a survey cell is covered when
 *  its respondent OR its question is listed. Group rows built from tags
 *  also carry `tagGuids`, which express that same union as a query
 *  filter. */
export interface RowScope {
  docs: string[]
  respondents: SurveyEntityRef[]
  questions: SurveyEntityRef[]
  tagGuids?: string[]
}

function docScope(sourceGuid: string): RowScope {
  return { docs: [sourceGuid], respondents: [], questions: [] }
}

export interface DisplayRow {
  /** Unique display path (a row can appear under several groups). */
  path: string
  /** Identity the row's summaries are stored under. */
  key: string
  depth: number
  label: string
  /** Secondary text shown under the label — a respondent's or
   *  question's survey. */
  detail?: string
  icon: RowIcon
  isGroup: boolean
  /** Index into config.rows for top-level rows (removable). */
  entryIndex?: number
  /** Number of leaf rows (groups only). */
  memberCount?: number
  /** Set on a member that has left its group but still has summaries:
   *  the kind of group it left. */
  orphanOf?: GroupKind
  /** Document / survey entity / tag no longer exists in the project. */
  missing?: boolean
  scope: RowScope
}

export type SummaryData = Pick<
  AnalysisInitData,
  'sources' | 'tags' | 'categories' | 'folders' | 'sourceFolder' | 'tagMembers'
  | 'respondentTagMembers' | 'questionTagMembers' | 'surveyEntityLabels' | 'sourceSelections'
>

/** Shown on orphaned rows, worded for the kind of group they left. */
export function orphanNote(kind: GroupKind): string {
  switch (kind) {
    case 'tag': return 'No longer has this tag'
    case 'category': return 'No longer has a tag in this category'
    case 'folder': return 'No longer in this folder'
  }
}

/** A row's label with its detail, for plain-text output (CSV, report). */
export function fullLabel(row: Pick<DisplayRow, 'label' | 'detail' | 'orphanOf'>): string {
  const base = row.detail ? `${row.label} (${row.detail})` : row.label
  return row.orphanOf ? `${base} (${orphanNote(row.orphanOf).toLowerCase()})` : base
}

export function summaryKey(rowKey: string, codeGuid: string): string {
  return `${rowKey}|${codeGuid}`
}

export function docKey(sourceGuid: string): string {
  return `doc:${sourceGuid}`
}

export function respondentKey(sourceGuid: string, respondentId: string): string {
  return `resp:${sourceGuid}:${respondentId}`
}

export function questionKey(sourceGuid: string, questionId: string): string {
  return `quest:${sourceGuid}:${questionId}`
}

/** Identity of a top-level entry — used for dedup on drop and as the
 *  summary key of group header rows. */
export function entryKey(e: SummaryRowEntry): string {
  switch (e.kind) {
    case 'doc': return docKey(e.sourceGuid)
    case 'respondent': return respondentKey(e.sourceGuid, e.respondentId)
    case 'question': return questionKey(e.sourceGuid, e.questionId)
    case 'tag': return `tag:${e.tagGuid}`
    case 'category': return `category:${e.categoryGuid}`
    case 'folder': return `folder:${e.folderGuid}`
  }
}

/** Move the item at `from` so it lands before the item currently at
 *  `insertAt` (`insertAt === arr.length` moves it to the end). Returns
 *  the same array when the move is a no-op. */
export function moveItem<T>(arr: T[], from: number, insertAt: number): T[] {
  const to = insertAt > from ? insertAt - 1 : insertAt
  if (from < 0 || from >= arr.length || to === from) return arr
  const next = arr.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/** Append entries, skipping any already present. */
export function mergeRowEntries(prev: SummaryRowEntry[], fresh: SummaryRowEntry[]): SummaryRowEntry[] {
  const seen = new Set(prev.map(entryKey))
  const additions = fresh.filter((e) => {
    const k = entryKey(e)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return additions.length > 0 ? [...prev, ...additions] : prev
}

export function hasSummaryText(summaries: Record<string, string>, rowKey: string, codeGuids: string[]): boolean {
  return codeGuids.some((cg) => (summaries[summaryKey(rowKey, cg)] ?? '').trim() !== '')
}

interface Leaf {
  key: string
  label: string
  detail?: string
  icon: RowIcon
  scope: RowScope
  missing?: boolean
}

function respondentLabel(data: SummaryData, sourceGuid: string, respondentId: string, fallback?: string): string {
  return data.surveyEntityLabels?.[sourceGuid]?.respondents?.[respondentId] || fallback || 'Respondent'
}

function questionLabel(data: SummaryData, sourceGuid: string, questionId: string, fallback?: string): string {
  return data.surveyEntityLabels?.[sourceGuid]?.questions?.[questionId] || fallback || 'Question'
}

function respondentLeaf(data: SummaryData, sourceNames: Map<string, string>, sourceGuid: string, respondentId: string, fallback?: string): Leaf {
  const surveyName = sourceNames.get(sourceGuid)
  return {
    key: respondentKey(sourceGuid, respondentId),
    label: respondentLabel(data, sourceGuid, respondentId, fallback),
    detail: surveyName,
    icon: 'respondent',
    scope: { docs: [], respondents: [{ sourceGuid, id: respondentId }], questions: [] },
    missing: surveyName === undefined
  }
}

function questionLeaf(data: SummaryData, sourceNames: Map<string, string>, sourceGuid: string, questionId: string, fallback?: string): Leaf {
  const surveyName = sourceNames.get(sourceGuid)
  return {
    key: questionKey(sourceGuid, questionId),
    label: questionLabel(data, sourceGuid, questionId, fallback),
    detail: surveyName,
    icon: 'question',
    scope: { docs: [], respondents: [], questions: [{ sourceGuid, id: questionId }] },
    missing: surveyName === undefined
  }
}

/** Rebuild a leaf from its key alone (orphans carry nothing else). */
function leafFromKey(data: SummaryData, sourceNames: Map<string, string>, key: string): Leaf {
  if (key.startsWith('resp:') || key.startsWith('quest:')) {
    const [kind, sourceGuid, ...rest] = key.split(':')
    const id = rest.join(':')
    return kind === 'resp'
      ? respondentLeaf(data, sourceNames, sourceGuid, id)
      : questionLeaf(data, sourceNames, sourceGuid, id)
  }
  const sourceGuid = key.slice('doc:'.length)
  const name = sourceNames.get(sourceGuid)
  return { key, label: name ?? 'Deleted document', icon: 'doc', scope: docScope(sourceGuid), missing: name === undefined }
}

/** A tag's members as leaves, in Document Browser order: whole
 *  documents first, then the respondents and questions of surveys tagged
 *  per entity (skipping surveys already tagged whole). */
function tagLeaves(data: SummaryData, sourceNames: Map<string, string>, tagGuid: string): Leaf[] {
  const members = new Set(data.tagMembers[tagGuid] || [])
  const leaves: Leaf[] = []
  for (const s of data.sources) {
    if (members.has(s.guid)) leaves.push({ key: docKey(s.guid), label: s.name, icon: 'doc', scope: docScope(s.guid) })
  }
  const partial = (r: SurveyEntityRef) => !members.has(r.sourceGuid) && sourceNames.has(r.sourceGuid)
  for (const r of (data.respondentTagMembers?.[tagGuid] || []).filter(partial)) {
    leaves.push(respondentLeaf(data, sourceNames, r.sourceGuid, r.id))
  }
  for (const q of (data.questionTagMembers?.[tagGuid] || []).filter(partial)) {
    leaves.push(questionLeaf(data, sourceNames, q.sourceGuid, q.id))
  }
  return leaves
}

function folderLeaves(data: SummaryData, folderGuid: string): Leaf[] {
  const set = new Set<string>([folderGuid])
  let added = true
  while (added) {
    added = false
    for (const f of data.folders || []) {
      if (f.parentGuid && set.has(f.parentGuid) && !set.has(f.guid)) {
        set.add(f.guid)
        added = true
      }
    }
  }
  return data.sources
    .filter((s) => {
      const fg = data.sourceFolder?.[s.guid]
      return fg ? set.has(fg) : false
    })
    .map((s) => ({ key: docKey(s.guid), label: s.name, icon: 'doc' as const, scope: docScope(s.guid) }))
}

/** A group's leaves, narrowed to its document limit if it has one. */
function limitLeaves(leaves: Leaf[], sourceGuids: string[] | undefined): Leaf[] {
  if (!sourceGuids) return leaves
  const allowed = new Set(sourceGuids)
  return leaves.filter((l) => {
    const sg = l.scope.docs[0] ?? l.scope.respondents[0]?.sourceGuid ?? l.scope.questions[0]?.sourceGuid
    return sg !== undefined && allowed.has(sg)
  })
}

/** Union several scopes, keeping the invariant that a survey covered
 *  whole never also lists individual respondents or questions. */
export function unionScopes(scopes: RowScope[], tagGuids?: string[]): RowScope {
  const docs = new Set<string>()
  for (const s of scopes) for (const d of s.docs) docs.add(d)
  const entities = (pick: (s: RowScope) => SurveyEntityRef[]): SurveyEntityRef[] => {
    const seen = new Set<string>()
    const out: SurveyEntityRef[] = []
    for (const s of scopes) {
      for (const r of pick(s)) {
        const k = `${r.sourceGuid}:${r.id}`
        if (docs.has(r.sourceGuid) || seen.has(k)) continue
        seen.add(k)
        out.push(r)
      }
    }
    return out
  }
  return { docs: [...docs], respondents: entities((s) => s.respondents), questions: entities((s) => s.questions), tagGuids }
}

/** Every leaf key a top-level group entry currently resolves to. */
export function liveLeafKeys(data: SummaryData, entry: SummaryRowEntry): string[] {
  const sourceNames = new Map(data.sources.map((s) => [s.guid, s.name]))
  switch (entry.kind) {
    case 'tag':
      return limitLeaves(tagLeaves(data, sourceNames, entry.tagGuid), entry.sourceGuids).map((l) => l.key)
    case 'category':
      return data.tags
        .filter((t) => t.categoryGuid === entry.categoryGuid)
        .flatMap((t) => limitLeaves(tagLeaves(data, sourceNames, t.guid), entry.sourceGuids).map((l) => l.key))
    case 'folder':
      return limitLeaves(folderLeaves(data, entry.folderGuid), entry.sourceGuids).map((l) => l.key)
    default:
      return []
  }
}

/**
 * Flatten the row entries into display rows. Collapsed groups emit only
 * their header row (pass `expandAll` to ignore collapse state, e.g. for
 * CSV export).
 */
export function buildDisplayRows(
  data: SummaryData,
  config: Pick<FrameworkMatrixConfig, 'rows' | 'codeGuids' | 'summaries' | 'collapsed'>,
  opts?: { expandAll?: boolean }
): DisplayRow[] {
  const sourceNames = new Map(data.sources.map((s) => [s.guid, s.name]))
  const collapsed = new Set(opts?.expandAll ? [] : config.collapsed)
  const out: DisplayRow[] = []

  const pushLeaves = (parentPath: string, depth: number, leaves: Leaf[], orphanOf?: GroupKind) => {
    for (const l of leaves) {
      out.push({ path: `${parentPath}/${l.key}`, key: l.key, depth, label: l.label, detail: l.detail, icon: l.icon, isGroup: false, orphanOf, missing: l.missing, scope: l.scope })
    }
  }

  // Orphans: remembered members with summary text that are no longer
  // anywhere in the group's live membership.
  const orphansFor = (entry: { kept?: string[] }, live: Set<string>): Leaf[] =>
    (entry.kept ?? [])
      .filter((k) => !live.has(k) && hasSummaryText(config.summaries, k, config.codeGuids))
      .map((k) => leafFromKey(data, sourceNames, k))

  config.rows.forEach((entry, entryIndex) => {
    const key = entryKey(entry)
    const path = key
    switch (entry.kind) {
      case 'doc': {
        const name = sourceNames.get(entry.sourceGuid)
        out.push({
          path, key, depth: 0, entryIndex,
          label: name ?? entry.name ?? 'Deleted document',
          icon: 'doc', isGroup: false, missing: name === undefined,
          scope: docScope(entry.sourceGuid)
        })
        return
      }
      case 'respondent':
      case 'question': {
        const leaf = entry.kind === 'respondent'
          ? respondentLeaf(data, sourceNames, entry.sourceGuid, entry.respondentId, entry.name)
          : questionLeaf(data, sourceNames, entry.sourceGuid, entry.questionId, entry.name)
        out.push({ ...leaf, path, depth: 0, entryIndex, isGroup: false })
        return
      }
      case 'tag': {
        const tag = data.tags.find((t) => t.guid === entry.tagGuid)
        const leaves = limitLeaves(tagLeaves(data, sourceNames, entry.tagGuid), entry.sourceGuids)
        const orphans = orphansFor(entry, new Set(leaves.map((l) => l.key)))
        out.push({
          path, key, depth: 0, entryIndex,
          label: tag ? (tag.value || tag.name) : (entry.name ?? 'Deleted tag'),
          icon: 'tag', isGroup: true, memberCount: leaves.length, missing: !tag,
          scope: unionScopes(leaves.map((l) => l.scope), [entry.tagGuid])
        })
        if (collapsed.has(path)) return
        pushLeaves(path, 1, leaves)
        pushLeaves(path, 1, orphans, 'tag')
        return
      }
      case 'category': {
        const cat = data.categories.find((c) => c.guid === entry.categoryGuid)
        const childTags = data.tags.filter((t) => t.categoryGuid === entry.categoryGuid)
        const perTag = childTags.map((t) => ({ tag: t, leaves: limitLeaves(tagLeaves(data, sourceNames, t.guid), entry.sourceGuids) }))
        const allLeaves = perTag.flatMap((p) => p.leaves)
        const orphans = orphansFor(entry, new Set(allLeaves.map((l) => l.key)))
        out.push({
          path, key, depth: 0, entryIndex,
          label: cat?.name ?? entry.name ?? 'Deleted category',
          icon: 'category', isGroup: true, memberCount: new Set(allLeaves.map((l) => l.key)).size, missing: !cat,
          scope: unionScopes(allLeaves.map((l) => l.scope), childTags.map((t) => t.guid))
        })
        if (collapsed.has(path)) return
        for (const { tag, leaves } of perTag) {
          const tagPath = `${path}/tag:${tag.guid}`
          out.push({
            path: tagPath, key: `tag:${tag.guid}`, depth: 1,
            label: tag.value || tag.name, icon: 'tag', isGroup: true, memberCount: leaves.length,
            scope: unionScopes(leaves.map((l) => l.scope), [tag.guid])
          })
          if (!collapsed.has(tagPath)) pushLeaves(tagPath, 2, leaves)
        }
        pushLeaves(path, 1, orphans, 'category')
        return
      }
      case 'folder': {
        const folder = (data.folders || []).find((f) => f.guid === entry.folderGuid)
        const leaves = limitLeaves(folderLeaves(data, entry.folderGuid), entry.sourceGuids)
        const orphans = orphansFor(entry, new Set(leaves.map((l) => l.key)))
        out.push({
          path, key, depth: 0, entryIndex,
          label: folder?.name ?? entry.name ?? 'Deleted folder',
          icon: 'folder', isGroup: true, memberCount: leaves.length, missing: !folder,
          scope: unionScopes(leaves.map((l) => l.scope))
        })
        if (collapsed.has(path)) return
        pushLeaves(path, 1, leaves)
        pushLeaves(path, 1, orphans, 'folder')
        return
      }
    }
  })
  return out
}

/** Number of segments coded with `codeGuid` within a row's scope.
 *  Counts the code itself only (not its subcodes), matching the plain
 *  code query the cell runs. A survey cell counts once even when both
 *  its respondent and its question are in scope. */
export function countInScope(data: Pick<SummaryData, 'sourceSelections'>, scope: RowScope, codeGuid: string): number {
  const coded = (sel: { codings: { codeGuid: string }[] }) => sel.codings.some((c) => c.codeGuid === codeGuid)
  let n = 0
  for (const sg of scope.docs) {
    for (const sel of data.sourceSelections[sg] || []) if (coded(sel)) n++
  }
  const partial = new Map<string, { resp: Set<string>; quest: Set<string> }>()
  const entry = (sg: string) => {
    let e = partial.get(sg)
    if (!e) { e = { resp: new Set(), quest: new Set() }; partial.set(sg, e) }
    return e
  }
  for (const r of scope.respondents) entry(r.sourceGuid).resp.add(r.id)
  for (const q of scope.questions) entry(q.sourceGuid).quest.add(q.id)
  for (const [sg, { resp, quest }] of partial) {
    for (const sel of data.sourceSelections[sg] || []) {
      const cell = sel.surveyCell
      if (cell && (resp.has(cell.respondentId) || quest.has(cell.questionId)) && coded(sel)) n++
    }
  }
  return n
}

/** Arguments for the 'run-code-in-doc-query' analysis action: the
 *  documents to search plus the survey-cell scope. Tag groups scope by
 *  their tags (which unions tagged respondents and questions, exactly
 *  like the count); a single respondent or question row scopes to it. */
export function queryArgsForScope(scope: RowScope): { sourceGuids: string[]; cellScope?: SurveyCellScopeArgs } | null {
  const sourceGuids = [...new Set([
    ...scope.docs,
    ...scope.respondents.map((r) => r.sourceGuid),
    ...scope.questions.map((q) => q.sourceGuid)
  ])]
  if (sourceGuids.length === 0) return null
  if (scope.respondents.length === 0 && scope.questions.length === 0) return { sourceGuids }
  if (scope.tagGuids?.length) return { sourceGuids, cellScope: { tagGuids: scope.tagGuids } }
  const cellScope: SurveyCellScopeArgs = {}
  if (scope.respondents.length > 0) cellScope.respondentScope = scope.respondents
  if (scope.questions.length > 0) cellScope.questionScope = scope.questions
  return { sourceGuids, cellScope }
}
