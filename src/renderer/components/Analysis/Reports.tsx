/**
 * Reports — an analysis tool for compiling results (saved queries,
 * analyses, quotes, memos) plus authored sections and free text into a
 * single ordered list, exported as a PDF using Magnolia's shared
 * template. Everything is regenerated from the live stores at export
 * time so the PDF never carries stale data.
 *
 * Phase 1: the tool shell — toolbar (draggable Section / Text), the
 * reorderable list with drop targets for every supported drag source,
 * per-analysis options, save / reopen, and PDF export of the non-
 * analysis content. Analysis-table generation lands in a later phase.
 */
import { useState, useMemo, useCallback, useRef, useLayoutEffect, useEffect } from 'react'
import type { AnalysisInitData, AnalysisToolType } from '../../models/types'
import {
  Icon,
  faNotebookTabs,
  faXmark,
  faHeading1,
  faHeading2,
  faFont,
  faBars,
  faMagnifyingGlass,
  faQuoteLeft,
  faStickyNote
} from '../Icon'
import { TOOL_REGISTRY } from '../../utils/tool-registry'
import { MarkdownEditor } from '../MarkdownEditor'
import { generateGuid } from '../../utils/guid'
import { EditableTitleSuffix } from '../EditableTitleSuffix'
import { renameSavedAnalysis } from '../../utils/rename-saved-analysis'
import { useToolDirtyState } from '../../hooks/use-tool-dirty-state'
import { useRegisterToolSave } from '../../hooks/use-register-tool-save'
import { useAnalysisTabsStore } from '../../stores/analysis-tabs-store'
import { useQueryStore } from '../../stores/query-store'
import { useProjectStore } from '../../stores/project-store'
import { useQuoteStore } from '../../stores/quote-store'
import { useMemoStore } from '../../stores/memo-store'
import {
  exportReportPdf,
  reportItemTypeLabel,
  resolveItemLabel,
  resolveItemSnippet,
  type ReportItem,
  type AnalysisItemOptions
} from './report-export'

interface Props {
  data: AnalysisInitData
  savedConfig?: { title?: string; items?: ReportItem[]; guid: string; name: string }
  inTab?: {
    onClose: () => void
    onSaved: (savedGuid: string, name: string) => void
    onDirtyChange?: (dirty: boolean) => void
    tabId?: string
  }
}

const BLOCK_MIME = 'application/x-magnolia-report-block'
const REORDER_MIME = 'application/x-magnolia-report-reorder'

/** Which display options each analysis tool exposes (the toggles the
 *  tool itself shows). Drives the per-item options row. */
const ANALYSIS_CAPS: Record<string, { totalsOnly?: boolean; binary?: boolean; visual?: boolean; barChart?: boolean; wordCloud?: boolean }> = {
  'codes-in-documents': { totalsOnly: true, binary: true, visual: true },
  'results-in-documents': { totalsOnly: true, binary: true, visual: true },
  'code-cooccurrences': { totalsOnly: true, binary: true, visual: true },
  'code-frequencies': {},
  'code-orders': {},
  'word-frequencies': { barChart: true, wordCloud: true },
  'relationship-map': {}
}

function itemIcon(item: ReportItem) {
  switch (item.kind) {
    case 'section':
      return item.level === 2 ? faHeading2 : faHeading1
    case 'text':
      return faFont
    case 'query':
      return faMagnifyingGlass
    case 'quote':
      return faQuoteLeft
    case 'memo':
      return faStickyNote
    case 'analysis':
      return TOOL_REGISTRY[item.toolType]?.icon ?? faNotebookTabs
  }
}

/** Parse a drop onto the list into one or more new report items (or null
 *  for a reorder, handled by the caller). */
function parseDrop(e: React.DragEvent): ReportItem[] {
  const block = e.dataTransfer.getData(BLOCK_MIME)
  if (block) {
    const which = block === 'text' ? 'text' : 'section'
    return [
      which === 'text'
        ? { id: generateGuid(), kind: 'text', content: '' }
        : { id: generateGuid(), kind: 'section', title: '', level: 1 }
    ]
  }
  const queryRaw = e.dataTransfer.getData('application/x-magnolia-query')
  if (queryRaw) {
    try {
      const parsed = JSON.parse(queryRaw) as { guid: string } | { guid: string }[]
      const arr = Array.isArray(parsed) ? parsed : [parsed]
      return arr.filter((q) => q?.guid).map((q) => ({ id: generateGuid(), kind: 'query', refGuid: q.guid }))
    } catch { /* ignore */ }
  }
  const jsonRaw = e.dataTransfer.getData('application/json')
  if (jsonRaw) {
    try {
      const p = JSON.parse(jsonRaw) as { kind?: string; entityGuid?: string; toolType?: AnalysisToolType }
      if (p.kind === 'analysis' && p.entityGuid && p.toolType) {
        return [{ id: generateGuid(), kind: 'analysis', refGuid: p.entityGuid, toolType: p.toolType, options: {} }]
      }
      if (p.kind === 'quote' && p.entityGuid) {
        return [{ id: generateGuid(), kind: 'quote', refGuid: p.entityGuid }]
      }
      if (p.kind === 'memo' && p.entityGuid) {
        return [{ id: generateGuid(), kind: 'memo', refGuid: p.entityGuid }]
      }
    } catch { /* ignore */ }
  }
  return []
}

/** True when a drag carries something this tool accepts. */
function isAcceptedDrag(e: React.DragEvent): boolean {
  const t = e.dataTransfer.types
  return (
    t.includes(BLOCK_MIME) ||
    t.includes(REORDER_MIME) ||
    t.includes('application/x-magnolia-query') ||
    t.includes('application/json')
  )
}

/** True when the drag is an existing row being reordered (vs. an external
 *  item being added). */
function isReorderDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(REORDER_MIME)
}

/** Reordering an existing row is a 'move'; everything else is a 'copy'.
 *  The dropEffect MUST match the drag's effectAllowed or the browser
 *  rejects the drop (which is why reorder drops silently did nothing). */
function dropEffectFor(e: React.DragEvent): 'move' | 'copy' {
  return isReorderDrag(e) ? 'move' : 'copy'
}

export function Reports({ savedConfig, inTab }: Props) {
  const [items, setItems] = useState<ReportItem[]>(savedConfig?.items ?? [])
  const [analysisGuid] = useState(savedConfig?.guid ?? generateGuid())
  // The report's title is the analysis name, edited inline in the header
  // (active on open for a new report). It doubles as the PDF's <h1>.
  const [analysisName, setAnalysisName] = useState(savedConfig?.name ?? savedConfig?.title ?? '')
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)
  // The row currently being drag-reordered (dimmed as a placeholder while
  // a ghost of it follows the cursor). Ref mirror for use inside the drag
  // handlers, which fire before a state update would be visible.
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const draggingIdRef = useRef<string | null>(null)
  // FLIP reordering animation: row element + last-known-position refs.
  const rowEls = useRef(new Map<string, HTMLDivElement>())
  const prevTops = useRef(new Map<string, number>())
  const prevOrderRef = useRef('')
  const isExisting = !!savedConfig?.guid
  // True once the report has been saved at least once, so an inline title
  // edit persists the rename instead of waiting for the first save.
  const savedRef = useRef(isExisting)
  // The latest committed title, read synchronously by Save / Export so a
  // just-typed name isn't missed by a stale render of analysisName.
  const nameRef = useRef(savedConfig?.name ?? savedConfig?.title ?? '')
  // Skip the persist-to-config effect on first mount, so merely opening a
  // report doesn't dirty the project.
  const persistMountRef = useRef(true)

  // Live store reads so item cards always show current names.
  const savedQueries = useQueryStore((s) => s.savedQueries)
  const savedAnalyses = useProjectStore((s) => s.savedAnalyses)
  const quotes = useQuoteStore((s) => s.quotes)
  const memos = useMemoStore((s) => s.memos)
  // Subscribe so labels recompute when the referenced entities change.
  void savedQueries; void savedAnalyses; void quotes; void memos

  const currentConfig = useMemo(() => ({ items }), [items])
  const initialBaseline = useMemo(() => ({ items: savedConfig?.items ?? [] }), [])
  const { dirty, baseline, setBaseline } = useToolDirtyState(currentConfig, initialBaseline, inTab)

  const insertItemsAt = useCallback((index: number, newItems: ReportItem[]) => {
    if (newItems.length === 0) return
    setItems((prev) => {
      const next = [...prev]
      next.splice(Math.max(0, Math.min(index, next.length)), 0, ...newItems)
      return next
    })
  }, [])

  // Live reorder while dragging a row handle: drop the dragged item where
  // the pointer sits (by the other rows' vertical midpoints) so the list
  // reflows under the cursor. No-ops when the order is unchanged so we
  // don't thrash renders mid-drag.
  const liveReorder = useCallback((dragId: string, clientY: number) => {
    setItems((prev) => {
      const dragged = prev.find((it) => it.id === dragId)
      if (!dragged) return prev
      const others = prev.filter((it) => it.id !== dragId)
      let insertBefore = others.length
      for (let i = 0; i < others.length; i++) {
        const el = rowEls.current.get(others[i].id)
        if (!el) continue
        const rect = el.getBoundingClientRect()
        if (clientY < rect.top + rect.height / 2) { insertBefore = i; break }
      }
      const next = [...others.slice(0, insertBefore), dragged, ...others.slice(insertBefore)]
      if (next.every((it, i) => it.id === prev[i].id)) return prev
      return next
    })
  }, [])

  const endReorder = useCallback(() => {
    draggingIdRef.current = null
    setDraggingId(null)
  }, [])

  const handleDropAt = useCallback((index: number, e: React.DragEvent) => {
    e.preventDefault()
    // Stop the drop from also bubbling to the list container's onDrop,
    // which would insert the item a second time.
    e.stopPropagation()
    setDragOverIdx(null)
    if (e.dataTransfer.types.includes(REORDER_MIME)) {
      // A row reorder is finalised live during dragover; just end it.
      endReorder()
      return
    }
    insertItemsAt(index, parseDrop(e))
  }, [insertItemsAt, endReorder])

  const removeItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id))
  }, [])

  const updateItem = useCallback((id: string, patch: Partial<ReportItem>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? ({ ...it, ...patch } as ReportItem) : it)))
  }, [])

  const setAnalysisOption = useCallback((id: string, key: keyof AnalysisItemOptions, value: boolean) => {
    setItems((prev) =>
      prev.map((it) =>
        it.id === id && it.kind === 'analysis'
          ? { ...it, options: { ...it.options, [key]: value } }
          : it
      )
    )
  }, [])

  const handleSave = useCallback((name: string) => {
    setAnalysisName(name)
    nameRef.current = name
    savedRef.current = true
    window.api.sendAnalysisAction('save-analysis', {
      guid: analysisGuid,
      toolType: 'reports',
      name,
      config: { items }
    })
    setBaseline({ items })
    if (inTab) inTab.onSaved(analysisGuid, name)
    else setTimeout(() => window.close(), 200)
  }, [analysisGuid, items, inTab, setBaseline])

  // Commit an inline title edit: always track the new name; persist the
  // rename only once the report has been saved (before that the name is
  // just carried into the first save).
  const commitTitle = useCallback((newName: string) => {
    const name = newName.trim()
    if (!name) return
    nameRef.current = name
    setAnalysisName(name)
    // Reflect the title in the tab header immediately, like the other
    // tools do on rename. Set it directly (not via onSaved) so it doesn't
    // clear the unsaved-changes flag for an unsaved report.
    if (inTab?.tabId) useAnalysisTabsStore.getState().setTitle(inTab.tabId, name)
    if (savedRef.current) renameSavedAnalysis(analysisGuid, name)
  }, [analysisGuid, inTab])

  const handleDiscard = useCallback(() => {
    setItems(baseline.items)
  }, [baseline])

  useRegisterToolSave(inTab?.tabId, () => {
    handleSave(nameRef.current.trim() || 'Untitled Report')
    return true
  })

  const [exporting, setExporting] = useState(false)
  const handleExport = useCallback(async () => {
    setExporting(true)
    try {
      await exportReportPdf(nameRef.current || analysisName, items)
    } finally {
      setExporting(false)
    }
  }, [analysisName, items])

  // FLIP: when the item order changes, slide each row from its previous
  // position to its new one. Fires only on reorder (not on content edits),
  // so typing in a Text block never triggers an animation.
  useLayoutEffect(() => {
    const order = items.map((i) => i.id).join(',')
    const orderChanged = prevOrderRef.current !== '' && order !== prevOrderRef.current
    const newTops = new Map<string, number>()
    rowEls.current.forEach((el, id) => newTops.set(id, el.offsetTop))
    if (orderChanged) {
      newTops.forEach((newTop, id) => {
        // The dragged row is represented by the cursor ghost; let it snap
        // to its slot rather than sliding under the pointer.
        if (id === draggingIdRef.current) return
        const prev = prevTops.current.get(id)
        const el = rowEls.current.get(id)
        if (prev != null && el && prev !== newTop) {
          el.style.transition = 'none'
          el.style.transform = `translateY(${prev - newTop}px)`
          requestAnimationFrame(() => {
            el.style.transition = 'transform 0.22s ease'
            el.style.transform = ''
          })
        }
      })
    }
    prevTops.current = newTops
    prevOrderRef.current = order
  }, [items])

  // Persist the working report (title + items) to the per-tab config so it
  // survives tab switches / remounts and project reopen — even before the
  // report is saved. Skips the first mount so opening a report doesn't
  // dirty the project. InlineAnalysisTab ignores config when deriving its
  // analysis data, so these writes stay cheap.
  useEffect(() => {
    if (persistMountRef.current) { persistMountRef.current = false; return }
    const tabId = inTab?.tabId
    if (!tabId) return
    useAnalysisTabsStore.getState().setConfig(tabId, { title: analysisName, items })
  }, [analysisName, items, inTab?.tabId])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Title row + actions */}
      <div style={{ padding: '14px 20px 6px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)' }}>
          <Icon icon={faNotebookTabs} className="analysis-header-icon" style={{ fontSize: 16 }} />
          Report:
          <EditableTitleSuffix
            name={analysisName}
            onRename={commitTitle}
            autoEdit={!isExisting}
            placeholder="Untitled report"
          />
        </h2>
        <div style={{ flex: 1 }} />
        <button className="secondary" style={{ fontSize: 11, padding: '4px 14px' }} onClick={() => (inTab ? inTab.onClose() : window.close())}>
          Close
        </button>
        {isExisting && dirty && (
          <button className="secondary" style={{ fontSize: 11, padding: '4px 14px' }} onClick={handleDiscard}>
            Discard Changes
          </button>
        )}
        <button className="secondary" style={{ fontSize: 11, padding: '4px 14px' }} disabled={exporting} onClick={handleExport}>
          {exporting ? 'Exporting…' : 'Export PDF'}
        </button>
        {isExisting ? (
          <button style={{ fontSize: 11, padding: '4px 14px' }} disabled={!dirty} onClick={() => handleSave(nameRef.current.trim() || 'Untitled Report')}>
            {dirty ? 'Update Report' : 'Saved'}
          </button>
        ) : (
          <button style={{ fontSize: 11, padding: '4px 14px' }} onClick={() => handleSave(nameRef.current.trim() || 'Untitled Report')}>
            Save Report
          </button>
        )}
        <div style={{ width: 36, flexShrink: 0 }} />
      </div>

      {/* Tool toolbar: draggable Section / Text blocks. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 20px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-panel)', flexShrink: 0 }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 4 }}>Drag in:</span>
        <PaletteChip block="section" icon={faHeading1} label="Section" />
        <PaletteChip block="text" icon={faFont} label="Text" />
      </div>

      {/* The report list */}
      <div
        style={{ flex: 1, overflow: 'auto', padding: '14px 20px' }}
        onDragOver={(e) => {
          if (!isAcceptedDrag(e)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = dropEffectFor(e)
          if (isReorderDrag(e) && draggingIdRef.current) liveReorder(draggingIdRef.current, e.clientY)
        }}
        onDrop={(e) => handleDropAt(items.length, e)}
      >
        {items.length === 0 ? (
          <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)', border: '2px dashed var(--border-color)', borderRadius: 'var(--radius-md)' }}>
            Drag saved queries, analyses, quotes, and memos onto the canvas to build your report
          </div>
        ) : (
          <div>
            {items.map((item, idx) => (
              <div
                key={item.id}
                ref={(el) => { if (el) rowEls.current.set(item.id, el); else rowEls.current.delete(item.id) }}
                // While a row reorder is in flight, make the OTHER rows
                // ignore pointer events so dragover falls through to the
                // list container (live reorder) instead of their editable
                // fields showing a text caret as if the item could be
                // dropped inside them. The dragged row itself must keep
                // pointer events — disabling them on the drag source
                // cancels the native drag.
                style={{ opacity: draggingId === item.id ? 0.4 : 1, pointerEvents: draggingId && draggingId !== item.id ? 'none' : undefined }}
              >
                {/* Drop indicator before this row. */}
                <div
                  onDragOver={(e) => { if (isAcceptedDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = dropEffectFor(e); if (!isReorderDrag(e)) setDragOverIdx(idx) } }}
                  onDragLeave={() => setDragOverIdx((c) => (c === idx ? null : c))}
                  onDrop={(e) => handleDropAt(idx, e)}
                  style={{ height: 8, borderRadius: 2, background: dragOverIdx === idx ? 'var(--accent)' : 'transparent' }}
                />
                <ReportRow
                  item={item}
                  label={resolveItemLabel(item)}
                  onRemove={() => removeItem(item.id)}
                  onUpdate={(patch) => updateItem(item.id, patch)}
                  onSetOption={(key, value) => setAnalysisOption(item.id, key, value)}
                  onReorderStart={(e) => {
                    e.dataTransfer.setData(REORDER_MIME, item.id)
                    e.dataTransfer.effectAllowed = 'move'
                    const rowEl = rowEls.current.get(item.id)
                    if (rowEl) {
                      const rect = rowEl.getBoundingClientRect()
                      e.dataTransfer.setDragImage(rowEl, e.clientX - rect.left, e.clientY - rect.top)
                    }
                    draggingIdRef.current = item.id
                    setDraggingId(item.id)
                  }}
                  onReorderEnd={endReorder}
                />
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  )
}

function PaletteChip({ block, icon, label }: { block: 'section' | 'text'; icon: typeof faHeading1; label: string }) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(BLOCK_MIME, block)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      title={`Drag onto the list to add a ${label.toLowerCase()}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', padding: '3px 10px', cursor: 'grab' }}
    >
      <Icon icon={icon} style={{ fontSize: 11, color: 'var(--text-muted)' }} />
      {label}
    </div>
  )
}

function ReportRow({
  item,
  label,
  onRemove,
  onUpdate,
  onSetOption,
  onReorderStart,
  onReorderEnd
}: {
  item: ReportItem
  label: string
  onRemove: () => void
  onUpdate: (patch: Partial<ReportItem>) => void
  onSetOption: (key: keyof AnalysisItemOptions, value: boolean) => void
  onReorderStart: (e: React.DragEvent) => void
  onReorderEnd: () => void
}) {
  const caps = item.kind === 'analysis' ? ANALYSIS_CAPS[item.toolType] ?? {} : {}
  return (
    <div style={{ border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', background: 'var(--bg-secondary)', marginBottom: 2, padding: '8px 10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          draggable
          onDragStart={onReorderStart}
          onDragEnd={onReorderEnd}
          title="Drag to reorder"
          style={{ cursor: 'grab', color: 'var(--text-muted)', flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '6px 7px', margin: '-4px -3px', borderRadius: 'var(--radius-sm)' }}
        >
          <Icon icon={faBars} style={{ fontSize: 16 }} />
        </span>
        <Icon icon={itemIcon(item)} style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }} />
        <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', flexShrink: 0 }}>{reportItemTypeLabel(item)}</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {item.kind !== 'section' && item.kind !== 'text' ? label : ''}
        </span>
        <span onClick={onRemove} title="Remove" style={{ cursor: 'pointer', color: 'var(--text-muted)', flexShrink: 0, display: 'inline-flex' }}>
          <Icon icon={faXmark} style={{ fontSize: 12 }} />
        </span>
      </div>

      {/* Quote / memo: a preview of the content. */}
      {(item.kind === 'quote' || item.kind === 'memo') && (() => {
        const snippet = resolveItemSnippet(item)
        if (!snippet) return null
        return (
          <div style={{ marginTop: 6, paddingLeft: 28, fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'pre-wrap', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {item.kind === 'quote' ? `“${snippet}”` : snippet}
          </div>
        )
      })()}

      {/* Section: editable heading text + H1 / H2 level. */}
      {item.kind === 'section' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <div style={{ display: 'inline-flex', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', overflow: 'hidden', flexShrink: 0 }}>
            {([[1, 'Section'], [2, 'Subsection']] as const).map(([lvl, label]) => {
              const active = (item.level ?? 1) === lvl
              return (
                <button
                  key={lvl}
                  onClick={() => onUpdate({ level: lvl })}
                  title={`${label} (H${lvl})`}
                  style={{ fontSize: 11, fontWeight: 600, padding: '5px 10px', border: 'none', cursor: 'pointer', background: active ? 'var(--accent)' : 'var(--bg-tertiary)', color: active ? '#fff' : 'var(--text-secondary)' }}
                >
                  {label}
                </button>
              )
            })}
          </div>
          <input
            type="text"
            value={item.title}
            placeholder="Section heading"
            onChange={(e) => onUpdate({ title: e.target.value })}
            style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, padding: '5px 8px', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}
          />
        </div>
      )}

      {/* Text: inline rich-text editor (stored as markdown; no headings). */}
      {item.kind === 'text' && (
        <div style={{ marginTop: 8 }}>
          <MarkdownEditor value={item.content} onChange={(md) => onUpdate({ content: md })} style={{ minHeight: 90 }} headings={false} />
        </div>
      )}

      {/* Analysis: display options. */}
      {item.kind === 'analysis' && (caps.totalsOnly || caps.binary || caps.visual || caps.barChart || caps.wordCloud) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 8, paddingLeft: 28, flexWrap: 'wrap' }}>
          {caps.totalsOnly && (
            <OptionToggle label="Totals only" checked={!!item.options.totalsOnly} onChange={(v) => onSetOption('totalsOnly', v)} />
          )}
          {caps.binary && (
            <OptionToggle label="Binary" checked={!!item.options.binary} onChange={(v) => onSetOption('binary', v)} />
          )}
          {caps.visual && (
            <OptionToggle label="Visual" checked={!!item.options.visual} onChange={(v) => onSetOption('visual', v)} />
          )}
          {caps.barChart && (
            <OptionToggle label="Bar chart" checked={!!item.options.barChart} onChange={(v) => onSetOption('barChart', v)} />
          )}
          {caps.wordCloud && (
            <OptionToggle label="Word cloud" checked={!!item.options.wordCloud} onChange={(v) => onSetOption('wordCloud', v)} />
          )}
        </div>
      )}
    </div>
  )
}

function OptionToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-secondary)', cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}
