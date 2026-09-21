import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useMemoStore } from '../../stores/memo-store'
import { useDocumentStore } from '../../stores/document-store'
import { useProjectStore, useCheckoutLockedBy, checkoutLockedTitle } from '../../stores/project-store'
import { useSurveyViewStore } from '../../stores/survey-view-store'
import { Icon, MEMO_ICON, faChevronDown, faChevronRight, faXmark, faUpRightFromSquare, faDownLeftAndUpRightToCenter, faPlus, faMagnifyingGlass } from '../Icon'
import { generateGuid } from '../../utils/guid'
import { isToolTab } from '../../utils/tab-ids'
import { useClampedMenuPosition } from '../../utils/use-clamped-menu-position'
import type { Memo, MemoType, MemoEditInitData } from '../../models/types'

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function MemoItem({
  memo,
  selected,
  onItemClick,
  onDoubleClick,
  onRightClick,
  draggable,
  onDragStart,
  indent
}: {
  memo: Memo
  selected: boolean
  /** Fires on any left-click: handles plain/shift/ctrl/cmd selection
   *  semantics *and* optional single-click navigation. MemosPane owns
   *  the logic. */
  onItemClick: (e: React.MouseEvent, memo: Memo) => void
  onDoubleClick: () => void
  onRightClick: (e: React.MouseEvent, memo: Memo) => void
  draggable?: boolean
  onDragStart?: (e: React.DragEvent) => void
  /** Left padding so the memo row reads as nested under its parent
   *  group header (Analysis Memos → map sub-group → memos). Defaults
   *  to 8 px (top-level / single-section position). */
  indent?: number
}) {
  return (
    <div
      style={{
        padding: `5px 8px 5px ${indent ?? 8}px`,
        cursor: 'pointer',
        fontSize: 'var(--font-size-sm)',
        transition: 'background 0.1s',
        background: selected ? 'var(--selection-bg)' : undefined
      }}
      className="codebook-entry"
      onClick={(e) => onItemClick(e, memo)}
      onDoubleClick={onDoubleClick}
      draggable={draggable !== false}
      onDragStart={(e) => {
        // Relationship-map JSON payload so memos can be dropped onto an
        // inline map or the popped-out map canvas.
        e.dataTransfer.setData('application/json', JSON.stringify({
          kind: 'memo',
          entityGuid: memo.guid,
          label: memo.title,
          snippet: memo.content
        }))
        e.dataTransfer.effectAllowed = 'copy'
        if (onDragStart) onDragStart(e)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        onRightClick(e, memo)
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{
          fontWeight: 500,
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}>
          {memo.title || 'Untitled Memo'}
        </span>
        <span
          style={{ fontSize: 11, flexShrink: 0, color: 'var(--memo-icon-color)', cursor: 'pointer' }}
          title="Open memo"
          onClick={(e) => {
            e.stopPropagation()
            onDoubleClick()
          }}
        >
          <Icon icon={MEMO_ICON} />
        </span>
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
        {formatDate(memo.createdDateTime)}
        {memo.content && (
          <span> — {memo.content.slice(0, 40)}{memo.content.length > 40 ? '...' : ''}</span>
        )}
      </div>
    </div>
  )
}

function MemoSection({
  title,
  memos,
  selectedGuids,
  onItemClick,
  onRightClick,
  onOpen,
  draggable,
  onDragStartMemo,
  onDrop,
  droppable,
  defaultExpanded,
  isFirst,
  forceExpanded
}: {
  title: string
  memos: Memo[]
  selectedGuids: Set<string>
  onItemClick: (e: React.MouseEvent, memo: Memo) => void
  onRightClick: (e: React.MouseEvent, memo: Memo) => void
  onOpen: (guid: string) => void
  draggable?: boolean
  onDragStartMemo?: (e: React.DragEvent, memo: Memo) => void
  onDrop?: (e: React.DragEvent) => void
  droppable?: boolean
  defaultExpanded?: boolean
  isFirst?: boolean
  /** While a search is active, force the section open regardless of its
   *  own collapse state so filtered matches stay visible. */
  forceExpanded?: boolean
}) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? true)
  const [isDragOver, setIsDragOver] = useState(false)
  const effectiveExpanded = expanded || !!forceExpanded

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 8px',
          ...(!isFirst ? { marginTop: 4, borderTop: '1px solid var(--border-color)' } : {}),
          cursor: 'pointer',
          fontSize: 'var(--font-size-sm)',
          fontWeight: 600,
          color: 'var(--text-secondary)',
          userSelect: 'none',
          background: isDragOver ? 'var(--selection-bg)' : undefined
        }}
        onClick={() => setExpanded((v) => !v)}
        onDragOver={droppable ? (e) => { e.preventDefault(); setIsDragOver(true) } : undefined}
        onDragLeave={droppable ? () => setIsDragOver(false) : undefined}
        onDrop={droppable ? (e) => { setIsDragOver(false); onDrop?.(e) } : undefined}
      >
        <span style={{ fontSize: 10, width: 12, textAlign: 'center', opacity: 0.6 }}>
          <Icon icon={effectiveExpanded ? faChevronDown : faChevronRight} />
        </span>
        <span style={{ flex: 1 }}>{title}</span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{memos.length}</span>
      </div>
      {effectiveExpanded && memos.map((memo) => (
        <MemoItem
          key={memo.guid}
          memo={memo}
          selected={selectedGuids.has(memo.guid)}
          onItemClick={onItemClick}
          onDoubleClick={() => onOpen(memo.guid)}
          onRightClick={onRightClick}
          draggable={draggable}
          onDragStart={onDragStartMemo ? (e) => onDragStartMemo(e, memo) : undefined}
        />
      ))}
    </div>
  )
}

/** Analysis Memos section: header + one collapsible sub-group per map. */
function AnalysisMemoGroups({
  groups,
  unattached,
  selectedGuids,
  onItemClick,
  onRightClick,
  onOpen,
  onDragStart,
  isFirst
}: {
  groups: { guid: string; name: string; memos: Memo[] }[]
  unattached: Memo[]
  selectedGuids: Set<string>
  onItemClick: (e: React.MouseEvent, memo: Memo) => void
  onRightClick: (e: React.MouseEvent, memo: Memo) => void
  onOpen: (guid: string) => void
  onDragStart: (e: React.DragEvent, memo: Memo) => void
  isFirst?: boolean
}) {
  const [sectionExpanded, setSectionExpanded] = useState(true)
  const total = groups.reduce((n, g) => n + g.memos.length, 0) + unattached.length

  return (
    <div>
      <div
        onClick={() => setSectionExpanded((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 8px',
          ...(!isFirst ? { marginTop: 4, borderTop: '1px solid var(--border-color)' } : {}),
          cursor: 'pointer',
          fontSize: 'var(--font-size-sm)',
          fontWeight: 600,
          color: 'var(--text-secondary)',
          userSelect: 'none'
        }}
      >
        <span style={{ fontSize: 10, width: 12, textAlign: 'center', opacity: 0.6 }}>
          <Icon icon={sectionExpanded ? faChevronDown : faChevronRight} />
        </span>
        <span style={{ flex: 1 }}>Analysis Memos</span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{total}</span>
      </div>
      {sectionExpanded && groups.map((g) => (
        <AnalysisMemoMapGroup
          key={g.guid}
          name={g.name}
          memos={g.memos}
          selectedGuids={selectedGuids}
          onItemClick={onItemClick}
          onRightClick={onRightClick}
          onOpen={onOpen}
          onDragStart={onDragStart}
        />
      ))}
      {sectionExpanded && unattached.length > 0 && (
        <AnalysisMemoMapGroup
          name="(unlinked)"
          memos={unattached}
          selectedGuids={selectedGuids}
          onItemClick={onItemClick}
          onRightClick={onRightClick}
          onOpen={onOpen}
          onDragStart={onDragStart}
        />
      )}
    </div>
  )
}

function AnalysisMemoMapGroup({
  name,
  memos,
  selectedGuids,
  onItemClick,
  onRightClick,
  onOpen,
  onDragStart
}: {
  name: string
  memos: Memo[]
  selectedGuids: Set<string>
  onItemClick: (e: React.MouseEvent, memo: Memo) => void
  onRightClick: (e: React.MouseEvent, memo: Memo) => void
  onOpen: (guid: string) => void
  onDragStart: (e: React.DragEvent, memo: Memo) => void
}) {
  const [expanded, setExpanded] = useState(true)
  return (
    <div>
      <div
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px 4px 22px',
          cursor: 'pointer',
          fontSize: 'var(--font-size-sm)',
          fontWeight: 500,
          color: 'var(--text-secondary)',
          userSelect: 'none'
        }}
      >
        <span style={{ fontSize: 10, width: 12, textAlign: 'center', opacity: 0.6 }}>
          <Icon icon={expanded ? faChevronDown : faChevronRight} />
        </span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{memos.length}</span>
      </div>
      {expanded && memos.map((memo) => (
        <MemoItem
          key={memo.guid}
          memo={memo}
          selected={selectedGuids.has(memo.guid)}
          onItemClick={onItemClick}
          onDoubleClick={() => onOpen(memo.guid)}
          onRightClick={onRightClick}
          draggable
          onDragStart={(e) => onDragStart(e, memo)}
          // Align the memo row's icon with the map sub-group's text:
          // map header has 22 px left padding + 12 px chevron + 6 px
          // gap = 40 px to where the map name begins.
          indent={40}
        />
      ))}
    </div>
  )
}

interface Props {
  onClose?: () => void
  onPopOut?: () => void
  isPoppedOut?: boolean
}

export function MemosPane({ onClose, onPopOut, isPoppedOut }: Props) {
  // Enforced checkout lock: reading existing memos stays live; the
  // controls for creating, editing, and deleting stay clickable but
  // intercept and prompt (Take Over / Create a Copy / Cancel) while
  // someone else holds the lock, rather than performing the mutation or
  // silently doing nothing.
  const lockedBy = useCheckoutLockedBy()
  const promptCheckoutLocked = () => useProjectStore.getState().promptCheckoutConflict()
  const memos = useMemoStore((s) => s.memos)
  const addMemo = useMemoStore((s) => s.addMemo)
  const removeMemo = useMemoStore((s) => s.removeMemo)
  const findMemo = useMemoStore((s) => s.findMemo)
  const changeMemoType = useMemoStore((s) => s.changeMemoType)
  // The store's `viewedDocumentGuid` slot doubles as the active tab id and
  // can hold a tool-tab id (map:/analysis:/query-builder:) when a non-document
  // tool is open. Memos only care about real documents, so collapse those
  // tool-tab states to null here.
  const activeTabId = useDocumentStore((s) => s.viewedDocumentGuid)
  const viewedDocumentGuid = activeTabId && !isToolTab(activeTabId) ? activeTabId : null
  const viewDocument = useDocumentStore((s) => s.viewDocument)
  const viewDocumentAt = useDocumentStore((s) => s.viewDocumentAt)
  const setSurveyView = useSurveyViewStore((s) => s.setView)
  const setSurveyScrollTarget = useSurveyViewStore((s) => s.setScrollTarget)

  // Single-click on a memo navigates to its associated document (and scrolls
  // to the anchor for selection memos). Project/analysis memos have no doc.
  const handleSingleClickMemo = useCallback((memo: Memo) => {
    // Survey-question memo → switch to Question view of that question.
    if (memo.type === 'survey-question' && memo.sourceGuid && memo.questionGuid) {
      setSurveyView(memo.sourceGuid, 'question', memo.questionGuid)
      setSurveyScrollTarget({
        surveyGuid: memo.sourceGuid,
        questionId: memo.questionGuid
      })
      viewDocument(memo.sourceGuid)
      return
    }
    // Survey-respondent memo → switch to Respondent view of that
    // respondent (no question scroll target — the memo sits on the
    // sticky header at the very top).
    if (memo.type === 'survey-respondent' && memo.sourceGuid && memo.respondentId) {
      setSurveyView(memo.sourceGuid, 'respondent', memo.respondentId)
      setSurveyScrollTarget({
        surveyGuid: memo.sourceGuid,
        respondentId: memo.respondentId
      })
      viewDocument(memo.sourceGuid)
      return
    }
    // Survey-cell memo (whole-cell, FAB-created) or span content
    // memo inside a survey cell → Respondent view of that
    // respondent, scroll to the matching question section.
    if ((memo.type === 'survey-cell' || memo.type === 'content') && memo.sourceGuid && memo.surveyCell) {
      setSurveyView(memo.sourceGuid, 'respondent', memo.surveyCell.respondentId)
      setSurveyScrollTarget({
        surveyGuid: memo.sourceGuid,
        respondentId: memo.surveyCell.respondentId,
        questionId: memo.surveyCell.questionId
      })
      viewDocument(memo.sourceGuid)
      return
    }
    if (memo.type === 'content' && memo.sourceGuid && memo.startPosition !== undefined) {
      viewDocumentAt(memo.sourceGuid, memo.startPosition, memo.endPosition ?? memo.startPosition, memo.pdfRegion)
    } else if (memo.type === 'document' && memo.sourceGuids && memo.sourceGuids.length > 0) {
      viewDocument(memo.sourceGuids[0])
    }
  }, [viewDocument, viewDocumentAt, setSurveyView, setSurveyScrollTarget])

  const [newMemoMenu, setNewMemoMenu] = useState<{ x: number; y: number } | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setSearchQuery('')
  }, [])
  const trimmedSearch = searchQuery.trim()
  const filterByTitle = useCallback(
    (list: Memo[]) => {
      if (!trimmedSearch) return list
      const q = trimmedSearch.toLowerCase()
      return list.filter((m) => (m.title || 'Untitled Memo').toLowerCase().includes(q))
    },
    [trimmedSearch]
  )

  const projectMemos = useMemo(() => memos.filter((m) => m.type === 'project'), [memos])
  const documentMemos = useMemo(
    () => memos.filter((m) => {
      if (!viewedDocumentGuid) return false
      // Plain document memos.
      if (m.type === 'document') return !!m.sourceGuids?.includes(viewedDocumentGuid)
      // Survey-question and survey-respondent memos behave as document
      // memos for the survey they're attached to — they group under
      // the survey's row in the Memos pane the same way a document
      // memo would.
      if (m.type === 'survey-question') return m.sourceGuid === viewedDocumentGuid
      if (m.type === 'survey-respondent') return m.sourceGuid === viewedDocumentGuid
      return false
    }),
    [memos, viewedDocumentGuid]
  )
  const contentMemos = useMemo(
    () => memos.filter((m) =>
      // Plain selection memos (range / point / survey-span).
      (m.type === 'content' || m.type === 'survey-cell') &&
      m.sourceGuid === viewedDocumentGuid
    ),
    [memos, viewedDocumentGuid]
  )
  const analysisMemos = useMemo(() => memos.filter((m) => m.type === 'analysis'), [memos])
  const savedAnalyses = useProjectStore((s) => s.savedAnalyses) ?? []
  // Group analysis memos by the map (savedAnalysis) they belong to, so
  // the sidebar reads "Analysis Memos → <map name> → <memos>".
  const analysisMemoGroups = useMemo(() => {
    const byAnalysis = new Map<string, Memo[]>()
    const unattached: Memo[] = []
    for (const m of analysisMemos) {
      if (m.analysisGuid) {
        const list = byAnalysis.get(m.analysisGuid) ?? []
        list.push(m)
        byAnalysis.set(m.analysisGuid, list)
      } else {
        unattached.push(m)
      }
    }
    const nameFor = (guid: string): string =>
      savedAnalyses.find((a) => a.guid === guid)?.name?.trim() || 'Untitled map'
    const groups = Array.from(byAnalysis.entries())
      .map(([guid, list]) => ({ guid, name: nameFor(guid), memos: list }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return { groups, unattached }
  }, [analysisMemos, savedAnalyses])

  const openMemoEdit = useCallback((guid: string) => {
    const memo = useMemoStore.getState().findMemo(guid)
    if (!memo) return
    const initData: MemoEditInitData = {
      memo,
      theme: document.documentElement.getAttribute('data-theme') || ''
    }
    window.api.openMemoEditWindow(initData)
  }, [])

  const handleNewMemoClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (lockedBy) { promptCheckoutLocked(); return }
    const rect = (e.target as HTMLElement).getBoundingClientRect()
    setNewMemoMenu({ x: rect.right, y: rect.bottom + 2 })
  }, [lockedBy])

  const handleCreateMemo = useCallback((type: MemoType) => {
    // Build a draft memo without persisting it to the store.
    // It will only be created when the user saves in the edit window.
    const now = new Date().toISOString()
    const draft: Memo = {
      guid: generateGuid(),
      type,
      title: '',
      content: '',
      createdDateTime: now,
      ...(type === 'document' && viewedDocumentGuid ? { sourceGuids: [viewedDocumentGuid] } : {})
    }
    const initData: MemoEditInitData = {
      memo: draft,
      theme: document.documentElement.getAttribute('data-theme') || '',
      isNew: true
    }
    window.api.openMemoEditWindow(initData)
    setNewMemoMenu(null)
  }, [viewedDocumentGuid])

  const handleDragStart = useCallback((e: React.DragEvent, memo: Memo) => {
    e.dataTransfer.setData('application/x-magnolia-memo', JSON.stringify({ guid: memo.guid }))
    e.dataTransfer.effectAllowed = 'copyMove'
  }, [])

  // ── Multi-select state ─────────────────────────────────────────
  const [selectedGuids, setSelectedGuids] = useState<Set<string>>(new Set())
  const anchorGuidRef = useRef<string | null>(null)
  const [memoContextMenu, setMemoContextMenu] = useState<{ x: number; y: number; target: Memo } | null>(null)
  const memoMenuPos = useClampedMenuPosition(memoContextMenu)
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState<Memo[] | null>(null)

  // Flat ordered list of all rendered memo guids — drives shift-click
  // range selection and also defines the order for bulk delete. Built
  // from the title-filtered lists so a search doesn't let either reach
  // memos the user can't currently see.
  const orderedGuids = useMemo(() => {
    const out: string[] = []
    for (const m of filterByTitle(projectMemos)) out.push(m.guid)
    for (const m of filterByTitle(documentMemos)) out.push(m.guid)
    for (const m of filterByTitle(contentMemos)) out.push(m.guid)
    for (const g of analysisMemoGroups.groups) for (const m of g.memos) out.push(m.guid)
    for (const m of analysisMemoGroups.unattached) out.push(m.guid)
    return out
  }, [projectMemos, documentMemos, contentMemos, analysisMemoGroups, filterByTitle])

  const handleItemClick = useCallback(
    (e: React.MouseEvent, memo: Memo) => {
      const isMeta = e.metaKey || e.ctrlKey
      const isShift = e.shiftKey
      if (isShift && anchorGuidRef.current) {
        const a = orderedGuids.indexOf(anchorGuidRef.current)
        const b = orderedGuids.indexOf(memo.guid)
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
          if (next.has(memo.guid)) next.delete(memo.guid)
          else next.add(memo.guid)
          return next
        })
        anchorGuidRef.current = memo.guid
        return
      }
      // Plain click: select only this one, then do the single-click
      // navigation behaviour (open the associated document if any).
      setSelectedGuids(new Set([memo.guid]))
      anchorGuidRef.current = memo.guid
      handleSingleClickMemo(memo)
    },
    [orderedGuids, handleSingleClickMemo]
  )

  const handleItemRightClick = useCallback(
    (e: React.MouseEvent, memo: Memo) => {
      // If the right-clicked memo isn't already part of the selection,
      // make it the sole selection so the menu operates on the thing
      // the user is pointing at.
      if (!selectedGuids.has(memo.guid)) {
        setSelectedGuids(new Set([memo.guid]))
        anchorGuidRef.current = memo.guid
      }
      setMemoContextMenu({ x: e.clientX, y: e.clientY, target: memo })
    },
    [selectedGuids]
  )

  // Dismiss menu on outside click / Escape. Also clears selection on
  // Escape so the user has an obvious way to drop the multi-select.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setMemoContextMenu(null)
        setSelectedGuids(new Set())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const bulkDelete = useCallback(() => {
    const guids = Array.from(selectedGuids)
    if (guids.length === 0) return
    const targets = guids.map((g) => findMemo(g)).filter(Boolean) as Memo[]
    setBulkDeleteConfirm(targets)
    setMemoContextMenu(null)
  }, [selectedGuids, findMemo])

  const confirmBulkDelete = useCallback(() => {
    if (!bulkDeleteConfirm) return
    for (const m of bulkDeleteConfirm) removeMemo(m.guid)
    setBulkDeleteConfirm(null)
    setSelectedGuids(new Set())
    anchorGuidRef.current = null
  }, [bulkDeleteConfirm, removeMemo])

  const handleDropOnProject = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const data = e.dataTransfer.getData('application/x-magnolia-memo')
    if (!data) return
    const { guid } = JSON.parse(data)
    const memo = findMemo(guid)
    if (!memo || memo.type === 'project') return
    if (memo.type === 'document' || memo.type === 'content') {
      if (!confirm(`Moving this memo to Project Memos will break its link to the document. Continue?`)) return
    }
    changeMemoType(guid, 'project', { sourceGuids: undefined, sourceGuid: undefined, startPosition: undefined, endPosition: undefined })
  }, [findMemo, changeMemoType])

  return (
    <div className="panel">
      <div className="panel-header">
        {searchOpen ? (
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') closeSearch() }}
            placeholder="Filter memos..."
            aria-label="Filter memos"
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
          <span style={{ flex: 1 }}>Memos</span>
        )}
        {memos.length > 0 && (
          <button
            className="panel-header-search"
            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            title={searchOpen ? 'Close search' : 'Filter memos'}
            aria-label={searchOpen ? 'Close search' : 'Filter memos'}
          >
            <Icon icon={searchOpen ? faXmark : faMagnifyingGlass} />
          </button>
        )}
        <button
          className="panel-header-add"
          onClick={handleNewMemoClick}
          title={lockedBy ? checkoutLockedTitle(lockedBy) : 'Add memo'}
          aria-label="Add memo"
          style={lockedBy ? { opacity: 0.4 } : undefined}
        >
          <Icon icon={faPlus} />
        </button>
        {newMemoMenu && createPortal(
          // Rendered via a portal so the menu escapes the panel-header's
          // containing block (.panel-header is a `container-type:
          // inline-size` query container, which establishes a containing
          // block for fixed-position children — without the portal the
          // menu's `right`/`top` would be measured against the header,
          // not the viewport, and the menu would be clipped inside the
          // pane).
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 999 }} onClick={() => setNewMemoMenu(null)} />
            <div
              className="context-menu"
              style={{
                position: 'fixed',
                right: window.innerWidth - newMemoMenu.x,
                top: newMemoMenu.y,
                zIndex: 1000
              }}
            >
              <div className="context-menu-item" onClick={() => handleCreateMemo('project')}>
                Project Memo
              </div>
              {viewedDocumentGuid && (
                <div className="context-menu-item" onClick={() => handleCreateMemo('document')}>
                  Document Memo
                </div>
              )}
            </div>
          </>,
          document.body
        )}
        {onPopOut && <button className="panel-header-popout" onClick={onPopOut} title={isPoppedOut ? "Pop back in" : "Pop out"} aria-label={isPoppedOut ? "Pop pane back into main window" : "Pop pane out into its own window"}><Icon icon={isPoppedOut ? faDownLeftAndUpRightToCenter : faUpRightFromSquare} /></button>}
        {onClose && <button className="panel-header-close" onClick={onClose} title="Close panel" aria-label="Close panel"><Icon icon={faXmark} /></button>}
      </div>

      <div className="panel-content">
        {(() => {
          const visibleProject = filterByTitle(projectMemos)
          const visibleDocument = filterByTitle(documentMemos)
          const visibleContent = filterByTitle(contentMemos)
          const showProject = visibleProject.length > 0
          const showDocument = visibleDocument.length > 0
          const showContent = visibleContent.length > 0
          // Analysis memos are intentionally hidden from this pane —
          // saved-analysis memos are reachable from the Saved
          // Analyses pane (row icon + right-click) and the in-tab
          // memo FAB, so duplicating them here just adds noise.
          const showAnalysis = false
          const firstShown: 'project' | 'document' | 'content' | 'analysis' | null
            = showProject ? 'project'
            : showDocument ? 'document'
            : showContent ? 'content'
            : showAnalysis ? 'analysis'
            : null
          return (
            <>
              {firstShown === null && !trimmedSearch && (
                <div className="empty-state" style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
                  No memos yet.
                  <br />
                  Click the + button above, or right-click a selection in a document and choose "Add Memo".
                </div>
              )}
              {firstShown === null && trimmedSearch && (
                <div className="empty-state" style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
                  No memos match "{trimmedSearch}".
                </div>
              )}
              {showProject && (
                <MemoSection
                  title="Project Memos"
                  memos={visibleProject}
                  selectedGuids={selectedGuids}
                  onItemClick={handleItemClick}
                  onRightClick={handleItemRightClick}
                  onOpen={openMemoEdit}
                  draggable
                  onDragStartMemo={handleDragStart}
                  droppable
                  onDrop={handleDropOnProject}
                  isFirst={firstShown === 'project'}
                  forceExpanded={!!trimmedSearch}
                />
              )}
              {showDocument && (
                <MemoSection
                  title="Document Memos"
                  memos={visibleDocument}
                  selectedGuids={selectedGuids}
                  onItemClick={handleItemClick}
                  onRightClick={handleItemRightClick}
                  onOpen={openMemoEdit}
                  draggable
                  onDragStartMemo={handleDragStart}
                  defaultExpanded={!!viewedDocumentGuid}
                  isFirst={firstShown === 'document'}
                  forceExpanded={!!trimmedSearch}
                />
              )}
              {showContent && (
                <MemoSection
                  title="Selection Memos"
                  memos={visibleContent}
                  selectedGuids={selectedGuids}
                  onItemClick={handleItemClick}
                  onRightClick={handleItemRightClick}
                  onOpen={openMemoEdit}
                  draggable
                  onDragStartMemo={handleDragStart}
                  defaultExpanded={!!viewedDocumentGuid}
                  isFirst={firstShown === 'content'}
                  forceExpanded={!!trimmedSearch}
                />
              )}
              {showAnalysis && (
                <AnalysisMemoGroups
                  groups={analysisMemoGroups.groups}
                  unattached={analysisMemoGroups.unattached}
                  selectedGuids={selectedGuids}
                  onItemClick={handleItemClick}
                  onRightClick={handleItemRightClick}
                  onOpen={openMemoEdit}
                  onDragStart={handleDragStart}
                  isFirst={firstShown === 'analysis'}
                />
              )}
            </>
          )
        })()}
      </div>

      {/* Single-point contextual menu that operates on the current
          selection. Shows bulk delete when >1 memo is selected. */}
      {memoContextMenu && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 99 }}
            onMouseDown={(e) => { e.stopPropagation(); setMemoContextMenu(null) }}
          />
          <div
            ref={memoMenuPos.ref}
            className="context-menu"
            style={{ left: memoMenuPos.x, top: memoMenuPos.y, zIndex: 100 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {selectedGuids.size <= 1 && (
              <div
                className="context-menu-item"
                title={lockedBy ? checkoutLockedTitle(lockedBy) : undefined}
                onClick={() => {
                  setMemoContextMenu(null)
                  if (lockedBy) { promptCheckoutLocked(); return }
                  openMemoEdit(memoContextMenu.target.guid)
                }}
              >
                Edit Memo
              </div>
            )}
            {selectedGuids.size <= 1 && <div className="context-menu-separator" />}
            <div
              className="context-menu-item"
              style={{ color: 'var(--menu-fg-danger)' }}
              title={lockedBy ? checkoutLockedTitle(lockedBy) : undefined}
              onClick={() => {
                if (lockedBy) { promptCheckoutLocked(); return }
                bulkDelete()
              }}
            >
              {selectedGuids.size > 1 ? `Delete ${selectedGuids.size} memos` : 'Delete Memo'}
            </div>
          </div>
        </>
      )}

      {/* Bulk-delete confirmation modal */}
      {bulkDeleteConfirm && (
        <div
          className="modal-overlay"
          onClick={() => setBulkDeleteConfirm(null)}
          style={{ position: 'fixed' }}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ margin: '0 0 12px' }}>
              {bulkDeleteConfirm.length > 1 ? `Delete ${bulkDeleteConfirm.length} memos` : 'Delete Memo'}
            </h2>
            <p style={{ margin: '0 0 16px', fontSize: 'var(--font-size-sm)' }}>
              {bulkDeleteConfirm.length > 1
                ? `Delete ${bulkDeleteConfirm.length} memos? This cannot be undone.`
                : `Delete "${bulkDeleteConfirm[0].title || 'Untitled Memo'}"? This cannot be undone.`}
            </p>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setBulkDeleteConfirm(null)}>Cancel</button>
              <button style={{ background: 'var(--danger)' }} onClick={confirmBulkDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
