import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { SavedQuery, Query } from '../../models/types'
import { Icon, faMagnifyingGlass, faXmark, MEMO_ICON } from '../Icon'
import { useClampedMenuPosition } from '../../utils/use-clamped-menu-position'
import { useTranslation } from 'react-i18next'

interface Props {
  /** The list to render. Caller is responsible for sourcing this from
   *  zustand (in the main window) or IPC init data (in the popped-out
   *  window). */
  savedQueries: SavedQuery[]
  /** Current active query — used to highlight which saved query's
   *  results are showing. May be undefined / null when no query is
   *  active. */
  currentQuery?: Query | null
  isActive: boolean
  onRunQuery: (guid: string) => void
  onDeleteQuery: (guid: string) => void
  onRenameQuery: (guid: string, newName: string) => void
  onEditQuery: (guid: string) => void
  /** Returns the guid of the memo attached to the given saved query, or
   *  undefined when none. Used to render the memo indicator next to
   *  rows and to drive the context-menu Add/View Memo option. */
  findMemoGuidForQuery?: (queryGuid: string) => string | undefined
  /** Open the existing memo for a query. */
  onOpenQueryMemo?: (queryGuid: string) => void
  /** Create a new memo for a query and open the edit window. */
  onCreateQueryMemo?: (queryGuid: string) => void
  /** Used by the in-app version to pulse a row after a save / rename
   *  to draw the user's eye. Optional. */
  pulsedQueryGuid?: string | null
  /** Accepted by the popped-out PanelWindow wrapper but not yet wired
   *  through to a pop-back-in button in the header. Kept on the type
   *  so the call site compiles; restore the button when polishing the
   *  popped-out queries view. */
  onPopOut?: () => void
  isPoppedOut?: boolean
}

export function SavedQueries({
  savedQueries,
  currentQuery,
  isActive,
  onRunQuery,
  onDeleteQuery,
  onRenameQuery,
  onEditQuery,
  findMemoGuidForQuery,
  onOpenQueryMemo,
  onCreateQueryMemo,
  pulsedQueryGuid
}: Props) {
  const { t } = useTranslation()
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; guid: string } | null>(null)
  const menuPos = useClampedMenuPosition(contextMenu)
  const [editing, setEditing] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [animatingGuid, setAnimatingGuid] = useState<string | null>(null)
  const [selectedGuids, setSelectedGuids] = useState<Set<string>>(new Set())
  const lastClickedRef = useRef<string | null>(null)
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setSearchQuery('')
  }, [])

  const activeQueryGuid = useMemo(() => {
    if (!isActive || !currentQuery) return null
    const match = savedQueries.find(
      (sq) => JSON.stringify(sq.query) === JSON.stringify(currentQuery)
    )
    return match?.guid ?? null
  }, [isActive, currentQuery, savedQueries])

  const trimmedSearch = searchQuery.trim().toLowerCase()
  const filteredQueries = useMemo(
    () => trimmedSearch ? savedQueries.filter((sq) => sq.name.toLowerCase().includes(trimmedSearch)) : savedQueries,
    [savedQueries, trimmedSearch]
  )

  // Shift-click range selection operates over what's currently visible, so
  // a search doesn't let it reach queries the user can't see.
  const flatGuids = useMemo(() => filteredQueries.map((sq) => sq.guid), [filteredQueries])

  useEffect(() => {
    if (pulsedQueryGuid) {
      setAnimatingGuid(pulsedQueryGuid)
      const el = rowRefs.current.get(pulsedQueryGuid)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      const timer = setTimeout(() => setAnimatingGuid(null), 1500)
      return () => clearTimeout(timer)
    }
  }, [pulsedQueryGuid])

  const handleClick = useCallback((guid: string, e: React.MouseEvent) => {
    if (editing) return
    if (e.shiftKey && lastClickedRef.current) {
      const from = flatGuids.indexOf(lastClickedRef.current)
      const to = flatGuids.indexOf(guid)
      if (from !== -1 && to !== -1) {
        const lo = Math.min(from, to)
        const hi = Math.max(from, to)
        const range = flatGuids.slice(lo, hi + 1)
        setSelectedGuids((prev) => {
          const next = new Set(prev)
          for (const g of range) next.add(g)
          return next
        })
      }
    } else if (e.metaKey || e.ctrlKey) {
      setSelectedGuids((prev) => {
        const next = new Set(prev)
        if (next.has(guid)) next.delete(guid)
        else next.add(guid)
        return next
      })
      lastClickedRef.current = guid
    } else {
      setSelectedGuids((prev) => {
        if (prev.size === 1 && prev.has(guid)) return new Set()
        return new Set([guid])
      })
      lastClickedRef.current = guid
    }
  }, [editing, flatGuids])

  const handleDoubleClick = useCallback((guid: string) => {
    if (!editing) onRunQuery(guid)
  }, [editing, onRunQuery])

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
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div className="panel-header">
        {searchOpen ? (
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') closeSearch() }}
            placeholder={t('queries.filterPlaceholder')}
            aria-label={t('queries.filter')}
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
          <span style={{ flex: 1 }}>{t('queries.savedHeading')}</span>
        )}
        {savedQueries.length > 0 && (
          <button
            className="panel-header-search"
            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            title={searchOpen ? t('common.closeSearch') : t('queries.filter')}
            aria-label={searchOpen ? t('common.closeSearch') : t('queries.filter')}
          >
            <Icon icon={searchOpen ? faXmark : faMagnifyingGlass} />
          </button>
        )}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: 4 }}>
      {savedQueries.length === 0 && (
        <div
          className="empty-state"
          style={{
            padding: 20,
            textAlign: 'center',
            color: 'var(--text-muted)',
            fontSize: 'var(--font-size-sm)'
          }}
        >
          {t('queries.empty')}
          <br />
          {t('queries.emptyHint')}
        </div>
      )}
      {savedQueries.length > 0 && filteredQueries.length === 0 && (
        <div
          className="empty-state"
          style={{
            padding: 20,
            textAlign: 'center',
            color: 'var(--text-muted)',
            fontSize: 'var(--font-size-sm)'
          }}
        >
          No saved queries match "{trimmedSearch}".
        </div>
      )}
      {filteredQueries.map((sq) => {
        const isSelected = selectedGuids.has(sq.guid)
        const isActiveQuery = activeQueryGuid === sq.guid
        return (
          <div
            key={sq.guid}
            ref={(el) => { if (el) rowRefs.current.set(sq.guid, el); else rowRefs.current.delete(sq.guid) }}
            draggable
            onDragStart={(e) => {
              if (isSelected && selectedGuids.size > 1) {
                const items = Array.from(selectedGuids).map((g) => {
                  const s = savedQueries.find((q) => q.guid === g)
                  return { guid: g, name: s?.name || '' }
                })
                e.dataTransfer.setData('application/x-magnolia-query', JSON.stringify(items))
                e.dataTransfer.setData('application/json', JSON.stringify({
                  kind: 'multi',
                  items: items.map((it) => ({ kind: 'query', entityGuid: it.guid, label: it.name }))
                }))
              } else {
                e.dataTransfer.setData('application/x-magnolia-query', JSON.stringify({ guid: sq.guid, name: sq.name }))
                e.dataTransfer.setData('application/json', JSON.stringify({
                  kind: 'query',
                  entityGuid: sq.guid,
                  label: sq.name
                }))
              }
              e.dataTransfer.effectAllowed = 'copy'
            }}
            style={{
              padding: '5px 8px',
              cursor: 'pointer',
              borderRadius: 'var(--radius-sm)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 'var(--font-size-sm)',
              fontWeight: isActiveQuery ? 700 : undefined,
              background: isSelected ? 'var(--selection-bg)' : undefined,
              animation: animatingGuid === sq.guid ? 'query-pulse 1.5s ease-out' : undefined
            }}
            onClick={(e) => handleClick(sq.guid, e)}
            onDoubleClick={(e) => {
              e.stopPropagation()
              handleDoubleClick(sq.guid)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setContextMenu({ x: e.clientX, y: e.clientY, guid: sq.guid })
            }}
            onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'var(--bg-hover)' }}
            onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = '' }}
          >
            {editing === sq.guid ? (
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={() => {
                  if (editName.trim()) onRenameQuery(sq.guid, editName.trim())
                  setEditing(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (editName.trim()) onRenameQuery(sq.guid, editName.trim())
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
                <Icon
                  icon={faMagnifyingGlass}
                  style={{ fontSize: 11, opacity: 0.75, flexShrink: 0, width: 14, textAlign: 'center', color: 'var(--text-secondary)' }}
                />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {sq.name}
                </span>
                {findMemoGuidForQuery?.(sq.guid) && (
                  <Icon
                    icon={MEMO_ICON}
                    style={{ fontSize: 11, color: 'var(--memo-icon-color)', flexShrink: 0, cursor: 'pointer' }}
                    title={t('common.openMemo')}
                    onClick={(e) => {
                      ;(e as any).stopPropagation()
                      onOpenQueryMemo?.(sq.guid)
                    }}
                  />
                )}
              </>
            )}
          </div>
        )
      })}

      {contextMenu && (
        <div
          ref={menuPos.ref}
          className="context-menu"
          style={{ left: menuPos.x, top: menuPos.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="context-menu-item"
            onClick={() => {
              onRunQuery(contextMenu.guid)
              setContextMenu(null)
            }}
          >
            {t('queries.run')}
          </div>
          <div
            className="context-menu-item"
            onClick={() => {
              onEditQuery(contextMenu.guid)
              setContextMenu(null)
            }}
          >
            {t('queries.edit')}
          </div>
          <div
            className="context-menu-item"
            onClick={() => {
              const sq = savedQueries.find((q) => q.guid === contextMenu.guid)
              if (sq) {
                setEditing(sq.guid)
                setEditName(sq.name)
              }
              setContextMenu(null)
            }}
          >
            {t('common.rename')}
          </div>
          {(onOpenQueryMemo || onCreateQueryMemo) && (
            <>
              <div className="context-menu-separator" />
              {findMemoGuidForQuery?.(contextMenu.guid) ? (
                <div
                  className="context-menu-item"
                  onClick={() => {
                    onOpenQueryMemo?.(contextMenu.guid)
                    setContextMenu(null)
                  }}
                >
                  {t('common.viewMemo')}
                </div>
              ) : (
                <div
                  className="context-menu-item"
                  onClick={() => {
                    onCreateQueryMemo?.(contextMenu.guid)
                    setContextMenu(null)
                  }}
                >
                  {t('common.addMemo')}
                </div>
              )}
            </>
          )}
          <div className="context-menu-separator" />
          <div
            className="context-menu-item"
            style={{ color: 'var(--menu-fg-danger)' }}
            onClick={() => {
              onDeleteQuery(contextMenu.guid)
              setContextMenu(null)
            }}
          >
            {t('common.delete')}
          </div>
        </div>
      )}
      </div>
    </div>
  )
}
