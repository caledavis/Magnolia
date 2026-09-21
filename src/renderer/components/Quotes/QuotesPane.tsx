import { useState, useMemo, useEffect, useCallback } from 'react'
import { useQuoteStore } from '../../stores/quote-store'
import { useDocumentStore } from '../../stores/document-store'
import { Icon, QUOTE_ICON, faChevronDown, faChevronRight, faXmark, faUpRightFromSquare, faDownLeftAndUpRightToCenter, faMagnifyingGlass } from '../Icon'
import { stripFormatting } from '../../utils/strip-formatting'
import { sourceTypeFromFilename } from '../../utils/format-registry'
import { PdfRegionThumbnail } from '../DocumentViewer/PdfRegionThumbnail'
import { useClampedMenuPosition } from '../../utils/use-clamped-menu-position'
import { renderPdfRegionThumbnail } from '../../utils/pdf-thumbnail'
import { renderImageRegionThumbnail } from '../../utils/image-thumbnail'
import { useProjectStore, useCheckoutLockedBy, checkoutLockedTitle } from '../../stores/project-store'

interface Props {
  onClose?: () => void
  onPopOut?: () => void
  isPoppedOut?: boolean
}

export function QuotesPane({ onClose, onPopOut, isPoppedOut }: Props) {
  // Enforced checkout lock: browsing/opening quotes stays live; removing
  // one is disabled while someone else holds the lock.
  const lockedBy = useCheckoutLockedBy()
  const quotes = useQuoteStore((s) => s.quotes)
  const removeQuote = useQuoteStore((s) => s.removeQuote)
  const sources = useDocumentStore((s) => s.sources)
  const viewDocumentAt = useDocumentStore((s) => s.viewDocumentAt)

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; guid: string } | null>(null)
  const menuPos = useClampedMenuPosition(contextMenu)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setSearchQuery('')
  }, [])

  // Group quotes by source document
  const groups = useMemo(() => {
    const map = new Map<string, { sourceName: string; sourceGuid: string; quotes: typeof quotes }>()
    for (const q of quotes) {
      let group = map.get(q.sourceGuid)
      if (!group) {
        group = { sourceName: q.sourceName, sourceGuid: q.sourceGuid, quotes: [] }
        map.set(q.sourceGuid, group)
      }
      group.quotes.push(q)
    }
    return Array.from(map.values())
  }, [quotes])

  const trimmedSearch = searchQuery.trim()

  /** Filter groups by a search query, matching anywhere in the quote's
   *  text or its source document's name. A group whose own document name
   *  matches keeps every quote (the name match is the "find"); otherwise
   *  only the individual matching quotes survive, and the group header
   *  renders dimmed since it's shown purely for context. */
  const filteredGroups = useMemo(() => {
    if (!trimmedSearch) return groups
    const q = trimmedSearch.toLowerCase()
    const result: { sourceName: string; sourceGuid: string; quotes: typeof quotes; nameMatch: boolean }[] = []
    for (const group of groups) {
      const nameMatch = group.sourceName.toLowerCase().includes(q)
      const matchingQuotes = nameMatch
        ? group.quotes
        : group.quotes.filter((quote) => {
            const src = sources.find((s) => s.guid === quote.sourceGuid)
            const st = src?.sourceType || sourceTypeFromFilename(quote.sourceName)
            return stripFormatting(quote.text, st).toLowerCase().includes(q)
          })
      if (matchingQuotes.length > 0) {
        result.push({ ...group, quotes: matchingQuotes, nameMatch })
      }
    }
    return result
  }, [groups, trimmedSearch, sources])

  /** Copy a quote to the clipboard. Text quotes get their stripped /
   *  unwrapped body (no surrounding quote marks, no format markers) as
   *  text/plain. Box-region quotes (PDF / image rectangle selections)
   *  carry no useful text — render the region thumbnail to PNG and
   *  write it to the clipboard as image/png so the user can paste the
   *  image straight into another app. */
  const handleCopyQuote = async (guid: string): Promise<void> => {
    const q = quotes.find((x) => x.guid === guid)
    if (!q) return
    if (q.pdfRegion) {
      try {
        const src = sources.find((s) => s.guid === q.sourceGuid)
        const fd = (src as any)?.formatData
        const filePath = (fd?.imageFilePath as string | undefined) ?? (fd?.pdfFilePath as string | undefined)
        const pdfBase64 = fd?.pdfBase64 as string | undefined
        const isImage = (src as any)?.sourceType === 'image'
          || (!!filePath && sourceTypeFromFilename(filePath) === 'image')
        const dataUrl = isImage
          ? await renderImageRegionThumbnail({
              filePath: filePath as string,
              x: q.pdfRegion.x, y: q.pdfRegion.y,
              width: q.pdfRegion.width, height: q.pdfRegion.height
            })
          : await renderPdfRegionThumbnail(
              filePath
                ? { filePath, page: q.pdfRegion.page, x: q.pdfRegion.x, y: q.pdfRegion.y, width: q.pdfRegion.width, height: q.pdfRegion.height }
                : { pdfBase64: pdfBase64 as string, docKey: q.sourceGuid, page: q.pdfRegion.page, x: q.pdfRegion.x, y: q.pdfRegion.y, width: q.pdfRegion.width, height: q.pdfRegion.height }
            )
        const blob = await (await fetch(dataUrl)).blob()
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
      } catch (err) {
        console.error('Copy region quote to clipboard failed:', err)
      }
      return
    }
    const src = sources.find((s) => s.guid === q.sourceGuid)
    const st = (src as any)?.sourceType || sourceTypeFromFilename(q.sourceName)
    const clean = stripFormatting(q.text, st)
    try {
      await navigator.clipboard.writeText(clean)
    } catch (err) {
      console.error('Copy quote to clipboard failed:', err)
    }
  }

  // Dismiss the context menu on any mousedown outside the menu itself.
  // Document-level (not panel-level) so clicks anywhere — other panes,
  // the document viewer, the toolbar — also close it. Stays attached
  // only while a menu is open.
  useEffect(() => {
    if (!contextMenu) return
    const handleDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('.context-menu')) setContextMenu(null)
    }
    document.addEventListener('mousedown', handleDown)
    return () => document.removeEventListener('mousedown', handleDown)
  }, [contextMenu])

  const toggleGroup = (sourceGuid: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(sourceGuid)) next.delete(sourceGuid)
      else next.add(sourceGuid)
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
            placeholder="Filter quotes..."
            aria-label="Filter quotes"
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
          <span style={{ flex: 1 }}>Quotes</span>
        )}
        {quotes.length > 0 && (
          <button
            className="panel-header-search"
            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            title={searchOpen ? 'Close search' : 'Filter quotes'}
            aria-label={searchOpen ? 'Close search' : 'Filter quotes'}
          >
            <Icon icon={searchOpen ? faXmark : faMagnifyingGlass} />
          </button>
        )}
        {onPopOut && <button className="panel-header-popout" onClick={onPopOut} title={isPoppedOut ? "Pop back in" : "Pop out"} aria-label={isPoppedOut ? "Pop pane back into main window" : "Pop pane out into its own window"}><Icon icon={isPoppedOut ? faDownLeftAndUpRightToCenter : faUpRightFromSquare} /></button>}
        {onClose && <button className="panel-header-close" onClick={onClose} title="Close panel" aria-label="Close panel"><Icon icon={faXmark} /></button>}
      </div>
      <div className="panel-content">
        {quotes.length === 0 && (
          <div className="empty-state" style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
            No quotes yet.
            <br />
            Right-click a selection in a document and choose "Add as Quote".
          </div>
        )}
        {quotes.length > 0 && filteredGroups.length === 0 && (
          <div className="empty-state" style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
            No quotes match "{trimmedSearch}".
          </div>
        )}
        {filteredGroups.map((group) => {
          const isCollapsed = !trimmedSearch && collapsedGroups.has(group.sourceGuid)
          const dimmed = !!trimmedSearch && !group.nameMatch
          return (
            <div key={group.sourceGuid}>
              {/* Document group header — styled like the parent-category
                  headers in MemosPane / SavedAnalyses / DocumentBrowser
                  (small-secondary, no uppercase, count on the right). */}
              <div
                onClick={() => toggleGroup(group.sourceGuid)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 8px',
                  fontSize: 'var(--font-size-sm)',
                  fontWeight: 600,
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  userSelect: 'none',
                  opacity: dimmed ? 0.45 : 1
                }}
              >
                <span style={{ fontSize: 10, width: 12, textAlign: 'center', opacity: 0.6 }}>
                  <Icon icon={isCollapsed ? faChevronRight : faChevronDown} />
                </span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {group.sourceName}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{group.quotes.length}</span>
              </div>
              {/* Quote items */}
              {!isCollapsed && group.quotes.map((q) => (
                <div
                  key={q.guid}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/json', JSON.stringify({
                      kind: 'quote',
                      entityGuid: q.guid,
                      label: q.sourceName,
                      snippet: q.text,
                      sourceGuid: q.sourceGuid,
                      startPosition: q.startPosition,
                      endPosition: q.endPosition,
                      pdfRegion: q.pdfRegion
                    }))
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                  onClick={() => {
                    // Pass pdfRegion so box-selection quotes scroll to their
                    // rectangle on the PDF / image instead of landing at
                    // codepoint 0 (which goes nowhere for a box quote).
                    viewDocumentAt(q.sourceGuid, q.startPosition, q.endPosition, q.pdfRegion)
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setContextMenu({ x: e.clientX, y: e.clientY, guid: q.guid })
                  }}
                  style={{
                    padding: '4px 8px 4px 16px',
                    cursor: 'pointer',
                    borderRadius: 'var(--radius-sm)',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 6,
                    fontSize: 'var(--font-size-sm)'
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <Icon
                    icon={QUOTE_ICON}
                    style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0, marginTop: 2 }}
                  />
                  {q.pdfRegion ? (
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                      <PdfRegionThumbnail
                        sourceGuid={q.sourceGuid}
                        page={q.pdfRegion.page}
                        x={q.pdfRegion.x}
                        y={q.pdfRegion.y}
                        width={q.pdfRegion.width}
                        height={q.pdfRegion.height}
                        maxW={240}
                        maxH={160}
                      />
                      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Page {q.pdfRegion.page}</span>
                    </div>
                  ) : (
                    <span style={{
                      flex: 1,
                      overflow: 'hidden',
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      lineHeight: '15px',
                      color: 'var(--text-primary)'
                    }}>
                      {(() => {
                        const src = sources.find((s) => s.guid === q.sourceGuid)
                        const st = src?.sourceType || sourceTypeFromFilename(q.sourceName)
                        const clean = stripFormatting(q.text, st)
                        return `${clean.slice(0, 120)}${clean.length > 120 ? '...' : ''}`
                      })()}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )
        })}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={menuPos.ref}
          className="context-menu"
          style={{ left: menuPos.x, top: menuPos.y }}
          onClick={(e) => e.stopPropagation()}
          /* Stop mousedown so it doesn't bubble to the panel's mousedown
             handler, which would dismiss the menu before the click fires
             on the Delete item. */
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div
            className="context-menu-item"
            onClick={() => {
              handleCopyQuote(contextMenu.guid)
              setContextMenu(null)
            }}
          >
            Copy Quote
          </div>
          <div className="context-menu-separator" />
          <div
            className="context-menu-item"
            style={{ color: 'var(--menu-fg-danger)' }}
            title={lockedBy ? checkoutLockedTitle(lockedBy) : undefined}
            onClick={() => {
              setContextMenu(null)
              if (lockedBy) { useProjectStore.getState().promptCheckoutConflict(); return }
              removeQuote(contextMenu.guid)
            }}
          >
            Delete Quote
          </div>
        </div>
      )}
    </div>
  )
}
