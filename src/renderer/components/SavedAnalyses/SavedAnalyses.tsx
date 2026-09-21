import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { useProjectStore, useCheckoutLockedBy, checkoutLockedTitle } from '../../stores/project-store'
import { useDocumentStore } from '../../stores/document-store'
import { useRelationshipMapStore } from '../../stores/relationship-map-store'
import { useMemoStore } from '../../stores/memo-store'
import { Icon, faXmark, faUpRightFromSquare, faDownLeftAndUpRightToCenter, faChevronDown, faChevronRight, MEMO_ICON, faMagnifyingGlass } from '../Icon'
import type { AnalysisToolType, SavedAnalysis } from '../../models/types'
import { TOOL_REGISTRY } from '../../utils/tool-registry'
import { toolColors } from '../../utils/tool-colors'
import { makeMapTabId } from '../../utils/tab-ids'
import { useClampedMenuPosition } from '../../utils/use-clamped-menu-position'

interface Props {
  onOpen: (toolType: AnalysisToolType, savedConfig: any) => void
  onClose?: () => void
  onPopOut?: () => void
  isPoppedOut?: boolean
  /** Returns the memo guid attached to the given saved analysis, or
   *  undefined when none. Drives the row indicator and context menu. */
  findMemoGuidForAnalysis?: (analysisGuid: string) => string | undefined
  /** Open the existing memo for an analysis (or create + open a new
   *  one if none exists yet). */
  onOpenAnalysisMemo?: (analysisGuid: string) => void
}

// Tool order matches the toolbar so the pane reads in the same sequence
// the user already knows from the top of the app. Tools not in this
// list (e.g. an unknown legacy tool) fall through to alphabetical at
// the bottom.
const TOOL_ORDER: AnalysisToolType[] = [
  'codes-in-documents',
  'results-in-documents',
  'code-cooccurrences',
  'code-frequencies',
  'code-orders',
  'word-frequencies',
  'relationship-map'
]

export function SavedAnalyses({ onOpen, onClose, onPopOut, isPoppedOut, findMemoGuidForAnalysis, onOpenAnalysisMemo }: Props) {
  // Enforced checkout lock: opening/browsing saved analyses stays live;
  // rename/delete/memo controls stay clickable but intercept and prompt
  // (Take Over / Create a Copy / Cancel) while someone else holds the
  // lock, rather than performing the mutation or silently doing nothing.
  const lockedBy = useCheckoutLockedBy()
  const promptCheckoutLocked = () => useProjectStore.getState().promptCheckoutConflict()
  const savedAnalyses = useProjectStore((s) => s.savedAnalyses) ?? []
  const setSavedAnalyses = useProjectStore((s) => s.setSavedAnalyses)

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; guid: string } | null>(null)
  const menuPos = useClampedMenuPosition(contextMenu)

  // Dismiss the context menu on any outside click — document-level so
  // clicking another pane / the viewer / the toolbar also closes it.
  useEffect(() => {
    if (!contextMenu) return
    const handleDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('.context-menu')) setContextMenu(null)
    }
    document.addEventListener('mousedown', handleDown)
    return () => document.removeEventListener('mousedown', handleDown)
  }, [contextMenu])
  const [editing, setEditing] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  // Per-tool collapse state. Tools not in the set are expanded.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setSearchQuery('')
  }, [])

  // Multi-select state. anchorGuidRef anchors shift-click range selection.
  const [selectedGuids, setSelectedGuids] = useState<Set<string>>(new Set())
  const anchorGuidRef = useRef<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<SavedAnalysis[] | null>(null)

  // Group analyses by their tool type. Sections render in TOOL_ORDER;
  // any tool not listed there falls through to the end alphabetically.
  // Within each group items are sorted by name.
  const groups = useMemo(() => {
    const byTool = new Map<string, SavedAnalysis[]>()
    for (const a of savedAnalyses) {
      const arr = byTool.get(a.toolType) ?? []
      arr.push(a)
      byTool.set(a.toolType, arr)
    }
    const orderedKeys: string[] = []
    for (const t of TOOL_ORDER) if (byTool.has(t)) orderedKeys.push(t)
    const extras = Array.from(byTool.keys()).filter((k) => !TOOL_ORDER.includes(k as AnalysisToolType))
    extras.sort()
    orderedKeys.push(...extras)
    return orderedKeys.map((toolType) => {
      const items = byTool.get(toolType)!.slice().sort((a, b) => a.name.localeCompare(b.name))
      return {
        toolType,
        label: TOOL_REGISTRY[toolType]?.label ?? toolType,
        icon: TOOL_REGISTRY[toolType]?.icon,
        color: toolColors[toolType as keyof typeof toolColors],
        items
      }
    })
  }, [savedAnalyses])

  const trimmedSearch = searchQuery.trim()

  /** Filter groups by analysis name, matching anywhere (not just the
   *  start). Tool-type section labels ("Code Frequencies" etc.) are
   *  fixed registry text, not user data, so only items are matched —
   *  a section just disappears once none of its items match. */
  const filteredGroups = useMemo(() => {
    if (!trimmedSearch) return groups
    const q = trimmedSearch.toLowerCase()
    return groups
      .map((g) => ({ ...g, items: g.items.filter((i) => i.name.toLowerCase().includes(q)) }))
      .filter((g) => g.items.length > 0)
  }, [groups, trimmedSearch])

  // Flat guid list in the visual order so shift-click range selection
  // still works across groups. Includes items from collapsed sections —
  // a range selection that crosses a collapsed section grabs them too,
  // matching how most file-tree pickers behave. Derived from the
  // filtered groups so a search doesn't let range-select or bulk actions
  // reach analyses the user can't currently see.
  const orderedGuids = useMemo(
    () => filteredGroups.flatMap((g) => g.items.map((i) => i.guid)),
    [filteredGroups]
  )

  // Esc clears selection and any open menus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setSelectedGuids(new Set())
        setContextMenu(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const handleItemClick = (e: React.MouseEvent, guid: string): void => {
    const isMeta = e.metaKey || e.ctrlKey
    const isShift = e.shiftKey
    if (isShift && anchorGuidRef.current) {
      const a = orderedGuids.indexOf(anchorGuidRef.current)
      const b = orderedGuids.indexOf(guid)
      if (a >= 0 && b >= 0) {
        const [from, to] = a <= b ? [a, b] : [b, a]
        const next = new Set<string>()
        for (let i = from; i <= to; i++) next.add(orderedGuids[i])
        setSelectedGuids(next)
      }
      return
    }
    if (isMeta) {
      setSelectedGuids((prev) => {
        const next = new Set(prev)
        if (next.has(guid)) next.delete(guid)
        else next.add(guid)
        return next
      })
      anchorGuidRef.current = guid
      return
    }
    setSelectedGuids(new Set([guid]))
    anchorGuidRef.current = guid
  }

  const handleItemRightClick = (e: React.MouseEvent, guid: string): void => {
    e.preventDefault()
    e.stopPropagation()
    // If right-clicked item isn't part of selection, make it sole target.
    if (!selectedGuids.has(guid)) {
      setSelectedGuids(new Set([guid]))
      anchorGuidRef.current = guid
    }
    setContextMenu({ x: e.clientX, y: e.clientY, guid })
  }

  /** Remove a set of saved analyses — and any tabs / popped-out windows
   *  that were showing them — in one go. Relationship Map tabs are
   *  closed via document-store; popped-out analysis windows are closed
   *  via the close-analysis-windows IPC. */
  const deleteAnalyses = (analyses: SavedAnalysis[]): void => {
    const guids = new Set(analyses.map((a) => a.guid))
    // Update renderer state FIRST so the pane visually drops the row
    // even if something downstream (IPC not yet available in dev, an
    // errant subscription) throws later.
    setSavedAnalyses(savedAnalyses.filter((a) => !guids.has(a.guid)))
    setSelectedGuids(new Set())
    anchorGuidRef.current = null
    // Close any open relationship-map tabs and drop their in-memory
    // state so the auto-save doesn't rewrite the deleted analysis.
    const docStore = useDocumentStore.getState()
    const rmStore = useRelationshipMapStore.getState()
    for (const a of analyses) {
      if (a.toolType === 'relationship-map') {
        docStore.closeToolTab(makeMapTabId(a.guid))
        rmStore.removeMap(a.guid)
      }
    }
    // Cascade: drop the saved-analysis memo (if any) for each deleted
    // analysis so it doesn't become an orphan invisible everywhere in
    // the UI.
    const memoStore = useMemoStore.getState()
    for (const memo of memoStore.memos) {
      if (memo.type === 'saved-analysis' && memo.analysisGuid && guids.has(memo.analysisGuid)) {
        memoStore.removeMemo(memo.guid)
      }
    }
  }

  const requestBulkDelete = (): void => {
    if (lockedBy) { promptCheckoutLocked(); return }
    const targets = savedAnalyses.filter((a) => selectedGuids.has(a.guid))
    if (targets.length === 0) return
    setDeleteConfirm(targets)
    setContextMenu(null)
  }

  const toggleCollapsed = (toolType: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(toolType)) next.delete(toolType)
      else next.add(toolType)
      return next
    })
  }

  return (
    <div className="panel">
      <div className="panel-header">
        {searchOpen ? (
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') closeSearch() }}
            placeholder="Filter analyses..."
            aria-label="Filter analyses"
            autoFocus
            style={{
              flex: 1,
              minWidth: 0,
              padding: '2px 6px',
              fontSize: 12,
              fontWeight: 400,
              letterSpacing: 'normal',
              textTransform: 'none',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-sm)',
              outline: 'none',
              background: 'var(--bg-input)',
              color: 'var(--text-primary)'
            }}
          />
        ) : (
          <span style={{ flex: 1 }}>Analyses</span>
        )}
        {savedAnalyses.length > 0 && (
          <button
            className="panel-header-search"
            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            title={searchOpen ? 'Close search' : 'Filter analyses'}
            aria-label={searchOpen ? 'Close search' : 'Filter analyses'}
          >
            <Icon icon={searchOpen ? faXmark : faMagnifyingGlass} />
          </button>
        )}
        {onPopOut && <button className="panel-header-popout" onClick={onPopOut} title={isPoppedOut ? "Pop back in" : "Pop out"} aria-label={isPoppedOut ? "Pop pane back into main window" : "Pop pane out into its own window"}><Icon icon={isPoppedOut ? faDownLeftAndUpRightToCenter : faUpRightFromSquare} /></button>}
        {onClose && <button className="panel-header-close" onClick={onClose} title="Close panel" aria-label="Close panel"><Icon icon={faXmark} /></button>}
      </div>
      <div className="panel-content">
        {savedAnalyses.length === 0 && (
          <div className="empty-state" style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
            No saved analyses.
            <br />
            Open an analysis tool and click Save Analysis.
          </div>
        )}
        {savedAnalyses.length > 0 && filteredGroups.length === 0 && (
          <div className="empty-state" style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
            No analyses match "{trimmedSearch}".
          </div>
        )}
        {filteredGroups.map((group, idx) => {
          const isCollapsed = !trimmedSearch && collapsed.has(group.toolType)
          const isFirst = idx === 0
          return (
            <div key={group.toolType}>
              {/* Section header — chevron + tool icon + label + count.
                  Click anywhere on the row to collapse/expand. Matches
                  the MemoSection styling, including the divider rule
                  between sections. */}
              <div
                onClick={() => toggleCollapsed(group.toolType)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 8px',
                  ...(!isFirst ? { marginTop: 4, borderTop: '1px solid var(--border-color)' } : {}),
                  cursor: 'pointer',
                  userSelect: 'none',
                  fontSize: 'var(--font-size-sm)',
                  fontWeight: 600,
                  color: 'var(--text-secondary)'
                }}
              >
                <Icon icon={isCollapsed ? faChevronRight : faChevronDown} style={{ fontSize: 9, width: 10, textAlign: 'center', opacity: 0.6 }} />
                {group.icon && (
                  <Icon icon={group.icon} style={{ fontSize: 11, opacity: 0.85, flexShrink: 0, width: 14, textAlign: 'center', color: 'var(--text-secondary)' }} />
                )}
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group.label}</span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 500 }}>{group.items.length}</span>
              </div>
              {!isCollapsed && group.items.map((sa) => {
                const isSelected = selectedGuids.has(sa.guid)
                return (
                  <div
                    key={sa.guid}
                    draggable
                    onDragStart={(e) => {
                      // Relationship-map JSON payload so the user can drag a saved
                      // analysis onto a map canvas as a node.
                      e.dataTransfer.setData('application/json', JSON.stringify({
                        kind: 'analysis',
                        entityGuid: sa.guid,
                        label: sa.name,
                        toolType: sa.toolType
                      }))
                      e.dataTransfer.effectAllowed = 'copy'
                    }}
                    style={{
                      padding: '4px 8px 4px 30px',
                      cursor: 'pointer',
                      borderRadius: 'var(--radius-sm)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 'var(--font-size-sm)',
                      background: isSelected ? 'var(--selection-bg)' : undefined
                    }}
                    onClick={(e) => handleItemClick(e, sa.guid)}
                    onDoubleClick={() => {
                      if (!editing) onOpen(sa.toolType, { ...sa.config, guid: sa.guid, name: sa.name })
                    }}
                    onContextMenu={(e) => handleItemRightClick(e, sa.guid)}
                  >
                    {editing === sa.guid ? (
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onBlur={() => {
                          const trimmed = editName.trim()
                          if (trimmed) {
                            setSavedAnalyses(savedAnalyses.map((a) => a.guid === sa.guid ? { ...a, name: trimmed } : a))
                            useRelationshipMapStore.getState().setName(sa.guid, trimmed)
                          }
                          setEditing(null)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const trimmed = editName.trim()
                            if (trimmed) {
                              setSavedAnalyses(savedAnalyses.map((a) => a.guid === sa.guid ? { ...a, name: trimmed } : a))
                              useRelationshipMapStore.getState().setName(sa.guid, trimmed)
                            }
                            setEditing(null)
                          } else if (e.key === 'Escape') {
                            setEditing(null)
                          }
                        }}
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                        style={{ flex: 1, padding: '1px 4px' }}
                      />
                    ) : (
                      <>
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {sa.name}
                        </span>
                        {findMemoGuidForAnalysis?.(sa.guid) && (
                          <Icon
                            icon={MEMO_ICON}
                            style={{ fontSize: 11, color: 'var(--memo-icon-color)', flexShrink: 0, cursor: 'pointer' }}
                            title="Open memo"
                            onClick={(e) => {
                              ;(e as any).stopPropagation()
                              onOpenAnalysisMemo?.(sa.guid)
                            }}
                          />
                        )}
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      {/* Item context menu. With >1 selected, Open/Rename are hidden
          because they only make sense per-item; Delete applies to all
          selected. */}
      {contextMenu && (
        <div
          ref={menuPos.ref}
          className="context-menu"
          style={{ left: menuPos.x, top: menuPos.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {selectedGuids.size <= 1 && (
            <>
              <div
                className="context-menu-item"
                onClick={() => {
                  const sa = savedAnalyses.find((a) => a.guid === contextMenu.guid)
                  if (sa) onOpen(sa.toolType, { ...sa.config, guid: sa.guid, name: sa.name })
                  setContextMenu(null)
                }}
              >
                Open
              </div>
              <div
                className="context-menu-item"
                title={lockedBy ? checkoutLockedTitle(lockedBy) : undefined}
                onClick={() => {
                  setContextMenu(null)
                  if (lockedBy) { promptCheckoutLocked(); return }
                  const sa = savedAnalyses.find((a) => a.guid === contextMenu.guid)
                  if (sa) {
                    setEditing(sa.guid)
                    setEditName(sa.name)
                  }
                }}
              >
                Rename
              </div>
              {onOpenAnalysisMemo && (
                <div
                  className="context-menu-item"
                  title={lockedBy ? checkoutLockedTitle(lockedBy) : undefined}
                  onClick={() => {
                    setContextMenu(null)
                    if (lockedBy) { promptCheckoutLocked(); return }
                    onOpenAnalysisMemo(contextMenu.guid)
                  }}
                >
                  {findMemoGuidForAnalysis?.(contextMenu.guid) ? 'View Memo' : 'Add Memo'}
                </div>
              )}
              <div className="context-menu-separator" />
            </>
          )}
          <div
            className="context-menu-item"
            style={{ color: 'var(--menu-fg-danger)' }}
            title={lockedBy ? checkoutLockedTitle(lockedBy) : undefined}
            onClick={requestBulkDelete}
          >
            {selectedGuids.size > 1 ? `Delete ${selectedGuids.size} analyses` : 'Delete'}
          </div>
        </div>
      )}

      {/* Bulk delete confirm */}
      {deleteConfirm && (
        <div
          className="modal-overlay"
          onClick={() => setDeleteConfirm(null)}
          style={{ position: 'fixed' }}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ margin: '0 0 12px' }}>
              {deleteConfirm.length > 1 ? `Delete ${deleteConfirm.length} analyses` : 'Delete analysis'}
            </h2>
            <p style={{ margin: '0 0 16px', fontSize: 'var(--font-size-sm)' }}>
              {deleteConfirm.length > 1
                ? `Delete ${deleteConfirm.length} saved analyses? Any of them currently open in a tab or window will be closed. This cannot be undone.`
                : `Delete "${deleteConfirm[0].name}"? If it's currently open, it will be closed. This cannot be undone.`}
            </p>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setDeleteConfirm(null)}>Cancel</button>
              <button
                style={{ background: 'var(--danger)' }}
                onClick={() => {
                  // Dismiss the dialog first so if the store updates
                  // inside deleteAnalyses trigger a render, the modal
                  // isn't shown briefly with a stale/empty target list.
                  const toDelete = deleteConfirm
                  setDeleteConfirm(null)
                  if (toDelete) deleteAnalyses(toDelete)
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
