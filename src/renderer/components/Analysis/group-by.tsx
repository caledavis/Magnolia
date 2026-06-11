import type { AnalysisInitData } from '../../models/types'
import { Icon, faXmark, faFolder, faTag, faTags, faUser } from '../Icon'

/** Drag MIME emitted by the Document Browser's survey "Respondents"
 *  header. Carries no payload — its presence means "group surveys by
 *  respondent". */
export const RESPONDENTS_GROUP_MIME = 'application/x-magnolia-survey-respondents'

/** A single Group-by entry. Drives the column/row breakdown in the
 *  analysis grids. Tags become a flat slot; categories and folders
 *  expand to a band of sub-slots with a spanning label and a subtotal.
 *
 *  The optional `name` snapshot is captured at drag time and used as a
 *  display fallback when the analysis window's snapshot of
 *  data.folders / categories / tags is stale (e.g. opened before the
 *  entity existed). Live data still wins when present; the snapshot
 *  prevents the chip from collapsing to the literal kind name. */
export type GroupByEntry =
  | { kind: 'tag'; tagGuid: string; name?: string }
  | { kind: 'category'; categoryGuid: string; name?: string }
  | { kind: 'folder'; folderGuid: string; name?: string }
  // Inverted grouping: when present, each in-scope survey COLLAPSES to a
  // single whole-survey total column; when absent, the survey EXPANDS
  // into a band of its respondents (one slot per respondent + a
  // whole-survey subtotal). Auto-added when a survey enters scope, so
  // the collapsed total is the default. A single entry covers every
  // survey in scope; non-survey documents are unaffected.
  | { kind: 'respondents' }

export interface GroupedSlot {
  id: string
  label: string
  sourceGuids: string[]
  isSubtotal?: boolean
}

export interface GroupedHeader {
  id: string
  label: string | null
  span: number
}

/** Stable key for dedup. */
export function groupByKey(e: GroupByEntry): string {
  switch (e.kind) {
    case 'tag': return `t:${e.tagGuid}`
    case 'category': return `c:${e.categoryGuid}`
    case 'folder': return `f:${e.folderGuid}`
    case 'respondents': return 'respondents'
  }
}

/** Append entries to an existing group-by list, dropping duplicates. */
export function mergeGroupBy(prev: GroupByEntry[], fresh: GroupByEntry[]): GroupByEntry[] {
  const seen = new Set(prev.map(groupByKey))
  const additions: GroupByEntry[] = []
  for (const e of fresh) {
    const k = groupByKey(e)
    if (seen.has(k)) continue
    seen.add(k)
    additions.push(e)
  }
  return additions.length > 0 ? [...prev, ...additions] : prev
}

/** Read a drag event and return any group-by entries it carries.
 *  Order of precedence: folder > category > tag. The DocumentBrowser's
 *  category drag also sets the bundled-tags MIME for legacy targets,
 *  so we check the category MIME first to nest rather than fan out.
 *  When the source provides a side-channel info MIME (folder-info /
 *  category-info / tag-info) we capture the entity's name so the chip
 *  can render correctly even if the analysis window's data snapshot
 *  doesn't contain the entity. */
export function parseGroupByDrop(e: React.DragEvent): GroupByEntry[] {
  // The survey "Respondents" header carries only this marker MIME.
  if (e.dataTransfer.types.includes(RESPONDENTS_GROUP_MIME)) {
    return [{ kind: 'respondents' }]
  }
  const folderGuid = e.dataTransfer.getData('application/x-magnolia-folder')
  if (folderGuid) {
    let name: string | undefined
    const folderInfo = e.dataTransfer.getData('application/x-magnolia-folder-info')
    if (folderInfo) {
      try { name = (JSON.parse(folderInfo) as { name?: string }).name } catch { /* ignore */ }
    }
    return [{ kind: 'folder', folderGuid, name }]
  }
  const catJson = e.dataTransfer.getData('application/x-magnolia-category')
  if (catJson) {
    try {
      const parsed = JSON.parse(catJson) as { categoryGuid: string; name?: string }
      if (parsed.categoryGuid) return [{ kind: 'category', categoryGuid: parsed.categoryGuid, name: parsed.name }]
    } catch { /* fall through */ }
  }
  const tagJson = e.dataTransfer.getData('application/x-magnolia-tag')
  if (tagJson) {
    try {
      const guids = JSON.parse(tagJson) as string[]
      return guids.map((g) => ({ kind: 'tag', tagGuid: g }))
    } catch { /* ignore */ }
  }
  return []
}

/** True if the drag event carries any group-by-able payload. */
export function isGroupByDrag(e: React.DragEvent): boolean {
  const types = e.dataTransfer.types
  return (
    types.includes('application/x-magnolia-tag') ||
    types.includes('application/x-magnolia-category') ||
    types.includes('application/x-magnolia-folder') ||
    types.includes(RESPONDENTS_GROUP_MIME)
  )
}

/** Compute every folder guid that descends from rootGuid (inclusive)
 *  via a parentGuid walk. Used by folder entries to flatten subfolders
 *  into a single band. */
function descendantFolderGuids(folders: AnalysisInitData['folders'], rootGuid: string): Set<string> {
  const set = new Set<string>([rootGuid])
  let added = true
  while (added) {
    added = false
    for (const f of folders) {
      if (f.parentGuid && set.has(f.parentGuid) && !set.has(f.guid)) {
        set.add(f.guid)
        added = true
      }
    }
  }
  return set
}

/** Migrate the legacy `groupByTags: string[]` shape (pre-category
 *  support) into the tagged-union list. New saves write GroupByEntry[];
 *  old saves still load. */
export function migrateLegacyGroupBy(legacyTags: string[] | undefined): GroupByEntry[] {
  if (!legacyTags || legacyTags.length === 0) return []
  return legacyTags.map((tagGuid) => ({ kind: 'tag' as const, tagGuid }))
}

export interface BuildSlotsOptions {
  /** Eligible source guids (what the analysis is currently viewing). */
  candidateSourceGuids: string[]
  /** Map of source guid -> display name; used for folder leaves. */
  sourceMap: Map<string, string>
  /** Whether to include category/folder subtotal slots. Tools that show
   *  averages/percentages may set this false because a "sum" is
   *  semantically ambiguous for those values. */
  includeSubtotals?: boolean
  /** Whether to append a trailing "Other" slot for candidate sources
   *  that fell into none of the explicit groups. */
  includeOther?: boolean
}

/** Walk a GroupByEntry list and produce a flat slot list (which the
 *  analysis renders as either columns or rows) plus a parallel
 *  `headerGroups` describing category/folder bands and their spans. */
export function buildGroupedSlots(
  groupBy: GroupByEntry[],
  data: Pick<AnalysisInitData, 'tags' | 'categories' | 'folders' | 'tagMembers' | 'sourceFolder'>,
  opts: BuildSlotsOptions
): { slots: GroupedSlot[]; headerGroups: GroupedHeader[]; hasGroupedHeader: boolean } {
  const includeSubtotals = opts.includeSubtotals !== false
  const includeOther = opts.includeOther !== false
  const slots: GroupedSlot[] = []
  const groups: GroupedHeader[] = []
  for (const entry of groupBy) {
    if (entry.kind === 'tag') {
      const tag = data.tags.find((t) => t.guid === entry.tagGuid)
      if (!tag) continue
      const members = (data.tagMembers[entry.tagGuid] || []).filter((g) => opts.candidateSourceGuids.includes(g))
      slots.push({ id: `tag:${entry.tagGuid}`, label: tag.value || tag.name || 'Tag', sourceGuids: members })
      groups.push({ id: `tag:${entry.tagGuid}`, label: null, span: 1 })
    } else if (entry.kind === 'category') {
      const cat = data.categories.find((c) => c.guid === entry.categoryGuid)
      if (!cat) continue
      const childTags = data.tags.filter((t) => t.categoryGuid === entry.categoryGuid)
      if (childTags.length === 0) continue
      const before = slots.length
      for (const tag of childTags) {
        const members = (data.tagMembers[tag.guid] || []).filter((g) => opts.candidateSourceGuids.includes(g))
        slots.push({ id: `cat:${entry.categoryGuid}:tag:${tag.guid}`, label: tag.value || tag.name || 'Tag', sourceGuids: members })
      }
      if (includeSubtotals) {
        // Union of every child-tag's members so a doc tagged with
        // multiple of the category's tags is counted once.
        const subtotalSet = new Set<string>()
        for (const tag of childTags) {
          for (const g of (data.tagMembers[tag.guid] || [])) {
            if (opts.candidateSourceGuids.includes(g)) subtotalSet.add(g)
          }
        }
        slots.push({ id: `cat:${entry.categoryGuid}:subtotal`, label: 'Subtotal', sourceGuids: Array.from(subtotalSet), isSubtotal: true })
      }
      groups.push({ id: `cat:${entry.categoryGuid}`, label: cat.name, span: slots.length - before })
    } else if (entry.kind === 'folder') {
      const folder = (data.folders || []).find((f) => f.guid === entry.folderGuid)
      if (!folder) continue
      const folderSet = descendantFolderGuids(data.folders || [], entry.folderGuid)
      const folderDocs = opts.candidateSourceGuids.filter((g) => {
        const fg = data.sourceFolder?.[g]
        return fg ? folderSet.has(fg) : false
      })
      if (folderDocs.length === 0) continue
      const before = slots.length
      for (const docGuid of folderDocs) {
        slots.push({ id: `folder:${entry.folderGuid}:doc:${docGuid}`, label: opts.sourceMap.get(docGuid) || 'Document', sourceGuids: [docGuid] })
      }
      if (includeSubtotals) {
        slots.push({ id: `folder:${entry.folderGuid}:subtotal`, label: 'Subtotal', sourceGuids: [...folderDocs], isSubtotal: true })
      }
      groups.push({ id: `folder:${entry.folderGuid}`, label: folder.name, span: slots.length - before })
    }
  }
  if (includeOther) {
    // Ignore subtotal slots when computing the catch-all — a doc that
    // landed in a subtotal is already in one of the category's tag slots.
    const taggedGuids = new Set(slots.filter((s) => !s.isSubtotal).flatMap((s) => s.sourceGuids))
    const otherGuids = opts.candidateSourceGuids.filter((g) => !taggedGuids.has(g))
    if (otherGuids.length > 0) {
      slots.push({ id: '__other', label: 'Other', sourceGuids: otherGuids })
      groups.push({ id: '__other', label: null, span: 1 })
    }
  }
  const hasGroupedHeader = groups.some((g) => g.label !== null)
  return { slots, headerGroups: groups, hasGroupedHeader }
}

/** Inline chip cluster for the "Group by" drop zone. Renders one chip
 *  per entry with the appropriate icon (tag / multi-tag / folder),
 *  child-count for categories/folders, and an inline remove button. */
export function GroupByChips({
  groupBy,
  data,
  candidateSourceGuids,
  onRemove
}: {
  groupBy: GroupByEntry[]
  data: Pick<AnalysisInitData, 'tags' | 'categories' | 'folders' | 'tagMembers' | 'sourceFolder'>
  candidateSourceGuids: string[]
  onRemove: (entry: GroupByEntry) => void
}) {
  if (groupBy.length === 0) return null
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {groupBy.map((entry) => {
        if (entry.kind === 'respondents') {
          return (
            <span key="respondents" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, background: 'var(--bg-tertiary)', padding: '2px 8px', borderRadius: 'var(--radius-sm)', fontWeight: 600, border: '1px solid var(--border-color)' }}>
              <Icon icon={faUser} style={{ fontSize: 10, color: 'var(--text-muted)' }} />
              Respondents
              <span onClick={() => onRemove(entry)} style={{ fontSize: 9, color: 'var(--text-muted)', cursor: 'pointer' }}><Icon icon={faXmark} /></span>
            </span>
          )
        }
        if (entry.kind === 'tag') {
          const tag = data.tags.find((t) => t.guid === entry.tagGuid)
          return (
            <span key={`t:${entry.tagGuid}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, background: 'var(--bg-tertiary)', padding: '2px 8px', borderRadius: 'var(--radius-sm)' }}>
              <Icon icon={faTag} style={{ fontSize: 10, color: 'var(--text-muted)' }} />
              {tag?.value || tag?.name || entry.name || 'Tag'}
              <span onClick={() => onRemove(entry)} style={{ fontSize: 9, color: 'var(--text-muted)', cursor: 'pointer' }}><Icon icon={faXmark} /></span>
            </span>
          )
        }
        if (entry.kind === 'category') {
          const cat = data.categories.find((c) => c.guid === entry.categoryGuid)
          const childCount = data.tags.filter((t) => t.categoryGuid === entry.categoryGuid).length
          return (
            <span key={`c:${entry.categoryGuid}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, background: 'var(--bg-tertiary)', padding: '2px 8px', borderRadius: 'var(--radius-sm)', fontWeight: 600, border: '1px solid var(--border-color)' }}>
              <Icon icon={faTags} style={{ fontSize: 10, color: 'var(--text-muted)' }} />
              {cat?.name || entry.name || 'Category'}
              <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>({childCount})</span>
              <span onClick={() => onRemove(entry)} style={{ fontSize: 9, color: 'var(--text-muted)', cursor: 'pointer' }}><Icon icon={faXmark} /></span>
            </span>
          )
        }
        const folder = (data.folders || []).find((f) => f.guid === entry.folderGuid)
        const folderSet = descendantFolderGuids(data.folders || [], entry.folderGuid)
        const docCount = candidateSourceGuids.filter((g) => {
          const fg = data.sourceFolder?.[g]
          return fg ? folderSet.has(fg) : false
        }).length
        return (
          <span key={`f:${entry.folderGuid}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, background: 'var(--bg-tertiary)', padding: '2px 8px', borderRadius: 'var(--radius-sm)', fontWeight: 600, border: '1px dashed var(--border-color)' }}>
            <Icon icon={faFolder} style={{ fontSize: 10, color: 'var(--text-muted)' }} />
            {folder?.name || entry.name || 'Folder'}
            <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>({docCount})</span>
            <span onClick={() => onRemove(entry)} style={{ fontSize: 9, color: 'var(--text-muted)', cursor: 'pointer' }}><Icon icon={faXmark} /></span>
          </span>
        )
      })}
    </div>
  )
}
