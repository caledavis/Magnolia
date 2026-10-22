import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { useQueryStore } from '../../stores/query-store'
import { useDocumentStore, surveyEntityKey } from '../../stores/document-store'
import { useCodeStore } from '../../stores/code-store'
import { useSurveyViewStore } from '../../stores/survey-view-store'
import { Icon, faUpRightFromSquare, faXmark } from '../Icon'
import type { QueryResult, PlainTextSelection, SurveyFormatData } from '../../models/types'
import { stripFormatting } from '../../utils/strip-formatting'
import { sourceTypeFromFilename } from '../../utils/format-registry'
import { EditableTitleSuffix } from '../EditableTitleSuffix'
import { QueryResultsBody, groupByDocument } from './QueryResultsBody'
import { QueryLoadingBar } from './QueryLoadingBar'
import { exportPdfWithHeader, buildPdfDocument, escHtml } from '../../utils/pdf-export'

interface Props {
  onSaveQuery?: () => void
  onEditQuery?: () => void
  queryName?: string
  /** Called when user wants to code all results with a new code */
  onCodeAllNewCode?: () => void
  /** Called to apply an existing code guid to all results */
  onApplyCodeToResults?: (codeGuid: string) => void
  /** Called to pop out the query results into a separate window */
  onPopOut?: () => void
  onClose?: () => void
  /** Optional left-hand sidebar — when provided, the panel-content
   *  area is wrapped in a horizontal split with the sidebar on the
   *  left and the existing results body on the right. Used to host
   *  the Saved Queries list inside the combined Queries panel. */
  sidebar?: React.ReactNode
  sidebarDefaultSize?: number
  sidebarMinSize?: number
  sidebarMaxSize?: number
}


export function QueryResultViewer({ onSaveQuery, onEditQuery, queryName, onCodeAllNewCode, onApplyCodeToResults, onPopOut, onClose, sidebar, sidebarDefaultSize = 18, sidebarMinSize = 10, sidebarMaxSize = 40 }: Props) {
  const results = useQueryStore((s) => s.results)
  const isActive = useQueryStore((s) => s.isActive)
  const isLoading = useQueryStore((s) => s.isLoading)
  const missingDocuments = useQueryStore((s) => s.missingDocuments)
  const currentQuery = useQueryStore((s) => s.currentQuery)
  const savedQueries = useQueryStore((s) => s.savedQueries)
  const clearQuery = useQueryStore((s) => s.clearQuery)
  const viewDocument = useDocumentStore((s) => s.viewDocument)
  const viewDocumentAt = useDocumentStore((s) => s.viewDocumentAt)
  const sources = useDocumentStore((s) => s.sources)
  const selectDocuments = useDocumentStore((s) => s.selectDocuments)
  const selectSurveyEntities = useDocumentStore((s) => s.selectSurveyEntities)

  // Select every document / respondent the current results came from, so
  // the user can drag a tag onto the Document Browser to tag them all.
  // Survey matches select the matched respondent (not the whole survey).
  const handleSelectDocuments = useCallback(() => {
    const docGuids = new Set<string>()
    const entityKeys = new Set<string>()
    for (const r of results) {
      if (r.surveyCell) entityKeys.add(surveyEntityKey('resp', r.sourceGuid, r.surveyCell.respondentId))
      else docGuids.add(r.sourceGuid)
    }
    selectDocuments(docGuids)
    selectSurveyEntities(entityKeys)
  }, [results, selectDocuments, selectSurveyEntities])
  const codeFindCode = useCodeStore((s) => s.findCode)

  // Build a map of sourceGuid -> selections for quick lookup
  const sourceSelectionsMap = useMemo(() => {
    const m = new Map<string, PlainTextSelection[]>()
    for (const s of sources) {
      if (s.selections.length > 0) m.set(s.guid, s.selections)
    }
    return m
  }, [sources])

  // Wrap findCode to return just name+color
  const findCodeInfo = useCallback((guid: string) => {
    const c = codeFindCode(guid)
    return c ? { name: c.name, color: c.color } : undefined
  }, [codeFindCode])

  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [codeAllMenu, setCodeAllMenu] = useState<null | 'context' | 'drop-zone'>(null)
  const [dropOver, setDropOver] = useState(false)
  const codeAllRef = useRef<HTMLDivElement>(null)
  const codeAllBtnRef = useRef<HTMLButtonElement>(null)
  const [popoverPos, setPopoverPos] = useState<{ left: number; bottom: number } | null>(null)

  // Close context menu on outside click (but not the drop-zone — it needs to stay open during drags)
  useEffect(() => {
    if (codeAllMenu !== 'context') return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (codeAllRef.current && codeAllRef.current.contains(target)) return
      if (codeAllBtnRef.current && codeAllBtnRef.current.contains(target)) return
      setCodeAllMenu(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [codeAllMenu])

  // Suppress raising child windows while the drop-zone is open
  useEffect(() => {
    if (codeAllMenu === 'drop-zone') {
      ;(window as any).__suppressRaiseChildWindows = true
    } else {
      ;(window as any).__suppressRaiseChildWindows = false
    }
    return () => { (window as any).__suppressRaiseChildWindows = false }
  }, [codeAllMenu])

  // Compute popover position when opening. Anchors above the button;
  // clamps horizontal position so the menu can't overflow the window
  // edge if the Code All button lives near the right edge of a narrow
  // panel. MENU_W is the rendered outer width of the wider variant
  // (drop-zone minWidth 240 + padding 24 + border 2 = 266); 290 gives
  // a small buffer for content that might push width up a few pixels.
  useEffect(() => {
    if (codeAllMenu && codeAllBtnRef.current) {
      const rect = codeAllBtnRef.current.getBoundingClientRect()
      const MENU_W = 290
      const EDGE_PAD = 8
      const desiredLeft = Math.min(rect.left, window.innerWidth - MENU_W - EDGE_PAD)
      setPopoverPos({
        left: Math.max(EDGE_PAD, desiredLeft),
        bottom: window.innerHeight - rect.top + 4
      })
    }
  }, [codeAllMenu])

  const handleDropCodes = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDropOver(false)
    const multiJson = e.dataTransfer.getData('application/x-magnolia-codes')
    const singleJson = e.dataTransfer.getData('application/x-magnolia-code')
    try {
      let codeItems: { guid: string }[]
      if (multiJson) codeItems = JSON.parse(multiJson)
      else if (singleJson) codeItems = [JSON.parse(singleJson)]
      else return
      for (const c of codeItems) {
        onApplyCodeToResults?.(c.guid)
      }
      setCodeAllMenu(null)
    } catch { /* ignore */ }
  }, [onApplyCodeToResults])

  const groups = useMemo(() => groupByDocument(results), [results])

  const isUnsaved = useMemo(() => {
    if (!isActive || !currentQuery) return false
    return !savedQueries.some(
      (sq) => JSON.stringify(sq.query) === JSON.stringify(currentQuery)
    )
  }, [isActive, currentQuery, savedQueries])

  // The saved-query record matching the active query, when there is one
  // — used to render the inline-editable name suffix in the header and
  // to provide the rename target.
  const activeSavedQuery = useMemo(() => {
    if (!isActive || !currentQuery) return null
    return savedQueries.find(
      (sq) => JSON.stringify(sq.query) === JSON.stringify(currentQuery)
    ) ?? null
  }, [isActive, currentQuery, savedQueries])

  const handleRenameQuery = useCallback((newName: string) => {
    if (!activeSavedQuery) return
    useQueryStore.getState().renameSavedQuery(activeSavedQuery.guid, newName)
  }, [activeSavedQuery])

  const handleExportPdf = useCallback(async () => {
    if (groups.length === 0) return
    const title = queryName || 'Query Results'
    const now = new Date().toLocaleString()

    // Pre-render thumbnails for any region-based results so they can be
    // embedded as data-URL <img> tags in the exported HTML.
    const { renderPdfRegionThumbnail } = await import('../../utils/pdf-thumbnail')
    const { renderImageRegionThumbnail } = await import('../../utils/image-thumbnail')
    const thumbDataUrls = new Map<string, string>()
    for (const group of groups) {
      for (const r of group.results) {
        const selection = sourceSelectionsMap.get(r.sourceGuid)?.find((s) => s.guid === r.selectionGuid)
        const region = selection?.pdfRegion
        if (!region) continue
        const source = sources.find((s) => s.guid === r.sourceGuid) as any
        const isImage = source?.sourceType === 'image'
        const filePath = isImage
          ? source?.formatData?.imageFilePath
          : source?.formatData?.pdfFilePath
        if (!filePath) continue
        try {
          const url = isImage
            ? await renderImageRegionThumbnail({
                filePath,
                x: region.x,
                y: region.y,
                width: region.width,
                height: region.height
              })
            : await renderPdfRegionThumbnail({
                filePath,
                page: region.page,
                x: region.x,
                y: region.y,
                width: region.width,
                height: region.height
              })
          thumbDataUrls.set(r.selectionGuid, url)
        } catch {
          // Skip failed renders — fall back to text preview.
        }
      }
    }

    let body = ''
    for (const group of groups) {
      body += `<div class="doc-group">`
      body += `<h2>${escHtml(group.sourceName)} <span class="count">(${group.results.length} match${group.results.length !== 1 ? 'es' : ''})</span></h2>`
      for (const r of group.results) {
        const codes = r.matchedCodes.map((c) =>
          `<span class="code-badge" style="border-left:3px solid ${c.color || '#888'}">${escHtml(c.name)}</span>`
        ).join(' ')
        const highlight = r.matchedCodes[0]?.color
          ? `background:${r.matchedCodes[0].color}40`
          : 'background:#fef08a'
        body += `<div class="result">`
        if (codes) body += `<div class="codes">${codes}</div>`
        const thumbUrl = thumbDataUrls.get(r.selectionGuid)
        if (thumbUrl) {
          const selection = sourceSelectionsMap.get(r.sourceGuid)?.find((s) => s.guid === r.selectionGuid)
          const pg = selection?.pdfRegion?.page
          const src = sources.find((s) => s.guid === r.sourceGuid) as any
          const isImageSrc = src?.sourceType === 'image'
          body += `<div class="context"><img src="${thumbUrl}" class="region-thumb" />`
          if (pg && !isImageSrc) body += `<div class="region-caption">Page ${pg}</div>`
          body += `</div></div>`
          continue
        }
        body += `<div class="context">`
        const st = sources.find((s) => s.guid === r.sourceGuid)?.sourceType || sourceTypeFromFilename(r.sourceName)
        const ctxB = st !== 'text' ? stripFormatting(r.contextBefore || '', st) : (r.contextBefore || '')
        const mtch = st !== 'text' ? stripFormatting(r.matchedText, st) : r.matchedText
        const ctxA = st !== 'text' ? stripFormatting(r.contextAfter || '', st) : (r.contextAfter || '')
        body += `<span class="muted">${ctxB ? '...' + escHtml(ctxB) : ''}</span>`
        body += `<mark style="${highlight}">${escHtml(mtch)}</mark>`
        body += `<span class="muted">${ctxA ? escHtml(ctxA) + '...' : ''}</span>`
        body += `</div></div>`
      }
      body += `</div>`
    }

    // Query-results-specific styling: per-document group, result row,
    // code badges, highlighted match, region thumbnails. Body
    // typography, h1, .subtitle, and .muted are provided by
    // buildPdfDocument's base CSS.
    const extraCss = `
  .doc-group { margin-bottom: 18px; }
  h2 { font-size: 13px; margin: 0 0 6px; padding: 4px 8px; background: #f3f4f6; border-radius: 4px; }
  h2 .count { font-weight: 400; color: #888; font-size: 11px; }
  .result { padding: 5px 8px 5px 14px; border-bottom: 1px solid #eee; }
  .codes { margin-bottom: 3px; }
  .code-badge { display: inline-block; font-size: 10px; padding: 1px 6px; margin-right: 4px; background: #f3f4f6; border-radius: 3px; }
  .context { white-space: pre-wrap; }
  mark { border-radius: 2px; padding: 1px 2px; font-weight: 600; }
  .region-thumb { display: block; max-width: 380px; max-height: 260px; border: 1px solid #ddd; border-radius: 3px; }
  .region-caption { font-size: 10px; color: #888; margin-top: 2px; }
`

    const html = buildPdfDocument({
      title,
      subtitle: `${results.length} match${results.length !== 1 ? 'es' : ''} in ${groups.length} document${groups.length !== 1 ? 's' : ''} &mdash; exported ${escHtml(now)}`,
      body,
      extraCss
    })

    const safeName = (queryName || 'Query Results').replace(/[^a-zA-Z0-9 _-]/g, '').trim()
    await exportPdfWithHeader(html, safeName)
  }, [groups, results, queryName])

  const toggleExpand = (key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleGroup = (sourceGuid: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(sourceGuid)) next.delete(sourceGuid)
      else next.add(sourceGuid)
      return next
    })
  }

  return (
    <div className="panel query-results-panel">
      {(() => {
      const header = (
        <div className="panel-header query-results-header">
        {/* Title + (when an active saved query is running) ": <name>"
            with click-to-rename. Mirrors the Tool: Name pattern used
            in the analysis tools, Query Builder, and Relationships
            tool. */}
        <span>Query{activeSavedQuery ? ':' : ''}</span>
        {activeSavedQuery && (
          <span style={{ marginLeft: 4 }}>
            <EditableTitleSuffix name={activeSavedQuery.name} onRename={handleRenameQuery} />
          </span>
        )}
        <span style={{ flex: 1 }} />
        {isActive && (
          <>
            {results.length > 0 && (
              <button
                className="secondary"
                style={{ fontSize: 11, padding: '2px 8px', marginRight: 4 }}
                onClick={handleSelectDocuments}
                disabled={isLoading}
                title="Select all documents and respondents in these results in the Document Browser — then drag a tag onto them to tag all at once"
              >
                Select Documents
              </button>
            )}
            {results.length > 0 && (
              <div style={{ marginRight: 4 }}>
                <button
                  ref={codeAllBtnRef}
                  className="secondary"
                  style={{ fontSize: 11, padding: '2px 8px' }}
                  onClick={() => setCodeAllMenu(codeAllMenu ? null : 'context')}
                  disabled={isLoading}
                  title={`Apply a code to all ${results.length} results`}
                >
                  Code All ({results.length})
                </button>

                {codeAllMenu && popoverPos && createPortal(
                  <div ref={codeAllRef} style={{
                    position: 'fixed',
                    left: popoverPos.left,
                    bottom: popoverPos.bottom,
                    zIndex: 10000
                  }}>
                    {codeAllMenu === 'context' && (
                      <div className="context-menu" style={{
                        background: 'var(--bg-panel)',
                        border: '1px solid var(--border-color)',
                        borderRadius: 'var(--radius-md)',
                        boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
                        padding: 4,
                        minWidth: 180
                      }}>
                        <div
                          className="context-menu-item"
                          style={{ padding: '6px 12px', fontSize: 12, cursor: 'pointer', borderRadius: 'var(--radius-sm)' }}
                          onClick={() => {
                            setCodeAllMenu(null)
                            onCodeAllNewCode?.()
                          }}
                          onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-tertiary)'}
                          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                        >
                          New Code...
                        </div>
                        <div
                          className="context-menu-item"
                          style={{ padding: '6px 12px', fontSize: 12, cursor: 'pointer', borderRadius: 'var(--radius-sm)' }}
                          onClick={() => setCodeAllMenu('drop-zone')}
                          onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-tertiary)'}
                          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                        >
                          Existing Codes...
                        </div>
                      </div>
                    )}

                    {codeAllMenu === 'drop-zone' && (
                      <div style={{
                        background: 'var(--bg-panel)',
                        border: '1px solid var(--border-color)',
                        borderRadius: 'var(--radius-md)',
                        boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
                        padding: 12,
                        minWidth: 240
                      }}>
                        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Apply Existing Codes</div>
                        <div
                          onDragOver={(e) => {
                            if (e.dataTransfer.types.includes('application/x-magnolia-code') || e.dataTransfer.types.includes('application/x-magnolia-codes')) {
                              e.preventDefault()
                              e.dataTransfer.dropEffect = 'copy'
                              setDropOver(true)
                            }
                          }}
                          onDragLeave={() => setDropOver(false)}
                          onDrop={handleDropCodes}
                          style={{
                            padding: '18px 12px',
                            border: `2px dashed ${dropOver ? 'var(--accent)' : 'var(--border-color)'}`,
                            borderRadius: 'var(--radius-md)',
                            textAlign: 'center',
                            fontSize: 11,
                            color: 'var(--text-muted)',
                            background: dropOver ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : undefined,
                            transition: 'border-color 0.15s, background 0.15s',
                            minHeight: 52,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                          }}
                        >
                          Drop codes here to apply to all results
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                          <button className="secondary" style={{ fontSize: 11, padding: '3px 10px' }} onClick={() => setCodeAllMenu(null)}>Close</button>
                        </div>
                      </div>
                    )}
                  </div>,
                  document.body
                )}
              </div>
            )}
            {onEditQuery && (
              <button
                style={{ fontSize: 11, padding: '2px 8px', marginRight: 4 }}
                className="secondary"
                onClick={onEditQuery}
              >
                Edit Query
              </button>
            )}
            <button
              style={{ fontSize: 11, padding: '2px 8px', marginRight: 4 }}
              className="secondary"
              onClick={handleExportPdf}
              disabled={isLoading}
              title="Export results as PDF"
            >
              Export PDF
            </button>
            <button
              style={{ fontSize: 11, padding: '2px 8px', marginRight: 4 }}
              className="secondary"
              onClick={clearQuery}
            >
              Clear
            </button>
            {isUnsaved && (
              <button
                style={{ fontSize: 11, padding: '2px 8px', marginRight: 4 }}
                onClick={onSaveQuery}
              >
                Save Query
              </button>
            )}
          </>
        )}
        {onPopOut && (
          <button
            className="panel-header-popout"
            onClick={onPopOut}
            title="Open query results in a separate window"
          >
            <Icon icon={faUpRightFromSquare} />
          </button>
        )}
        {onClose && (
          <button
            className="panel-header-close"
            onClick={onClose}
            title="Close panel"
          >
            <Icon icon={faXmark} />
          </button>
        )}
        </div>
      )
        const body = (
          <>
          <QueryLoadingBar active={isLoading} />
          {/* While a run is pending the previous results stay visible but
              dimmed and inert, so a click or a dropped code can't act on
              rows that are about to be replaced. */}
          <div className="panel-content" aria-busy={isLoading} style={isLoading ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
            <QueryResultsBody
              results={results}
              isActive={isActive}
              expandedKeys={expandedKeys}
              toggleExpand={toggleExpand}
              collapsedGroups={collapsedGroups}
              toggleGroup={toggleGroup}
              sourceSelectionsByGuid={sourceSelectionsMap}
              findCode={findCodeInfo}
              onOpenResult={(result, selection) => {
                // Survey-cell results: also flip the survey viewer to
                // the matching respondent and tell it which cell to
                // scroll into view. The cell-relative startPosition
                // wouldn't navigate to anything in the raw CSV view,
                // and the SurveyViewer ignores the doc-store
                // scrollTarget — it has its own.
                if (selection?.surveyCell) {
                  const svs = useSurveyViewStore.getState()
                  svs.setView(result.sourceGuid, 'respondent', selection.surveyCell.respondentId)
                  svs.setScrollTarget({
                    surveyGuid: result.sourceGuid,
                    respondentId: selection.surveyCell.respondentId,
                    questionId: selection.surveyCell.questionId
                  })
                }
                viewDocumentAt(
                  result.sourceGuid,
                  result.startPosition,
                  result.endPosition,
                  selection?.pdfRegion,
                  result.timeRange
                )
              }}
              onOpenSource={viewDocument}
              sourceTypeForGuid={(guid) => {
                const src = sources.find((s) => s.guid === guid)
                return src?.sourceType ?? sourceTypeFromFilename(src?.name ?? '')
              }}
              pdfPageOffsetsForGuid={(guid) => sources.find((s) => s.guid === guid)?.formatData?.pdfPageOffsets}
              surveyForGuid={(guid) => {
                const src = sources.find((s) => s.guid === guid)
                if (src?.sourceType !== 'survey') return undefined
                return (src.formatData as SurveyFormatData | undefined)?.survey
              }}
              missingDocuments={missingDocuments}
            />
          </div>
          </>
        )
        return sidebar ? (
          <PanelGroup direction="horizontal" style={{ flex: 1, overflow: 'hidden' }}>
            <Panel defaultSize={sidebarDefaultSize} minSize={sidebarMinSize} maxSize={sidebarMaxSize}>
              {sidebar}
            </Panel>
            {/* The class on this handle is read by the Granola theme
                override so the divider stays visible inside the
                Queries panel even though the global Granola rule
                hides every other resize handle (to preserve the
                floating-card look). */}
            <PanelResizeHandle className="queries-sidebar-divider" style={{ width: 1, background: 'var(--border-color)', cursor: 'col-resize' }} />
            <Panel defaultSize={100 - sidebarDefaultSize} minSize={40}>
              {/* Header lives inside the right Panel so the sidebar
                  Panel can span the full Queries-panel height. */}
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                {header}
                {body}
              </div>
            </Panel>
          </PanelGroup>
        ) : (
          <>
            {header}
            {body}
          </>
        )
      })()}
    </div>
  )
}
