import { useState, useCallback, useMemo, useRef, useEffect, Component, type ReactNode, type ErrorInfo } from 'react'
import { useDocumentStore } from '../../stores/document-store'
import { useCodeStore } from '../../stores/code-store'
import { useMemoStore } from '../../stores/memo-store'
import { useQuoteStore } from '../../stores/quote-store'
import { useSurveyViewStore } from '../../stores/survey-view-store'
import { CodedTextView, type CodingRightClickContext } from './CodedTextView'
import { PdfDocumentViewer } from './PdfDocumentViewer'
import { AudioDocumentViewer } from './AudioDocumentViewer'
import { VideoDocumentViewer } from './VideoDocumentViewer'
import { ImageDocumentViewer } from './ImageDocumentViewer'
import { SurveyViewer } from '../SurveyViewer/SurveyViewer'
import { TabBar } from './TabBar'
import type { Code, MemoEditInitData } from '../../models/types'
import { sourceTypeFromFilename } from '../../utils/format-registry'
import { isAnalysisTab, isMapTab, isPreferencesTab, isMergeTab, isQueryBuilderTab, isToolTab, mapGuidFromTabId } from '../../utils/tab-ids'
import { InlineAnalysisTab } from '../Analysis/InlineAnalysisTab'
import { PreferencesWindow } from '../Preferences/PreferencesWindow'
import { MergeReviewWindow } from '../Merge/MergeReviewWindow'
import { useAnalysisTabsStore } from '../../stores/analysis-tabs-store'
import { usePendingSelectionStore } from '../../stores/pending-selection-store'
import { useNewCodeTriggerStore } from '../../stores/new-code-trigger-store'
import { modKey } from '../../utils/platform'
import { useProjectStore, useCheckoutLockedBy, checkoutLockedTitle } from '../../stores/project-store'

/** Single dispatch point for "what to render for a tool tab id". Lives
 *  here (not in tab-ids) so JSX-bearing modules don't pull tab-ids into
 *  the renderer's lower layers. */
function renderToolTab(tabId: string): React.ReactNode {
  if (isMapTab(tabId)) {
    const mapGuid = mapGuidFromTabId(tabId)
    // The Memo FAB is intentionally NOT rendered on relationship-map
    // tabs: the map's own toolbar already anchors an Export SVG
    // button at the top-right, and the FAB would land on top of it.
    // Saved-analysis memos for maps remain accessible via the row
    // icon and right-click "Add / View Memo" item in the Saved
    // Analyses sidebar.
    return mapGuid ? <InlineRelationshipMap key={tabId} mapGuid={mapGuid} /> : null
  }
  if (isAnalysisTab(tabId) || isQueryBuilderTab(tabId)) {
    return <InlineAnalysisTab key={tabId} tabId={tabId} />
  }
  if (isPreferencesTab(tabId)) {
    return (
      <PreferencesWindow
        key={tabId}
        onClose={() => useDocumentStore.getState().closeTab(tabId)}
      />
    )
  }
  if (isMergeTab(tabId)) {
    return (
      <MergeReviewWindow
        key={tabId}
        onClose={() => useDocumentStore.getState().closeTab(tabId)}
      />
    )
  }
  return null
}
import { InlineRelationshipMap } from '../Analysis/RelationshipMap/InlineRelationshipMap'
import { MemoFab } from '../Memos/MemoFab'

class ViewerErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('DocumentViewer error:', error, info) }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 20, color: 'var(--danger)', fontSize: 'var(--font-size-sm)' }}>
          <strong>Error loading document:</strong> {this.state.error.message}
        </div>
      )
    }
    return this.props.children
  }
}

function flattenCodes(codes: Code[], depth = 0): { code: Code; depth: number }[] {
  const result: { code: Code; depth: number }[] = []
  for (const code of codes) {
    result.push({ code, depth })
    result.push(...flattenCodes(code.children, depth + 1))
  }
  return result
}

export function DocumentViewer() {
  // Enforced checkout lock: reading/scrolling/searching documents stays
  // live; the right-click menu's mutations (New Code, apply/remove a
  // code, add a quote, add/delete a selection memo), the drag-a-code-here
  // drop, and the Cmd+0-9 hotkey-apply shortcut all stay clickable but
  // intercept and prompt (Take Over / Create a Copy / Cancel) instead of
  // performing the mutation while someone else holds the lock.
  const lockedBy = useCheckoutLockedBy()
  const promptCheckoutLocked = () => useProjectStore.getState().promptCheckoutConflict()
  const selectedGuid = useDocumentStore((s) => s.viewedDocumentGuid)
  const openTabs = useDocumentStore((s) => s.openTabs)
  // Display-only: while Merge is the active tab, hide every other tab from
  // the tab bar so it reads as the only thing open — the underlying
  // openTabs list in the store is untouched, so closing Merge brings
  // everything back exactly as it was.
  const visibleTabs = isMergeTab(selectedGuid) ? openTabs.filter((id) => isMergeTab(id)) : openTabs
  const viewDocument = useDocumentStore((s) => s.viewDocument)
  const closeTabRaw = useDocumentStore((s) => s.closeTab)
  // Wrap closeTab so analysis / query-builder tabs also clean up their
  // analysis-tabs-store entry when the user clicks the X. Document and
  // map tabs go through the existing path unchanged.
  const closeTab = (tabId: string) => {
    if (isAnalysisTab(tabId) || isQueryBuilderTab(tabId)) {
      useAnalysisTabsStore.getState().remove(tabId)
    }
    closeTabRaw(tabId)
  }
  const reorderTabs = useDocumentStore((s) => s.reorderTabs)
  const sources = useDocumentStore((s) => s.sources)
  const sourceContents = useDocumentStore((s) => s.sourceContents)
  const addSelection = useDocumentStore((s) => s.addSelection)
  const addCodingToSelection = useDocumentStore((s) => s.addCodingToSelection)
  const removeCoding = useDocumentStore((s) => s.removeCoding)
  const removeSelection = useDocumentStore((s) => s.removeSelection)
  const codes = useCodeStore((s) => s.codes)
  const findCode = useCodeStore((s) => s.findCode)
  const addMemo = useMemoStore((s) => s.addMemo)
  const removeMemo = useMemoStore((s) => s.removeMemo)
  const contentMemos = useMemoStore((s) => s.getContentMemosForSource(selectedGuid ?? ''))
  const sourceQuotes = useQuoteStore((s) => s.getQuotesForSource(selectedGuid ?? ''))
  const quoteRangesForViewer = useMemo(() =>
    sourceQuotes.map((q) => ({ guid: q.guid, startCp: q.startPosition, endCp: q.endPosition })),
    [sourceQuotes]
  )

  // Tracks the user's current text selection (set on mouseup, no popup shown)
  const [pendingSelection, setPendingSelection] = useState<{
    startCp: number
    endCp: number
    selectedText: string
  } | null>(null)

  // Mirror the selection into the global pending-selection-store so
  // sibling surfaces (notably the New Code dialog rendered in App.tsx)
  // can apply a freshly-created code to whatever the user has selected.
  const setGlobalPendingSelection = usePendingSelectionStore((s) => s.setSelection)
  useEffect(() => {
    if (pendingSelection && selectedGuid) {
      setGlobalPendingSelection({ kind: 'text', sourceGuid: selectedGuid, ...pendingSelection })
    } else {
      setGlobalPendingSelection(null)
    }
  }, [pendingSelection, selectedGuid, setGlobalPendingSelection])

  // Right-click context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    context: CodingRightClickContext
  } | null>(null)

  const [isDragOver, setIsDragOver] = useState(false)
  const [menuHighlight, setMenuHighlight] = useState<{ startCp: number; endCp: number } | null>(null)
  const dragCounterRef = useRef(0)
  const scrollTarget = useDocumentStore((s) => s.scrollTarget)
  const clearScrollTarget = useDocumentStore((s) => s.clearScrollTarget)
  const textContainerRef = useRef<HTMLDivElement>(null)
  const scrollPositionsRef = useRef<Map<string, number>>(new Map())
  const prevGuidRef = useRef<string | null>(null)

  // Preserve scroll position when switching tabs
  useEffect(() => {
    const prevGuid = prevGuidRef.current
    // Save previous tab's scroll position
    if (prevGuid && textContainerRef.current) {
      scrollPositionsRef.current.set(prevGuid, textContainerRef.current.scrollTop)
    }
    // Clear selection/menu state on tab switch
    if (prevGuid !== selectedGuid) {
      setPendingSelection(null)
      setContextMenu(null)
      setMenuHighlight(null)
    }
    prevGuidRef.current = selectedGuid
    // Restore new tab's scroll position (unless there's a scrollTarget which takes priority)
    if (selectedGuid && !scrollTarget && textContainerRef.current) {
      const saved = scrollPositionsRef.current.get(selectedGuid)
      if (saved !== undefined) {
        requestAnimationFrame(() => {
          if (textContainerRef.current) textContainerRef.current.scrollTop = saved
        })
      }
    }
  }, [selectedGuid]) // eslint-disable-line react-hooks/exhaustive-deps

  // When a scroll target is set, highlight and scroll to it. The
  // highlight is then released after a short pulse so subsequent hover
  // interactions (bracket labels, memo icons, quote icons) work again —
  // without this, clicking a Saved Quote or Saved Memo would park
  // `menuHighlight` permanently and externalHighlightRange would
  // override every following mouseenter.
  useEffect(() => {
    if (!scrollTarget || !textContainerRef.current) return
    setMenuHighlight(scrollTarget)
    requestAnimationFrame(() => {
      if (!textContainerRef.current) return
      const container = textContainerRef.current
      const allSpans = container.querySelectorAll<HTMLSpanElement>('[data-cpoffset]')
      for (const span of allSpans) {
        const cpOff = parseInt(span.dataset.cpoffset!, 10)
        const spanCpLen = [...(span.textContent || '')].length
        if (scrollTarget.startCp >= cpOff && scrollTarget.startCp < cpOff + spanCpLen) {
          span.scrollIntoView({ behavior: 'smooth', block: 'center' })
          break
        }
      }
    })
    clearScrollTarget()
    const timer = setTimeout(() => setMenuHighlight(null), 1500)
    return () => clearTimeout(timer)
  }, [scrollTarget, clearScrollTarget, selectedGuid])

  const source = useMemo(
    () => sources.find((s) => s.guid === selectedGuid),
    [sources, selectedGuid]
  )

  // Detect sourceType from the field or fall back to file extension
  const effectiveSourceType = useMemo(() => {
    if (source?.sourceType) return source.sourceType
    if (source?.name) return sourceTypeFromFilename(source.name)
    return undefined
  }, [source])

  const content = selectedGuid ? sourceContents[selectedGuid] ?? '' : ''

  const isPdf = !!(source?.formatData?.pdfBase64 || source?.formatData?.pdfFilePath)
  const isAudio = source?.sourceType === 'audio'
  const isVideo = source?.sourceType === 'video'
  const isImage = source?.sourceType === 'image'
  const isSurvey = source?.sourceType === 'survey'

  const flatCodes = useMemo(() => flattenCodes(codes), [codes])

  // Build hotkey map: number -> code
  const hotkeyMap = useMemo(() => {
    const map = new Map<number, Code>()
    for (const { code } of flatCodes) {
      if (code.hotkey !== undefined) map.set(code.hotkey, code)
    }
    return map
  }, [flatCodes])

  const hotkeyCodes = useMemo(
    () => flatCodes.filter(({ code }) => code.hotkey !== undefined)
      .sort((a, b) => (a.code.hotkey ?? 0) - (b.code.hotkey ?? 0)),
    [flatCodes]
  )

  const applyCodingToRange = useCallback(
    (codeGuid: string, startCp: number, endCp: number, text: string) => {
      if (!selectedGuid) return

      const existingSel = source?.selections.find(
        (s) => s.startPosition === startCp && s.endPosition === endCp
      )

      if (existingSel) {
        const alreadyCoded = existingSel.codings.some((c) => c.codeGuid === codeGuid)
        if (!alreadyCoded) {
          addCodingToSelection(selectedGuid, existingSel.guid, codeGuid)
        }
      } else {
        const truncatedName =
          text.length > 60 ? text.slice(0, 57) + '...' : text
        const selGuid = addSelection(selectedGuid, startCp, endCp, truncatedName)
        addCodingToSelection(selectedGuid, selGuid, codeGuid)
      }
    },
    [selectedGuid, source, addSelection, addCodingToSelection]
  )

  // Called when user finishes selecting text (mouseup) — just store it, no popup
  const handleTextSelected = useCallback(
    (startCp: number, endCp: number, selectedText: string) => {
      setPendingSelection({ startCp, endCp, selectedText })
      // Don't clear context menu here — it may have just been opened by right-click
    },
    []
  )

  // Right-click handler from CodedTextView
  const handleRightClick = useCallback(
    (e: React.MouseEvent, ctx: CodingRightClickContext) => {
      // If there's a pending text selection, attach it to the context
      const fullCtx: CodingRightClickContext = {
        ...ctx,
        pendingSelection: ctx.pendingSelection || pendingSelection || undefined
      }
      // Only show the menu when there's an actual action available —
      // a selection, an existing coding, or an overlapping memo. Otherwise
      // every section is hidden and the user sees an empty menu.
      const hasMemos = (fullCtx.overlappingMemos?.length ?? 0) > 0
      if (fullCtx.existingCodings.length > 0 || fullCtx.pendingSelection || hasMemos) {
        setContextMenu({ x: e.clientX, y: e.clientY, context: fullCtx })
      }
    },
    [pendingSelection]
  )

  // Apply a code from the right-click menu
  const handleApplyCodeFromMenu = useCallback(
    (codeGuid: string) => {
      if (!contextMenu?.context.pendingSelection) return
      const { startCp, endCp, selectedText } = contextMenu.context.pendingSelection
      applyCodingToRange(codeGuid, startCp, endCp, selectedText)
      setContextMenu(null); setMenuHighlight(null)
      // Keep text selected so user can apply more codes
    },
    [contextMenu, applyCodingToRange]
  )

  // Remove a coding from the right-click menu
  const handleRemoveCoding = useCallback(
    (selectionGuid: string, codingGuid: string) => {
      if (!selectedGuid) return
      removeCoding(selectedGuid, selectionGuid, codingGuid)
      // Check if the selection now has no codings
      const sel = source?.selections.find((s) => s.guid === selectionGuid)
      if (sel && sel.codings.length <= 1) {
        removeSelection(selectedGuid, selectionGuid)
      }
      setContextMenu(null); setMenuHighlight(null)
    },
    [selectedGuid, source, removeCoding, removeSelection]
  )

  // Create a selection memo at the current selection or click point
  const handleCreateContentMemo = useCallback(
    (startCp: number, endCp: number) => {
      if (!selectedGuid) return
      const guid = addMemo('content', '', {
        sourceGuid: selectedGuid,
        startPosition: startCp,
        endPosition: endCp
      })
      // Open memo edit window
      const memo = useMemoStore.getState().findMemo(guid)
      if (memo) {
        const initData: MemoEditInitData = {
          memo,
          theme: document.documentElement.getAttribute('data-theme') || ''
        }
        window.api.openMemoEditWindow(initData)
      }
      setContextMenu(null); setMenuHighlight(null)
    },
    [selectedGuid, addMemo]
  )

  // Drag-and-drop: apply dropped code(s) to pending selection
  const handleDrop = useCallback(
    (codeGuids: string[]) => {
      if (pendingSelection) {
        const { startCp, endCp, selectedText } = pendingSelection
        for (const codeGuid of codeGuids) {
          applyCodingToRange(codeGuid, startCp, endCp, selectedText)
        }
        // Keep text selected so user can apply more codes
      }
    },
    [pendingSelection, applyCodingToRange]
  )

  // Keyboard shortcut: Cmd+0-9 applies hotkeyed code to pending selection
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return
      const digit = parseInt(e.key, 10)
      if (isNaN(digit) || digit < 0 || digit > 9) return
      const code = hotkeyMap.get(digit)
      if (!code || !pendingSelection || !selectedGuid) return
      e.preventDefault()
      if (lockedBy) { useProjectStore.getState().promptCheckoutConflict(); return }
      const { startCp, endCp, selectedText } = pendingSelection
      applyCodingToRange(code.guid, startCp, endCp, selectedText)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [hotkeyMap, pendingSelection, selectedGuid, applyCodingToRange, lockedBy])

  // Tool tabs (relationship maps, analysis tools, query builder) share
  // the same chrome as documents. We keep every open tool tab mounted
  // and toggle visibility with display:none so switching to a sibling
  // tab and back preserves the tool's internal state — previously each
  // switch unmounted the active tool and any in-progress grid / drag
  // state was lost.
  const toolTabIds = openTabs.filter((t) => isToolTab(t))
  const activeIsTool = isToolTab(selectedGuid)

  return (
    <div
      className="panel"
      onMouseDown={(e) => {
        // Dismiss context menu when clicking outside of it
        if (contextMenu) {
          const target = e.target as HTMLElement
          if (!target.closest('.context-menu')) {
            setContextMenu(null); setMenuHighlight(null)
          }
        }
      }}
    >
      {openTabs.length > 0 ? (
        <TabBar
          openTabs={visibleTabs}
          activeTab={selectedGuid}
          sources={sources}
          onSelectTab={(guid) => {
            // Clicking a survey tab snaps the survey viewer back to
            // its summary page — gives the user a predictable "home"
            // for that survey, since the tab name otherwise stays
            // the same whether they're viewing a respondent or a
            // question. Non-survey tabs just view the document.
            const src = sources.find((s) => s.guid === guid)
            if (src?.sourceType === 'survey') {
              useSurveyViewStore.getState().setView(guid, 'summary')
            }
            viewDocument(guid)
          }}
          onCloseTab={closeTab}
          onReorderTabs={reorderTabs}
        />
      ) : (
        <div className="panel-header">
          <span style={{ flex: 1 }}>Viewer</span>
        </div>
      )}
      {/* Persistent tool-tab mounts — only the active one is visible.
          The dispatched component inside each wrapper is keyed on tabId
          so React preserves it across switches. Inactive wrappers are
          display:none so they take no layout space and receive no
          events. */}
      {toolTabIds.map((id) => (
        <div
          key={id}
          style={{
            display: activeIsTool && id === selectedGuid ? 'flex' : 'none',
            flexDirection: 'column',
            flex: 1,
            minHeight: 0,
            overflow: 'hidden'
          }}
        >
          {renderToolTab(id)}
        </div>
      ))}
      {!activeIsTool && (<>
      {/* Document header — the document's name + a document-level memo
          FAB, always visible at the top of the viewer area. Survey
          documents skip this: SurveyViewer renders its own per-sub-view
          header (Respondent N / Question N) inside its scroll area. */}
      {source && !isSurvey && (
        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '14px 20px 12px 20px',
            background: 'var(--bg-panel)',
            borderBottom: '1px solid var(--border-color)',
            userSelect: 'none'
          }}
        >
          <h1
            title={source.name}
            style={{
              margin: 0,
              fontSize: 18,
              color: 'var(--text-secondary)',
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {source.name}
          </h1>
          <MemoFab variant="inline" kind="document" sourceGuid={source.guid} />
        </div>
      )}
      {/* The generic viewer-toolbar carries source-type / word-count meta for
          viewers that don't ship their own controls. PDF and image viewers
          render their own toolbars instead. */}
      {source && !isPdf && !isImage && !isSurvey && (
        <div className="viewer-toolbar">
          <span className="viewer-meta">
            {(() => {
              const t = effectiveSourceType
              const label = t === 'markdown' ? 'Markdown' : t === 'audio' ? 'Audio transcript' : t === 'video' ? 'Video transcript' : 'Plain text'
              const wc = (content.match(/\S+/g) || []).length
              return `${label} · ${wc.toLocaleString()} words`
            })()}
          </span>
          <span className="viewer-spacer" />
        </div>
      )}
      <div
        ref={textContainerRef}
        className="panel-content"
        style={{
          position: 'relative',
          outline: isDragOver && pendingSelection ? '2px dashed var(--accent)' : 'none',
          outlineOffset: -2
        }}
        onDragEnter={(e) => {
          if (isPdf || isAudio || isVideo || isImage || isSurvey) return // dedicated viewers handle own drag-drop
          if (e.dataTransfer.types.includes('application/x-magnolia-code') || e.dataTransfer.types.includes('application/x-magnolia-codes')) {
            e.preventDefault()
            dragCounterRef.current++
            setIsDragOver(true)
          }
        }}
        onDragOver={(e) => {
          if (isPdf || isAudio || isVideo || isImage || isSurvey) return
          if (e.dataTransfer.types.includes('application/x-magnolia-code') || e.dataTransfer.types.includes('application/x-magnolia-codes')) {
            e.preventDefault()
            e.dataTransfer.dropEffect = pendingSelection ? 'copy' : 'none'
          }
        }}
        onDragLeave={() => {
          if (isPdf || isAudio || isVideo || isImage || isSurvey) return
          dragCounterRef.current--
          if (dragCounterRef.current <= 0) {
            dragCounterRef.current = 0
            setIsDragOver(false)
          }
        }}
        onDrop={(e) => {
          if (isPdf || isAudio || isVideo || isImage || isSurvey) return
          e.preventDefault()
          dragCounterRef.current = 0
          setIsDragOver(false)
          if (lockedBy) { promptCheckoutLocked(); return }
          // Check for multi-code drop first
          const multiData = e.dataTransfer.getData('application/x-magnolia-codes')
          if (multiData) {
            try {
              const codes = JSON.parse(multiData) as { guid: string }[]
              handleDrop(codes.map((c) => c.guid))
            } catch { /* ignore */ }
            return
          }
          const data = e.dataTransfer.getData('application/x-magnolia-code')
          if (!data) return
          try {
            const codeData = JSON.parse(data) as { guid: string }
            handleDrop([codeData.guid])
          } catch {
            // ignore
          }
        }}
      >
        {source && isAudio && (
          <ViewerErrorBoundary>
            <AudioDocumentViewer source={source} content={content} />
          </ViewerErrorBoundary>
        )}
        {source && isVideo && (
          <ViewerErrorBoundary>
            <VideoDocumentViewer source={source} content={content} />
          </ViewerErrorBoundary>
        )}
        {source && isPdf && !isAudio && !isVideo && (
          <PdfDocumentViewer source={source} content={content} />
        )}
        {source && isImage && (
          <ViewerErrorBoundary>
            <ImageDocumentViewer source={source} />
          </ViewerErrorBoundary>
        )}
        {source && isSurvey && (
          <ViewerErrorBoundary>
            <SurveyViewer source={source} />
          </ViewerErrorBoundary>
        )}
        {source && content && !isPdf && !isAudio && !isVideo && !isImage && !isSurvey && (
          <CodedTextView
            text={content}
            sourceType={effectiveSourceType}
            selections={source.selections}
            codes={codes}
            contentMemos={contentMemos}
            quotes={quoteRangesForViewer}
            externalHighlightRange={menuHighlight}
            onTextSelected={handleTextSelected}
            onMemoClick={(memoGuid) => {
              const memo = useMemoStore.getState().findMemo(memoGuid)
              if (memo) {
                const initData: MemoEditInitData = { memo, theme: document.documentElement.getAttribute('data-theme') || '' }
                window.api.openMemoEditWindow(initData)
              }
            }}
            onCodingRightClick={handleRightClick}
          />
        )}
        {isDragOver && pendingSelection && (
          <div
            style={{
              position: 'absolute',
              top: 0, left: 0, right: 0, bottom: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(124, 111, 240, 0.08)',
              pointerEvents: 'none',
              zIndex: 10
            }}
          >
            <span style={{ color: 'var(--accent)', fontWeight: 600, fontSize: 14 }}>
              Drop code to apply to selection
            </span>
          </div>
        )}
        {isDragOver && !pendingSelection && source && (
          <div
            style={{
              position: 'absolute',
              top: 0, left: 0, right: 0, bottom: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(224, 80, 80, 0.08)',
              pointerEvents: 'none',
              zIndex: 10
            }}
          >
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              Select text first, then drag a code onto it
            </span>
          </div>
        )}
      </div>

      {/* Right-click context menu */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* New Code — always at the top. Auto-applies the new code to
              the current pending selection via handleCreateCode. */}
          <div
            className="context-menu-item"
            title={lockedBy ? checkoutLockedTitle(lockedBy) : undefined}
            onClick={() => {
              setContextMenu(null); setMenuHighlight(null)
              if (lockedBy) { promptCheckoutLocked(); return }
              useNewCodeTriggerStore.getState().request()
            }}
          >
            New Code
          </div>
          <div className="context-menu-separator" />
          {/* If there's a pending text selection, show hotkeyed codes for quick apply */}
          {contextMenu.context.pendingSelection && (
            <>
              <div
                style={{
                  padding: '4px 14px',
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  fontWeight: 600,
                  userSelect: 'none'
                }}
              >
                Apply Code
              </div>
              <div
                style={{
                  padding: '0 14px 6px',
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  lineHeight: 1.4,
                  maxWidth: 220,
                  userSelect: 'none'
                }}
              >
                To apply any code, select content and drag the code from the Code Browser to the selection.
              </div>
              {hotkeyCodes.map(({ code }) => (
                <div
                  key={code.guid}
                  className="context-menu-item"
                  title={lockedBy ? checkoutLockedTitle(lockedBy) : undefined}
                  onClick={() => {
                    if (lockedBy) { promptCheckoutLocked(); return }
                    handleApplyCodeFromMenu(code.guid)
                  }}
                >
                  <span
                    className="color-pip"
                    style={{ background: code.color || '#888' }}
                  />
                  <span style={{ flex: 1 }}>{code.name}</span>
                  <span style={{ fontSize: 10, color: 'var(--menu-fg-muted)', marginLeft: 12 }}>
                    {modKey(code.hotkey)}
                  </span>
                </div>
              ))}
              {hotkeyCodes.length === 0 && (
                <div
                  className="context-menu-item"
                  style={{ color: 'var(--text-muted)', pointerEvents: 'none' }}
                >
                  No hotkeys assigned — right-click a code to assign one
                </div>
              )}
            </>
          )}

          {/* Separator if both sections present */}
          {contextMenu.context.pendingSelection &&
            contextMenu.context.existingCodings.length > 0 && (
              <div className="context-menu-separator" />
            )}

          {/* If right-clicked on already-coded text, show remove options */}
          {contextMenu.context.existingCodings.length > 0 && (
            <>
              <div
                style={{
                  padding: '4px 14px',
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  fontWeight: 600,
                  userSelect: 'none'
                }}
              >
                Remove Code
              </div>
              {contextMenu.context.existingCodings.map((ec) => {
                const code = findCode(ec.codeGuid)
                return (
                  <div
                    key={ec.codingGuid}
                    className="context-menu-item"
                    style={{ color: 'var(--menu-fg-danger)' }}
                    title={lockedBy ? checkoutLockedTitle(lockedBy) : undefined}
                    onClick={() => {
                      if (lockedBy) { promptCheckoutLocked(); return }
                      handleRemoveCoding(ec.selectionGuid, ec.codingGuid)
                    }}
                    onMouseEnter={() => setMenuHighlight({ startCp: ec.startCp, endCp: ec.endCp })}
                    onMouseLeave={() => setMenuHighlight(null)}
                  >
                    <span
                      className="color-pip"
                      style={{ background: code?.color || '#888' }}
                    />
                    {code?.name ?? 'Unknown'}
                  </div>
                )
              })}
            </>
          )}

          {/* Add as Quote */}
          {contextMenu.context.pendingSelection && source && (
            <>
              <div className="context-menu-separator" />
              <div
                className="context-menu-item"
                title={lockedBy ? checkoutLockedTitle(lockedBy) : undefined}
                onClick={() => {
                  setContextMenu(null)
                  if (lockedBy) { promptCheckoutLocked(); return }
                  const ps = contextMenu.context.pendingSelection!
                  useQuoteStore.getState().addQuote(source.guid, source.name, ps.startCp, ps.endCp, ps.selectedText)
                }}
              >
                Add as Quote
              </div>
            </>
          )}

          {/* Selection memo */}
          {/* Memos in text contexts must attach to a range — no point
              memos. Only show this item when the user has a live text
              selection. */}
          {contextMenu.context.pendingSelection && (
            <>
              <div className="context-menu-separator" />
              <div
                className="context-menu-item"
                title={lockedBy ? checkoutLockedTitle(lockedBy) : undefined}
                onClick={() => {
                  if (lockedBy) { promptCheckoutLocked(); return }
                  handleCreateContentMemo(
                    contextMenu.context.pendingSelection!.startCp,
                    contextMenu.context.pendingSelection!.endCp
                  )
                }}
              >
                Add Selection Memo
              </div>
            </>
          )}

          {/* Delete memo options */}
          {contextMenu.context.overlappingMemos && contextMenu.context.overlappingMemos.length > 0 && (
            <>
              <div className="context-menu-separator" />
              <div
                style={{
                  padding: '4px 14px',
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  fontWeight: 600,
                  userSelect: 'none'
                }}
              >
                Delete Memo
              </div>
              {contextMenu.context.overlappingMemos.map((m) => (
                <div
                  key={m.guid}
                  className="context-menu-item"
                  style={{ color: 'var(--menu-fg-danger)' }}
                  title={lockedBy ? checkoutLockedTitle(lockedBy) : undefined}
                  onClick={() => {
                    setContextMenu(null); setMenuHighlight(null)
                    if (lockedBy) { promptCheckoutLocked(); return }
                    removeMemo(m.guid)
                  }}
                  onMouseEnter={() => setMenuHighlight({ startCp: m.startCp, endCp: m.endCp })}
                  onMouseLeave={() => setMenuHighlight(null)}
                >
                  {m.title}
                </div>
              ))}
            </>
          )}
        </div>
      )}
      </>)}
    </div>
  )
}
