import { useState, useMemo, useRef, useEffect, Fragment, Component, type ReactNode, type ErrorInfo } from 'react'
import { useDocumentStore } from '../../stores/document-store'
import { useSurveyViewStore } from '../../stores/survey-view-store'
import { COLLAPSE_SPLIT_RATIO, DEFAULT_SPLIT_RATIO, clampSplitRatio, getSplitRatio, paneScrollKey, setSplitRatio, type SplitPane } from '../../utils/split-view'
import { setViewPosition } from '../../stores/view-position-store'
import { TextDocumentPane } from './TextDocumentPane'
import { PdfDocumentViewer } from './PdfDocumentViewer'
import { AudioDocumentViewer } from './AudioDocumentViewer'
import { VideoDocumentViewer } from './VideoDocumentViewer'
import { ImageDocumentViewer } from './ImageDocumentViewer'
import { SurveyViewer } from '../SurveyViewer/SurveyViewer'
import { TabBar } from './TabBar'
import { NoteHeader } from './NoteHeader'
import { sourceTypeFromFilename } from '../../utils/format-registry'
import { isAnalysisTab, isMapTab, isPreferencesTab, isMergeTab, isQueryBuilderTab, isToolTab, mapGuidFromTabId } from '../../utils/tab-ids'
import { InlineAnalysisTab } from '../Analysis/InlineAnalysisTab'
import { PreferencesWindow } from '../Preferences/PreferencesWindow'
import { MergeReviewWindow } from '../Merge/MergeReviewWindow'
import { useAnalysisTabsStore } from '../../stores/analysis-tabs-store'

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
import { Icon, faSquareSplitVertical } from '../Icon'

/** Header button that splits the document into two halves, or joins them
 *  again. Styled to match the memo button beside it. */
function SplitToggle({ split, onToggle }: { split: boolean; onToggle: () => void }) {
  const [hovered, setHovered] = useState(false)
  const color = split ? 'var(--accent)' : hovered ? 'var(--text-muted)' : 'var(--border-color)'
  const label = split ? 'Remove split' : 'Split into two views'
  return (
    <button
      onClick={onToggle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={label}
      aria-label={label}
      aria-pressed={split}
      style={{
        position: 'relative',
        flexShrink: 0,
        width: 28,
        height: 28,
        borderRadius: '50%',
        display: 'grid',
        placeItems: 'center',
        lineHeight: 0,
        fontSize: 0,
        background: 'var(--bg-panel)',
        border: `1.5px solid ${color}`,
        color,
        cursor: 'pointer',
        padding: 0,
        transition: 'color 0.12s, border-color 0.12s'
      }}
    >
      <Icon icon={faSquareSplitVertical} style={{ fontSize: 13, display: 'block' }} />
    </button>
  )
}

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

export function DocumentViewer() {
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
  const isNote = source?.sourceType === 'note'
  // PDFs and text documents (not notes) can be split into two halves, each
  // scrolled and coded on its own (see utils/split-view.ts). The other
  // types scroll inside their dedicated viewers.
  const isText = !!source && !isPdf && !isAudio && !isVideo && !isImage && !isSurvey
  const canSplit = !!source && (isPdf || (isText && !isNote))
  const [splitRatio, setSplitRatioState] = useState<number | null>(null)
  const [activePane, setActivePane] = useState<SplitPane>('primary')
  useEffect(() => {
    setSplitRatioState(canSplit && selectedGuid ? getSplitRatio(selectedGuid) : null)
    setActivePane('primary')
  }, [selectedGuid, canSplit])
  const toggleSplit = () => {
    if (!selectedGuid) return
    const next = splitRatio === null ? DEFAULT_SPLIT_RATIO : null
    setSplitRatioState(next)
    setSplitRatio(selectedGuid, next)
    if (next === null) setActivePane('primary')
  }
  // Bumped to remount the top half's viewer so it re-reads its remembered
  // position (when closing the top half leaves the bottom half's view).
  const [primaryEpoch, setPrimaryEpoch] = useState(0)
  const splitAreaRef = useRef<HTMLDivElement>(null)
  // While the divider is dragged, the halves are resized directly rather
  // than through state, so long documents don't re-render on every move.
  const paneWrapperRefs = useRef<Record<SplitPane, HTMLDivElement | null>>({ primary: null, secondary: null })
  const startDividerDrag = (e: React.MouseEvent) => {
    e.preventDefault()
    const area = splitAreaRef.current
    if (!area || !selectedGuid) return
    const guid = selectedGuid
    let ratio = splitRatio ?? DEFAULT_SPLIT_RATIO
    // The half the divider has been dragged over, which closes on release.
    let closing: SplitPane | null = null
    const onMove = (ev: MouseEvent) => {
      const rect = area.getBoundingClientRect()
      const raw = (ev.clientY - rect.top) / rect.height
      closing = raw < COLLAPSE_SPLIT_RATIO ? 'primary' : raw > 1 - COLLAPSE_SPLIT_RATIO ? 'secondary' : null
      ratio = clampSplitRatio(raw)
      const shown = closing === 'primary' ? 0 : closing === 'secondary' ? 1 : ratio
      const { primary, secondary } = paneWrapperRefs.current
      if (primary) primary.style.flex = `${shown} 1 0`
      if (secondary) secondary.style.flex = `${1 - shown} 1 0`
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      if (!closing) {
        setSplitRatioState(ratio)
        setSplitRatio(guid, ratio)
        return
      }
      if (closing === 'primary') {
        // The bottom half's view is what's left: carry its position over.
        const scroller = paneWrapperRefs.current.secondary?.querySelector<HTMLElement>('.pdf-scroll-area, [data-text-pane-scroller]')
        if (scroller) setViewPosition(paneScrollKey(guid, 'primary'), scroller.scrollTop, scroller.scrollHeight)
        setPrimaryEpoch((n) => n + 1)
      }
      setSplitRatioState(null)
      setSplitRatio(guid, null)
      setActivePane('primary')
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'row-resize'
  }

  // Tool tabs (relationship maps, analysis tools, query builder) share
  // the same chrome as documents. We keep every open tool tab mounted
  // and toggle visibility with display:none so switching to a sibling
  // tab and back preserves the tool's internal state — previously each
  // switch unmounted the active tool and any in-progress grid / drag
  // state was lost.
  const toolTabIds = openTabs.filter((t) => isToolTab(t))
  const activeIsTool = isToolTab(selectedGuid)

  return (
    <div className="panel">
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
          {isNote ? <NoteHeader source={source} /> : (
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
          )}
          {canSplit && <SplitToggle split={splitRatio !== null} onToggle={toggleSplit} />}
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
              const label = t === 'note' ? 'Note' : t === 'markdown' ? 'Markdown' : t === 'audio' ? 'Audio transcript' : t === 'video' ? 'Video transcript' : 'Plain text'
              const wc = (content.match(/\S+/g) || []).length
              return `${label} · ${wc.toLocaleString()} words`
            })()}
          </span>
          <span className="viewer-spacer" />
        </div>
      )}
      {source && (isPdf || isText) ? (
        <div
          ref={splitAreaRef}
          className="panel-content"
          style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        >
          {(splitRatio === null ? ['primary'] as const : ['primary', 'secondary'] as const).map((pane) => {
            const split = splitRatio !== null
            const share = pane === 'primary' ? splitRatio ?? 1 : 1 - (splitRatio ?? 0)
            const active = !split || activePane === pane
            const activate = () => { if (split && activePane !== pane) setActivePane(pane) }
            return (
              <Fragment key={pane}>
                {pane === 'secondary' && (
                  <div
                    role="separator"
                    aria-orientation="horizontal"
                    title="Drag to resize · drag to an edge or double-click to remove the split"
                    onMouseDown={startDividerDrag}
                    onDoubleClick={toggleSplit}
                    style={{
                      flexShrink: 0,
                      height: 6,
                      cursor: 'row-resize',
                      background: 'var(--bg-secondary)',
                      borderTop: '1px solid var(--border-color)',
                      borderBottom: '1px solid var(--border-color)'
                    }}
                  />
                )}
                <div
                  ref={(el) => { paneWrapperRefs.current[pane] = el }}
                  style={{
                    flex: `${share} 1 0`,
                    minHeight: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    position: 'relative'
                  }}
                >
                  {/* In a split, a thin accent bar marks the half that takes
                      code hotkeys and follows quote/memo clicks. Drawn above
                      the viewer, which paints its own background. */}
                  {split && active && (
                    <div
                      data-active-pane-marker="1"
                      style={{
                        position: 'absolute',
                        top: 0,
                        bottom: 0,
                        left: 0,
                        width: 3,
                        background: 'var(--accent)',
                        zIndex: 20,
                        pointerEvents: 'none'
                      }}
                    />
                  )}
                  {isPdf ? (
                    <PdfDocumentViewer
                      key={pane === 'secondary' ? `${source.guid}|split` : `primary-${primaryEpoch}`}
                      source={source}
                      content={content}
                      pane={pane}
                      active={active}
                      onActivate={activate}
                    />
                  ) : (
                    <TextDocumentPane
                      key={pane === 'secondary' ? source.guid : `${source.guid}:${primaryEpoch}`}
                      source={source}
                      content={content}
                      sourceType={effectiveSourceType}
                      pane={pane}
                      active={active}
                      onActivate={activate}
                    />
                  )}
                </div>
              </Fragment>
            )
          })}
        </div>
      ) : (
        <div className="panel-content" style={{ position: 'relative' }}>
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
        </div>
      )}
      </>)}
    </div>
  )
}
