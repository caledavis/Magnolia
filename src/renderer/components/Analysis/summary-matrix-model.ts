/**
 * Summary Matrix — pure model shared by the on-screen tool and the
 * report renderer. Rows are documents / survey respondents, either
 * dropped individually or nested under a dropped tag, tag category or
 * folder; columns are codes. Each cell holds the user's free-text
 * summary of what that code looks like in that row.
 *
 * Summaries are keyed by ROW IDENTITY (a document, respondent, or
 * group), not by where the row appears, so a document listed under two
 * tags shares one set of cells.
 *
 * Group membership is resolved live from the tag / folder data, so the
 * nested rows follow later tagging changes. A member that has had a
 * summary written for it is remembered on its group entry (`kept`); if
 * it later leaves the group while its summaries still have text, it
 * stays in the group as an orphaned row instead of silently vanishing.
 */
import type { AnalysisInitData, SurveyEntityRef } from '../../models/types'

/** One thing the user dropped into the rows area. */
export type SummaryRowEntry =
  | { kind: 'doc'; sourceGuid: string; name?: string }
  | { kind: 'respondent'; sourceGuid: string; respondentId: string; name?: string }
  | { kind: 'tag'; tagGuid: string; name?: string; kept?: string[] }
  | { kind: 'category'; categoryGuid: string; name?: string; kept?: string[] }
  | { kind: 'folder'; folderGuid: string; name?: string; kept?: string[] }

export interface SummaryMatrixConfig {
  rows: SummaryRowEntry[]
  codeGuids: string[]
  /** Cell text keyed by summaryKey(rowKey, codeGuid). */
  summaries: Record<string, string>
  /** Display paths of collapsed groups. */
  collapsed: string[]
}

export type RowIcon = 'doc' | 'respondent' | 'tag' | 'category' | 'folder'

export type GroupKind = 'tag' | 'category' | 'folder'

/** The documents and survey respondents a row covers. A survey listed in
 *  `docs` is covered whole; `respondents` only ever names respondents of
 *  surveys NOT in `docs`. */
export interface RowScope {
  docs: string[]
  respondents: SurveyEntityRef[]
}

export interface DisplayRow {
  /** Unique display path (a row can appear under several groups). */
  path: string
  /** Identity the row's summaries are stored under. */
  key: string
  depth: number
  label: string
  /** Secondary text shown after the label — a respondent's survey. */
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
  /** Document / respondent / tag no longer exists in the project. */
  missing?: boolean
  scope: RowScope
}

export type SummaryData = Pick<
  AnalysisInitData,
  'sources' | 'tags' | 'categories' | 'folders' | 'sourceFolder' | 'tagMembers'
  | 'respondentTagMembers' | 'surveyEntityLabels' | 'sourceSelections'
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

/** Identity of a top-level entry — used for dedup on drop and as the
 *  summary key of group header rows. */
export function entryKey(e: SummaryRowEntry): string {
  switch (e.kind) {
    case 'doc': return docKey(e.sourceGuid)
    case 'respondent': return respondentKey(e.sourceGuid, e.respondentId)
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

/** Rebuild a leaf from its key alone (orphans carry nothing else). */
function leafFromKey(data: SummaryData, sourceNames: Map<string, string>, key: string): Leaf {
  if (key.startsWith('resp:')) {
    const [, sourceGuid, ...rest] = key.split(':')
    const respondentId = rest.join(':')
    const surveyName = sourceNames.get(sourceGuid)
    return {
      key,
      label: respondentLabel(data, sourceGuid, respondentId),
      detail: surveyName,
      icon: 'respondent',
      scope: { docs: [], respondents: [{ sourceGuid, id: respondentId }] },
      missing: !surveyName
    }
  }
  const sourceGuid = key.slice('doc:'.length)
  const name = sourceNames.get(sourceGuid)
  return { key, label: name ?? 'Deleted document', icon: 'doc', scope: { docs: [sourceGuid], respondents: [] }, missing: name === undefined }
}

/** A tag's members as leaves, in Document Browser order: whole
 *  documents first, then respondents of surveys tagged per respondent
 *  (skipping surveys already tagged whole). */
function tagLeaves(data: SummaryData, sourceNames: Map<string, string>, tagGuid: string): Leaf[] {
  const members = new Set(data.tagMembers[tagGuid] || [])
  const leaves: Leaf[] = []
  for (const s of data.sources) {
    if (members.has(s.guid)) leaves.push({ key: docKey(s.guid), label: s.name, icon: 'doc', scope: { docs: [s.guid], respondents: [] } })
  }
  for (const r of data.respondentTagMembers?.[tagGuid] || []) {
    if (members.has(r.sourceGuid) || !sourceNames.has(r.sourceGuid)) continue
    leaves.push({
      key: respondentKey(r.sourceGuid, r.id),
      label: respondentLabel(data, r.sourceGuid, r.id),
      detail: sourceNames.get(r.sourceGuid),
      icon: 'respondent',
      scope: { docs: [], respondents: [r] }
    })
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
    .map((s) => ({ key: docKey(s.guid), label: s.name, icon: 'doc' as const, scope: { docs: [s.guid], respondents: [] } }))
}

/** Union several scopes, keeping the invariant that a survey covered
 *  whole never also lists individual respondents. */
export function unionScopes(scopes: RowScope[]): RowScope {
  const docs = new Set<string>()
  for (const s of scopes) for (const d of s.docs) docs.add(d)
  const seen = new Set<string>()
  const respondents: SurveyEntityRef[] = []
  for (const s of scopes) {
    for (const r of s.respondents) {
      const k = `${r.sourceGuid}:${r.id}`
      if (docs.has(r.sourceGuid) || seen.has(k)) continue
      seen.add(k)
      respondents.push(r)
    }
  }
  return { docs: [...docs], respondents }
}

/** Every leaf key a top-level group entry currently resolves to. */
export function liveLeafKeys(data: SummaryData, entry: SummaryRowEntry): string[] {
  const sourceNames = new Map(data.sources.map((s) => [s.guid, s.name]))
  switch (entry.kind) {
    case 'tag':
      return tagLeaves(data, sourceNames, entry.tagGuid).map((l) => l.key)
    case 'category':
      return data.tags
        .filter((t) => t.categoryGuid === entry.categoryGuid)
        .flatMap((t) => tagLeaves(data, sourceNames, t.guid).map((l) => l.key))
    case 'folder':
      return folderLeaves(data, entry.folderGuid).map((l) => l.key)
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
  config: Pick<SummaryMatrixConfig, 'rows' | 'codeGuids' | 'summaries' | 'collapsed'>,
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
          scope: { docs: [entry.sourceGuid], respondents: [] }
        })
        return
      }
      case 'respondent': {
        const surveyName = sourceNames.get(entry.sourceGuid)
        out.push({
          path, key, depth: 0, entryIndex,
          label: respondentLabel(data, entry.sourceGuid, entry.respondentId, entry.name),
          detail: surveyName,
          icon: 'respondent', isGroup: false, missing: surveyName === undefined,
          scope: { docs: [], respondents: [{ sourceGuid: entry.sourceGuid, id: entry.respondentId }] }
        })
        return
      }
      case 'tag': {
        const tag = data.tags.find((t) => t.guid === entry.tagGuid)
        const leaves = tagLeaves(data, sourceNames, entry.tagGuid)
        const orphans = orphansFor(entry, new Set(leaves.map((l) => l.key)))
        out.push({
          path, key, depth: 0, entryIndex,
          label: tag ? (tag.value || tag.name) : (entry.name ?? 'Deleted tag'),
          icon: 'tag', isGroup: true, memberCount: leaves.length, missing: !tag,
          scope: unionScopes(leaves.map((l) => l.scope))
        })
        if (collapsed.has(path)) return
        pushLeaves(path, 1, leaves)
        pushLeaves(path, 1, orphans, 'tag')
        return
      }
      case 'category': {
        const cat = data.categories.find((c) => c.guid === entry.categoryGuid)
        const childTags = data.tags.filter((t) => t.categoryGuid === entry.categoryGuid)
        const perTag = childTags.map((t) => ({ tag: t, leaves: tagLeaves(data, sourceNames, t.guid) }))
        const allLeaves = perTag.flatMap((p) => p.leaves)
        const orphans = orphansFor(entry, new Set(allLeaves.map((l) => l.key)))
        out.push({
          path, key, depth: 0, entryIndex,
          label: cat?.name ?? entry.name ?? 'Deleted category',
          icon: 'category', isGroup: true, memberCount: new Set(allLeaves.map((l) => l.key)).size, missing: !cat,
          scope: unionScopes(allLeaves.map((l) => l.scope))
        })
        if (collapsed.has(path)) return
        for (const { tag, leaves } of perTag) {
          const tagPath = `${path}/tag:${tag.guid}`
          out.push({
            path: tagPath, key: `tag:${tag.guid}`, depth: 1,
            label: tag.value || tag.name, icon: 'tag', isGroup: true, memberCount: leaves.length,
            scope: unionScopes(leaves.map((l) => l.scope))
          })
          if (!collapsed.has(tagPath)) pushLeaves(tagPath, 2, leaves)
        }
        pushLeaves(path, 1, orphans, 'category')
        return
      }
      case 'folder': {
        const folder = (data.folders || []).find((f) => f.guid === entry.folderGuid)
        const leaves = folderLeaves(data, entry.folderGuid)
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
 *  code query the cell runs. */
export function countInScope(data: Pick<SummaryData, 'sourceSelections'>, scope: RowScope, codeGuid: string): number {
  let n = 0
  for (const sg of scope.docs) {
    for (const sel of data.sourceSelections[sg] || []) {
      if (sel.codings.some((c) => c.codeGuid === codeGuid)) n++
    }
  }
  for (const r of scope.respondents) {
    for (const sel of data.sourceSelections[r.sourceGuid] || []) {
      if (sel.surveyCell?.respondentId === r.id && sel.codings.some((c) => c.codeGuid === codeGuid)) n++
    }
  }
  return n
}

/** Arguments for the 'run-code-in-doc-query' analysis action: the
 *  documents to search, plus a respondent scope for surveys covered
 *  only by some of their respondents. */
export function queryArgsForScope(scope: RowScope): { sourceGuids: string[]; respondentScope?: SurveyEntityRef[] } | null {
  const sourceGuids = [...new Set([...scope.docs, ...scope.respondents.map((r) => r.sourceGuid)])]
  if (sourceGuids.length === 0) return null
  return { sourceGuids, respondentScope: scope.respondents.length > 0 ? scope.respondents : undefined }
}
