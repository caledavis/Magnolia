/**
 * Framework Matrix — a documents × codes grid of free-text summaries.
 *
 * Rows come from documents, survey respondents, tags, tag categories and
 * folders dragged in from the Document Browser (groups nest their
 * members underneath); columns come from codes dragged in from the Code
 * Browser. Clicking a cell runs that row × code query in Query Results
 * and puts the cursor in the cell so the user can summarise what they
 * see. Row building, counting and query scoping live in
 * framework-matrix-model.ts so the report renderer shares them.
 *
 * Persistence follows Reports: the working state is mirrored into the
 * tab config (so unsaved work survives a reload), and once saved, edits
 * auto-save on a short debounce — this tool is mostly typing, and losing
 * written summaries to a forgotten "Update" would be costly.
 */
import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import type { AnalysisInitData } from '../../models/types'
import {
  Icon,
  faFrame,
  faChevronDown,
  faChevronRight,
  faXmark,
  faTag,
  faTags,
  faFolder,
  faFile,
  faHeadphones,
  faVideo,
  faImage,
  faBars,
  SURVEY_ICON,
  SURVEY_RESPONDENT_ICON,
  SURVEY_QUESTION_ICON,
  type IconComponent
} from '../Icon'
import { sourceTypeFromFilename } from '../../utils/format-registry'
import { useIconTint, iconTintKindForSourceType, type IconTintKind } from '../../utils/icon-tint'
import { toCsv } from './analysis-helpers'
import { parseGroupByDrop } from './group-by'
import { parseQuestionDrop, parseRespondentDrop } from './survey-grouping'
import {
  type SummaryRowEntry,
  type FrameworkMatrixConfig,
  type DisplayRow,
  type RowIcon,
  buildDisplayRows,
  countInScope,
  entryKey,
  liveLeafKeys,
  mergeRowEntries,
  moveItem,
  orphanNote,
  fullLabel,
  queryArgsForScope,
  summaryKey
} from './framework-matrix-model'
import { useLiveAnalysisData } from './use-live-analysis-data'
import { EditableTitleSuffix } from '../EditableTitleSuffix'
import { renameSavedAnalysis } from '../../utils/rename-saved-analysis'
import { generateGuid } from '../../utils/guid'
import { useToolDirtyState } from '../../hooks/use-tool-dirty-state'
import { useRegisterToolSave } from '../../hooks/use-register-tool-save'
import { useAnalysisTabsStore } from '../../stores/analysis-tabs-store'

interface Props {
  data: AnalysisInitData
  savedConfig?: Partial<FrameworkMatrixConfig> & { guid?: string; name?: string }
  inTab?: {
    onClose: () => void
    onSaved: (savedGuid: string, name: string) => void
    onDirtyChange?: (dirty: boolean) => void
    tabId?: string
  }
}

const ROW_ICONS: Record<Exclude<RowIcon, 'doc'>, IconComponent> = {
  respondent: SURVEY_RESPONDENT_ICON,
  question: SURVEY_QUESTION_ICON,
  tag: faTag,
  category: faTags,
  folder: faFolder
}

/** Palette colours for the row icons, matching the Document Browser.
 *  Tags and categories carry no colour there, so they stay muted. */
const ROW_TINTS: Partial<Record<RowIcon, IconTintKind>> = {
  respondent: 'respondent',
  question: 'question',
  folder: 'folder'
}

/** A document row's glyph and palette colour, by file kind — the same
 *  choice the Document Browser and tab bar make. Prefer the declared
 *  sourceType; only sniff the name when it's unset (foreign QDPX imports
 *  name sources without extensions). */
function docIcon(source: { name: string; sourceType?: string } | undefined): { icon: IconComponent; tint?: IconTintKind } {
  if (!source) return { icon: faFile }
  if (source.sourceType === 'survey') return { icon: SURVEY_ICON, tint: 'survey' }
  const st = (source.sourceType || sourceTypeFromFilename(source.name)) as string
  const tint = iconTintKindForSourceType(st)
  if (st === 'audio') return { icon: faHeadphones, tint }
  if (st === 'video') return { icon: faVideo, tint }
  if (st === 'image') return { icon: faImage, tint }
  return { icon: faFile, tint }
}

/** Internal drag of a row or column handle (reordering within the
 *  matrix). Distinct from every Browser drag MIME so it never reads as
 *  adding something. */
const REORDER_MIME = 'application/x-magnolia-framework-reorder'

type ReorderKind = 'row' | 'col'

const LABEL_W = 240
const CELL_W = 260
const GROUP_TINT = 'color-mix(in srgb, var(--text-secondary) 6%, var(--bg-panel))'
const EMPTY_TINT = 'color-mix(in srgb, var(--text-secondary) 4%, var(--bg-panel))'

function isCodeDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes('application/x-magnolia-code') ||
    e.dataTransfer.types.includes('application/x-magnolia-codes')
}

function parseDraggedCodes(e: React.DragEvent): string[] {
  const multiJson = e.dataTransfer.getData('application/x-magnolia-codes')
  const singleJson = e.dataTransfer.getData('application/x-magnolia-code')
  try {
    let codes: { guid: string }[]
    if (multiJson) codes = JSON.parse(multiJson)
    else if (singleJson) codes = [JSON.parse(singleJson)]
    else return []
    return codes.map((c) => c.guid)
  } catch { return [] }
}

/** True for anything the matrix accepts: codes, or a row source. The
 *  respondent payload is plain application/json, so (as with the
 *  Questions box) this is permissive during drag-over and the real kind
 *  is checked on drop. */
function isAcceptedDrag(e: React.DragEvent): boolean {
  const t = e.dataTransfer.types
  return isCodeDrag(e) ||
    t.includes('application/x-magnolia-docs') ||
    t.includes('application/x-magnolia-tag') ||
    t.includes('application/x-magnolia-category') ||
    t.includes('application/x-magnolia-folder') ||
    t.includes('application/json')
}

/** Document rows are dragged with effectAllowed 'move', tags/codes with
 *  'copy'; the drop effect must be one the source allows or the drop is
 *  refused. */
function dropEffectFor(e: React.DragEvent): 'copy' | 'move' {
  const allowed = e.dataTransfer.effectAllowed
  return allowed === 'move' ? 'move' : 'copy'
}

function parseRowDrop(e: React.DragEvent, data: AnalysisInitData): SummaryRowEntry[] {
  // Tags / categories / folders, with the same precedence the Group-by
  // drop zones use (a category drag also carries its bundled tags).
  const groups = parseGroupByDrop(e)
  if (groups.length > 0) {
    const out: SummaryRowEntry[] = []
    for (const g of groups) {
      if (g.kind === 'tag') {
        const tag = data.tags.find((t) => t.guid === g.tagGuid)
        out.push({ kind: 'tag', tagGuid: g.tagGuid, name: tag ? (tag.value || tag.name) : g.name })
      } else if (g.kind === 'category') {
        out.push({ kind: 'category', categoryGuid: g.categoryGuid, name: g.name })
      } else if (g.kind === 'folder') {
        out.push({ kind: 'folder', folderGuid: g.folderGuid, name: g.name })
      }
    }
    return out
  }
  const docsJson = e.dataTransfer.getData('application/x-magnolia-docs')
  if (docsJson) {
    try {
      const guids = JSON.parse(docsJson) as string[]
      return guids.map((g) => ({ kind: 'doc', sourceGuid: g, name: data.sources.find((s) => s.guid === g)?.name }))
    } catch { return [] }
  }
  // Survey respondents and questions share one JSON envelope, told apart
  // by `kind`; each parser returns [] for the other.
  return [
    ...parseRespondentDrop(e).map((r): SummaryRowEntry => ({ kind: 'respondent', sourceGuid: r.sourceGuid, respondentId: r.id, name: r.label })),
    ...parseQuestionDrop(e).map((q): SummaryRowEntry => ({ kind: 'question', sourceGuid: q.sourceGuid, questionId: q.id, name: q.label }))
  ]
}

export function FrameworkMatrix({ data: propData, savedConfig, inTab }: Props) {
  const live = useLiveAnalysisData()
  const data = useMemo(() => ({ ...propData, ...live }), [propData, live])

  const [rows, setRows] = useState<SummaryRowEntry[]>(savedConfig?.rows ?? [])
  const [codeGuids, setCodeGuids] = useState<string[]>(savedConfig?.codeGuids ?? [])
  const [summaries, setSummaries] = useState<Record<string, string>>(savedConfig?.summaries ?? {})
  const [collapsed, setCollapsed] = useState<string[]>(savedConfig?.collapsed ?? [])
  const [selected, setSelected] = useState<{ path: string; codeGuid: string } | null>(null)
  const [dropOver, setDropOver] = useState(false)
  // Row / column reordering. The ref carries the drag source (dataTransfer
  // can't be read during dragover); the state drives the insertion line.
  const reorderRef = useRef<{ kind: ReorderKind; from: number } | null>(null)
  const [reordering, setReordering] = useState(false)
  const [indicator, setIndicator] = useState<{ kind: ReorderKind; insertAt: number; pos: number; start: number; length: number } | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const tableRef = useRef<HTMLTableElement>(null)
  const [analysisGuid] = useState(savedConfig?.guid ?? generateGuid())
  const [analysisName, setAnalysisName] = useState(savedConfig?.name ?? '')
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const isExisting = !!savedConfig?.guid
  const savedRef = useRef(isExisting)
  const nameRef = useRef(analysisName)
  const textareas = useRef(new Map<string, HTMLTextAreaElement>())

  // Collapse state is saved with the analysis but is view state, so it
  // doesn't count as an unsaved change.
  const currentConfig = useMemo(() => ({ rows, codeGuids, summaries }), [rows, codeGuids, summaries])
  const initialBaseline = useMemo(() => ({
    rows: savedConfig?.rows ?? [],
    codeGuids: savedConfig?.codeGuids ?? [],
    summaries: savedConfig?.summaries ?? {}
  }), [])
  const { dirty, baseline, setBaseline } = useToolDirtyState(currentConfig, initialBaseline, inTab)

  const codeMap = useMemo(() => new Map(data.codes.map((c) => [c.guid, c])), [data.codes])
  const sourceByGuid = useMemo(() => new Map(data.sources.map((s) => [s.guid, s])), [data.sources])
  const tint = useIconTint()
  const rowIcon = (row: DisplayRow): { icon: IconComponent; tint?: IconTintKind } =>
    row.icon === 'doc'
      ? docIcon(sourceByGuid.get(row.key.slice('doc:'.length)))
      : { icon: ROW_ICONS[row.icon], tint: ROW_TINTS[row.icon] }

  const displayRows = useMemo(
    () => buildDisplayRows(data, { rows, codeGuids, summaries, collapsed }),
    [data, rows, codeGuids, summaries, collapsed]
  )

  // Coded-segment counts per row × code. Kept apart from displayRows'
  // summary dependency so typing doesn't recount — keyed by row key,
  // which is enough because a key's scope is the same wherever it shows.
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of displayRows) {
      for (const cg of codeGuids) {
        const k = summaryKey(r.key, cg)
        if (!m.has(k)) m.set(k, countInScope(data, r.scope, cg))
      }
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, codeGuids, displayRows.map((r) => r.key).join('\n')])

  // ── Persistence ───────────────────────────────────────────────────

  const persistMountRef = useRef(true)
  useEffect(() => {
    if (persistMountRef.current) { persistMountRef.current = false; return }
    const tabId = inTab?.tabId
    if (!tabId) return
    useAnalysisTabsStore.getState().setConfig(tabId, { rows, codeGuids, summaries, collapsed })
  }, [rows, codeGuids, summaries, collapsed, inTab?.tabId])

  const persistSaved = useCallback((name: string) => {
    window.api.sendAnalysisAction('save-analysis', {
      guid: analysisGuid,
      toolType: 'framework-matrix',
      name,
      config: { rows, codeGuids, summaries, collapsed }
    })
    setBaseline({ rows, codeGuids, summaries })
  }, [analysisGuid, rows, codeGuids, summaries, collapsed, setBaseline])

  const handleSave = useCallback((name: string) => {
    setAnalysisName(name)
    nameRef.current = name
    savedRef.current = true
    setShowSaveDialog(false)
    persistSaved(name)
    if (inTab) inTab.onSaved(analysisGuid, name)
    else setTimeout(() => window.close(), 200)
  }, [analysisGuid, inTab, persistSaved])

  useEffect(() => {
    if (!dirty || !savedRef.current) return
    const t = setTimeout(() => persistSaved(nameRef.current.trim() || 'Untitled'), 800)
    return () => clearTimeout(t)
  }, [dirty, persistSaved])

  // Collapse state isn't part of `dirty`, so the auto-save above never
  // fires for it alone; persist it directly once the analysis is saved.
  const collapseMountRef = useRef(true)
  useEffect(() => {
    if (collapseMountRef.current) { collapseMountRef.current = false; return }
    if (savedRef.current) persistSaved(nameRef.current.trim() || 'Untitled')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed])

  const handleDiscard = useCallback(() => {
    setRows(baseline.rows)
    setCodeGuids(baseline.codeGuids)
    setSummaries(baseline.summaries)
  }, [baseline])

  const handleRename = useCallback((newName: string) => {
    setAnalysisName(newName)
    nameRef.current = newName
    renameSavedAnalysis(analysisGuid, newName)
    if (inTab) inTab.onSaved('', newName)
  }, [analysisGuid, inTab])

  useRegisterToolSave(inTab?.tabId, () => {
    if (isExisting) {
      handleSave(analysisName)
      return true
    }
    setShowSaveDialog(true)
    return false
  })

  // ── Editing ───────────────────────────────────────────────────────

  const setSummary = useCallback((row: DisplayRow, codeGuid: string, text: string) => {
    setSummaries((prev) => {
      const next = { ...prev }
      if (text === '') delete next[summaryKey(row.key, codeGuid)]
      else next[summaryKey(row.key, codeGuid)] = text
      return next
    })
    // Remember the member on every group it currently belongs to, so it
    // stays visible (as an orphan) if it later leaves that group.
    if (row.isGroup || text.trim() === '') return
    setRows((prev) => {
      let changed = false
      const next = prev.map((entry) => {
        if (entry.kind !== 'tag' && entry.kind !== 'category' && entry.kind !== 'folder') return entry
        if (entry.kept?.includes(row.key)) return entry
        if (!liveLeafKeys(data, entry).includes(row.key)) return entry
        changed = true
        return { ...entry, kept: [...(entry.kept ?? []), row.key] }
      })
      return changed ? next : prev
    })
  }, [data])

  const runCellQuery = useCallback((row: DisplayRow, codeGuid: string) => {
    const args = queryArgsForScope(row.scope)
    if (!args) return
    window.api.sendAnalysisAction('run-code-in-doc-query', codeGuid, args.sourceGuids, undefined, args.cellScope)
  }, [])

  const handleCellFocus = useCallback((row: DisplayRow, codeGuid: string) => {
    if (selected?.path === row.path && selected.codeGuid === codeGuid) return
    setSelected({ path: row.path, codeGuid })
    runCellQuery(row, codeGuid)
  }, [selected, runCellQuery])

  const toggleCollapsed = useCallback((path: string) => {
    setCollapsed((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]))
  }, [])

  // ── Drag and drop ─────────────────────────────────────────────────

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDropOver(false)
    if (isCodeDrag(e)) {
      const guids = parseDraggedCodes(e)
      setCodeGuids((prev) => [...prev, ...guids.filter((g) => !prev.includes(g))])
      return
    }
    const fresh = parseRowDrop(e, data)
    if (fresh.length > 0) setRows((prev) => mergeRowEntries(prev, fresh))
  }, [data])

  // Top-level entry each display row belongs to, so a group and its
  // members move (and highlight as a drop target) as one block.
  const entryIndexByKey = useMemo(() => new Map(rows.map((e, i) => [entryKey(e), i])), [rows])

  const startReorder = useCallback((e: React.DragEvent, kind: ReorderKind, from: number, dragImage: HTMLElement | null) => {
    e.dataTransfer.setData(REORDER_MIME, String(from))
    e.dataTransfer.effectAllowed = 'move'
    if (dragImage) {
      const rect = dragImage.getBoundingClientRect()
      e.dataTransfer.setDragImage(dragImage, e.clientX - rect.left, e.clientY - rect.top)
    }
    reorderRef.current = { kind, from }
    setReordering(true)
  }, [])

  const endReorder = useCallback(() => {
    reorderRef.current = null
    setReordering(false)
    setIndicator(null)
  }, [])

  // Where the dragged row / column would land: the insertion index among
  // top-level rows (by each block's vertical midpoint) or columns (by
  // each header's horizontal midpoint), plus the insertion line's
  // position relative to the matrix wrapper.
  const updateIndicator = useCallback((e: React.DragEvent) => {
    const drag = reorderRef.current
    const table = tableRef.current
    const wrapper = wrapperRef.current
    if (!drag || !table || !wrapper) return
    const wrap = wrapper.getBoundingClientRect()
    const tbl = table.getBoundingClientRect()
    if (drag.kind === 'row') {
      const blocks: { top: number; bottom: number }[] = []
      table.querySelectorAll<HTMLElement>('tbody tr[data-entry]').forEach((tr) => {
        const i = Number(tr.dataset.entry)
        const rect = tr.getBoundingClientRect()
        const b = blocks[i]
        blocks[i] = b ? { top: Math.min(b.top, rect.top), bottom: Math.max(b.bottom, rect.bottom) } : { top: rect.top, bottom: rect.bottom }
      })
      if (blocks.length === 0) return
      const insertAt = blocks.filter((b) => (b.top + b.bottom) / 2 < e.clientY).length
      const y = insertAt < blocks.length ? blocks[insertAt].top : blocks[blocks.length - 1].bottom
      const left = Math.max(tbl.left, wrap.left)
      setIndicator({ kind: 'row', insertAt, pos: y - wrap.top, start: left - wrap.left, length: Math.min(tbl.right, wrap.right) - left })
    } else {
      const heads = Array.from(table.querySelectorAll<HTMLElement>('thead th[data-col]')).map((th) => th.getBoundingClientRect())
      if (heads.length === 0) return
      const insertAt = heads.filter((h) => (h.left + h.right) / 2 < e.clientX).length
      const x = insertAt < heads.length ? heads[insertAt].left : heads[heads.length - 1].right
      const top = Math.max(tbl.top, wrap.top)
      setIndicator({ kind: 'col', insertAt, pos: x - wrap.left, start: top - wrap.top, length: Math.min(tbl.bottom, wrap.bottom) - top })
    }
  }, [])

  const handleReorderDrop = useCallback(() => {
    const drag = reorderRef.current
    if (drag && indicator && indicator.kind === drag.kind) {
      if (drag.kind === 'row') setRows((prev) => moveItem(prev, drag.from, indicator.insertAt))
      else setCodeGuids((prev) => moveItem(prev, drag.from, indicator.insertAt))
    }
    endReorder()
  }, [indicator, endReorder])

  // ── Removal ───────────────────────────────────────────────────────

  // Drop the summaries of row keys that no longer appear anywhere in the
  // matrix (nor are remembered by a group), so removed rows don't leave
  // hidden text behind in the saved analysis.
  const pruneSummaries = useCallback((nextRows: SummaryRowEntry[], prevSummaries: Record<string, string>) => {
    const all = buildDisplayRows(data, { rows: nextRows, codeGuids, summaries: prevSummaries, collapsed: [] })
    const liveKeys = new Set(all.map((r) => r.key))
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(prevSummaries)) {
      if (liveKeys.has(k.slice(0, k.lastIndexOf('|')))) out[k] = v
    }
    return out
  }, [data, codeGuids])

  const confirmLoss = (what: string) =>
    window.confirm(`Remove ${what}? The summaries written for it will be deleted.`)

  const removeEntry = useCallback((row: DisplayRow) => {
    if (row.entryIndex === undefined) return
    const nextRows = rows.filter((_, i) => i !== row.entryIndex)
    const nextSummaries = pruneSummaries(nextRows, summaries)
    if (Object.keys(nextSummaries).length < Object.keys(summaries).length && !confirmLoss(`“${row.label}”`)) return
    setRows(nextRows)
    setSummaries(nextSummaries)
    setCollapsed((prev) => prev.filter((p) => p !== row.path && !p.startsWith(row.path + '/')))
  }, [rows, summaries, pruneSummaries])

  const discardOrphan = useCallback((row: DisplayRow) => {
    const topPath = row.path.split('/')[0]
    const nextRows = rows.map((entry) =>
      entryKey(entry) === topPath && 'kept' in entry
        ? { ...entry, kept: (entry.kept ?? []).filter((k) => k !== row.key) }
        : entry
    )
    const nextSummaries = pruneSummaries(nextRows, summaries)
    if (Object.keys(nextSummaries).length < Object.keys(summaries).length && !confirmLoss(`“${row.label}”`)) return
    setRows(nextRows)
    setSummaries(nextSummaries)
  }, [rows, summaries, pruneSummaries])

  const removeCode = useCallback((codeGuid: string) => {
    const hasText = Object.entries(summaries).some(([k, v]) => k.endsWith(`|${codeGuid}`) && v.trim() !== '')
    if (hasText && !confirmLoss(`the “${codeMap.get(codeGuid)?.name ?? 'code'}” column`)) return
    setCodeGuids((prev) => prev.filter((g) => g !== codeGuid))
    setSummaries((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !k.endsWith(`|${codeGuid}`))))
  }, [summaries, codeMap])

  // ── Export ────────────────────────────────────────────────────────

  const handleExportCsv = useCallback(() => {
    const all = buildDisplayRows(data, { rows, codeGuids, summaries, collapsed }, { expandAll: true })
    const out: string[][] = [['Group', 'Row', ...codeGuids.map((g) => codeMap.get(g)?.name ?? '')]]
    const chain: string[] = []
    for (const r of all) {
      chain.length = r.depth
      const group = chain.join(' > ')
      if (r.isGroup) chain[r.depth] = r.label
      out.push([
        r.isGroup ? [group, r.label].filter(Boolean).join(' > ') : group,
        r.isGroup ? '' : fullLabel(r),
        ...codeGuids.map((cg) => summaries[summaryKey(r.key, cg)] ?? '')
      ])
    }
    window.api.exportCsv(toCsv(out), 'framework-matrix.csv')
  }, [data, rows, codeGuids, summaries, collapsed, codeMap])

  // ── Render ────────────────────────────────────────────────────────

  const isEmpty = rows.length === 0 && codeGuids.length === 0

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '14px 20px 6px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)' }}>
          <Icon icon={faFrame} className="analysis-header-icon" style={{ fontSize: 16 }} />
          Framework Matrix{isExisting || savedRef.current ? ':' : ''}
          {(isExisting || savedRef.current) && <EditableTitleSuffix name={analysisName} onRename={handleRename} />}
        </h2>
        <div style={{ flex: 1 }} />
        <button className="secondary" style={{ fontSize: 11, padding: '4px 14px' }} onClick={() => inTab ? inTab.onClose() : window.close()}>
          Close
        </button>
        {isExisting && dirty && (
          <button className="secondary" style={{ fontSize: 11, padding: '4px 14px' }} onClick={handleDiscard}>
            Discard Changes
          </button>
        )}
        <button className="secondary" style={{ fontSize: 11, padding: '4px 14px' }} onClick={handleExportCsv} disabled={rows.length === 0 || codeGuids.length === 0}>
          Export CSV
        </button>
        {savedRef.current ? (
          <button style={{ fontSize: 11, padding: '4px 14px' }} disabled={!dirty} onClick={() => handleSave(nameRef.current.trim() || 'Untitled')}>
            {dirty ? 'Update Analysis' : 'Saved'}
          </button>
        ) : (
          <button style={{ fontSize: 11, padding: '4px 14px' }} onClick={() => setShowSaveDialog(true)}>
            Save Analysis
          </button>
        )}
        {/* Clearance for the floating MemoFab. */}
        <div style={{ width: 36, flexShrink: 0 }} />
      </div>

      {showSaveDialog && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Save Analysis</h2>
            <input
              autoFocus
              type="text"
              defaultValue={analysisName}
              placeholder="Analysis name"
              style={{ width: '100%' }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave((e.target as HTMLInputElement).value.trim() || 'Untitled')
                if (e.key === 'Escape') setShowSaveDialog(false)
              }}
            />
            <div className="modal-actions">
              <button className="secondary" onClick={() => setShowSaveDialog(false)}>Cancel</button>
              <button onClick={(e) => {
                const input = (e.target as HTMLElement).parentElement!.parentElement!.querySelector('input') as HTMLInputElement
                handleSave(input.value.trim() || 'Untitled')
              }}>Save</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ padding: '4px 20px 8px', fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
        Drag documents, tags, categories, folders, or survey respondents and questions in to add rows, and codes to add columns. Click a cell to see its coded segments in Query Results and write a summary.
      </div>

      {/* The whole matrix area is the drop target and the scroll
          container, so the header row and label column can stick. */}
      <div ref={wrapperRef} style={{ flex: 1, minHeight: 0, margin: '0 20px 14px', position: 'relative' }}>
      <div
        style={{ height: '100%', overflow: 'auto', background: 'var(--bg-panel)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(REORDER_MIME)) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            updateIndicator(e)
            return
          }
          if (!isAcceptedDrag(e)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = dropEffectFor(e)
          setDropOver(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropOver(false)
        }}
        onDrop={(e) => {
          if (e.dataTransfer.types.includes(REORDER_MIME)) {
            e.preventDefault()
            handleReorderDrop()
            return
          }
          handleDrop(e)
        }}
      >
        {isEmpty ? (
          <div style={{ padding: '60px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
            Drag documents or tags here for rows, and codes for columns
          </div>
        ) : (
          <table ref={tableRef} style={{ borderCollapse: 'separate', borderSpacing: 0, tableLayout: 'fixed', fontSize: 12, width: LABEL_W + CELL_W * Math.max(1, codeGuids.length) }}>
            <colgroup>
              <col style={{ width: LABEL_W }} />
              {codeGuids.length === 0 ? <col style={{ width: CELL_W }} /> : codeGuids.map((g) => <col key={g} style={{ width: CELL_W }} />)}
            </colgroup>
            <thead>
              <tr>
                <th style={{ ...stickyHeadStyle, left: 0, zIndex: 3, textAlign: 'left' }}>
                  {rows.length === 0 ? 'Drag documents or tags here' : 'Documents'}
                </th>
                {codeGuids.length === 0 ? (
                  <th style={{ ...stickyHeadStyle, fontWeight: 400, color: 'var(--text-muted)', textAlign: 'left' }}>Drag codes here</th>
                ) : codeGuids.map((cg, colIndex) => {
                  const code = codeMap.get(cg)
                  return (
                    <th key={cg} data-col={colIndex} style={{ ...stickyHeadStyle, textAlign: 'left' }} title={code?.name}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <DragHandle
                          title="Drag to reorder"
                          onDragStart={(e) => startReorder(e, 'col', colIndex, (e.currentTarget as HTMLElement).closest('th'))}
                          onDragEnd={endReorder}
                        />
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: code?.color || '#888', flexShrink: 0 }} />
                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{code?.name ?? 'Deleted code'}</span>
                        <span onClick={() => removeCode(cg)} title="Remove column" style={{ cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex' }}>
                          <Icon icon={faXmark} style={{ fontSize: 10 }} />
                        </span>
                      </div>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row) => (
                <tr key={row.path} data-entry={entryIndexByKey.get(row.path.split('/')[0])}>
                  <td
                    style={{
                      position: 'sticky', left: 0, zIndex: 1,
                      background: row.isGroup ? GROUP_TINT : 'var(--bg-panel)',
                      borderRight: '1px solid var(--border-color)', borderBottom: '1px solid var(--border-color)',
                      padding: '6px 8px', paddingLeft: 8 + row.depth * 16, verticalAlign: 'top'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                      {row.entryIndex !== undefined ? (
                        <DragHandle
                          title="Drag to reorder"
                          onDragStart={(e) => startReorder(e, 'row', row.entryIndex!, (e.currentTarget as HTMLElement).closest('tr'))}
                          onDragEnd={endReorder}
                        />
                      ) : (
                        <span style={{ width: HANDLE_W, flexShrink: 0 }} />
                      )}
                      {row.isGroup ? (
                        <span onClick={() => toggleCollapsed(row.path)} style={{ cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', width: 10, flexShrink: 0 }}>
                          <Icon icon={collapsed.includes(row.path) ? faChevronRight : faChevronDown} style={{ fontSize: 10 }} />
                        </span>
                      ) : (
                        <span style={{ width: 10, flexShrink: 0 }} />
                      )}
                      {(() => {
                        const ri = rowIcon(row)
                        return <Icon icon={ri.icon} style={{ fontSize: 12, width: 13, color: 'var(--text-muted)', flexShrink: 0, ...(ri.tint ? tint(ri.tint) : {}) }} />
                      })()}
                      <span
                        title={row.detail ? `${row.label} (${row.detail})` : row.label}
                        style={{
                          flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          fontWeight: row.isGroup ? 600 : 400,
                          fontStyle: row.orphanOf || row.missing ? 'italic' : undefined,
                          color: row.orphanOf || row.missing ? 'var(--text-muted)' : undefined
                        }}
                      >
                        {row.label}
                      </span>
                      {row.isGroup && row.memberCount !== undefined && (
                        <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>({row.memberCount})</span>
                      )}
                      {(row.entryIndex !== undefined || row.orphanOf) && (
                        <span
                          onClick={() => (row.orphanOf ? discardOrphan(row) : removeEntry(row))}
                          title={row.orphanOf ? 'Discard this row' : 'Remove row'}
                          style={{ cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', flexShrink: 0 }}
                        >
                          <Icon icon={faXmark} style={{ fontSize: 10 }} />
                        </span>
                      )}
                    </div>
                    {row.detail && (
                      <div title={row.detail} style={{ ...subLineStyle, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.detail}</div>
                    )}
                    {row.orphanOf && (
                      <div style={subLineStyle}>{orphanNote(row.orphanOf)}</div>
                    )}
                  </td>
                  {codeGuids.length === 0 ? (
                    <td style={{ borderBottom: '1px solid var(--border-color)', background: row.isGroup ? GROUP_TINT : undefined }} />
                  ) : codeGuids.map((cg) => {
                    const k = summaryKey(row.key, cg)
                    const count = counts.get(k) ?? 0
                    const isSel = selected?.path === row.path && selected.codeGuid === cg
                    const textKey = `${row.path}\n${cg}`
                    return (
                        <td
                          key={cg}
                          onMouseDown={(e) => {
                            // Clicks on the cell padding still land in the text.
                            if (e.target === e.currentTarget) {
                              e.preventDefault()
                              textareas.current.get(textKey)?.focus()
                            }
                          }}
                          style={{
                            position: 'relative', padding: 0, verticalAlign: 'top', cursor: 'text',
                            borderRight: '1px solid var(--border-color)', borderBottom: '1px solid var(--border-color)',
                            background: row.isGroup ? GROUP_TINT : count === 0 ? EMPTY_TINT : undefined,
                            boxShadow: isSel ? 'inset 0 0 0 2px var(--accent)' : undefined
                          }}
                        >
                          <textarea
                            ref={(el) => { if (el) textareas.current.set(textKey, el); else textareas.current.delete(textKey) }}
                            value={summaries[k] ?? ''}
                            onChange={(e) => setSummary(row, cg, e.target.value)}
                            onFocus={() => handleCellFocus(row, cg)}
                            onKeyDown={(e) => { if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur() }}
                            spellCheck
                            style={{
                              display: 'block', width: '100%', minHeight: 40, boxSizing: 'border-box',
                              padding: '6px 26px 6px 8px', margin: 0, border: 'none', outline: 'none', resize: 'none',
                              background: 'transparent', color: 'var(--text-primary)', font: 'inherit', lineHeight: 1.4,
                              // Grow with the text so the row gets taller instead of scrolling.
                              fieldSizing: 'content',
                              opacity: count === 0 && !isSel ? 0.55 : 1,
                              // While reordering, let dragover fall through to the
                              // matrix instead of showing a text caret in the cells.
                              pointerEvents: reordering ? 'none' : undefined
                            } as React.CSSProperties}
                          />
                          <span
                            title={`${count} coded segment${count === 1 ? '' : 's'}`}
                            style={{
                              position: 'absolute', top: 5, right: 6, pointerEvents: 'none',
                              fontSize: 9, fontWeight: 600, lineHeight: '14px', minWidth: 14, padding: '0 4px', textAlign: 'center',
                              borderRadius: 7, background: 'var(--bg-tertiary)',
                              color: count === 0 ? 'var(--text-muted)' : 'var(--text-secondary)',
                              opacity: count === 0 ? 0.6 : 1
                            }}
                          >
                            {count}
                          </span>
                        </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
        {indicator && (
          <div style={{
            position: 'absolute', pointerEvents: 'none', zIndex: 5, background: 'var(--accent)', borderRadius: 1,
            ...(indicator.kind === 'row'
              ? { top: indicator.pos - 1, left: indicator.start, width: indicator.length, height: 2 }
              : { left: indicator.pos - 1, top: indicator.start, height: indicator.length, width: 2 })
          }} />
        )}
        {dropOver && (
          <div style={{
            position: 'absolute', inset: 0,
            background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
            border: '2px dashed var(--accent)',
            borderRadius: 'var(--radius-md)',
            pointerEvents: 'none'
          }} />
        )}
      </div>
    </div>
  )
}

const HANDLE_W = 13

/** The hamburger grip used to drag a row or column, as in Reports. */
function DragHandle({ title, onDragStart, onDragEnd }: {
  title: string
  onDragStart: (e: React.DragEvent) => void
  onDragEnd: () => void
}) {
  return (
    <span
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      title={title}
      style={{ cursor: 'grab', color: 'var(--text-muted)', display: 'inline-flex', width: HANDLE_W, flexShrink: 0 }}
    >
      <Icon icon={faBars} style={{ fontSize: HANDLE_W }} />
    </span>
  )
}

/** A small grey line under a row's label (survey name, orphan note),
 *  indented to line up with the label text. */
const subLineStyle: React.CSSProperties = {
  // handle + chevron + icon, each followed by the 6px row gap
  fontSize: 10, color: 'var(--text-muted)', marginTop: 2, paddingLeft: HANDLE_W + 6 + 10 + 6 + 13 + 6
}

const stickyHeadStyle: React.CSSProperties = {
  position: 'sticky', top: 0, zIndex: 2,
  background: 'var(--bg-secondary)',
  borderRight: '1px solid var(--border-color)', borderBottom: '1px solid var(--border-color)',
  padding: '8px', fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)',
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
}
