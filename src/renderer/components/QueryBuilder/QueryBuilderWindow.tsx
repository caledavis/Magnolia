import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { QueryNodeEditor } from './QueryNodeEditor'
import { Icon, faChevronDown, faChevronRight, faMagnifyingGlass } from '../Icon'
import { toolColors } from '../../utils/tool-colors'
import {
  DocumentSelector,
  emptyDocumentFilter,
  type DocumentFilterState
} from '../DocumentSelector/DocumentSelector'
import type {
  CodeCondition,
  Query,
  QueryBuilderInitData
} from '../../models/types'
import { EditableTitleSuffix } from '../EditableTitleSuffix'
import { useQueryStore } from '../../stores/query-store'
import { useToolDirtyState } from '../../hooks/use-tool-dirty-state'
import { useRegisterToolSave } from '../../hooks/use-register-tool-save'
import { generateGuid } from '../../utils/guid'

function describeDocFilter(
  df: Query['documentFilter'],
  sources: { guid: string; name: string }[],
  tags: { guid: string; name: string; value?: string }[]
): string {
  const parts: string[] = []
  if (df.sourceGuids && df.sourceGuids.length > 0) {
    const names = df.sourceGuids.map((g) => sources.find((s) => s.guid === g)?.name).filter(Boolean) as string[]
    if (names.length > 0) parts.push(names.length <= 2 ? names.join(', ') : `${names.length} docs`)
  }
  if (df.tagGuids && df.tagGuids.length > 0) {
    const tagNames = df.tagGuids.map((g) => tags.find((tg) => tg.guid === g)?.name).filter(Boolean) as string[]
    if (tagNames.length > 0) parts.push(tagNames.join(', '))
  }
  if (df.tagExcludeGuids && df.tagExcludeGuids.length > 0) {
    const exNames = df.tagExcludeGuids.map((g) => tags.find((tg) => tg.guid === g)?.name).filter(Boolean) as string[]
    if (exNames.length > 0) parts.push('NOT ' + exNames.join(', '))
  }
  return parts.length > 0 ? ' IN ' + parts.join(', ') : ''
}

function describeCondition(cond: CodeCondition, codes: { guid: string; name: string }[]): string {
  const findName = (guid: string): string => {
    const c = codes.find((c) => c.guid === guid)
    return c?.name || 'Code'
  }
  switch (cond.type) {
    case 'code': return findName(cond.codeGuid) + (cond.includeSubcodes ? ' (incl. subcodes)' : '')
    case 'text': return `"${cond.searchText}"`
    case 'and': return cond.conditions.map((c) => describeCondition(c, codes)).join(' AND ')
    case 'or': return cond.conditions.map((c) => describeCondition(c, codes)).join(' OR ')
    case 'xor': return cond.conditions.map((c) => describeCondition(c, codes)).join(' XOR ')
    case 'not': return 'NOT ' + describeCondition(cond.condition, codes)
    case 'overlap': return `${describeCondition(cond.condition1, codes)} overlapping ${describeCondition(cond.condition2, codes)}`
    case 'inside': return `${describeCondition(cond.condition1, codes)} inside ${describeCondition(cond.condition2, codes)}`
    case 'outside': return `${describeCondition(cond.condition1, codes)} outside ${describeCondition(cond.condition2, codes)}`
    case 'before': return `${describeCondition(cond.condition1, codes)} before ${describeCondition(cond.condition2, codes)}`
    case 'followedBy': return `${describeCondition(cond.condition1, codes)} followed by ${describeCondition(cond.condition2, codes)}`
    default: return 'Query'
  }
}

// Section boxes in the Query Builder use the shared .analysis-section
// class (defined in global.css) so they stay visually consistent with
// the collapsible sections in every Analysis tool.


interface Props {
  /** Built by the inline tab wrapper. */
  initData?: QueryBuilderInitData
  /** Builder is hosted inside a Document Viewer tab. Save / Cancel /
   *  Close go through the host. */
  inTab?: {
    onClose: () => void
    /** Called after a Save Query / Update Query click. The tab stays
     *  open per the analysis-tools convention; the host updates the
     *  tab title to the saved name. The optional `savedGuid` lets
     *  the host stamp the saved-query identity onto the tab instance
     *  after a brand-new save, so the "open this saved query"
     *  navigation finds this tab instead of opening a duplicate. */
    onSaved: (name: string, savedGuid?: string) => void
    /** Lets the host (InlineAnalysisTab) mirror the builder's
     *  unsaved-changes flag into the analysis-tabs-store so the tab
     *  strip can render an asterisk and the close handler can prompt
     *  Save / Discard / Cancel. */
    onDirtyChange?: (dirty: boolean) => void
    /** Tab id (when hosted inline) — used to register the save handler
     *  with the global registry the close-confirm dialog invokes. */
    tabId?: string
  }
}

export function QueryBuilderWindow({ initData, inTab }: Props = {}) {
  // In tab mode `initData` is provided synchronously as a prop, so the
  // edit-related state below initializes from it on the very first
  // render. Without this, QueryNodeEditor mounts seeing
  // initialCondition=undefined, builds its internal graph (via useRef)
  // as null, and never recomputes — applyInitData runs in useEffect
  // *after* the canvas is locked, so the user sees an empty canvas
  // when re-opening a saved query that was edited and closed.
  const initialDocFilterFromInitData = (): DocumentFilterState => {
    if (initData?.editQuery) {
      const df = initData.editQuery.documentFilter
      return {
        sourceGuids: df.sourceGuids ?? [],
        tagGuids: df.tagGuids ?? [],
        tagExcludeGuids: df.tagExcludeGuids ?? [],
        folderGuids: df.folderGuids ?? [],
        typeInclude: [],
        typeExclude: [],
        // Hand the persisted graph back so DocumentSelector rebuilds from
        // it instead of synthesising one from the resolved arrays.
        graph: df.graph
      }
    }
    return emptyDocumentFilter()
  }

  const [data, setData] = useState<QueryBuilderInitData | null>(initData ?? null)
  const [editGuid, setEditGuid] = useState<string | undefined>(initData?.editSavedQueryGuid)
  const [initialCondition, setInitialCondition] = useState<CodeCondition | undefined>(
    initData?.editQuery?.codeCondition
  )

  const [docFilter, setDocFilter] = useState<DocumentFilterState>(initialDocFilterFromInitData)
  const [docFilterKey, setDocFilterKey] = useState(0) // force DocumentSelector remount on re-init
  const [docSectionOpen, setDocSectionOpen] = useState(() => {
    if (!initData?.editQuery) return false
    const df = initData.editQuery.documentFilter
    return Boolean(df.sourceGuids?.length || df.tagGuids?.length || df.tagExcludeGuids?.length || df.folderGuids?.length)
  })
  const [codeCondition, setCodeCondition] = useState<CodeCondition | null>(null)
  const [currentGraph, setCurrentGraph] = useState<{ nodes: any[]; conns: any[] } | null>(null)
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [saveQueryName, setSaveQueryName] = useState('')

  // Saved-query name shown after the title in tab mode. Subscribed via
  // useQueryStore so that renaming (from this header or from the Saved
  // Queries pane) re-renders the title automatically. Only meaningful
  // when the builder is editing an existing saved query (`editGuid`)
  // AND running in the main renderer (inTab) — popped-out windows have
  // their own empty zustand store, so `editName` is empty there and we
  // hide the suffix to avoid rendering a stray colon.
  const savedQueries = useQueryStore((s) => s.savedQueries)
  const editName = useMemo(() => {
    if (!editGuid) return ''
    return savedQueries.find((q) => q.guid === editGuid)?.name ?? ''
  }, [editGuid, savedQueries])

  const handleRenameQuery = useCallback((newName: string) => {
    if (!editGuid) return
    useQueryStore.getState().renameSavedQuery(editGuid, newName)
    if (inTab) inTab.onSaved(newName)
  }, [editGuid, inTab])
  const [initialGraphLayout, setInitialGraphLayout] = useState<{ nodes: any[]; conns: any[] } | undefined>(
    initData?.editGraphLayout
  )
  // Document-selector graph to restore on Discard. Kept in a ref rather
  // than the dirty-tracked baseline because the graph carries node x/y
  // positions: folding it into the JSON dirty-compare would flag a query
  // as unsaved on every node drag. Seeded from the loaded query and
  // re-seated whenever a save makes the current state the new baseline,
  // so Discard reverts to the right graph in both cases. The code graph's
  // equivalent is `initialGraphLayout`, which the editor remount reads.
  const discardDocGraphRef = useRef(initData?.editQuery?.documentFilter.graph)
  // Bumped on Discard to force QueryNodeEditor to remount with the
  // restored initialCondition / initialGraphLayout. Without the
  // remount the editor keeps its internal graph state and the
  // restored props don't propagate.
  const [editorRemountKey, setEditorRemountKey] = useState(0)

  // Dirty tracking. Baseline holds the docFilter + codeCondition the
  // builder loaded with (or empty for a brand-new query). Save updates
  // the baseline; Discard restores from it.
  const docFilterForCompare = useMemo(() => ({
    sourceGuids: docFilter.sourceGuids,
    tagGuids: docFilter.tagGuids,
    tagExcludeGuids: docFilter.tagExcludeGuids,
    folderGuids: docFilter.folderGuids
  }), [docFilter])
  const currentConfig = useMemo(
    () => ({ docFilter: docFilterForCompare, codeCondition }),
    [docFilterForCompare, codeCondition]
  )
  const initialBaseline = useMemo(() => ({
    docFilter: initData?.editQuery
      ? {
          sourceGuids: initData.editQuery.documentFilter.sourceGuids ?? [],
          tagGuids: initData.editQuery.documentFilter.tagGuids ?? [],
          tagExcludeGuids: initData.editQuery.documentFilter.tagExcludeGuids ?? [],
          folderGuids: initData.editQuery.documentFilter.folderGuids ?? []
        }
      : { sourceGuids: [], tagGuids: [], tagExcludeGuids: [], folderGuids: [] },
    codeCondition: (initData?.editQuery?.codeCondition ?? null) as CodeCondition | null
  }), [])
  const { dirty, baseline, setBaseline } = useToolDirtyState(currentConfig, initialBaseline, inTab)

  const handleDiscard = useCallback(() => {
    setDocFilter({
      sourceGuids: baseline.docFilter.sourceGuids,
      tagGuids: baseline.docFilter.tagGuids,
      tagExcludeGuids: baseline.docFilter.tagExcludeGuids,
      folderGuids: baseline.docFilter.folderGuids,
      typeInclude: [],
      typeExclude: [],
      // Restore the authored selector graph so Discard reverts to the
      // exact node structure (operators included) rather than letting the
      // DocumentSelector re-synthesise a lossy union from the flat arrays.
      graph: discardDocGraphRef.current
    })
    setDocFilterKey((k) => k + 1)
    setInitialCondition(baseline.codeCondition ?? undefined)
    setEditorRemountKey((k) => k + 1)
  }, [baseline])

  const applyInitData = useCallback((initData: QueryBuilderInitData) => {
    // Apply theme from main window
    const theme = (initData as any).theme
    if (theme !== undefined) {
      document.documentElement.setAttribute('data-theme', theme)
    }
    setData(initData)
    if (initData.editQuery) {
      // Editing a saved query or the current active (unsaved) query
      if (initData.editSavedQueryGuid) {
        setEditGuid(initData.editSavedQueryGuid)
      } else {
        setEditGuid(undefined)
      }
      setInitialCondition(initData.editQuery.codeCondition)
      if (initData.editGraphLayout) setInitialGraphLayout(initData.editGraphLayout)
      const df = initData.editQuery.documentFilter
      // Seed the Discard target with the loaded graph.
      discardDocGraphRef.current = df.graph
      setDocFilter({
        sourceGuids: df.sourceGuids ?? [],
        tagGuids: df.tagGuids ?? [],
        tagExcludeGuids: df.tagExcludeGuids ?? [],
        folderGuids: df.folderGuids ?? [],
        typeInclude: [],
        typeExclude: [],
        graph: df.graph
      })
      if (df.sourceGuids?.length || df.tagGuids?.length || df.tagExcludeGuids?.length || df.folderGuids?.length) setDocSectionOpen(true)
      setDocFilterKey((k) => k + 1)
      // Re-seat the dirty baseline from the freshly-arrived data.
      // Window mode populates this asynchronously via IPC; without
      // resetting here the baseline would still reflect the initial
      // empty render and every loaded-saved-query would read as dirty.
      setBaseline({
        docFilter: {
          sourceGuids: df.sourceGuids ?? [],
          tagGuids: df.tagGuids ?? [],
          tagExcludeGuids: df.tagExcludeGuids ?? [],
          folderGuids: df.folderGuids ?? []
        },
        codeCondition: initData.editQuery.codeCondition ?? null
      })
    } else {
      setEditGuid(undefined)
      setInitialCondition(undefined)
      setDocFilterKey((k) => k + 1)
      setBaseline({
        docFilter: { sourceGuids: [], tagGuids: [], tagExcludeGuids: [], folderGuids: [] },
        codeCondition: null
      })
    }
  }, [setBaseline])

  // Window mode: pull project data via IPC. Tab mode: host already
  // passed the data via the initData prop, so skip the IPC entirely.
  //
  // initData is provided by the inline tab host as a prop. Runs ONCE
  // on first non-null initData (guarded by initDataAppliedRef);
  // re-applying on every initData reference change would wipe
  // builder-owned state — most visibly the editGuid that
  // confirmNewQuerySave sets immediately after a save. Parents pass a
  // new initData reference whenever ats.setTitle / ats.setDirty bumps
  // the instance; that's a UI bookkeeping change, not a "load this
  // query" event, and must not trigger a re-init.
  const initDataAppliedRef = useRef(false)
  useEffect(() => {
    if (!initData) return
    if (initDataAppliedRef.current) return
    initDataAppliedRef.current = true
    applyInitData(initData)
  }, [applyInitData, initData])

  const handleConditionChange = useCallback(
    (condition: CodeCondition | null) => {
      setCodeCondition(condition)
    },
    []
  )

  const buildDocumentFilter = useCallback(() => ({
    sourceGuids: docFilter.sourceGuids.length > 0 ? docFilter.sourceGuids : undefined,
    tagGuids: docFilter.tagGuids.length > 0 ? docFilter.tagGuids : undefined,
    tagExcludeGuids: docFilter.tagExcludeGuids.length > 0 ? docFilter.tagExcludeGuids : undefined,
    folderGuids: docFilter.folderGuids.length > 0 ? docFilter.folderGuids : undefined,
    // Persist the authored selector graph so reopening rebuilds the exact
    // node structure (operators included) rather than re-synthesising a
    // lossy union from the resolved arrays above. The flat arrays remain
    // for the query engine and for legacy queries with no graph.
    graph: docFilter.graph
  }), [docFilter])

  // Send live preview to main window whenever query changes. The code
  // graph rides alongside so the main store's currentGraphLayout stays in
  // sync — "Edit current query" then reopens from the authored graph
  // rather than re-deriving (and re-expanding "And subcodes") from the
  // condition. The document graph already travels inside the query.
  useEffect(() => {
    if (!codeCondition) return
    const query: Query = {
      documentFilter: buildDocumentFilter(),
      codeCondition
    }
    window.api.sendPreviewToMain(query, currentGraph ?? undefined)
  }, [codeCondition, docFilter, buildDocumentFilter, currentGraph])

  const handleRun = () => {
    if (!codeCondition) return
    const query: Query = {
      documentFilter: buildDocumentFilter(),
      codeCondition
    }
    window.api.sendQueryToMain(query, editGuid, currentGraph ?? undefined)
  }

  const closeHost = () => {
    if (inTab) inTab.onClose()
    else window.close()
  }

  const handleClose = () => {
    // Close the host, keeping the current preview query active.
    closeHost()
  }

  // Confirm-save flow for a brand-new query (the Save Query dialog).
  // Mints a guid client-side so we can flip the builder's own editGuid
  // immediately — the title row's inline name suffix appears in the
  // same render rather than after a re-mount, matching the analysis
  // tools where the saved-name appears as soon as the user clicks
  // Save. The minted guid travels through the IPC roundtrip back into
  // the savedQueries store, and the builder's editGuid now points at
  // the same entry, so subsequent Update Query clicks hit the right
  // saved query.
  const confirmNewQuerySave = useCallback(() => {
    if (!saveQueryName.trim() || !codeCondition) return
    const trimmed = saveQueryName.trim()
    const query: Query = {
      documentFilter: buildDocumentFilter(),
      codeCondition
    }
    const newGuid = generateGuid()
    if (inTab) {
      // Tab mode: the builder shares the renderer (and the zustand
      // store) with the main app, so talk to the store directly.
      // The IPC roundtrip would let savedQueries lag behind editGuid
      // for one render — long enough that the editName lookup
      // (savedQueries.find by guid) returns undefined and the
      // title's editable suffix paints empty until the roundtrip
      // completes.
      const qs = useQueryStore.getState()
      qs.setComplexQuery(query, currentGraph ?? undefined)
      qs.saveCurrentQuery(trimmed, currentGraph ?? undefined, newGuid)
    } else {
      // Window mode (legacy popout has its own store instance) —
      // round-trip through main so the main-window store can apply
      // the save.
      window.api.sendSaveQueryToMain(query, trimmed, currentGraph ?? undefined, newGuid)
    }
    setShowSaveDialog(false)
    setBaseline({ docFilter: docFilterForCompare, codeCondition })
    // A save makes the current state the new Discard target, for both the
    // document graph and the code graph.
    discardDocGraphRef.current = query.documentFilter.graph
    setInitialGraphLayout(currentGraph ?? undefined)
    setEditGuid(newGuid)
    if (inTab) inTab.onSaved(trimmed, newGuid)
    else window.close()
  }, [saveQueryName, codeCondition, buildDocumentFilter, currentGraph, setBaseline, docFilterForCompare, inTab])

  // Register save with the TabBar's unsaved-changes dialog. For an
  // existing query (editGuid set) this fires Update Query
  // synchronously; for a brand-new query it pops the Save Query name
  // dialog and reports false so the dialog backs off.
  useRegisterToolSave(inTab?.tabId, () => {
    if (!codeCondition) return false
    if (editGuid) {
      handleRun()
      setBaseline({ docFilter: docFilterForCompare, codeCondition })
      // Re-seat the Discard targets to the just-saved state.
      discardDocGraphRef.current = buildDocumentFilter().graph
      setInitialGraphLayout(currentGraph ?? undefined)
      if (inTab) inTab.onSaved('')
      return true
    }
    const condName = codeCondition ? describeCondition(codeCondition, data?.codes ?? []) : ''
    const filterName = data ? describeDocFilter(buildDocumentFilter(), data.sources, data.tags) : ''
    setSaveQueryName(condName + filterName)
    setShowSaveDialog(true)
    return false
  })

  const hasDocFilters =
    docFilter.sourceGuids.length > 0 ||
    docFilter.folderGuids.length > 0 ||
    docFilter.tagGuids.length > 0 ||
    docFilter.typeInclude.length > 0

  if (!data) {
    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-muted)'
        }}
      >
        Loading project data...
      </div>
    )
  }

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}
    >
      {/* Title + action buttons */}
      <div
        style={{
          padding: '14px 20px 6px',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: 18,
            fontWeight: 600,
            color: 'var(--text-secondary)',
            display: 'flex',
            alignItems: 'center',
            gap: 8
          }}
        >
          <Icon icon={faMagnifyingGlass} className="analysis-header-icon" style={{ fontSize: 16 }} />
          Query{editGuid ? ':' : ''}
          {editGuid && <EditableTitleSuffix name={editName} onRename={handleRenameQuery} />}
        </h2>
        <div style={{ flex: 1 }} />
        <button className="secondary" style={{ fontSize: 11, padding: '4px 14px' }} onClick={handleClose}>
          Close
        </button>
        {editGuid && dirty && (
          <button className="secondary" style={{ fontSize: 11, padding: '4px 14px' }} onClick={handleDiscard}>
            Discard Changes
          </button>
        )}
        <button
          style={{ fontSize: 11, padding: '4px 14px' }}
          disabled={!codeCondition || (editGuid ? !dirty : false)}
          onClick={() => {
            if (editGuid) {
              handleRun()
              setBaseline({ docFilter: docFilterForCompare, codeCondition })
              if (inTab) inTab.onSaved('')
            } else {
              const condName = codeCondition
                ? describeCondition(codeCondition, data.codes)
                : ''
              const filterName = describeDocFilter(buildDocumentFilter(), data.sources, data.tags)
              setSaveQueryName(condName + filterName)
              setShowSaveDialog(true)
            }
          }}
        >
          {editGuid ? (dirty ? 'Update Query' : 'Saved') : 'Save Query'}
        </button>
        {/* Clearance for the floating MemoFab. */}
        <div style={{ width: 36, flexShrink: 0 }} />
      </div>

      {/* Main content — single scrollable column. Mirrors the layout
          the Analysis tools use so the MemoFab (rendered as an
          absolute-positioned overlay by InlineAnalysisTab) lands in
          the same place across both: it measures the scrollable
          descendant to compensate for any scrollbar gutter, and
          having the same nesting in both tools means the same gutter
          offset is applied. */}
      <div style={{ flex: 1, overflow: 'auto', padding: '14px 20px' }}>
            {/* ── Part 1: Search these documents (collapsible) ── */}
            <div className="analysis-section" style={{ marginBottom: 14 }}>
              <div
                onClick={() => setDocSectionOpen(!docSectionOpen)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: 'pointer',
                  userSelect: 'none'
                }}
              >
                <Icon icon={docSectionOpen ? faChevronDown : faChevronRight} style={{ fontSize: 10, color: 'var(--text-muted)' }} />
                <span
                  style={{
                    fontSize: 'var(--font-size-lg)',
                    fontWeight: 600,
                    color: 'var(--text-secondary)'
                  }}
                >
                  Select Documents
                </span>
                <span
                  style={{
                    fontSize: 11,
                    color: hasDocFilters
                      ? 'var(--status-success)'
                      : 'var(--text-muted)',
                    marginLeft: 'auto'
                  }}
                >
                  {hasDocFilters ? 'Filtered' : 'All documents'}
                </span>
              </div>

              {docSectionOpen && (
                <div style={{ marginTop: 10, minHeight: 200 }}>
                  <DocumentSelector
                    key={docFilterKey}
                    sources={data.sources}
                    tags={data.tags}
                    categories={data.categories}
                    folders={data.folders}
                    sourceFolder={data.sourceFolder}
                    tagMembers={data.tagMembers}
                    respondentTagMembers={data.respondentTagMembers}
                    questionTagMembers={data.questionTagMembers}
                    surveyEntityLabels={data.surveyEntityLabels}
                    filter={docFilter}
                    onChange={setDocFilter}
                  />
                </div>
              )}
            </div>

            {/* ── Part 2: For this content (node editor) ── */}
            <div className="analysis-section" style={{ marginBottom: 14 }}>
              <div
                style={{
                  fontSize: 'var(--font-size-lg)',
                  fontWeight: 600,
                  color: 'var(--text-secondary)',
                  marginBottom: 10
                }}
              >
                Select Content
              </div>

              <QueryNodeEditor
                key={editorRemountKey}
                onChange={handleConditionChange}
                onGraphChange={setCurrentGraph}
                initialCondition={initialCondition}
                initialGraphLayout={initialGraphLayout}
                codes={data.codes}
              />
            </div>
      </div>

      {/* Save query dialog */}
      {showSaveDialog && (
        <div
          className="modal-overlay"
          onClick={() => setShowSaveDialog(false)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Save Query</h2>
            <div style={{ marginBottom: 12 }}>
              <input
                type="text"
                value={saveQueryName}
                onChange={(e) => setSaveQueryName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmNewQuerySave()
                }}
                placeholder="Query name..."
                autoFocus
                style={{ width: '100%' }}
              />
            </div>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setShowSaveDialog(false)}>
                Cancel
              </button>
              <button onClick={confirmNewQuerySave}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
