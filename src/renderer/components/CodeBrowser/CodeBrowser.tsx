import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useCodeStore } from '../../stores/code-store'
import { useDocumentStore } from '../../stores/document-store'
import { useQueryStore } from '../../stores/query-store'
import { MarkdownEditor } from '../MarkdownEditor'
import { Icon, faChevronDown, faChevronRight, faXmark, faUpRightFromSquare, faDownLeftAndUpRightToCenter, faPlus, faMagnifyingGlass } from '../Icon'
import type { Code } from '../../models/types'
import { useClampedMenuPosition } from '../../utils/use-clamped-menu-position'
import { isMac, modKey } from '../../utils/platform'
import { useProjectStore, useCheckoutLockedBy, checkoutLockedTitle } from '../../stores/project-store'

interface Props {
  onNewCode: () => void
  onClose?: () => void
  onPopOut?: () => void
  isPoppedOut?: boolean
}

/** Flatten a code tree into an ordered list of guids (for shift-click range selection) */
function flattenCodeGuids(codes: Code[]): string[] {
  const result: string[] = []
  for (const c of codes) {
    result.push(c.guid)
    result.push(...flattenCodeGuids(c.children))
  }
  return result
}

/** Filter a code tree by a search query, matching anywhere in the name
 *  (not just the start). A code is kept if its own name matches, or if
 *  any descendant matches (so the match's ancestor chain stays visible
 *  for tree context — CodeTreeItem dims the non-matching ancestors).
 *  `alwaysIncludeGuid` bypasses the match check for one code (and keeps
 *  its ancestors visible via the descendant-match rule) — used for a
 *  just-created code mid-rename, so it doesn't vanish under an active
 *  filter it doesn't yet match. */
function filterCodeTree(codes: Code[], query: string, alwaysIncludeGuid: string | null): Code[] {
  const q = query.trim().toLowerCase()
  if (!q) return codes
  const result: Code[] = []
  for (const code of codes) {
    const filteredChildren = filterCodeTree(code.children, query, alwaysIncludeGuid)
    const matchesSelf = code.guid === alwaysIncludeGuid || code.name.toLowerCase().includes(q)
    if (matchesSelf || filteredChildren.length > 0) {
      result.push({ ...code, children: filteredChildren })
    }
  }
  return result
}

const PRESET_COLORS = [
  '#e05050', '#e08050', '#e0c050', '#50c050', '#50c0c0',
  '#5080e0', '#8050e0', '#e050a0', '#c07030', '#7070e0',
  '#a0a040', '#40a0a0', '#a040a0', '#e07070', '#70b070'
]

function isDescendant(codes: Code[], parentGuid: string, childGuid: string): boolean {
  const find = (list: Code[]): boolean => {
    for (const c of list) {
      if (c.guid === parentGuid) {
        // Check if childGuid is anywhere in this subtree
        const inSubtree = (nodes: Code[]): boolean => {
          for (const n of nodes) {
            if (n.guid === childGuid) return true
            if (inSubtree(n.children)) return true
          }
          return false
        }
        return inSubtree(c.children)
      }
      if (find(c.children)) return true
    }
    return false
  }
  return find(codes)
}

function CodeTreeItem({
  code,
  depth,
  allCodes,
  selectedCodeGuids,
  codeCounts,
  onToggleSelect,
  onRename,
  onDelete,
  onRecolor,
  onAddChild,
  onMoveCode,
  onMoveCodeNear,
  onMergeInto,
  onEditMemo,
  onQueryAllDocs,
  onQueryActiveDoc,
  editingGuid,
  onStopEditing,
  searchQuery
}: {
  code: Code
  depth: number
  allCodes: Code[]
  selectedCodeGuids: Set<string>
  codeCounts: Map<string, number>
  onToggleSelect: (guid: string, e: React.MouseEvent) => void
  onRename: (guid: string, name: string) => void
  onDelete: (guid: string) => void
  onRecolor: (guid: string, color: string) => void
  onAddChild: (parentGuid: string) => void
  onMoveCode: (guid: string, newParentGuid: string | null) => void
  onMoveCodeNear: (guid: string, siblingGuid: string, position: 'before' | 'after') => void
  onMergeInto: (sourceGuid: string, targetGuid: string) => void
  onEditMemo: (guid: string) => void
  onQueryAllDocs: (codeGuid: string) => void
  onQueryActiveDoc: (codeGuid: string) => void
  editingGuid: string | null
  onStopEditing: () => void
  /** Active search filter (trimmed, empty when no search is running). When
   *  set, codes shown only for tree context (an ancestor of a match, but
   *  not itself matching) render dimmed, and every node force-expands so
   *  matches nested under a manually-collapsed parent stay visible. */
  searchQuery: string
}) {
  // Enforced checkout lock: dragging a code onto text (to apply it),
  // reordering/merging via drag-and-drop, and this row's own
  // rename/delete/recolor/merge context menu are mutations. Dragging
  // itself stays live (see draggable below) so the drop target — this
  // row's own reorder/merge drop zones, or DocumentViewer's apply-code
  // drop — is what intercepts and prompts if locked; reading/expanding
  // the tree is unaffected either way.
  const lockedBy = useCheckoutLockedBy()
  const promptCheckoutLocked = () => useProjectStore.getState().promptCheckoutConflict()
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const menuPos = useClampedMenuPosition(contextMenu)
  const isEditingFromParent = editingGuid === code.guid
  const [editingLocal, setEditingLocal] = useState(false)
  const editing = editingLocal || isEditingFromParent
  const [editName, setEditName] = useState(code.name)
  const [showColorPicker, setShowColorPicker] = useState(false)
  const [expanded, setExpanded] = useState(true)
  const searchActive = searchQuery.length > 0
  const isSearchMatch = !searchActive || isEditingFromParent || code.name.toLowerCase().includes(searchQuery.toLowerCase())
  const effectiveExpanded = expanded || searchActive
  const [isDragOver, setIsDragOver] = useState(false)
  const [dropPosition, setDropPosition] = useState<'before' | 'child' | 'after'>('child')
  const [showMergeDroplet, setShowMergeDroplet] = useState(false)
  const dragCounterRef = useRef(0)
  const rowRef = useRef<HTMLDivElement>(null)
  const isSelected = selectedCodeGuids.has(code.guid)
  const count = codeCounts.get(code.guid) || 0

  // Sync edit name when parent triggers editing
  useEffect(() => {
    if (isEditingFromParent) setEditName(code.name)
  }, [isEditingFromParent, code.name])

  // Dismiss context menu on any outside click
  useEffect(() => {
    if (!contextMenu) return
    const handleDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('.context-menu')) setContextMenu(null)
    }
    document.addEventListener('mousedown', handleDown)
    return () => document.removeEventListener('mousedown', handleDown)
  }, [contextMenu])

  return (
    <div>
      <div
        draggable
        onDragStart={(e) => {
          // If this code is in a multi-selection, drag all selected codes
          const isInSelection = selectedCodeGuids.has(code.guid) && selectedCodeGuids.size > 1
          if (isInSelection) {
            // Collect info for all selected codes
            const allSelected = Array.from(selectedCodeGuids).map((guid) => {
              const findInTree = (codes: Code[]): Code | undefined => {
                for (const c of codes) {
                  if (c.guid === guid) return c
                  const found = findInTree(c.children)
                  if (found) return found
                }
                return undefined
              }
              const c = findInTree(allCodes)
              return c ? { guid: c.guid, name: c.name, color: c.color } : null
            }).filter(Boolean) as { guid: string; name: string; color?: string }[]
            e.dataTransfer.setData('application/x-magnolia-code', JSON.stringify(allSelected[0]))
            e.dataTransfer.setData('application/x-magnolia-codes', JSON.stringify(allSelected))
            // Relationship-map JSON payload: single code → {kind:'code', ...},
            // multi-select → {kind:'multi', items: [...]}. The map's drop
            // handler unpacks the multi wrapper into a cascade of elements.
            if (allSelected.length === 1) {
              const c = allSelected[0]
              e.dataTransfer.setData('application/json', JSON.stringify({ kind: 'code', entityGuid: c.guid, label: c.name, codeColor: c.color }))
            } else {
              e.dataTransfer.setData('application/json', JSON.stringify({
                kind: 'multi',
                items: allSelected.map((c) => ({ kind: 'code', entityGuid: c.guid, label: c.name, codeColor: c.color }))
              }))
            }

            // Create custom drag image showing all selected codes
            const ghost = document.createElement('div')
            ghost.style.cssText = 'position:absolute;top:-9999px;left:-9999px;display:flex;flex-direction:column;gap:2px;padding:4px 8px;background:var(--bg-secondary,#2a2a2a);border:1px solid var(--border-color,#555);border-radius:4px;font-size:11px;color:var(--text-primary,#eee);white-space:nowrap;'
            for (const c of allSelected) {
              const row = document.createElement('div')
              row.style.cssText = 'display:flex;align-items:center;gap:5px;'
              const pip = document.createElement('span')
              pip.style.cssText = `width:8px;height:8px;border-radius:50%;background:${c.color || '#888'};flex-shrink:0;`
              row.appendChild(pip)
              row.appendChild(document.createTextNode(c.name))
              ghost.appendChild(row)
            }
            document.body.appendChild(ghost)
            e.dataTransfer.setDragImage(ghost, 10, 10)
            requestAnimationFrame(() => document.body.removeChild(ghost))
          } else {
            e.dataTransfer.setData('application/x-magnolia-code', JSON.stringify({
              guid: code.guid,
              name: code.name,
              color: code.color
            }))
            e.dataTransfer.setData('application/json', JSON.stringify({
              kind: 'code',
              entityGuid: code.guid,
              label: code.name,
              codeColor: code.color
            }))
          }
          e.dataTransfer.setData('application/x-magnolia-code-reorder', code.guid)
          e.dataTransfer.effectAllowed = 'copyMove'
        }}
        onDragEnter={(e) => {
          if (e.dataTransfer.types.includes('application/x-magnolia-code-reorder')) {
            e.preventDefault()
            dragCounterRef.current++
            setIsDragOver(true)
          }
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('application/x-magnolia-code-reorder')) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            // Compute drop position based on mouse Y
            if (rowRef.current) {
              const rect = rowRef.current.getBoundingClientRect()
              const y = e.clientY - rect.top
              const ratio = y / rect.height
              if (ratio < 0.25) setDropPosition('before')
              else if (ratio > 0.75) setDropPosition('after')
              else setDropPosition('child')
            }
          }
        }}
        onDragLeave={() => {
          dragCounterRef.current--
          if (dragCounterRef.current <= 0) {
            dragCounterRef.current = 0
            setIsDragOver(false)
          }
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          const pos = dropPosition
          dragCounterRef.current = 0
          setIsDragOver(false)
          setShowMergeDroplet(false)
          if (lockedBy) { promptCheckoutLocked(); return }

          // Read multi-selection data, fall back to single guid
          const multiData = e.dataTransfer.getData('application/x-magnolia-codes')
          const singleGuid = e.dataTransfer.getData('application/x-magnolia-code-reorder')
          const draggedGuids: string[] = multiData
            ? (JSON.parse(multiData) as { guid: string }[]).map((c) => c.guid)
            : singleGuid ? [singleGuid] : []
          if (draggedGuids.length === 0 || draggedGuids.includes(code.guid)) return

          // When a selection contains both a code and one of its
          // descendants, move only the top-level codes — each subtree
          // travels with its root, so the descendant comes along and keeps
          // its place. Re-parenting the descendant independently would pull
          // it out of its original parent and flatten the existing nesting.
          const topLevelDragged = draggedGuids.filter(
            (g) => !draggedGuids.some((other) => other !== g && isDescendant(allCodes, other, g))
          )

          if (pos === 'child') {
            for (const g of topLevelDragged) {
              if (g !== code.guid && !isDescendant(allCodes, g, code.guid)) {
                onMoveCode(g, code.guid)
              }
            }
            setExpanded(true)
          } else {
            // Insert in order: for 'before', process first-to-last; for 'after', process last-to-first
            const ordered = pos === 'before' ? topLevelDragged : [...topLevelDragged].reverse()
            for (const g of ordered) {
              if (g !== code.guid && !isDescendant(allCodes, g, code.guid)) {
                onMoveCodeNear(g, code.guid, pos)
              }
            }
          }
        }}
        ref={rowRef}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px',
          paddingLeft: 8 + depth * 16,
          cursor: 'grab',
          borderRadius: 'var(--radius-sm)',
          position: 'relative',
          background: isDragOver && dropPosition === 'child'
            ? 'var(--accent)'
            : isSelected
              ? 'var(--selection-bg)'
              : 'transparent',
          fontSize: 'var(--font-size-sm)',
          outline: isDragOver && dropPosition === 'child' ? '1px dashed var(--accent-hover)' : 'none',
          opacity: isSearchMatch ? 1 : 0.45,
          transition: 'background 0.1s'
        }}
        onClick={(e) => onToggleSelect(code.guid, e)}
        onDoubleClick={(e) => {
          e.stopPropagation()
          onEditMemo(code.guid)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setContextMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        {/* Reorder indicator line */}
        {isDragOver && dropPosition !== 'child' && (
          <div style={{
            position: 'absolute',
            left: 8 + depth * 16,
            right: 8,
            [dropPosition === 'before' ? 'top' : 'bottom']: -1,
            height: 2,
            background: 'var(--accent)',
            borderRadius: 1,
            pointerEvents: 'none',
            zIndex: 10
          }}>
            <div style={{
              position: 'absolute',
              left: -3,
              top: -2,
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--accent)'
            }} />
          </div>
        )}
        {/* Always reserve a fixed-width chevron slot so leaf codes align
            with their parent's name column instead of sliding left into
            the chevron position — preserves the visual hierarchy at
            every depth. */}
        <span
          onClick={code.children.length > 0 ? (e) => {
            e.stopPropagation()
            setExpanded(!expanded)
          } : undefined}
          style={{
            fontSize: 9,
            flexShrink: 0,
            width: 10,
            textAlign: 'center',
            opacity: 0.6,
            cursor: code.children.length > 0 ? 'pointer' : 'default'
          }}
        >
          {code.children.length > 0 && (
            <Icon icon={effectiveExpanded ? faChevronDown : faChevronRight} />
          )}
        </span>
        <span
          style={{ width: 14, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <span
            className="color-pip"
            style={{ background: code.color || '#888' }}
          />
        </span>
        {editing ? (
          <input
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            ref={(el) => { if (el && !el.dataset.selected) { el.select(); el.dataset.selected = 'true' } }}
            onBlur={() => {
              if (editName.trim()) onRename(code.guid, editName.trim())
              setEditingLocal(false)
              onStopEditing()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (editName.trim()) onRename(code.guid, editName.trim())
                setEditingLocal(false)
                onStopEditing()
              } else if (e.key === 'Escape') {
                setEditingLocal(false)
                onStopEditing()
              }
            }}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            style={{ flex: 1, padding: '1px 4px' }}
          />
        ) : (
          <>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {code.name}
            </span>
            {isDragOver && (
              <span
                onDragEnter={(e) => {
                  if (e.dataTransfer.types.includes('application/x-magnolia-code-reorder')) {
                    e.preventDefault()
                    setShowMergeDroplet(true)
                  }
                }}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes('application/x-magnolia-code-reorder')) {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                  }
                }}
                onDragLeave={() => setShowMergeDroplet(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  dragCounterRef.current = 0
                  setIsDragOver(false)
                  setShowMergeDroplet(false)
                  if (lockedBy) { promptCheckoutLocked(); return }
                  const draggedGuid = e.dataTransfer.getData('application/x-magnolia-code-reorder')
                  if (draggedGuid && draggedGuid !== code.guid) {
                    onMergeInto(draggedGuid, code.guid)
                  }
                }}
                style={{
                  flexShrink: 0,
                  padding: '1px 6px',
                  fontSize: 9,
                  fontWeight: 600,
                  color: showMergeDroplet ? '#fff' : 'var(--text-secondary)',
                  background: showMergeDroplet ? 'var(--danger)' : 'var(--bg-tertiary)',
                  borderRadius: 'var(--radius-sm)',
                  transition: 'background 0.15s',
                  cursor: 'pointer',
                  marginRight: 2
                }}
              >
                Merge
              </span>
            )}
            <span style={{ width: isMac ? 24 : 40, minWidth: isMac ? 24 : 40, flexShrink: 0, fontSize: 10, color: 'var(--text-muted)', textAlign: 'right' }}>
              {code.hotkey !== undefined ? modKey(code.hotkey) : ''}
            </span>
            <span style={{ width: 28, minWidth: 28, flexShrink: 0, fontSize: 10, color: 'var(--text-muted)', textAlign: 'right' }}>
              {count > 0 ? count : ''}
            </span>
          </>
        )}
      </div>

      {effectiveExpanded &&
        code.children.map((child) => (
          <CodeTreeItem
            key={child.guid}
            code={child}
            depth={depth + 1}
            allCodes={allCodes}
            selectedCodeGuids={selectedCodeGuids}
            codeCounts={codeCounts}
            onToggleSelect={onToggleSelect}
            onRename={onRename}
            onDelete={onDelete}
            onRecolor={onRecolor}
            onAddChild={onAddChild}
            onMoveCode={onMoveCode}
            onMoveCodeNear={onMoveCodeNear}
            onMergeInto={onMergeInto}
            onEditMemo={onEditMemo}
            onQueryAllDocs={onQueryAllDocs}
            onQueryActiveDoc={onQueryActiveDoc}
            editingGuid={editingGuid}
            onStopEditing={onStopEditing}
            searchQuery={searchQuery}
          />
        ))}

      {contextMenu && (
        <div
          ref={menuPos.ref}
          className="context-menu"
          style={{ left: menuPos.x, top: menuPos.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="context-menu-item"
            title={lockedBy ? checkoutLockedTitle(lockedBy) : undefined}
            onClick={() => {
              setContextMenu(null)
              if (lockedBy) { promptCheckoutLocked(); return }
              setEditName(code.name)
              setEditingLocal(true)
            }}
          >
            Rename
          </div>
          <div
            className="context-menu-item"
            title={lockedBy ? checkoutLockedTitle(lockedBy) : undefined}
            onClick={() => {
              setContextMenu(null)
              if (lockedBy) { promptCheckoutLocked(); return }
              setShowColorPicker(true)
            }}
          >
            Change Color
          </div>
          <div
            className="context-menu-item"
            title={lockedBy ? checkoutLockedTitle(lockedBy) : undefined}
            onClick={() => {
              setContextMenu(null)
              if (lockedBy) { promptCheckoutLocked(); return }
              onEditMemo(code.guid)
            }}
          >
            Edit Code
          </div>
          <div className="context-menu-separator" />
          <div
            className="context-menu-item"
            onClick={() => {
              onQueryAllDocs(code.guid)
              setContextMenu(null)
            }}
          >
            Show in All Documents
          </div>
          <div
            className="context-menu-item"
            onClick={() => {
              onQueryActiveDoc(code.guid)
              setContextMenu(null)
            }}
          >
            Show in Active Document
          </div>
          <div className="context-menu-separator" />
          <div
            className="context-menu-item"
            title={lockedBy ? checkoutLockedTitle(lockedBy) : undefined}
            onClick={() => {
              setContextMenu(null)
              if (lockedBy) { promptCheckoutLocked(); return }
              onAddChild(code.guid)
            }}
          >
            Add Child Code
          </div>
          <div
            className="context-menu-item"
            title={lockedBy ? checkoutLockedTitle(lockedBy) : undefined}
            onClick={() => {
              setContextMenu(null)
              if (lockedBy) { promptCheckoutLocked(); return }
              onMoveCode(code.guid, null)
            }}
          >
            Move to Top Level
          </div>
          <div className="context-menu-separator" />
          <div
            className="context-menu-item"
            style={{ color: 'var(--menu-fg-danger)' }}
            title={lockedBy ? checkoutLockedTitle(lockedBy) : undefined}
            onClick={() => {
              setContextMenu(null)
              if (lockedBy) { promptCheckoutLocked(); return }
              onDelete(code.guid)
            }}
          >
            Delete
          </div>
        </div>
      )}

      {showColorPicker && (
        <div
          className="modal-overlay"
          onClick={() => setShowColorPicker(false)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ minWidth: 250 }}>
            <h2>Choose Color</h2>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
              {PRESET_COLORS.map((c) => (
                <div
                  key={c}
                  onClick={() => {
                    onRecolor(code.guid, c)
                    setShowColorPicker(false)
                  }}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: '50%',
                    background: c,
                    cursor: 'pointer',
                    border: c === code.color ? '2px solid white' : '2px solid transparent'
                  }}
                />
              ))}
            </div>
            <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
              <label style={{ fontSize: 12 }}>Custom:</label>
              <input
                type="color"
                value={code.color || '#888888'}
                onInput={(e) => {
                  onRecolor(code.guid, (e.target as HTMLInputElement).value)
                }}
                onChange={(e) => {
                  onRecolor(code.guid, e.target.value)
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export function CodeEditDialog({
  code,
  onSave,
  onClose,
  initialColor
}: {
  code?: Code
  onSave: (name: string, color: string, description: string, hotkey: number | undefined) => void
  onClose: () => void
  initialColor?: string
}) {
  const defaultColors = [
    '#e05050', '#e08050', '#e0c050', '#50c050', '#5080e0',
    '#8050e0', '#e050a0', '#50c0c0', '#c07030', '#7070e0',
    '#a0a040', '#40a0a0', '#a040a0', '#e07070', '#70b070'
  ]
  const [name, setName] = useState(code?.name || '')
  const [color, setColor] = useState(code?.color || initialColor || defaultColors[0])
  const [description, setDescription] = useState(code?.description || '')
  const [hotkeyStr, setHotkeyStr] = useState(code?.hotkey !== undefined ? String(code.hotkey) : '')
  const [showColorPicker, setShowColorPicker] = useState(false)
  const isEdit = !!code

  const handleSave = () => {
    if (!name.trim()) return
    const hk = hotkeyStr.match(/^[0-9]$/) ? parseInt(hotkeyStr, 10) : undefined
    onSave(name.trim(), color, description, hk)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      {/* Fixed width so the modal doesn't grow as the user types a
          description — the auto-width TipTap editor would otherwise size
          the modal to its longest line. A definite width makes it wrap. */}
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 400 }}>
        <h2>{isEdit ? 'Edit Code' : 'New Code'}</h2>

        {/* Name + color pip */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <span
              className="color-pip"
              onClick={() => setShowColorPicker((v) => !v)}
              style={{
                background: color,
                width: 20,
                height: 20,
                cursor: 'pointer',
                border: '2px solid var(--border-color)',
                boxSizing: 'border-box'
              }}
              title="Choose color"
            />
            {showColorPicker && (
              <>
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 9 }}
                onClick={() => setShowColorPicker(false)}
              />
              <div
                style={{
                  position: 'absolute',
                  top: 28,
                  left: 0,
                  zIndex: 10,
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-sm)',
                  padding: 8,
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 6,
                  width: 210
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {defaultColors.map((c) => (
                  <div
                    key={c}
                    onClick={() => { setColor(c); setShowColorPicker(false) }}
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: '50%',
                      background: c,
                      cursor: 'pointer',
                      border: c === color ? '2px solid white' : '2px solid transparent',
                      boxSizing: 'border-box'
                    }}
                  />
                ))}
                <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                  <label style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Custom:</label>
                  <input
                    type="color"
                    value={color}
                    onInput={(e) => setColor((e.target as HTMLInputElement).value)}
                    onChange={(e) => setColor(e.target.value)}
                    style={{ padding: 0, width: 24, height: 20, border: 'none', background: 'none', cursor: 'pointer' }}
                  />
                </div>
              </div>
              </>
            )}
          </div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            placeholder="Code name..."
            autoFocus
            style={{ flex: 1 }}
          />
        </div>

        {/* Description */}
        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
            Description{isEdit ? '' : ' (optional)'}
          </label>
          <MarkdownEditor
            value={description}
            onChange={setDescription}
          />
        </div>

        {/* Hotkey */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <label style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
            {modKey('')}
          </label>
          <input
            type="text"
            value={hotkeyStr}
            onChange={(e) => {
              const v = e.target.value
              if (v === '' || /^[0-9]$/.test(v)) setHotkeyStr(v)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleSave()
              }
            }}
            placeholder="0–9"
            maxLength={1}
            style={{ width: 40, textAlign: 'center' }}
          />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Hotkey for quick coding
          </span>
        </div>

        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button onClick={handleSave}>{isEdit ? 'Save' : 'Create'}</button>
        </div>
      </div>
    </div>
  )
}

export function CodeBrowser({ onNewCode, onClose, onPopOut, isPoppedOut }: Props) {
  // Enforced checkout lock: browsing the code tree stays live, but
  // add/delete/rename/reorder/merge and dragging a code onto text are
  // disabled while someone else holds the lock.
  const lockedBy = useCheckoutLockedBy()
  const codes = useCodeStore((s) => s.codes)
  const renameCode = useCodeStore((s) => s.renameCode)
  const removeCode = useCodeStore((s) => s.removeCode)
  const recolorCode = useCodeStore((s) => s.recolorCode)
  const addCode = useCodeStore((s) => s.addCode)
  const moveCode = useCodeStore((s) => s.moveCode)
  const moveCodeNear = useCodeStore((s) => s.moveCodeNear)
  const mergeIntoCode = useCodeStore((s) => s.mergeIntoCode)
  const setCodeDescription = useCodeStore((s) => s.setCodeDescription)
  const setCodeHotkey = useCodeStore((s) => s.setCodeHotkey)
  const findCode = useCodeStore((s) => s.findCode)
  const sources = useDocumentStore((s) => s.sources)
  const [selectedCodeGuids, setSelectedCodeGuids] = useState<Set<string>>(new Set())
  const [editingMemoGuid, setEditingMemoGuid] = useState<string | null>(null)
  const [editingCodeGuid, setEditingCodeGuid] = useState<string | null>(null)
  const [mergeConfirm, setMergeConfirm] = useState<{ sourceGuid: string; targetGuid: string } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  // Collapsed by default — the filter input replaces the "Codes" title
  // in the header row itself rather than adding a permanent second row,
  // so the panel doesn't lose vertical space until the user asks to
  // search.
  const [searchOpen, setSearchOpen] = useState(false)
  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setSearchQuery('')
  }, [])
  const lastClickedRef = useRef<string | null>(null)

  // Compute code occurrence counts across all documents
  const codeCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const source of sources) {
      for (const sel of source.selections) {
        for (const coding of sel.codings) {
          counts.set(coding.codeGuid, (counts.get(coding.codeGuid) || 0) + 1)
        }
      }
    }
    return counts
  }, [sources])

  const trimmedSearch = searchQuery.trim()
  const filteredCodes = useMemo(
    () => filterCodeTree(codes, trimmedSearch, editingCodeGuid),
    [codes, trimmedSearch, editingCodeGuid]
  )

  // Shift-click range selection and select-all operate over what's
  // currently visible, so a search doesn't let either reach into codes
  // the user can't see.
  const flatOrder = useMemo(() => flattenCodeGuids(filteredCodes), [filteredCodes])

  // Listen for select-all event from App
  useEffect(() => {
    const handler = () => {
      setSelectedCodeGuids(new Set(flatOrder))
    }
    window.addEventListener('magnolia-select-all-codes', handler)
    return () => window.removeEventListener('magnolia-select-all-codes', handler)
  }, [flatOrder])

  const handleToggleSelect = useCallback((guid: string, e: React.MouseEvent) => {
    setSelectedCodeGuids((prev) => {
      if (e.shiftKey && lastClickedRef.current) {
        // Shift-click: range select from last clicked to this one
        const lastIdx = flatOrder.indexOf(lastClickedRef.current)
        const curIdx = flatOrder.indexOf(guid)
        if (lastIdx >= 0 && curIdx >= 0) {
          const lo = Math.min(lastIdx, curIdx)
          const hi = Math.max(lastIdx, curIdx)
          const range = new Set(flatOrder.slice(lo, hi + 1))
          const next = new Set(prev)
          for (const g of range) next.add(g)
          return next
        }
        return prev
      }
      if (e.metaKey || e.ctrlKey || e.altKey) {
        // Cmd/Ctrl/Alt-click: toggle this item
        const next = new Set(prev)
        if (next.has(guid)) next.delete(guid)
        else next.add(guid)
        lastClickedRef.current = guid
        return next
      }
      // Plain click = select only this code
      lastClickedRef.current = guid
      return new Set([guid])
    })
  }, [flatOrder])

  const handleAddChild = useCallback(
    (parentGuid: string) => {
      const parent = findCode(parentGuid)
      const color = parent?.color || PRESET_COLORS[0]
      const guid = addCode('New Code', color, parentGuid)
      setEditingCodeGuid(guid)
    },
    [addCode, findCode]
  )

  const handleQueryAllDocs = useCallback((codeGuid: string) => {
    useQueryStore.getState().setComplexQuery({
      documentFilter: {},
      codeCondition: { type: 'code', codeGuid }
    })
  }, [])

  const handleQueryActiveDoc = useCallback((codeGuid: string) => {
    const viewedGuid = useDocumentStore.getState().viewedDocumentGuid
    if (!viewedGuid) return
    useQueryStore.getState().setComplexQuery({
      documentFilter: { sourceGuids: [viewedGuid] },
      codeCondition: { type: 'code', codeGuid }
    })
  }, [])

  return (
    <div
      className="panel"
      // Marks this panel so a modal (e.g. the speaker-coding dialog) can leave
      // it interactive — and un-greyed — while dimming the rest of the window.
      data-spotlight="code-browser"
      onDragOver={(e) => {
        // Allow dropping codes on the empty area to move them to top level
        if (e.dataTransfer.types.includes('application/x-magnolia-code-reorder')) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
        }
      }}
      onDrop={(e) => {
        // Drop on empty space = move to top level
        if (e.dataTransfer.types.includes('application/x-magnolia-code-reorder')) {
          if (lockedBy) { useProjectStore.getState().promptCheckoutConflict(); return }
          const multiData = e.dataTransfer.getData('application/x-magnolia-codes')
          const singleGuid = e.dataTransfer.getData('application/x-magnolia-code-reorder')
          const guids: string[] = multiData
            ? (JSON.parse(multiData) as { guid: string }[]).map((c) => c.guid)
            : singleGuid ? [singleGuid] : []
          for (const g of guids) moveCode(g, null)
        }
      }}
    >
      <div className="panel-header">
        {searchOpen ? (
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') closeSearch() }}
            placeholder="Filter codes..."
            aria-label="Filter codes"
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
          <span style={{ flex: 1 }}>Codes</span>
        )}
        {codes.length > 0 && (
          <button
            className="panel-header-search"
            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            title={searchOpen ? 'Close search' : 'Filter codes'}
            aria-label={searchOpen ? 'Close search' : 'Filter codes'}
          >
            <Icon icon={searchOpen ? faXmark : faMagnifyingGlass} />
          </button>
        )}
        <button
          className="panel-header-add"
          onClick={onNewCode}
          title={lockedBy ? checkoutLockedTitle(lockedBy) : 'Create new code'}
          aria-label="Create new code"
          style={lockedBy ? { opacity: 0.4 } : undefined}
        >
          <Icon icon={faPlus} />
        </button>
        {onPopOut && <button className="panel-header-popout" onClick={onPopOut} title={isPoppedOut ? "Pop back in" : "Pop out"} aria-label={isPoppedOut ? "Pop pane back into main window" : "Pop pane out into its own window"}><Icon icon={isPoppedOut ? faDownLeftAndUpRightToCenter : faUpRightFromSquare} /></button>}
        {onClose && <button className="panel-header-close" onClick={onClose} title="Close panel" aria-label="Close panel"><Icon icon={faXmark} /></button>}
      </div>
      <div className="panel-content">
        {codes.length === 0 && (
          <div
            className="empty-state"
            style={{
              padding: 20,
              textAlign: 'center',
              color: 'var(--text-muted)',
              fontSize: 'var(--font-size-sm)'
            }}
          >
            No codes yet.
            <br />
            Click the + button above or use Codes menu.
          </div>
        )}
        {codes.length > 0 && filteredCodes.length === 0 && (
          <div
            className="empty-state"
            style={{
              padding: 20,
              textAlign: 'center',
              color: 'var(--text-muted)',
              fontSize: 'var(--font-size-sm)'
            }}
          >
            No codes match "{trimmedSearch}".
          </div>
        )}
        {filteredCodes.map((code) => (
          <CodeTreeItem
            key={code.guid}
            code={code}
            depth={0}
            allCodes={codes}
            selectedCodeGuids={selectedCodeGuids}
            codeCounts={codeCounts}
            onToggleSelect={handleToggleSelect}
            onRename={renameCode}
            onDelete={removeCode}
            onRecolor={recolorCode}
            onAddChild={handleAddChild}
            onMoveCode={moveCode}
            onMoveCodeNear={moveCodeNear}
            onMergeInto={(sourceGuid, targetGuid) => setMergeConfirm({ sourceGuid, targetGuid })}
            onEditMemo={setEditingMemoGuid}
            onQueryAllDocs={handleQueryAllDocs}
            onQueryActiveDoc={handleQueryActiveDoc}
            editingGuid={editingCodeGuid}
            onStopEditing={() => setEditingCodeGuid(null)}
            searchQuery={trimmedSearch}
          />
        ))}
      </div>

      {/* Merge confirmation dialog */}
      {mergeConfirm && (() => {
        const sourceCode = findCode(mergeConfirm.sourceGuid)
        const targetCode = findCode(mergeConfirm.targetGuid)
        if (!sourceCode || !targetCode) return null
        const sourceCount = codeCounts.get(sourceCode.guid) || 0
        return (
          <div className="modal-overlay" onClick={() => setMergeConfirm(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()} style={{ minWidth: 400 }}>
              <h2>Merge Codes</h2>
              <p style={{ fontSize: 'var(--font-size-sm)', lineHeight: 1.5, marginBottom: 12 }}>
                Merge <strong>{sourceCode.name}</strong> into <strong>{targetCode.name}</strong>?
                {sourceCount > 0 && (
                  <> All {sourceCount} coded segment{sourceCount !== 1 ? 's' : ''} will be recoded with <strong>{targetCode.name}</strong>.</>
                )}
                {' '}This cannot be undone.
              </p>
              <div className="modal-actions">
                <button className="secondary" onClick={() => setMergeConfirm(null)}>Cancel</button>
                <button
                  className="danger"
                  onClick={() => {
                    mergeIntoCode(mergeConfirm.sourceGuid, mergeConfirm.targetGuid)
                    setMergeConfirm(null)
                  }}
                >
                  Merge
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Edit Code dialog */}
      {editingMemoGuid && (() => {
        const editCode = findCode(editingMemoGuid)
        if (!editCode) return null
        return (
          <CodeEditDialog
            code={editCode}
            onSave={(name, color, desc, hotkey) => {
              renameCode(editingMemoGuid, name)
              recolorCode(editingMemoGuid, color)
              setCodeDescription(editingMemoGuid, desc)
              setCodeHotkey(editingMemoGuid, hotkey)
              setEditingMemoGuid(null)
            }}
            onClose={() => setEditingMemoGuid(null)}
          />
        )
      })()}
    </div>
  )
}
