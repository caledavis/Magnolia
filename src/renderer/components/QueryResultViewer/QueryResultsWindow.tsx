import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { Icon, faDownLeftAndUpRightToCenter } from '../Icon'
import type { QueryResult, QueryResultsInitData, PlainTextSelection } from '../../models/types'
import { stripFormatting } from '../../utils/strip-formatting'
import { sourceTypeFromFilename } from '../../utils/format-registry'
import { SavedQueries } from '../SavedQueries/SavedQueries'
import { QueryResultsBody, groupByDocument } from './QueryResultsBody'
import { QueryLoadingBar } from './QueryLoadingBar'
import { exportPdfWithHeader, buildPdfDocument, escHtml } from '../../utils/pdf-export'
import { EditableTitleSuffix } from '../EditableTitleSuffix'

export function QueryResultsWindow() {
  const [data, setData] = useState<QueryResultsInitData | null>(null)
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  useEffect(() => {
    window.api.getQueryResultsData().then((initData) => {
      if (initData) {
        setData(initData)
        const theme = (initData as any).theme
        if (theme) document.documentElement.setAttribute('data-theme', theme)
      }
    })
    const unsub = window.api.onQueryResultsData((initData) => {
      if (initData) {
        setData(initData)
        const theme = (initData as any).theme
        if (theme) document.documentElement.setAttribute('data-theme', theme)
      }
    })
    return unsub
  }, [])

  const groups = useMemo(() => data ? groupByDocument(data.results) : [], [data])

  const codeMap = useMemo(() => {
    const m = new Map<string, { name: string; color?: string }>()
    for (const c of data?.codes ?? []) m.set(c.guid, c)
    return m
  }, [data?.codes])

  const findCode = useCallback((guid: string) => codeMap.get(guid), [codeMap])

  const sourceSelections = data?.sourceSelections ?? {}
  const pdfFilePaths = data?.pdfFilePaths ?? {}

  const handleOpenResult = useCallback((result: QueryResult) => {
    const selections = sourceSelections[result.sourceGuid] || []
    const sel = selections.find((s) => s.guid === result.selectionGuid)
    window.api.jumpToQueryResult({
      sourceGuid: result.sourceGuid,
      startPosition: result.startPosition,
      endPosition: result.endPosition,
      pdfRegion: sel?.pdfRegion,
      timeRange: result.timeRange,
      surveyCell: sel?.surveyCell
    })
  }, [sourceSelections])

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

  // ── Code All dropdown state ────────────────────────────────────────
  // Same shape as the popped-in QueryResultViewer so the dropdown UI is
  // identical (context menu with New Code… / Existing Codes… that opens
  // an inline drop-zone). Drop-zone drag-drop accepts custom MIME types
  // dragged from the main window's Code Browser; Chromium routes them
  // across BrowserWindow instances in the same Electron app.
  const [codeAllMenu, setCodeAllMenu] = useState<null | 'context' | 'drop-zone'>(null)
  const [dropOver, setDropOver] = useState(false)
  const codeAllRef = useRef<HTMLDivElement>(null)
  const codeAllBtnRef = useRef<HTMLButtonElement>(null)
  const [popoverPos, setPopoverPos] = useState<{ left: number; top: number } | null>(null)

  // Close the context menu on outside click. Drop-zone stays open during
  // drags — closing it on click would dismiss it the moment a drag from
  // the main window enters the popout.
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

  // Compute popover position when the menu opens. Anchors BELOW the
  // button — the popout's header sits flush against the top of the
  // window, so opening upward (like the popped-in version does) would
  // push the menu past the top edge / behind the macOS title bar.
  // Anchoring below means the menu drops down into the body area
  // where there's always room.
  //
  // Also clamps the horizontal position so the menu can't overflow
  // past the right or left edge of the window. MENU_W is the rendered
  // outer width of the wider variant: the drop-zone has minWidth 240
  // + 12px padding × 2 + 1px border × 2 = 266px in content-box mode.
  // 290 gives a small buffer in case content pushes width up a few
  // pixels. The recompute triggers on every codeAllMenu transition
  // (context ↔ drop-zone) so the wider drop-zone is positioned with
  // this same upper bound.
  useEffect(() => {
    if (codeAllMenu && codeAllBtnRef.current) {
      const rect = codeAllBtnRef.current.getBoundingClientRect()
      const MENU_W = 290
      const EDGE_PAD = 8
      // Default to button's left edge; pull leftward if that would
      // push the menu's right edge past the viewport; then clamp to a
      // minimum so an absurdly narrow window can't push left negative.
      const desiredLeft = Math.min(rect.left, window.innerWidth - MENU_W - EDGE_PAD)
      setPopoverPos({
        left: Math.max(EDGE_PAD, desiredLeft),
        top: rect.bottom + 4
      })
    }
  }, [codeAllMenu])

  // Drop handler: parse the dragged code(s) and fire one IPC per code so
  // the main process applies each to every current query result. Same
  // parse logic as QueryResultViewer.handleDropCodes.
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
        window.api.sendQueryResultsAction('code-all-existing-code', { guid: c.guid })
      }
      setCodeAllMenu(null)
    } catch { /* ignore malformed drag payload */ }
  }, [])

  // Mirror handleSelectDocuments — fires an IPC; main does the selection
  // against its document store (which is the source of truth for tree
  // selection state).
  const handleSelectDocuments = useCallback(() => {
    window.api.sendQueryResultsAction('select-documents')
  }, [])

  // Rename a saved query via the existing IPC action (same one used by
  // the SavedQueries sidebar). Used by EditableTitleSuffix when the
  // active query's title is edited inline.
  const handleRenameActiveQuery = useCallback((guid: string, name: string) => {
    window.api.sendQueryResultsAction('rename-saved-query', { guid, name })
  }, [])

  const handleExportPdf = useCallback(async () => {
    if (!data || groups.length === 0) return
    const title = data.queryName || 'Query Results'
    const now = new Date().toLocaleString()

    // Pre-render thumbnails for region-based results so they embed as
    // data-URL <img> tags in the exported HTML. The popped-out window
    // doesn't carry source-type metadata, so we infer image vs PDF from
    // the source's filename — the same heuristic used elsewhere here.
    const { renderPdfRegionThumbnail } = await import('../../utils/pdf-thumbnail')
    const { renderImageRegionThumbnail } = await import('../../utils/image-thumbnail')
    const thumbDataUrls = new Map<string, string>()
    const regionByGuid = new Map<string, { page: number; x: number; y: number; width: number; height: number }>()
    for (const group of groups) {
      for (const r of group.results) {
        const selection = (sourceSelections[r.sourceGuid] || []).find((s) => s.guid === r.selectionGuid)
        const region = selection?.pdfRegion
        const filePath = pdfFilePaths[r.sourceGuid]
        if (!region || !filePath) continue
        regionByGuid.set(r.selectionGuid, region)
        const isImage = sourceTypeFromFilename(r.sourceName) === 'image'
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
          /* skip */
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
          const pg = regionByGuid.get(r.selectionGuid)?.page
          const isImageSrc = sourceTypeFromFilename(r.sourceName) === 'image'
          body += `<div class="context"><img src="${thumbUrl}" class="region-thumb" />`
          if (pg && !isImageSrc) body += `<div class="region-caption">Page ${pg}</div>`
          body += `</div></div>`
          continue
        }
        body += `<div class="context">`
        const st = sourceTypeFromFilename(r.sourceName)
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

    // Same query-results-specific styling as the in-app
    // QueryResultViewer. Body typography, h1, .subtitle, and .muted
    // come from buildPdfDocument's base CSS.
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
      subtitle: `${data.results.length} match${data.results.length !== 1 ? 'es' : ''} in ${groups.length} document${groups.length !== 1 ? 's' : ''} &mdash; exported ${escHtml(now)}`,
      body,
      extraCss
    })

    const safeName = (data.queryName || 'Query Results').replace(/[^a-zA-Z0-9 _-]/g, '').trim()
    await exportPdfWithHeader(html, safeName)
  }, [data, groups])

  // sourceSelections is plain Record<sourceGuid, selections> in the IPC
  // payload; QueryResultsBody wants a Map for O(1) lookup, so wrap once.
  // MUST live above the early-return below so the hook count stays
  // stable across the data-null → data-loaded transition (React
  // rules-of-hooks).
  const sourceSelectionsByGuid = useMemo(() => {
    const m = new Map<string, PlainTextSelection[]>()
    for (const [guid, sels] of Object.entries(sourceSelections)) m.set(guid, sels)
    return m
  }, [sourceSelections])

  // Match the popped-in computation: find the saved query whose stored
  // shape matches the currently-running query. If found, the title gets
  // the inline-rename treatment via EditableTitleSuffix. Lives above
  // the early-return for the same rules-of-hooks reason as
  // sourceSelectionsByGuid above.
  const activeSavedQuery = useMemo(() => {
    if (!data?.isActive || !data?.currentQuery) return null
    return (data.savedQueries ?? []).find(
      (sq) => JSON.stringify(sq.query) === JSON.stringify(data.currentQuery)
    ) ?? null
  }, [data?.isActive, data?.currentQuery, data?.savedQueries])

  if (!data) {
    return (
      <div
        style={{
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-muted)'
        }}
      >
        Loading query results...
      </div>
    )
  }

  // Header element. Built once and slotted into the right Panel below
  // so the sidebar can span the full popout height — the same pattern
  // QueryResultViewer uses when a sidebar is present.
  const header = (
    <div className="panel-header query-results-header">
      <span>Query{activeSavedQuery ? ':' : (data.queryName ? ':' : '')}</span>
      {activeSavedQuery ? (
        <span style={{ marginLeft: 4 }}>
          <EditableTitleSuffix
            name={activeSavedQuery.name}
            onRename={(newName) => handleRenameActiveQuery(activeSavedQuery.guid, newName)}
          />
        </span>
      ) : data.queryName && (
        <span style={{ marginLeft: 4, fontWeight: 300, color: 'var(--text-secondary)' }}>
          {data.queryName}
        </span>
      )}
      <span style={{ flex: 1 }} />
      {data.isActive && (
        <>
          {data.results.length > 0 && (
            <button
              className="secondary"
              style={{ fontSize: 11, padding: '2px 8px', marginRight: 4 }}
              onClick={handleSelectDocuments}
              disabled={data.isLoading}
              title="Select all documents and respondents in these results in the Document Browser — then drag a tag onto them to tag all at once"
            >
              Select Documents
            </button>
          )}
          {data.results.length > 0 && (
            <div style={{ marginRight: 4 }}>
              <button
                ref={codeAllBtnRef}
                className="secondary"
                style={{ fontSize: 11, padding: '2px 8px' }}
                onClick={() => setCodeAllMenu(codeAllMenu ? null : 'context')}
                disabled={data.isLoading}
                title={`Apply a code to all ${data.results.length} results`}
              >
                Code All ({data.results.length})
              </button>

              {codeAllMenu && popoverPos && createPortal(
                <div ref={codeAllRef} style={{
                  position: 'fixed',
                  left: popoverPos.left,
                  top: popoverPos.top,
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
                          window.api.sendQueryResultsAction('code-all-new-code')
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
          <button
            style={{ fontSize: 11, padding: '2px 8px', marginRight: 4 }}
            className="secondary"
            onClick={() => window.api.sendQueryResultsAction('edit-query')}
          >
            Edit Query
          </button>
          <button
            style={{ fontSize: 11, padding: '2px 8px', marginRight: 4 }}
            className="secondary"
            onClick={handleExportPdf}
            disabled={data.isLoading}
            title="Export results as PDF"
          >
            Export PDF
          </button>
          <button
            style={{ fontSize: 11, padding: '2px 8px', marginRight: 4 }}
            className="secondary"
            onClick={() => window.api.sendQueryResultsAction('clear-query')}
          >
            Clear
          </button>
          {data.isUnsaved && (
            <button
              style={{ fontSize: 11, padding: '2px 8px', marginRight: 4 }}
              onClick={() => window.api.sendQueryResultsAction('save-query')}
            >
              Save Query
            </button>
          )}
        </>
      )}
      <button
        className="panel-header-popout"
        onClick={() => window.close()}
        title="Pop back into main window"
      >
        <Icon icon={faDownLeftAndUpRightToCenter} />
      </button>
    </div>
  )

  return (
    <div className="panel query-results-panel">
      <PanelGroup direction="horizontal" style={{ flex: 1, overflow: 'hidden' }}>
        <Panel defaultSize={18} minSize={10} maxSize={40}>
          <SavedQueries
            savedQueries={data.savedQueries ?? []}
            currentQuery={data.currentQuery ?? null}
            isActive={data.isActive}
            onRunQuery={(guid) => window.api.sendQueryResultsAction('run-saved-query', { guid })}
            onDeleteQuery={(guid) => {
              // Optimistic local update so the row disappears instantly,
              // independent of how long the IPC roundtrip to main takes.
              setData((prev) => prev ? {
                ...prev,
                savedQueries: prev.savedQueries?.filter((sq) => sq.guid !== guid)
              } : prev)
              window.api.sendQueryResultsAction('delete-saved-query', { guid })
            }}
            onRenameQuery={(guid, name) => {
              // Optimistic local update — without this the input unmounts
              // before main's update reaches us, briefly showing the old
              // name; if anything in the IPC chain is delayed the user
              // sees the rename "revert". The eventual sync from main
              // overwrites this with the same value, harmlessly.
              setData((prev) => prev ? {
                ...prev,
                savedQueries: prev.savedQueries?.map((sq) => sq.guid === guid ? { ...sq, name } : sq)
              } : prev)
              window.api.sendQueryResultsAction('rename-saved-query', { guid, name })
            }}
            onEditQuery={(guid) => window.api.sendQueryResultsAction('edit-saved-query', { guid })}
          />
        </Panel>
        {/* The class on this handle is read by the Granola theme
            override so the divider stays visible inside the
            Queries panel even though the global Granola rule
            hides every other resize handle (to preserve the
            floating-card look). */}
        <PanelResizeHandle className="queries-sidebar-divider" style={{ width: 1, background: 'var(--border-color)', cursor: 'col-resize' }} />
        <Panel defaultSize={82} minSize={40}>
          {/* Header lives inside the right Panel so the sidebar Panel
              can span the full Queries-panel height — same structure
              the popped-in QueryResultViewer uses when a sidebar is
              present. */}
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {header}
            <QueryLoadingBar active={!!data.isLoading} />
            <div className="panel-content" aria-busy={!!data.isLoading} style={data.isLoading ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
              <QueryResultsBody
                results={data.results}
                isActive={data.isActive}
                expandedKeys={expandedKeys}
                toggleExpand={toggleExpand}
                collapsedGroups={collapsedGroups}
                toggleGroup={toggleGroup}
                sourceSelectionsByGuid={sourceSelectionsByGuid}
                findCode={findCode}
                onOpenResult={handleOpenResult}
                pdfFilePathForGuid={(guid) => pdfFilePaths[guid]}
                surveyForGuid={(guid) => data.surveysByGuid?.[guid]}
              />
            </div>
          </div>
        </Panel>
      </PanelGroup>
    </div>
  )
}
