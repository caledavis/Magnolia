/**
 * One scrolling view of a text-like document (plain text, Markdown, the
 * Word/RTF/ODT conversions, notes) with full coding: select text, then
 * apply codes by hotkey, right-click menu or by dragging a code onto it.
 *
 * DocumentViewer renders one of these, or two when the document is split
 * (see utils/split-view.ts). Each keeps its own selection, menu and scroll
 * position; only the active one takes code hotkeys, mirrors its selection
 * for the New Code dialog, and follows quote / memo / query-result clicks.
 */
import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { useDocumentStore } from '../../stores/document-store'
import { useCodeStore } from '../../stores/code-store'
import { useMemoStore } from '../../stores/memo-store'
import { useQuoteStore } from '../../stores/quote-store'
import { usePendingSelectionStore } from '../../stores/pending-selection-store'
import { useNewCodeTriggerStore } from '../../stores/new-code-trigger-store'
import { useProjectStore, useCheckoutLockedBy, checkoutLockedTitle } from '../../stores/project-store'
import { useRememberedScroll } from '../../utils/use-remembered-scroll'
import { paneScrollKey, type SplitPane } from '../../utils/split-view'
import { modKey } from '../../utils/platform'
import { CodedTextView, type CodingRightClickContext } from './CodedTextView'
import type { Code, MemoEditInitData, SourceType, TextSource } from '../../models/types'

function flattenCodes(codes: Code[], depth = 0): { code: Code; depth: number }[] {
  const result: { code: Code; depth: number }[] = []
  for (const code of codes) {
    result.push({ code, depth })
    result.push(...flattenCodes(code.children, depth + 1))
  }
  return result
}

interface Props {
  source: TextSource
  content: string
  sourceType: SourceType | undefined
  /** Which half of a split view this is; each remembers its own place. */
  pane: SplitPane
  /** The half the reader is working in (always true when not split). */
  active: boolean
  onActivate: () => void
}

export function TextDocumentPane({ source, content, sourceType, pane, active, onActivate }: Props) {
  // Enforced checkout lock: reading/scrolling/searching documents stays
  // live; the right-click menu's mutations (New Code, apply/remove a
  // code, add a quote, add/delete a selection memo), the drag-a-code-here
  // drop, and the Cmd+0-9 hotkey-apply shortcut all stay clickable but
  // intercept and prompt (Take Over / Create a Copy / Cancel) instead of
  // performing the mutation while someone else holds the lock.
  const lockedBy = useCheckoutLockedBy()
  const promptCheckoutLocked = () => useProjectStore.getState().promptCheckoutConflict()
  const sourceGuid = source.guid
  const isNote = sourceType === 'note'
  const addSelection = useDocumentStore((s) => s.addSelection)
  const addCodingToSelection = useDocumentStore((s) => s.addCodingToSelection)
  const removeCoding = useDocumentStore((s) => s.removeCoding)
  const removeSelection = useDocumentStore((s) => s.removeSelection)
  const applyTranscriptEdit = useDocumentStore((s) => s.applyTranscriptEdit)
  const codes = useCodeStore((s) => s.codes)
  const findCode = useCodeStore((s) => s.findCode)
  const addMemo = useMemoStore((s) => s.addMemo)
  const removeMemo = useMemoStore((s) => s.removeMemo)
  const contentMemos = useMemoStore((s) => s.getContentMemosForSource(sourceGuid))
  const sourceQuotes = useQuoteStore((s) => s.getQuotesForSource(sourceGuid))
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
  const containerRef = useRef<HTMLDivElement>(null)

  // Mirror the active half's selection into the global pending-selection
  // store so sibling surfaces (notably the New Code dialog rendered in
  // App.tsx) can apply a freshly-created code to whatever the user has
  // selected. A half that stops being active drops its selection, so the
  // dialog can never code a stale selection in the other half.
  const setGlobalPendingSelection = usePendingSelectionStore((s) => s.setSelection)
  useEffect(() => {
    if (!active) return
    if (pendingSelection) {
      setGlobalPendingSelection({ kind: 'text', sourceGuid, ...pendingSelection })
    } else {
      setGlobalPendingSelection(null)
    }
  }, [active, pendingSelection, sourceGuid, setGlobalPendingSelection])
  const wasActiveRef = useRef(active)
  useEffect(() => {
    if (wasActiveRef.current && !active) {
      setPendingSelection(null)
      setContextMenu(null)
      setMenuHighlight(null)
      setGlobalPendingSelection(null)
    }
    wasActiveRef.current = active
  }, [active, setGlobalPendingSelection])

  // Clicking anywhere outside the menu (including the other half or the
  // toolbar) dismisses it.
  useEffect(() => {
    if (!contextMenu) return
    const onMouseDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.context-menu')) {
        setContextMenu(null); setMenuHighlight(null)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [contextMenu])

  // When a scroll target is set, highlight and scroll to it. The
  // highlight is then released after a short pulse so subsequent hover
  // interactions (bracket labels, memo icons, quote icons) work again —
  // without this, clicking a Saved Quote or Saved Memo would park
  // `menuHighlight` permanently and externalHighlightRange would
  // override every following mouseenter.
  useEffect(() => {
    if (!active || !scrollTarget || !containerRef.current) return
    setMenuHighlight(scrollTarget)
    // A long document builds the block holding the target only once it
    // re-renders with the highlight, so keep looking for a few frames.
    let frame = 0
    let rafId = 0
    const tryScroll = () => {
      if (!containerRef.current) return
      const container = containerRef.current
      const allSpans = container.querySelectorAll<HTMLSpanElement>('[data-cpoffset]')
      for (const span of allSpans) {
        const cpOff = parseInt(span.dataset.cpoffset!, 10)
        const spanCpLen = [...(span.textContent || '')].length
        if (scrollTarget.startCp >= cpOff && scrollTarget.startCp < cpOff + spanCpLen) {
          // Smooth-scroll short hops only. Across a long document a smooth
          // scroll would build every block it passes, and their changing
          // heights would throw it off target.
          const distance = Math.abs(span.getBoundingClientRect().top - container.getBoundingClientRect().top)
          span.scrollIntoView({ behavior: distance < container.clientHeight * 3 ? 'smooth' : 'auto', block: 'center' })
          return
        }
      }
      if (++frame < 10) rafId = requestAnimationFrame(tryScroll)
    }
    rafId = requestAnimationFrame(tryScroll)
    clearScrollTarget()
    const timer = setTimeout(() => setMenuHighlight(null), 1500)
    return () => {
      clearTimeout(timer)
      cancelAnimationFrame(rafId)
    }
  }, [active, scrollTarget, clearScrollTarget])

  // Return to where the reader last was in this half, unless a scroll
  // target (a quote or memo click) is taking them somewhere specific.
  const rememberScroll = useRememberedScroll(paneScrollKey(sourceGuid, pane), containerRef, {
    skipRestore: active && !!scrollTarget
  })

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
      const existingSel = source.selections.find(
        (s) => s.startPosition === startCp && s.endPosition === endCp
      )

      if (existingSel) {
        const alreadyCoded = existingSel.codings.some((c) => c.codeGuid === codeGuid)
        if (!alreadyCoded) {
          addCodingToSelection(sourceGuid, existingSel.guid, codeGuid)
        }
      } else {
        const truncatedName =
          text.length > 60 ? text.slice(0, 57) + '...' : text
        const selGuid = addSelection(sourceGuid, startCp, endCp, truncatedName)
        addCodingToSelection(sourceGuid, selGuid, codeGuid)
      }
    },
    [sourceGuid, source, addSelection, addCodingToSelection]
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
      removeCoding(sourceGuid, selectionGuid, codingGuid)
      // Check if the selection now has no codings
      const sel = source.selections.find((s) => s.guid === selectionGuid)
      if (sel && sel.codings.length <= 1) {
        removeSelection(sourceGuid, selectionGuid)
      }
      setContextMenu(null); setMenuHighlight(null)
    },
    [sourceGuid, source, removeCoding, removeSelection]
  )

  // Create a selection memo at the current selection or click point
  const handleCreateContentMemo = useCallback(
    (startCp: number, endCp: number) => {
      const guid = addMemo('content', '', {
        sourceGuid,
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
    [sourceGuid, addMemo]
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
    if (!active) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return
      const digit = parseInt(e.key, 10)
      if (isNaN(digit) || digit < 0 || digit > 9) return
      const code = hotkeyMap.get(digit)
      if (!code || !pendingSelection) return
      e.preventDefault()
      if (lockedBy) { useProjectStore.getState().promptCheckoutConflict(); return }
      const { startCp, endCp, selectedText } = pendingSelection
      applyCodingToRange(code.guid, startCp, endCp, selectedText)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [active, hotkeyMap, pendingSelection, applyCodingToRange, lockedBy])

  const openMemo = (memoGuid: string) => {
    const memo = useMemoStore.getState().findMemo(memoGuid)
    if (memo) {
      const initData: MemoEditInitData = { memo, theme: document.documentElement.getAttribute('data-theme') || '' }
      window.api.openMemoEditWindow(initData)
    }
  }

  return (
    <>
      <div
        ref={containerRef}
        data-text-pane-scroller="1"
        onScroll={rememberScroll}
        onMouseDownCapture={onActivate}
        onContextMenuCapture={onActivate}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          position: 'relative',
          outline: isDragOver && pendingSelection ? '2px dashed var(--accent)' : 'none',
          outlineOffset: -2
        }}
        onDragEnter={(e) => {
          if (e.dataTransfer.types.includes('application/x-magnolia-code') || e.dataTransfer.types.includes('application/x-magnolia-codes')) {
            e.preventDefault()
            dragCounterRef.current++
            setIsDragOver(true)
          }
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('application/x-magnolia-code') || e.dataTransfer.types.includes('application/x-magnolia-codes')) {
            e.preventDefault()
            e.dataTransfer.dropEffect = pendingSelection ? 'copy' : 'none'
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
          dragCounterRef.current = 0
          setIsDragOver(false)
          onActivate()
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
        {isNote ? (
          <CodedTextView
            text={content}
            sourceType="note"
            selections={source.selections}
            codes={codes}
            contentMemos={contentMemos}
            quotes={quoteRangesForViewer}
            externalHighlightRange={menuHighlight}
            onTextSelected={handleTextSelected}
            onMemoClick={openMemo}
            onCodingRightClick={handleRightClick}
            hideLineNumbers
            editable={!lockedBy}
            onTextEdit={(next) => applyTranscriptEdit(sourceGuid, next)}
            onSelectionCleared={() => setPendingSelection(null)}
            placeholder="Write your observation…"
            autoFocus={content === ''}
          />
        ) : content && (
          <CodedTextView
            text={content}
            sourceType={sourceType}
            selections={source.selections}
            codes={codes}
            contentMemos={contentMemos}
            quotes={quoteRangesForViewer}
            externalHighlightRange={menuHighlight}
            onTextSelected={handleTextSelected}
            onMemoClick={openMemo}
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
        {isDragOver && !pendingSelection && (
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
                    {modKey(code.hotkey!)}
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
          {contextMenu.context.pendingSelection && (
            <>
              <div className="context-menu-separator" />
              <div
                className="context-menu-item"
                title={lockedBy ? checkoutLockedTitle(lockedBy) : undefined}
                onClick={() => {
                  setContextMenu(null)
                  if (lockedBy) { promptCheckoutLocked(); return }
                  const ps = contextMenu.context.pendingSelection!
                  useQuoteStore.getState().addQuote(sourceGuid, source.name, ps.startCp, ps.endCp, ps.selectedText)
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
    </>
  )
}
