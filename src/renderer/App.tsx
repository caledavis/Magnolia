import { useEffect, useCallback, useState, useRef } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { DocumentBrowser } from './components/DocumentBrowser/DocumentBrowser'
import { CodeBrowser, CodeEditDialog } from './components/CodeBrowser/CodeBrowser'
import { DocumentViewer } from './components/DocumentViewer/DocumentViewer'
import { QueryResultViewer } from './components/QueryResultViewer/QueryResultViewer'
import { SavedQueries } from './components/SavedQueries/SavedQueries'
import { SavedAnalyses } from './components/SavedAnalyses/SavedAnalyses'
import {
  Icon,
  faMagnifyingGlass,
  faBook,
  faNotebookPen,
  faTags
} from './components/Icon'
import { LicenceDialog } from './components/Licence/LicenceDialog'
import { UpdateDialog, type UpdateAvailableInfo } from './components/Update/UpdateDialog'
import { sourceTypeFromExtension } from './utils/format-registry'
import { parseSurveyGrid, type SurveyFormat } from './utils/survey/survey-parser'
import { parseCsv } from './utils/survey/csv-parser'
import { detectSurveyFormat } from './utils/survey/format-detect'
import { SurveyImportDialog } from './components/SurveyImportDialog'
import type { SurveyData, SurveyFormatData } from './models/types'
import type { CodebookInitData, QueryResultsInitData } from './models/types'

/** Human-readable tool names — used for the per-tool ad-hoc tab titles
 *  ("Code Frequencies (3)") and elsewhere. */
const ANALYSIS_TOOL_TITLES: Record<string, string> = {
  'code-cooccurrences': 'Code Co-Occurrences',
  'codes-in-documents': 'Codes in Documents',
  'results-in-documents': 'Results in Documents',
  'code-frequencies': 'Code Frequencies',
  'code-orders': 'Code Orders',
  'word-frequencies': 'Word Frequencies'
}

/** Flatten a code tree, tagging each code with its parent guid */
function flattenCodesWithParent(
  codes: Code[],
  parentGuid?: string
): { guid: string; name: string; color?: string; isCodable: boolean; parentGuid?: string }[] {
  const result: { guid: string; name: string; color?: string; isCodable: boolean; parentGuid?: string }[] = []
  for (const c of codes) {
    result.push({ guid: c.guid, name: c.name, color: c.color, isCodable: c.isCodable, parentGuid })
    result.push(...flattenCodesWithParent(c.children, c.guid))
  }
  return result
}
import { useProjectStore } from './stores/project-store'
import { useDocumentStore, surveyEntityKey } from './stores/document-store'
import { useCodeStore } from './stores/code-store'
import { useTagStore } from './stores/tag-store'
import { useQueryStore } from './stores/query-store'
import { useUndoStore } from './stores/undo-store'
import { useLogbookStore } from './stores/logbook-store'
import { useMemoStore } from './stores/memo-store'
import { useQuoteStore } from './stores/quote-store'
import { useRelationshipMapStore } from './stores/relationship-map-store'
import { useSurveyViewStore } from './stores/survey-view-store'
import { useAnalysisTabsStore } from './stores/analysis-tabs-store'
import { isAnalysisTab, isMapTab, isQueryBuilderTab, makeAnalysisTabId, makeMapTabId, makeQueryBuilderTabId, mapGuidFromTabId, parseAnalysisTabId, PREFERENCES_TAB_ID } from './utils/tab-ids'
import type { PersistedTab, PersistedTabState } from './models/types'
// ES import so Vite bundles + hashes the Magnolia wordmark for production.
import magnoliaUrl from './assets/magnolia.svg'
import { usePendingSelectionStore } from './stores/pending-selection-store'
import { useNewCodeTriggerStore } from './stores/new-code-trigger-store'
import { generateGuid } from './utils/guid'
import { ProjectDetailsDialog } from './components/ProjectDetails/ProjectDetailsDialog'
import { FindDialog } from './components/Find/FindDialog'
import { MemosPane } from './components/Memos/MemosPane'
import { QuotesPane } from './components/Quotes/QuotesPane'
import { AnalysisPopover } from './components/Toolbar/AnalysisPopover'
import { StudioPopover } from './components/Toolbar/StudioPopover'
import { WindowControls } from './components/Toolbar/WindowControls'
import type { Project, Query, CodeCondition, Code, TextSource, QDASet, LogbookInitData, AnalysisInitData, AnalysisToolType, PlainTextSelection, Memo, MemoEditInitData } from './models/types'

function describeCondition(cond: CodeCondition, findCode: (guid: string) => Code | undefined, depth?: number): string {
  const d = depth ?? 0
  const codeName = (guid: string) => findCode(guid)?.name ?? 'Code'
  switch (cond.type) {
    case 'code':
      return codeName(cond.codeGuid) + (cond.includeSubcodes ? ' (incl. subcodes)' : '')
    case 'text':
      return cond.searchText ? `"${cond.searchText}"` : 'Text'
    case 'and':
      return cond.conditions.map((c) => describeCondition(c, findCode, d + 1)).join(' AND ')
    case 'or':
      return cond.conditions.map((c) => describeCondition(c, findCode, d + 1)).join(' OR ')
    case 'xor':
      return cond.conditions.map((c) => describeCondition(c, findCode, d + 1)).join(' XOR ')
    case 'not':
      return 'NOT ' + describeCondition(cond.condition, findCode, d + 1)
    case 'overlap':
      return `(${describeCondition(cond.condition1, findCode, d + 1)}) overlapping (${describeCondition(cond.condition2, findCode, d + 1)})`
    case 'inside':
      return `(${describeCondition(cond.condition1, findCode, d + 1)}) inside (${describeCondition(cond.condition2, findCode, d + 1)})`
    case 'outside':
      return `(${describeCondition(cond.condition1, findCode, d + 1)}) outside (${describeCondition(cond.condition2, findCode, d + 1)})`
    case 'before':
      return `(${describeCondition(cond.condition1, findCode, d + 1)}) before (${describeCondition(cond.condition2, findCode, d + 1)})`
    case 'followedBy':
      return `(${describeCondition(cond.condition1, findCode, d + 1)}) followed by (${describeCondition(cond.condition2, findCode, d + 1)})`
    default:
      return 'Query'
  }
}

function describeQuery(
  query: Query,
  findCode: (guid: string) => Code | undefined,
  sources: TextSource[],
  tags: QDASet[]
): string {
  let name = describeCondition(query.codeCondition, findCode)
  const df = query.documentFilter
  const parts: string[] = []
  if (df.sourceGuids && df.sourceGuids.length > 0) {
    const names = df.sourceGuids
      .map((g) => sources.find((s) => s.guid === g)?.name)
      .filter(Boolean) as string[]
    if (names.length > 0) parts.push(names.length <= 2 ? names.join(', ') : `${names.length} docs`)
  }
  if (df.tagGuids && df.tagGuids.length > 0) {
    const tagNames = df.tagGuids
      .map((g) => tags.find((tg) => tg.guid === g)?.name)
      .filter(Boolean) as string[]
    if (tagNames.length > 0) parts.push(tagNames.join(', '))
  }
  if (df.tagExcludeGuids && df.tagExcludeGuids.length > 0) {
    const excludeNames = df.tagExcludeGuids
      .map((g) => tags.find((tg) => tg.guid === g)?.name)
      .filter(Boolean) as string[]
    if (excludeNames.length > 0) parts.push('NOT ' + excludeNames.join(', '))
  }
  if (parts.length > 0) name += ' IN ' + parts.join(', ')
  return name
}

function App() {
  const [showNewCodeDialog, setShowNewCodeDialog] = useState(false)
  const [pendingCodeAllNewCode, setPendingCodeAllNewCode] = useState(false)
  const [showManageDocTags, setShowManageDocTags] = useState(false)
  // Surveys imported via CSV are queued here so the user can preview /
  // adjust column types one at a time. The queue lets a multi-file
  // import (e.g. dropping three CSVs) walk through each survey
  // sequentially without losing the others. `folderGuid` carries the
  // drop target so the survey lands in the right folder on confirm.
  const [surveyImportQueue, setSurveyImportQueue] = useState<
    {
      csv: string
      suggestedName: string
      parsed: SurveyData
      detectedFormat: SurveyFormat
      detectionConfident: boolean
      folderGuid?: string
    }[]
  >([])

  /** Parse a CSV into a SurveyData and append to the preview queue.
   *  Auto-detects SurveyMonkey vs Microsoft Forms vs generic; the
   *  detected format and confidence flag travel with the queue entry
   *  so the dialog can show "Detected as …" and let the user override
   *  if the detection was a guess. Errors surface as an alert; the
   *  file is skipped on failure. */
  const queueSurveyImport = useCallback(
    (csv: string, suggestedName: string, folderGuid?: string) => {
      try {
        const grid = parseCsv(csv)
        const { format, confident } = detectSurveyFormat(grid)
        const parsed = parseSurveyGrid(grid, suggestedName, format)
        setSurveyImportQueue((prev) => [
          ...prev,
          {
            csv,
            suggestedName,
            parsed,
            detectedFormat: format,
            detectionConfident: confident,
            folderGuid
          }
        ])
      } catch (err: any) {
        window.alert(`Could not parse ${suggestedName}:\n\n${err?.message || String(err)}`)
      }
    },
    []
  )
  const [showProjectDetails, setShowProjectDetails] = useState(false)
  const [showLicenceDialog, setShowLicenceDialog] = useState(false)
  const [loadProgress, setLoadProgress] = useState<{ stage: string; current: number; total: number } | null>(null)
  const [updateInfo, setUpdateInfo] = useState<UpdateAvailableInfo | null>(null)

  useEffect(() => {
    return window.api.onProjectLoadProgress((p) => setLoadProgress(p))
  }, [])

  useEffect(() => {
    return window.api.onUpdateAvailable(setUpdateInfo)
  }, [])
  const [showSaveQueryDialog, setShowSaveQueryDialog] = useState(false)
  const [showFindDialog, setShowFindDialog] = useState(false)
  const [saveQueryName, setSaveQueryName] = useState('')
  const [pulsedQueryGuid, setPulsedQueryGuid] = useState<string | null>(null)
  const [queryResultsPoppedOut, setQueryResultsPoppedOut] = useState(false)
  const [queryResultsClosed, setQueryResultsClosed] = useState(false)
  const queryResultsHidden = queryResultsPoppedOut || queryResultsClosed
  const [panelVisibility, setPanelVisibility] = useState({
    documents: true,
    codes: true,
    memos: true,
    quotes: true,
    analyses: true,
  })
  type PanelId = keyof typeof panelVisibility
  const closePanel = useCallback((id: PanelId) => {
    setPanelVisibility((prev) => ({ ...prev, [id]: false }))
  }, [])
  const togglePanel = useCallback((id: PanelId) => {
    setPanelVisibility((prev) => ({ ...prev, [id]: !prev[id] }))
  }, [])
  const leftHasVisiblePanels = panelVisibility.documents || panelVisibility.codes
  const rightHasVisiblePanels = panelVisibility.memos || panelVisibility.quotes || panelVisibility.analyses
  const [activePanel, setActivePanel] = useState<'documents' | 'codes' | 'viewer' | 'queries' | null>(null)
  const activePanelRef = useRef(activePanel)
  activePanelRef.current = activePanel

  const projectStore = useProjectStore()
  const documentStore = useDocumentStore()
  const codeStore = useCodeStore()
  const tagStore = useTagStore()
  const queryStore = useQueryStore()
  const logbookStore = useLogbookStore()
  const memoStore = useMemoStore()

  const openCodebook = useCallback(() => {
    const initData: CodebookInitData = {
      codes: codeStore.codes,
      theme: document.documentElement.getAttribute('data-theme') || ''
    }
    window.api.openCodebookWindow(initData)
  }, [codeStore.codes])

  const openLogbook = useCallback(() => {
    const initData: LogbookInitData = {
      entries: logbookStore.entries,
      theme: document.documentElement.getAttribute('data-theme') || ''
    }
    window.api.openLogbookWindow(initData)
  }, [logbookStore.entries])

  const openAnalysis = useCallback((toolType: AnalysisToolType) => {
    // Relationship Maps open as a tab in the Document Viewer instead of a
    // separate window. The user pops it out from there if they want it
    // floating.
    if (toolType === 'relationship-map') {
      const mapGuid = useRelationshipMapStore.getState().createNewMap()
      useDocumentStore.getState().openToolTab(makeMapTabId(mapGuid))
      return
    }

    // The six analysis tools all open as tabs too. Each click of "open
    // <tool>" creates a fresh ad-hoc tab numbered "<Tool> (n)"; saved
    // analyses go through openSavedAnalysis below and reuse a shared id.
    const ats = useAnalysisTabsStore.getState()
    const ds = useDocumentStore.getState()
    const instanceId = generateGuid()
    const tabId = makeAnalysisTabId(toolType, instanceId)
    const counter = ats.nextCounter(toolType)
    const title = `${ANALYSIS_TOOL_TITLES[toolType] ?? 'Analysis'} (${counter})`
    ats.add(tabId, {
      toolType: toolType as any,
      title,
      config: undefined,
      poppedOut: false
    })
    ds.openToolTab(tabId)
  }, [])

  const openSavedAnalysis = useCallback((toolType: AnalysisToolType, savedConfig: any) => {
    // Saved relationship maps open as a tab.
    if (toolType === 'relationship-map') {
      const guid = savedConfig?.guid
      const name = savedConfig?.name ?? 'Relationship Map'
      if (guid) {
        const rmStore = useRelationshipMapStore.getState()
        rmStore.loadSavedMap(guid, name, {
          elements: savedConfig.elements ?? [],
          freeTexts: savedConfig.freeTexts ?? [],
          connections: savedConfig.connections ?? [],
          pan: savedConfig.pan ?? { x: 0, y: 0 }
        })
        useDocumentStore.getState().openToolTab(makeMapTabId(guid))
      }
      return
    }

    // Saved analyses for the six other tools: enforce one tab per saved
    // analysis. We search instances by savedAnalysisGuid (not by tab id)
    // because an ad-hoc tab that the user just saved keeps its original
    // tab id but acquires a savedAnalysisGuid stamp — we want the same
    // tab to be focused if the user clicks the saved analysis again.
    const savedGuid = savedConfig?.guid
    if (!savedGuid) return
    const ats = useAnalysisTabsStore.getState()
    const ds = useDocumentStore.getState()
    const existingTabId = Object.entries(ats.instances)
      .find(([, inst]) => inst.savedAnalysisGuid === savedGuid && inst.toolType === toolType)?.[0]
    if (existingTabId && ds.openTabs.includes(existingTabId)) {
      ds.openToolTab(existingTabId)
      return
    }
    // Fresh open: tab id encodes the saved guid for stability across
    // project save → reload.
    const tabId = makeAnalysisTabId(toolType, savedGuid)
    ats.add(tabId, {
      toolType: toolType as any,
      savedAnalysisGuid: savedGuid,
      title: savedConfig?.name ?? 'Analysis',
      config: savedConfig,
      poppedOut: false
    })
    ds.openToolTab(tabId)
  }, [])

  const popOutQueryResults = useCallback(() => {
    const qs = useQueryStore.getState()
    const theme = document.documentElement.getAttribute('data-theme') || ''
    const qName = qs.isActive && qs.currentQuery
      ? (() => {
          const saved = qs.savedQueries.find(
            (sq) => JSON.stringify(sq.query) === JSON.stringify(qs.currentQuery)
          )
          return saved
            ? saved.name
            : describeQuery(qs.currentQuery!, codeStore.findCode, documentStore.sources, tagStore.tags)
        })()
      : ''
    const isUnsaved = qs.isActive && qs.currentQuery
      ? !qs.savedQueries.some((sq) => JSON.stringify(sq.query) === JSON.stringify(qs.currentQuery))
      : false
    // Build source selections map for showing other codes in results
    const docStore = useDocumentStore.getState()
    const cdStore = useCodeStore.getState()
    const sourceSelections: Record<string, any[]> = {}
    const pdfFilePaths: Record<string, string> = {}
    const videoFilePaths: Record<string, string> = {}
    const videoMimeTypes: Record<string, string> = {}
    const surveysByGuid: Record<string, SurveyData> = {}
    for (const src of docStore.sources) {
      if (src.selections.length > 0) sourceSelections[src.guid] = src.selections
      const fp = (src as any).formatData?.pdfFilePath ?? (src as any).formatData?.imageFilePath
      if (fp) pdfFilePaths[src.guid] = fp
      const vp = (src as any).formatData?.videoFilePath
      if (vp) {
        videoFilePaths[src.guid] = vp
        videoMimeTypes[src.guid] = (src as any).formatData?.mimeType || 'video/mp4'
      }
      if (src.sourceType === 'survey') {
        const survey = (src.formatData as SurveyFormatData | undefined)?.survey
        if (survey) surveysByGuid[src.guid] = survey
      }
    }
    const codes = cdStore.flatCodes().map((c) => ({ guid: c.guid, name: c.name, color: c.color }))

    const initData: QueryResultsInitData = {
      results: qs.results,
      queryName: qName,
      isActive: qs.isActive,
      isUnsaved,
      theme,
      sourceSelections,
      surveysByGuid,
      pdfFilePaths,
      videoFilePaths,
      videoMimeTypes,
      codes,
      savedQueries: qs.savedQueries,
      currentQuery: qs.currentQuery ?? undefined
    }
    window.api.openQueryResultsWindow(initData)
    setQueryResultsPoppedOut(true)
  }, [codeStore.findCode, documentStore.sources, tagStore.tags])

  const collectProject = useCallback((): Project => {
    const ats = useAnalysisTabsStore.getState()
    const ds = useDocumentStore.getState()
    const persistedTabs: PersistedTab[] = ds.openTabs.map((id): PersistedTab => {
      if (isMapTab(id)) {
        return { id, kind: 'map', mapGuid: mapGuidFromTabId(id) ?? '' }
      }
      if (isAnalysisTab(id)) {
        const parsed = parseAnalysisTabId(id)
        const inst = ats.instances[id]
        return {
          id,
          kind: 'analysis',
          toolType: parsed?.toolType ?? inst?.toolType ?? '',
          title: inst?.title ?? '',
          savedAnalysisGuid: inst?.savedAnalysisGuid,
          // Only persist adhocConfig for unsaved tabs — saved-analysis-backed
          // tabs read their config from project.savedAnalyses on rehydrate.
          adhocConfig: inst?.savedAnalysisGuid ? undefined : inst?.config
        }
      }
      if (isQueryBuilderTab(id)) {
        const inst = ats.instances[id]
        return {
          id,
          kind: 'query-builder',
          title: inst?.title ?? '',
          adhocConfig: inst?.config
        }
      }
      return { id, kind: 'document' }
    })
    const tabState: PersistedTabState = {
      openTabs: persistedTabs,
      activeTabId: ds.viewedDocumentGuid,
      perToolCounters: ats.perToolCounters
    }
    return {
      name: projectStore.name,
      origin: projectStore.origin,
      creatingUserGUID: projectStore.creatingUserGUID,
      creationDateTime: projectStore.creationDateTime,
      modifyingUserGUID: projectStore.modifyingUserGUID,
      modifiedDateTime: projectStore.modifiedDateTime,
      users: projectStore.users,
      codes: codeStore.codes,
      sources: documentStore.sources,
      sets: tagStore.tags,
      notes: [],
      tagCategories: tagStore.categories,
      savedQueries: queryStore.savedQueries,
      logbookEntries: logbookStore.entries,
      memos: memoStore.memos,
      quotes: useQuoteStore.getState().quotes,
      savedAnalyses: projectStore.savedAnalyses,
      folders: documentStore.folders,
      sourceFolder: documentStore.sourceFolder,
      tabState
    }
  }, [projectStore, documentStore, codeStore, tagStore, queryStore, logbookStore, memoStore])

  // Suppress the post-load auto-save burst: declared here so every load
  // path (dialog open, recent-project, drag-drop, etc) can set it. The
  // auto-save effect further down checks the ref before scheduling.
  const loadInProgressRef = useRef(false)

  // Pending-autosave cancellation handle. Declared above the load handlers
  // so they can null any in-flight 2-second autosave timer the moment a
  // load starts — otherwise a timer scheduled at T-1.5s would fire mid-load
  // and try to save a half-populated payload. The autosave effect itself
  // owns scheduling; we only own cancellation here.
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelPendingAutoSave = useCallback(() => {
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current)
      autoSaveTimer.current = null
    }
  }, [])

  // Lift the load-in-progress suppression only after React has flushed the
  // final store-set steps and the browser has painted past them. A double
  // requestAnimationFrame is a deliberate barrier: rAF #1 runs after the
  // current render commits, rAF #2 runs after the browser paints, so any
  // autosave that re-evaluates after the lift reads the loaded project
  // state, never mid-load state. The previous fixed 500 ms timeout could
  // expire before slow setSources finished on large projects.
  const liftLoadSuppression = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        loadInProgressRef.current = false
      })
    })
  }, [])

  /** Rehydrate persisted Document Viewer tabs at project load. Runs after
   *  every per-store setX step so we can validate ids against fresh store
   *  state. Tool tabs that no longer have a backing record (e.g. a saved
   *  analysis was deleted before the project was last saved) are silently
   *  filtered out so we never strand orphan tab ids. */
  const restoreTabState = useCallback((tabState: PersistedTabState | undefined) => {
    if (!tabState) return
    const ats = useAnalysisTabsStore.getState()
    const ds = useDocumentStore.getState()
    const rms = useRelationshipMapStore.getState()
    const validToolTabIds = new Set<string>()
    const newInstances: Record<string, import('./stores/analysis-tabs-store').AnalysisTabInstance> = {}
    for (const t of tabState.openTabs ?? []) {
      if (t.kind === 'document') continue
      if (t.kind === 'map') {
        // Maps are restored via the relationship-map-store. Only keep the
        // tab if the underlying map record is in the store (loaded earlier
        // by saved-analyses rehydration paths).
        if (rms.maps[t.mapGuid]) validToolTabIds.add(t.id)
        continue
      }
      if (t.kind === 'analysis') {
        const inst: import('./stores/analysis-tabs-store').AnalysisTabInstance = {
          toolType: t.toolType as any,
          savedAnalysisGuid: t.savedAnalysisGuid,
          title: t.title,
          config: t.adhocConfig,
          poppedOut: false
        }
        newInstances[t.id] = inst
        validToolTabIds.add(t.id)
        continue
      }
      if (t.kind === 'query-builder') {
        const inst: import('./stores/analysis-tabs-store').AnalysisTabInstance = {
          toolType: 'query-builder',
          title: t.title,
          config: t.adhocConfig,
          poppedOut: false
        }
        newInstances[t.id] = inst
        validToolTabIds.add(t.id)
        continue
      }
    }
    ats.hydrate(newInstances, tabState.perToolCounters ?? {})
    ds.restoreTabs(
      (tabState.openTabs ?? []).map((t) => t.id),
      tabState.activeTabId,
      validToolTabIds
    )
  }, [])

  const handleNewProject = useCallback(async () => {
    // Prompt for the file location before touching any in-memory state.
    // If the user cancels, the current project is left exactly as-is.
    // The main process writes an empty .qdpx at the chosen path so the
    // file exists on disk from the moment the user starts working.
    const created = await window.api.createNewProjectFile()
    if (!created) return
    const { filePath, projectName } = created
    // Hidden flush of the outgoing project before we tear down its state.
    // Skipped if there's nothing to save or if the user happened to pick
    // the same path (in which case the empty file we just wrote IS the
    // outgoing project — nothing to preserve).
    const outgoingPath = projectStore.filePath
    if (projectStore.isDirty && outgoingPath && outgoingPath !== filePath) {
      try {
        await window.api.saveProject({
          project: collectProject(),
          sourceContents: documentStore.sourceContents,
          filePath: outgoingPath
        })
      } catch (err) {
        console.error('Pre-new-project flush failed:', err)
      }
    }
    cancelPendingAutoSave()
    documentStore.clearAll()
    codeStore.clearAll()
    tagStore.clearAll()
    queryStore.clearAll()
    logbookStore.clearAll()
    memoStore.clearAll()
    useQuoteStore.getState().clearAll()
    useRelationshipMapStore.getState().clearAll()
    useAnalysisTabsStore.getState().clearAll()
    const userGuid = generateGuid()
    projectStore.loadProject({
      name: projectName,
      origin: `Magnolia ${__APP_VERSION__}`,
      users: [{ guid: userGuid, name: 'User' }],
      creatingUserGUID: userGuid,
      creationDateTime: new Date().toISOString(),
      filePath,
      savedAnalyses: []
    })
    window.api.trackRecentProject(projectName, filePath)
  }, [projectStore, documentStore, codeStore, tagStore, queryStore, logbookStore, memoStore, collectProject, cancelPendingAutoSave])

  const handleOpenProject = useCallback(async () => {
    // Show the native file picker FIRST, before flipping any loading
    // state, so the picker appears immediately on click. Previously
    // setLoadProgress fired before the picker IPC, so the loading
    // overlay rendered first and the picker came up behind / on top —
    // making it feel like Magnolia stalled before the picker even
    // opened.
    const filePath = await window.api.pickProjectFile()
    if (!filePath) return
    loadInProgressRef.current = true
    cancelPendingAutoSave()
    setLoadProgress({ stage: 'Opening project…', current: 0, total: 0 })
    try {
      const data = await window.api.openProjectPath(filePath)
      if (!data) return
      // Drop any in-memory state from the previous project that wouldn't
      // otherwise get cleared by the per-store setX steps below. We do
      // NOT clearAll on documentStore here: that would leave sources=[]
      // while projectStore.filePath still points at the old project,
      // and any pending 2-second autosave timer would then write a
      // partial-empty payload to disk. Clearing only the leftover map
      // tabs is enough to fix the cross-project map-tab leak.
      documentStore.closeAllToolTabs()
      documentStore.closeAllToolTabs()
      useRelationshipMapStore.getState().clearAll()
      useAnalysisTabsStore.getState().clearAll()
      const { sourceContents, ...project } = data
      const steps: { label: string; run: () => void }[] = [
        {
          label: 'Project metadata',
          run: () =>
            projectStore.loadProject({
              name: project.name,
              origin: project.origin,
              users: project.users,
              creatingUserGUID: project.creatingUserGUID,
              creationDateTime: project.creationDateTime,
              modifyingUserGUID: project.modifyingUserGUID,
              modifiedDateTime: project.modifiedDateTime,
              filePath: (data as any).filePath,
              savedAnalyses: project.savedAnalyses
            })
        },
        { label: 'Documents', run: () => documentStore.setSources(project.sources, sourceContents) },
        { label: 'Folders', run: () => documentStore.setFolders((project as any).folders ?? [], (project as any).sourceFolder ?? {}) },
        { label: 'Codes', run: () => codeStore.setCodes(project.codes) },
        {
          label: 'Tags',
          run: () => {
            tagStore.setTags(project.sets)
            tagStore.setCategories(project.tagCategories ?? [])
          }
        },
        {
          label: 'Queries',
          run: () => {
            queryStore.clearQuery()
            queryStore.setSavedQueries(project.savedQueries ?? [])
          }
        },
        { label: 'Logbook', run: () => logbookStore.setEntries(project.logbookEntries ?? []) },
        { label: 'Memos', run: () => memoStore.setMemos(project.memos ?? []) },
        { label: 'Quotes', run: () => useQuoteStore.getState().setQuotes(project.quotes ?? []) },
        // Tabs runs LAST so it can validate ids against every store
        // populated above (sources, savedAnalyses, etc.).
        { label: 'Tabs', run: () => restoreTabState((project as any).tabState) }
      ]
      for (let i = 0; i < steps.length; i++) {
        setLoadProgress({ stage: `Populating ${steps[i].label}`, current: i + 1, total: steps.length })
        // Yield so React paints the progress bar update and browser repaints
        // before the synchronous store-set triggers a heavy re-render.
        await new Promise((r) => setTimeout(r, 0))
        steps[i].run()
      }
      // A freshly loaded project matches the file on disk, so it is NOT
      // dirty. The per-store setX steps above each flip isDirty; clear it
      // here so the post-load autosave doesn't fire and rewrite the whole
      // archive for a file the user only opened. That needless full-file
      // write is what got interrupted and truncated the project. Genuine
      // edits after this re-dirty it normally.
      useProjectStore.getState().markClean()
      if ((data as any).filePath) {
        window.api.trackRecentProject(project.name, (data as any).filePath)
      }
    } finally {
      setLoadProgress(null)
      liftLoadSuppression()
    }
  }, [projectStore, documentStore, codeStore, tagStore, queryStore, logbookStore, memoStore, cancelPendingAutoSave, liftLoadSuppression, restoreTabState])

  // Returns true if the project payload has no user-authored content at
  // all. Used by the save guard to refuse overwriting a real project file
  // with a wiped-state payload (e.g. after an HMR store reset).
  const isProjectPayloadEmpty = useCallback((p: Project): boolean => {
    return (
      !p.sources?.length &&
      !p.codes?.length &&
      !p.sets?.length &&
      !(p.savedQueries?.length) &&
      !(p.memos?.length) &&
      !(p.quotes?.length) &&
      !(p.savedAnalyses?.length)
    )
  }, [])

  // Ref tracking the most recent time we saw the project populated. Used
  // to decide whether "stores look empty" is suspicious. If we ever had
  // data in this session, treat empty-stores-at-save as a bug.
  const everHadDataRef = useRef(false)
  useEffect(() => {
    if (!isProjectPayloadEmpty(collectProject())) everHadDataRef.current = true
  }, [collectProject, isProjectPayloadEmpty])

  const handleSaveProject = useCallback(async () => {
    // Skip saves while a project open is in progress. A 2-second autosave
    // timer scheduled before the user clicked Open Recent can otherwise
    // fire mid-load, when one store has been reset for the incoming
    // project but others still hold the previous one — producing a
    // partial-empty payload that the all-empty guards below don't catch.
    if (loadInProgressRef.current) {
      console.warn('[save-project guard] skipping save during project load')
      return
    }
    const project = collectProject()
    // Renderer-side safety guard: refuse to overwrite an existing file on
    // disk with an all-empty payload when we've previously seen data in
    // this session. The main process has a last-resort guard too.
    if (isProjectPayloadEmpty(project) && projectStore.filePath && everHadDataRef.current) {
      console.warn(
        '[save-project guard] refusing to save an empty project over',
        projectStore.filePath
      )
      return
    }
    const result = await window.api.saveProject({
      project,
      sourceContents: documentStore.sourceContents,
      filePath: projectStore.filePath ?? undefined
    })
    if (result && typeof result === 'object' && (result as any).guardBlocked) {
      console.warn('[save-project guard]', (result as any).message)
      return
    }
    if (typeof result === 'string') {
      projectStore.setFilePath(result)
      projectStore.markClean()
      window.api.trackRecentProject(projectStore.name, result)
    }
  }, [collectProject, documentStore, projectStore, isProjectPayloadEmpty])

  const handleSaveProjectAs = useCallback(async () => {
    const project = collectProject()
    const result = await window.api.saveProjectAs({
      project,
      sourceContents: documentStore.sourceContents
    })
    if (result && typeof result === 'object' && (result as any).guardBlocked) {
      console.warn('[save-project-as guard]', (result as any).message)
      return
    }
    if (typeof result === 'string') {
      projectStore.setFilePath(result)
      projectStore.markClean()
      window.api.trackRecentProject(projectStore.name, result)
    }
  }, [collectProject, documentStore, projectStore])

  // Suppress the post-load auto-save burst: while a project open is in
  // progress, or for a short grace period after it completes, skip the
  // 2-second auto-save. Prevents any transient isDirty flicker during
  // load from writing mid-populated state back to disk. The autoSaveTimer
  // ref is declared above (next to cancelPendingAutoSave) so load handlers
  // can null in-flight timers the moment a load starts.
  useEffect(() => {
    if (loadInProgressRef.current) return
    if (projectStore.isDirty && projectStore.filePath) {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
      autoSaveTimer.current = setTimeout(() => {
        autoSaveTimer.current = null
        handleSaveProject()
      }, 2000)
    }
    return () => {
      if (autoSaveTimer.current) {
        clearTimeout(autoSaveTimer.current)
        autoSaveTimer.current = null
      }
    }
  }, [projectStore.isDirty, projectStore.filePath, handleSaveProject])

  // Hold the latest handleSaveProject in a ref so callbacks registered
  // via useEffect (which run once) can still invoke it against the
  // current closure — used for event-driven flushes like memo Save&Close.
  const saveProjectRef = useRef(handleSaveProject)
  useEffect(() => { saveProjectRef.current = handleSaveProject }, [handleSaveProject])

  // Drop files anywhere over the main window → import. The Document
  // Browser keeps its own drop handlers (which call stopPropagation),
  // so folder-targeted drops still land in the right folder; this is
  // the fallback for drops on any other pane / the canvas. Mirrors
  // DocumentBrowser.tsx's handleFileDrop so both paths route csv/xlsx
  // through the survey-import preview dialog and all other formats
  // through documentStore.addSource.
  const handleOSFileDrop = useCallback(async (filePaths: string[]) => {
    const files = await window.api.readTextFiles(filePaths)
    if (!files) return
    const errors: string[] = []
    for (const f of files) {
      if ((f as any).error) {
        errors.push(`${f.name}: ${(f as any).error}`)
        continue
      }
      const ext = (f as any).extension || f.name.split('.').pop()?.toLowerCase() || ''
      if (ext === 'csv' || ext === 'xlsx') {
        const suggestedName = f.name.replace(/\.(csv|xlsx)$/i, '')
        queueSurveyImport(f.content, suggestedName)
        continue
      }
      const sourceType = sourceTypeFromExtension(ext)
      const formatting = (f as any).formatting
      documentStore.addSource(f.name, f.content, sourceType !== 'text' ? sourceType : undefined, formatting)
    }
    if (errors.length > 0) {
      window.alert(`Could not import ${errors.length} file${errors.length > 1 ? 's' : ''}:\n\n${errors.join('\n')}`)
    }
  }, [documentStore, queueSurveyImport])

  const handleImportDocument = useCallback(async () => {
    const files = await window.api.importTextFile()
    if (!files) return
    const fileArray = Array.isArray(files) ? files : [files]
    const errors: string[] = []
    for (const file of fileArray) {
      if ((file as any).error) {
        errors.push(`${file.name}: ${(file as any).error}`)
        continue
      }
      const ext = (file as any).extension || file.name.split('.').pop()?.toLowerCase() || ''
      // CSV / XLSX → defer to the survey-import preview dialog
      // (queueSurveyImport handles parse errors itself). XLSX files
      // are converted to CSV text in the main process so the same
      // pipeline handles both. All other formats land directly.
      if (ext === 'csv' || ext === 'xlsx') {
        const suggestedName = file.name.replace(/\.(csv|xlsx)$/i, '')
        queueSurveyImport(file.content, suggestedName)
        continue
      }
      const sourceType = sourceTypeFromExtension(ext)
      const formatting = (file as any).formatting
      documentStore.addSource(file.name, file.content, sourceType !== 'text' ? sourceType : undefined, formatting)
    }
    if (errors.length > 0) {
      window.alert(`Could not import ${errors.length} file${errors.length > 1 ? 's' : ''}:\n\n${errors.join('\n')}`)
    }
  }, [documentStore, queueSurveyImport])

  const openQueryBuilder = useCallback((editSavedQueryGuid?: string, editCurrentQuery?: boolean) => {
    // Editing a saved query enforces one tab per saved query (and
    // editing the ad-hoc current query enforces one tab too): focus
    // the existing tab if open. Only the "+ Query Builder" launch with
    // neither flag set ever spawns a fresh ad-hoc tab.
    const ats = useAnalysisTabsStore.getState()
    const ds = useDocumentStore.getState()
    if (editSavedQueryGuid) {
      const existing = Object.entries(ats.instances).find(
        ([, inst]) => inst.toolType === 'query-builder' && inst.savedAnalysisGuid === editSavedQueryGuid
      )?.[0]
      if (existing && ds.openTabs.includes(existing)) {
        ds.openToolTab(existing)
        return
      }
      const tabId = makeQueryBuilderTabId(editSavedQueryGuid)
      const sq = queryStore.savedQueries.find((q) => q.guid === editSavedQueryGuid)
      ats.add(tabId, {
        toolType: 'query-builder',
        savedAnalysisGuid: editSavedQueryGuid,
        title: sq?.name ?? 'Query Builder',
        config: { editSavedQueryGuid },
        poppedOut: false
      })
      ds.openToolTab(tabId)
      return
    }
    if (editCurrentQuery) {
      const existing = Object.entries(ats.instances).find(
        ([, inst]) => inst.toolType === 'query-builder' && inst.config?.editCurrentQuery === true
      )?.[0]
      if (existing && ds.openTabs.includes(existing)) {
        ds.openToolTab(existing)
        return
      }
    }
    const instanceId = generateGuid()
    const tabId = makeQueryBuilderTabId(instanceId)
    const counter = ats.nextCounter('query-builder')
    ats.add(tabId, {
      toolType: 'query-builder',
      title: `Query Builder (${counter})`,
      config: editCurrentQuery ? { editCurrentQuery: true } : undefined,
      poppedOut: false
    })
    ds.openToolTab(tabId)
  }, [queryStore])

  const handleNewCode = useCallback(() => {
    setShowNewCodeDialog(true)
  }, [])

  // ── Memos for saved queries / saved analyses ──
  // One memo per saved query (type='saved-query', queryGuid points to
  // the saved query) and one per saved analysis (type='saved-analysis',
  // analysisGuid points to the saved analysis). Hidden from the Memos
  // pane — visible via the icon next to the row in their respective
  // sidebars and via the FAB icon when the analysis tab is open.
  // Reactive lookup: closure captures the live memos snapshot so when
  // a memo is added / removed, the SavedQueries / SavedAnalyses
  // sidebars re-render and the icons appear / disappear.
  const findMemoGuidForQuery = useCallback((queryGuid: string) => {
    const m = memoStore.memos.find(
      (m) => m.type === 'saved-query' && m.queryGuid === queryGuid
    )
    return m?.guid
  }, [memoStore.memos])
  const findMemoGuidForAnalysis = useCallback((analysisGuid: string) => {
    const m = memoStore.memos.find(
      (m) => m.type === 'saved-analysis' && m.analysisGuid === analysisGuid
    )
    return m?.guid
  }, [memoStore.memos])
  const openMemoEditByGuid = useCallback((memoGuid: string) => {
    const memo = useMemoStore.getState().findMemo(memoGuid)
    if (!memo) return
    const initData: MemoEditInitData = {
      memo,
      theme: document.documentElement.getAttribute('data-theme') || ''
    }
    window.api.openMemoEditWindow(initData)
  }, [])
  const openOrCreateQueryMemo = useCallback((queryGuid: string) => {
    const existing = findMemoGuidForQuery(queryGuid)
    if (existing) return openMemoEditByGuid(existing)
    const draft: Memo = {
      guid: generateGuid(),
      type: 'saved-query',
      title: '',
      content: '',
      createdDateTime: new Date().toISOString(),
      queryGuid
    }
    const initData: MemoEditInitData = {
      memo: draft,
      theme: document.documentElement.getAttribute('data-theme') || '',
      isNew: true
    }
    window.api.openMemoEditWindow(initData)
  }, [findMemoGuidForQuery, openMemoEditByGuid])
  const openOrCreateAnalysisMemo = useCallback((analysisGuid: string) => {
    const existing = findMemoGuidForAnalysis(analysisGuid)
    if (existing) return openMemoEditByGuid(existing)
    const draft: Memo = {
      guid: generateGuid(),
      type: 'saved-analysis',
      title: '',
      content: '',
      createdDateTime: new Date().toISOString(),
      analysisGuid
    }
    const initData: MemoEditInitData = {
      memo: draft,
      theme: document.documentElement.getAttribute('data-theme') || '',
      isNew: true
    }
    window.api.openMemoEditWindow(initData)
  }, [findMemoGuidForAnalysis, openMemoEditByGuid])

  // Open the New Code dialog when any viewer's context menu fires the
  // shared trigger. Skip the very first render's count=0 so we don't
  // pop the dialog on app start.
  const newCodeTriggerCount = useNewCodeTriggerStore((s) => s.count)
  useEffect(() => {
    if (newCodeTriggerCount > 0) setShowNewCodeDialog(true)
  }, [newCodeTriggerCount])

  const handleCreateCode = useCallback((name: string, color: string, description: string, hotkey: number | undefined) => {
    const guid = codeStore.addCode(name, color)
    if (description && guid) {
      codeStore.setCodeDescription(guid, description)
    }
    if (hotkey !== undefined && guid) {
      codeStore.setCodeHotkey(guid, hotkey)
    }
    setShowNewCodeDialog(false)

    // If this was triggered from "Code All > New Code", apply to all results
    if (pendingCodeAllNewCode && guid) {
      setPendingCodeAllNewCode(false)
      const qs = useQueryStore.getState()
      const ds = useDocumentStore.getState()
      for (const r of qs.results) {
        const isRealSelection = !r.selectionGuid.startsWith('text-match-')
        if (isRealSelection) {
          ds.addCodingToSelection(r.sourceGuid, r.selectionGuid, guid)
        } else {
          const selGuid = ds.addSelection(r.sourceGuid, r.startPosition, r.endPosition, r.matchedText)
          ds.addCodingToSelection(r.sourceGuid, selGuid, guid)
        }
      }
      return
    }

    // If the user had a selection in the active viewer when they
    // clicked "+ Code", apply the freshly-created code to that
    // selection automatically. Saves the user from having to drag the
    // new code onto the selection. Reuses an existing selection at the
    // same bounds (if any) so multiple "+ Code" rounds stack codings
    // on the same range/region. The pendingSelection state in the
    // viewer is left untouched so the user can chain another "+ Code"
    // click.
    if (guid) {
      const ps = usePendingSelectionStore.getState().selection
      if (ps?.kind === 'text') {
        const ds = useDocumentStore.getState()
        const src = ds.sources.find((s) => s.guid === ps.sourceGuid)
        const existingSel = src?.selections.find(
          (s) => s.startPosition === ps.startCp && s.endPosition === ps.endCp
        )
        if (existingSel) {
          if (!existingSel.codings.some((c) => c.codeGuid === guid)) {
            ds.addCodingToSelection(ps.sourceGuid, existingSel.guid, guid)
          }
        } else {
          const truncatedName = ps.selectedText.length > 60
            ? ps.selectedText.slice(0, 57) + '...'
            : ps.selectedText
          const selGuid = ds.addSelection(ps.sourceGuid, ps.startCp, ps.endCp, truncatedName)
          ds.addCodingToSelection(ps.sourceGuid, selGuid, guid)
        }
      } else if (ps?.kind === 'survey-cell') {
        // Survey-cell pending: apply the freshly-created code to
        // every cell in the (possibly multi-cell) pending selection.
        // Same reuse-an-existing-selection-on-the-same-bounds rule
        // as the text branch, so multiple "+ Code" rounds stack
        // codings on the same cell range rather than piling up
        // duplicate selection rows.
        const ds = useDocumentStore.getState()
        for (const cell of ps.cells) {
          const src = ds.sources.find((s) => s.guid === ps.sourceGuid)
          const existingSel = src?.selections.find(
            (s) =>
              s.surveyCell &&
              s.surveyCell.respondentId === cell.respondentId &&
              s.surveyCell.questionId === cell.questionId &&
              s.startPosition === cell.start &&
              s.endPosition === cell.end
          )
          if (existingSel) {
            if (!existingSel.codings.some((c) => c.codeGuid === guid)) {
              ds.addCodingToSelection(ps.sourceGuid, existingSel.guid, guid)
            }
          } else {
            const truncatedName = cell.selectedText.length > 60
              ? cell.selectedText.slice(0, 57) + '...'
              : cell.selectedText
            const selGuid = ds.addSelection(
              ps.sourceGuid,
              cell.start,
              cell.end,
              truncatedName,
              undefined,
              { respondentId: cell.respondentId, questionId: cell.questionId }
            )
            ds.addCodingToSelection(ps.sourceGuid, selGuid, guid)
          }
        }
      } else if (ps?.kind === 'region') {
        const ds = useDocumentStore.getState()
        const src = ds.sources.find((s) => s.guid === ps.sourceGuid)
        // Match an existing region selection within a half-pixel
        // tolerance (matches the viewer's own applyCodingToRegion
        // behaviour) so repeated "+ Code" rounds stack on the same
        // region.
        const r = ps.pdfRegion
        const existingSel = src?.selections.find(
          (s) => s.pdfRegion &&
            s.pdfRegion.page === r.page &&
            Math.abs(s.pdfRegion.x - r.x) < 0.5 &&
            Math.abs(s.pdfRegion.y - r.y) < 0.5 &&
            Math.abs(s.pdfRegion.width - r.width) < 0.5 &&
            Math.abs(s.pdfRegion.height - r.height) < 0.5
        )
        if (existingSel) {
          if (!existingSel.codings.some((c) => c.codeGuid === guid)) {
            ds.addCodingToSelection(ps.sourceGuid, existingSel.guid, guid)
          }
        } else {
          const selGuid = ds.addSelection(ps.sourceGuid, 0, 0, `Region p${r.page}`, r)
          ds.addCodingToSelection(ps.sourceGuid, selGuid, guid)
        }
      }
    }
  }, [codeStore, pendingCodeAllNewCode])

  // Handle menu actions from Electron
  useEffect(() => {
    const unsubscribe = window.api.onMenuAction((action) => {
      switch (action) {
        case 'new-project':
          handleNewProject()
          break
        case 'open-project':
          handleOpenProject()
          break
        case 'save-project':
          handleSaveProject()
          break
        case 'save-project-as':
          handleSaveProjectAs()
          break
        case 'import-document':
          handleImportDocument()
          break
        case 'open-preferences':
          useDocumentStore.getState().openToolTab(PREFERENCES_TAB_ID)
          break
        case 'open-project-details':
          setShowProjectDetails(true)
          break
        case 'new-code':
          handleNewCode()
          break
        case 'new-doc-folder':
          documentStore.addFolder('New Folder')
          break
        case 'manage-doc-tags':
          setShowManageDocTags(true)
          break
        case 'new-query':
          openQueryBuilder()
          break
        case 'clear-query':
          queryStore.clearQuery()
          break
        case 'show-codebook':
          openCodebook()
          break
        case 'show-logbook':
          openLogbook()
          break
        case 'export-codebook':
          window.api.exportCodebook(codeStore.codes)
          break
        case 'import-codebook':
          window.api.importCodebook().then((imported) => {
            if (imported && imported.length > 0) {
              codeStore.mergeCodes(imported)
            }
          })
          break
        case 'analysis-code-cooccurrences':
          openAnalysis('code-cooccurrences')
          break
        case 'analysis-codes-in-documents':
          openAnalysis('codes-in-documents')
          break
        case 'analysis-code-frequencies':
          openAnalysis('code-frequencies')
          break
        case 'analysis-code-orders':
          openAnalysis('code-orders')
          break
        case 'analysis-word-frequencies':
          openAnalysis('word-frequencies')
          break
        case 'analysis-relationship-map':
          openAnalysis('relationship-map')
          break
        case 'toggle-panel-documents': togglePanel('documents'); break
        case 'toggle-panel-codes': togglePanel('codes'); break
        case 'toggle-panel-queries': setQueryResultsClosed((prev) => !prev); break
        case 'toggle-panel-memos': togglePanel('memos'); break
        case 'toggle-panel-quotes': togglePanel('quotes'); break
        case 'toggle-panel-analyses': togglePanel('analyses'); break
        case 'close-active-tab': {
          // Cmd+W in the main window — close whichever document /
          // analysis / query-builder tab is currently viewed. Mirrors
          // DocumentViewer's closeTab cleanup so analysis-store
          // entries don't leak.
          const ds = useDocumentStore.getState()
          const tabId = ds.viewedDocumentGuid
          if (!tabId) break
          if (isAnalysisTab(tabId) || isQueryBuilderTab(tabId) || isMapTab(tabId)) {
            useAnalysisTabsStore.getState().remove(tabId)
          }
          ds.closeTab(tabId)
          break
        }
      }
    })
    return unsubscribe
  }, [
    handleNewProject,
    handleOpenProject,
    handleSaveProject,
    handleSaveProjectAs,
    handleImportDocument,
    handleNewCode,
    openQueryBuilder,
    openCodebook,
    openLogbook,
    openAnalysis,
    queryStore
  ])

  // Sync panel visibility to main process for View menu checkmarks.
  // The "Queries" menu item now drives the merged Queries pane (which
  // owns the Saved Queries sidebar + the live results), so its
  // checkmark tracks !queryResultsClosed.
  useEffect(() => {
    window.api.updatePanelVisibility({ ...panelVisibility, queries: !queryResultsClosed })
  }, [panelVisibility, queryResultsClosed])

  // Custom keyboard shortcuts for project-level operations.
  // Native text undo/redo/selectAll is handled by Electron's native roles.
  // When no text input is focused, these shortcuts trigger project-level actions instead.
  useEffect(() => {
    const isTextInput = () => {
      const el = document.activeElement
      if (!el) return false
      const tag = el.tagName.toLowerCase()
      return tag === 'input' || tag === 'textarea' || (el as HTMLElement).isContentEditable
    }
    const handleKeydown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === 'a' && !isTextInput()) {
        if (activePanelRef.current === 'documents') {
          e.preventDefault()
          const docStore = useDocumentStore.getState()
          docStore.selectDocuments(new Set(docStore.sources.map((s) => s.guid)))
        } else if (activePanelRef.current === 'codes') {
          e.preventDefault()
          window.dispatchEvent(new CustomEvent('magnolia-select-all-codes'))
        }
      } else if (e.key === 'z' && !e.shiftKey && !isTextInput()) {
        e.preventDefault()
        useUndoStore.getState().undo()
      } else if (e.key === 'z' && e.shiftKey && !isTextInput()) {
        e.preventDefault()
        useUndoStore.getState().redo()
      } else if (e.key === 'f') {
        // Find is the only global Cmd/Ctrl+F behaviour — fires even
        // when a text input is focused (e.g. while the user is
        // selecting text in a transcript). Only available when a
        // document is actually open in the viewer. Opening the popup
        // also un-hides the Query Results pane so the results are
        // visible after the user runs Find.
        const guid = useDocumentStore.getState().viewedDocumentGuid
        if (!guid) return
        e.preventDefault()
        setQueryResultsClosed(false)
        setShowFindDialog(true)
      }
    }
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [])

  // Update window title with project file name and dirty indicator
  useEffect(() => {
    let name = 'Untitled Project'
    if (projectStore.filePath) {
      // Extract filename without extension from the file path
      const parts = projectStore.filePath.replace(/\\/g, '/').split('/')
      const filename = parts[parts.length - 1] || ''
      name = filename.replace(/\.qdpx$/i, '') || name
    } else if (projectStore.name) {
      name = projectStore.name
    }
    const dirty = projectStore.isDirty ? ' — Edited' : ''
    document.title = `${name}${dirty} — Magnolia`
  }, [projectStore.name, projectStore.filePath, projectStore.isDirty])

  // Listen for memo updates from the memo edit window
  useEffect(() => {
    const unsub = window.api.onMemoUpdate((memo: any) => {
      const store = useMemoStore.getState()
      let payload: { guid: string; title: string; content: string }
      if (memo._isNew) {
        // First save of a draft memo — create it in the store
        const { _isNew, ...memoData } = memo
        store.addMemoFromDraft(memoData)
        payload = memoData
      } else {
        store.updateMemo(memo)
        payload = memo
      }
      // Propagate the edit to any memo element on relationship-map
      // tabs in this window.
      const rmStore = useRelationshipMapStore.getState()
      for (const m of Object.values(rmStore.maps)) {
        let changed = false
        const nextElements = m.elements.map((el) => {
          if (el.kind === 'memo' && el.entityGuid === payload.guid) {
            changed = true
            return { ...el, label: payload.title, snippet: payload.content }
          }
          return el
        })
        if (changed) rmStore.setElements(m.guid, nextElements)
      }
      // Memo edits come from an explicit "Save & Close" click, so flush
      // the project to disk immediately instead of waiting for the
      // 2-second auto-save debounce. Otherwise users who close the memo
      // window and immediately reopen the project see stale content.
      setTimeout(() => { saveProjectRef.current() }, 0)
    })
    return unsub
  }, [])

  // Listen for memo deletes from the memo edit window. Mirrors the
  // memo-update flow: remove from the store, drop matching memo
  // elements from any relationship-map tab, then flush the project
  // so the deletion sticks.
  useEffect(() => {
    const unsub = window.api.onMemoDelete((guid: string) => {
      useMemoStore.getState().removeMemo(guid)
      const rmStore = useRelationshipMapStore.getState()
      for (const m of Object.values(rmStore.maps)) {
        const nextElements = m.elements.filter((el) => !(el.kind === 'memo' && el.entityGuid === guid))
        if (nextElements.length !== m.elements.length) rmStore.setElements(m.guid, nextElements)
      }
      setTimeout(() => { saveProjectRef.current() }, 0)
    })
    return unsub
  }, [])

  // Listen for analysis actions (save, run-query)
  useEffect(() => {
    const unsub = window.api.onAnalysisAction((action, ...args) => {
      if (action === 'save-analysis') {
        const [analysis] = args as [{ guid: string; toolType: string; name: string; config: any }]
        const ps = useProjectStore.getState()
        const existing = ps.savedAnalyses ?? []
        const idx = existing.findIndex((a) => a.guid === analysis.guid)
        const now = new Date().toISOString()
        const entry = {
          guid: analysis.guid,
          toolType: analysis.toolType as any,
          name: analysis.name,
          config: analysis.config,
          createdDateTime: idx >= 0 ? existing[idx].createdDateTime : now,
          modifiedDateTime: now
        }
        if (idx >= 0) {
          const updated = [...existing]
          updated[idx] = entry
          ps.setSavedAnalyses(updated)
        } else {
          ps.setSavedAnalyses([...existing, entry])
        }
      } else if (action === 'run-cooccurrence-query') {
        // Build an overlap query for two codes, including document filter
        const [codeGuidA, codeGuidB, filteredGuids] = args as [string, string, string[] | undefined]
        const query: Query = {
          documentFilter: filteredGuids && filteredGuids.length > 0 ? { sourceGuids: filteredGuids } : {},
          codeCondition: {
            type: 'overlap',
            condition1: { type: 'code', codeGuid: codeGuidA },
            condition2: { type: 'code', codeGuid: codeGuidB }
          }
        }
        useQueryStore.getState().setComplexQuery(query)
      } else if (action === 'run-code-in-doc-query') {
        // Build a query for a code in specific documents
        const [codeGuid, sourceGuids, filteredGuids] = args as [string, string[], string[] | undefined]
        const docGuids = filteredGuids && filteredGuids.length > 0 ? sourceGuids.filter((g) => filteredGuids.includes(g)) : sourceGuids
        const query: Query = {
          documentFilter: { sourceGuids: docGuids },
          codeCondition: { type: 'code', codeGuid }
        }
        useQueryStore.getState().setComplexQuery(query)
      } else if (action === 'run-codes-in-doc-query') {
        // Build an OR query for multiple codes in specific documents (for totals)
        const [codeGuids, sourceGuids] = args as [string[], string[]]
        const codeCondition = codeGuids.length === 1
          ? { type: 'code' as const, codeGuid: codeGuids[0] }
          : { type: 'or' as const, conditions: codeGuids.map((g) => ({ type: 'code' as const, codeGuid: g })) }
        const query: Query = {
          documentFilter: { sourceGuids },
          codeCondition
        }
        useQueryStore.getState().setComplexQuery(query)
      } else if (action === 'run-code-in-tag-query') {
        // Build a query for a code filtered by tag (include or exclude)
        const [codeGuid, tagGuid, excludeTagGuids] = args as [string, string | null, string[] | undefined]
        const filter: Query['documentFilter'] = {}
        if (tagGuid) {
          filter.tagGuids = [tagGuid]
        }
        if (excludeTagGuids && excludeTagGuids.length > 0) {
          filter.tagExcludeGuids = excludeTagGuids
        }
        const query: Query = {
          documentFilter: filter,
          codeCondition: { type: 'code', codeGuid }
        }
        useQueryStore.getState().setComplexQuery(query)
      } else if (action === 'run-query-in-docs') {
        // Run a saved query scoped to specific documents
        const [query, sourceGuids] = args as [Query, string[]]
        const scopedQuery: Query = {
          documentFilter: { sourceGuids },
          codeCondition: query.codeCondition
        }
        useQueryStore.getState().setComplexQuery(scopedQuery)
      } else if (action === 'run-word-query') {
        // Build a text search query for a word in specific documents
        const [word, filteredGuids] = args as [string, string[] | undefined]
        const query: Query = {
          documentFilter: filteredGuids && filteredGuids.length > 0 ? { sourceGuids: filteredGuids } : {},
          codeCondition: { type: 'text', searchText: word, caseSensitive: false, wholeWord: true }
        }
        useQueryStore.getState().setComplexQuery(query)
      } else if (action === 'open-document') {
        const [sourceGuid] = args as [string]
        useDocumentStore.getState().viewDocument(sourceGuid)
      } else if (action === 'view-document-at') {
        const [sourceGuid, startCp, endCp] = args as [string, number, number]
        useDocumentStore.getState().viewDocumentAt(sourceGuid, startCp, endCp)
      } else if (action === 'run-code-query') {
        const [codeGuid] = args as [string]
        const query: Query = {
          documentFilter: {},
          codeCondition: { type: 'code', codeGuid }
        }
        useQueryStore.getState().setComplexQuery(query)
      } else if (action === 'open-memo') {
        const [memoGuid] = args as [string]
        const memo = useMemoStore.getState().findMemo(memoGuid)
        if (memo) {
          window.api.openMemoEditWindow({
            memo,
            theme: document.documentElement.getAttribute('data-theme') || ''
          })
        }
      } else if (action === 'run-saved-query') {
        const [queryGuid] = args as [string]
        useQueryStore.getState().runSavedQuery(queryGuid)
      } else if (action === 'select-tag-documents') {
        const [tagGuid] = args as [string]
        const tag = useTagStore.getState().tags.find((t) => t.guid === tagGuid)
        if (tag) {
          useDocumentStore.getState().selectDocuments(new Set(tag.memberSourceGuids))
        }
      } else if (action === 'select-tag-category-documents') {
        const [categoryGuid] = args as [string]
        const tgStore = useTagStore.getState()
        const categoryTags = tgStore.tags.filter((t) => t.categoryGuid === categoryGuid)
        const allGuids = new Set<string>()
        for (const tag of categoryTags) {
          for (const guid of tag.memberSourceGuids) allGuids.add(guid)
        }
        useDocumentStore.getState().selectDocuments(allGuids)
      } else if (action === 'select-folder-documents') {
        const [folderGuid] = args as [string]
        const ds = useDocumentStore.getState()
        // Recursively walk sub-folders so descendant docs are included,
        // matching how Group-by-folder resolves a folder's source set.
        const folderSet = new Set<string>([folderGuid])
        let added = true
        while (added) {
          added = false
          for (const f of ds.folders) {
            if (f.parentGuid && folderSet.has(f.parentGuid) && !folderSet.has(f.guid)) {
              folderSet.add(f.guid)
              added = true
            }
          }
        }
        const docs = new Set<string>()
        for (const s of ds.sources) {
          const fg = ds.sourceFolder[s.guid]
          if (fg && folderSet.has(fg)) docs.add(s.guid)
        }
        ds.selectDocuments(docs)
      } else if (action === 'open-saved-analysis') {
        const [toolType, savedConfig] = args as [string, any]
        // Callers from other analysis windows only know the guid/name — look
        // up the full saved config from the project store.
        let finalConfig = savedConfig
        if (savedConfig?.guid) {
          const ps = useProjectStore.getState()
          const sa = (ps.savedAnalyses ?? []).find((a) => a.guid === savedConfig.guid)
          if (sa) finalConfig = { ...sa.config, guid: sa.guid, name: sa.name }
        }
        openSavedAnalysis(toolType as any, finalConfig)
      }
    })
    return unsub
  }, [openSavedAnalysis])

  // Listen for open-recent-project from welcome screen
  useEffect(() => {
    const unsub = window.api.onOpenRecentProject(async (filePath) => {
      loadInProgressRef.current = true
      cancelPendingAutoSave()
      setLoadProgress({ stage: 'Opening project…', current: 0, total: 0 })
      try {
        const data = await window.api.openProjectPath(filePath)
        if (!data) return
        // Mirror handleOpenProject: drop only the leftover map tabs, not
        // the whole document store. See that handler for the autosave-
        // race rationale.
        useDocumentStore.getState().closeAllToolTabs()
        useDocumentStore.getState().closeAllToolTabs()
        useRelationshipMapStore.getState().clearAll()
        useAnalysisTabsStore.getState().clearAll()
        const { sourceContents, ...project } = data
        const steps: { label: string; run: () => void }[] = [
          {
            label: 'Project metadata',
            run: () =>
              useProjectStore.getState().loadProject({
                name: project.name,
                origin: project.origin,
                users: project.users,
                creatingUserGUID: project.creatingUserGUID,
                creationDateTime: project.creationDateTime,
                modifyingUserGUID: project.modifyingUserGUID,
                modifiedDateTime: project.modifiedDateTime,
                filePath: (data as any).filePath,
                savedAnalyses: project.savedAnalyses
              })
          },
          { label: 'Documents', run: () => useDocumentStore.getState().setSources(project.sources, sourceContents) },
          { label: 'Folders', run: () => useDocumentStore.getState().setFolders((project as any).folders ?? [], (project as any).sourceFolder ?? {}) },
          { label: 'Codes', run: () => useCodeStore.getState().setCodes(project.codes) },
          {
            label: 'Tags',
            run: () => {
              useTagStore.getState().setTags(project.sets)
              useTagStore.getState().setCategories(project.tagCategories ?? [])
            }
          },
          {
            label: 'Queries',
            run: () => {
              useQueryStore.getState().clearQuery()
              useQueryStore.getState().setSavedQueries(project.savedQueries ?? [])
            }
          },
          { label: 'Logbook', run: () => useLogbookStore.getState().setEntries(project.logbookEntries ?? []) },
          { label: 'Memos', run: () => useMemoStore.getState().setMemos(project.memos ?? []) },
          { label: 'Quotes', run: () => useQuoteStore.getState().setQuotes(project.quotes ?? []) },
          { label: 'Tabs', run: () => restoreTabState((project as any).tabState) }
        ]
        for (let i = 0; i < steps.length; i++) {
          setLoadProgress({ stage: `Populating ${steps[i].label}`, current: i + 1, total: steps.length })
          await new Promise((r) => setTimeout(r, 0))
          steps[i].run()
        }
        // Freshly loaded == matches disk == not dirty. Clear the dirty flag
        // the setX steps raised so opening a recent project doesn't trigger
        // a post-load autosave (a needless full-archive rewrite). See the
        // matching note in the file-picker open path above.
        useProjectStore.getState().markClean()
        window.api.trackRecentProject(project.name, filePath)
      } catch (err) {
        console.error('Failed to open recent project:', err)
      } finally {
        setLoadProgress(null)
        liftLoadSuppression()
      }
    })
    return unsub
  }, [cancelPendingAutoSave, liftLoadSuppression])

  // Hidden flush-on-close: when the main process intercepts the window
  // close, write the current project to disk before letting the window go.
  // While the save is in flight we ping a heartbeat to main every second
  // — main's watchdog only fires on silence, so a multi-minute save on a
  // large project keeps the window open indefinitely. notifyFlushComplete
  // fires regardless of save outcome so a thrown writer error doesn't
  // trap the user inside a window they asked to close.
  useEffect(() => {
    const unsub = window.api.onFlushAndClose(async () => {
      const ps = useProjectStore.getState()
      if (ps.isDirty && ps.filePath) {
        const heartbeat = setInterval(() => window.api.sendFlushHeartbeat(), 1000)
        // Send one immediately so main's watchdog is reset before the
        // first interval tick (which is a full second away).
        window.api.sendFlushHeartbeat()
        try {
          await window.api.saveProject({
            project: collectProject(),
            sourceContents: useDocumentStore.getState().sourceContents,
            filePath: ps.filePath
          })
        } catch (err) {
          console.error('Pre-close flush failed:', err)
        } finally {
          clearInterval(heartbeat)
        }
      }
      window.api.notifyFlushComplete()
    })
    return unsub
  }, [collectProject])

  // Listen for new-project-at-path from the welcome screen. The main
  // process has already written an empty .qdpx at filePath; we just need
  // the renderer's project state to point at it so subsequent saves and
  // the title bar reflect the chosen name and location.
  useEffect(() => {
    const unsub = window.api.onNewProjectAtPath(({ filePath, projectName }) => {
      const ps = useProjectStore.getState()
      const userGuid = ps.users[0]?.guid ?? generateGuid()
      ps.loadProject({
        name: projectName,
        origin: `Magnolia ${__APP_VERSION__}`,
        users: [{ guid: userGuid, name: 'User' }],
        creatingUserGUID: userGuid,
        creationDateTime: new Date().toISOString(),
        filePath,
        savedAnalyses: []
      })
      window.api.trackRecentProject(projectName, filePath)
    })
    return unsub
  }, [])

  // Listen for live preview queries from the query builder window
  // Use getState() inside callbacks to avoid re-subscribing on every store change
  useEffect(() => {
    const unsub = window.api.onPreviewFromBuilder((query, graphLayout) => {
      if (query) {
        useQueryStore.getState().setComplexQuery(query, graphLayout)
      } else {
        useQueryStore.getState().clearQuery()
      }
    })
    return unsub
  }, [])

  // Listen for save-query requests from the query builder window
  useEffect(() => {
    const unsub = window.api.onSaveQueryFromBuilder((query, name, graphLayout, savedGuid) => {
      useQueryStore.getState().setComplexQuery(query, graphLayout)
      // Honour the builder-supplied guid so the builder can flip its
      // own editGuid state in the same render — title-row inline name
      // appears immediately instead of after a re-mount.
      useQueryStore.getState().saveCurrentQuery(name, graphLayout, savedGuid)
    })
    return unsub
  }, [])

  // Listen for codebook updates from the codebook window
  useEffect(() => {
    const unsub = window.api.onCodebookUpdate((action, ...args) => {
      const cs = useCodeStore.getState()
      switch (action) {
        case 'save-code': {
          const [guid, name, color, description, hotkey] = args
          cs.renameCode(guid, name)
          cs.recolorCode(guid, color)
          cs.setCodeDescription(guid, description)
          cs.setCodeHotkey(guid, hotkey)
          break
        }
        case 'merge-codes': {
          const [imported] = args
          cs.mergeCodes(imported)
          break
        }
      }
    })
    return unsub
  }, [])

  // Listen for query results window close (pop back in)
  useEffect(() => {
    const unsub = window.api.onQueryResultsClosed(() => {
      setQueryResultsPoppedOut(false)
    })
    return unsub
  }, [])

  // Listen for double-click jumps from the popped-out query results
  // window. Equivalent to calling viewDocumentAt directly when the
  // results are inline in the main window.
  useEffect(() => {
    const unsub = window.api.onJumpToQueryResult((target) => {
      // Survey-cell results: prime the survey viewer with the
      // matching respondent + scroll target before opening the tab,
      // mirroring the inline-panel path.
      if (target.surveyCell) {
        const svs = useSurveyViewStore.getState()
        svs.setView(target.sourceGuid, 'respondent', target.surveyCell.respondentId)
        svs.setScrollTarget({
          surveyGuid: target.sourceGuid,
          respondentId: target.surveyCell.respondentId,
          questionId: target.surveyCell.questionId
        })
      }
      useDocumentStore.getState().viewDocumentAt(
        target.sourceGuid,
        target.startPosition,
        target.endPosition,
        target.pdfRegion,
        target.timeRange
      )
    })
    return unsub
  }, [])

  // Handle actions from popped-out query results window
  useEffect(() => {
    const unsub = window.api.onQueryResultsAction((action, payload) => {
      switch (action) {
        case 'edit-query': {
          const qs = useQueryStore.getState()
          const saved = qs.savedQueries.find(
            (sq) => JSON.stringify(sq.query) === JSON.stringify(qs.currentQuery)
          )
          if (saved) {
            openQueryBuilder(saved.guid)
          } else {
            openQueryBuilder(undefined, true)
          }
          break
        }
        case 'clear-query':
          useQueryStore.getState().clearQuery()
          break
        case 'save-query': {
          const q = useQueryStore.getState().currentQuery
          const defaultName = q
            ? describeQuery(q, codeStore.findCode, documentStore.sources, tagStore.tags)
            : ''
          setSaveQueryName(defaultName)
          setShowSaveQueryDialog(true)
          break
        }
        case 'code-all-new-code':
          setPendingCodeAllNewCode(true)
          setShowNewCodeDialog(true)
          break
        case 'code-all-existing-code': {
          // Mirror onApplyCodeToResults from the popped-in
          // QueryResultViewer: apply the dropped code to every
          // result. Survey-cell / region results carry real
          // selectionGuids; text-match results get a new selection
          // created on the fly so the code can attach.
          if (payload?.guid) {
            const qs = useQueryStore.getState()
            const ds = useDocumentStore.getState()
            for (const r of qs.results) {
              const isRealSelection = !r.selectionGuid.startsWith('text-match-')
              if (isRealSelection) {
                const alreadyApplied = r.matchedCodes.some((c) => c.guid === payload.guid)
                if (!alreadyApplied) {
                  ds.addCodingToSelection(r.sourceGuid, r.selectionGuid, payload.guid)
                }
              } else {
                const selGuid = ds.addSelection(r.sourceGuid, r.startPosition, r.endPosition, r.matchedText)
                ds.addCodingToSelection(r.sourceGuid, selGuid, payload.guid)
              }
            }
          }
          break
        }
        case 'select-documents': {
          // Mirror handleSelectDocuments from QueryResultViewer:
          // select every source document + every survey respondent
          // the current results came from, so the user can drag a
          // tag onto the Document Browser to tag them all.
          const qs = useQueryStore.getState()
          const ds = useDocumentStore.getState()
          const docGuids = new Set<string>()
          const entityKeys = new Set<string>()
          for (const r of qs.results) {
            if (r.surveyCell) entityKeys.add(surveyEntityKey('resp', r.sourceGuid, r.surveyCell.respondentId))
            else docGuids.add(r.sourceGuid)
          }
          ds.selectDocuments(docGuids)
          ds.selectSurveyEntities(entityKeys)
          break
        }
        // Saved-query actions from the popped-out Saved Queries
        // sidebar. Each carries a guid (and optionally a new name)
        // in the payload so the main app can dispatch to its store.
        case 'run-saved-query':
          if (payload?.guid) useQueryStore.getState().runSavedQuery(payload.guid)
          break
        case 'delete-saved-query':
          if (payload?.guid) useQueryStore.getState().deleteSavedQuery(payload.guid)
          break
        case 'rename-saved-query':
          if (payload?.guid && payload?.name) useQueryStore.getState().renameSavedQuery(payload.guid, payload.name)
          break
        case 'edit-saved-query':
          if (payload?.guid) openQueryBuilder(payload.guid)
          break
      }
    })
    return unsub
  }, [codeStore.findCode, documentStore.sources, tagStore.tags, openQueryBuilder])

  // Keep query-builder tab titles in sync with their backing saved-query
  // names — when a user renames a saved query (in-window or in the popped
  // Queries window), any open Query Builder tab editing that query needs
  // to pick up the new name. Tab title is captured at tab creation, so
  // without this it would stay frozen at whatever the name was when the
  // tab opened.
  useEffect(() => {
    const ats = useAnalysisTabsStore.getState()
    for (const [tabId, inst] of Object.entries(ats.instances)) {
      if (inst.toolType === 'query-builder' && inst.savedAnalysisGuid) {
        const sq = queryStore.savedQueries.find((q) => q.guid === inst.savedAnalysisGuid)
        if (sq && inst.title !== sq.name) {
          ats.setTitle(tabId, sq.name)
        }
      }
    }
  }, [queryStore.savedQueries])

  // Push live updates to popped-out query results window
  useEffect(() => {
    if (!queryResultsPoppedOut) return
    const qs = useQueryStore.getState()
    const theme = document.documentElement.getAttribute('data-theme') || ''
    const qName = qs.currentQuery
      ? (() => {
          const saved = qs.savedQueries.find(
            (sq) => JSON.stringify(sq.query) === JSON.stringify(qs.currentQuery)
          )
          return saved
            ? saved.name
            : describeQuery(qs.currentQuery!, codeStore.findCode, documentStore.sources, tagStore.tags)
        })()
      : 'Query Results'
    const isUnsaved = qs.isActive && qs.currentQuery
      ? !qs.savedQueries.some((sq) => JSON.stringify(sq.query) === JSON.stringify(qs.currentQuery))
      : false
    const docStore = useDocumentStore.getState()
    const cdStore = useCodeStore.getState()
    const sourceSelections: Record<string, any[]> = {}
    const pdfFilePaths: Record<string, string> = {}
    const videoFilePaths: Record<string, string> = {}
    const videoMimeTypes: Record<string, string> = {}
    const surveysByGuid: Record<string, SurveyData> = {}
    for (const src of docStore.sources) {
      if (src.selections.length > 0) sourceSelections[src.guid] = src.selections
      const fp = (src as any).formatData?.pdfFilePath ?? (src as any).formatData?.imageFilePath
      if (fp) pdfFilePaths[src.guid] = fp
      const vp = (src as any).formatData?.videoFilePath
      if (vp) {
        videoFilePaths[src.guid] = vp
        videoMimeTypes[src.guid] = (src as any).formatData?.mimeType || 'video/mp4'
      }
      if (src.sourceType === 'survey') {
        const survey = (src.formatData as SurveyFormatData | undefined)?.survey
        if (survey) surveysByGuid[src.guid] = survey
      }
    }
    const codes = cdStore.flatCodes().map((c) => ({ guid: c.guid, name: c.name, color: c.color }))

    const initData: QueryResultsInitData = {
      results: qs.results,
      queryName: qName,
      isActive: qs.isActive,
      isUnsaved,
      theme,
      sourceSelections,
      surveysByGuid,
      pdfFilePaths,
      videoFilePaths,
      videoMimeTypes,
      codes,
      savedQueries: qs.savedQueries,
      currentQuery: qs.currentQuery ?? undefined
    }
    window.api.updateQueryResultsWindow(initData)
  }, [queryResultsPoppedOut, queryStore.results, queryStore.currentQuery, queryStore.isActive, queryStore.savedQueries, codeStore.findCode, documentStore.sources, tagStore.tags])


  // Listen for logbook updates from the logbook window
  useEffect(() => {
    const unsub = window.api.onLogbookUpdate((action, ...args) => {
      const ls = useLogbookStore.getState()
      switch (action) {
        case 'add-entry': {
          const [entry] = args
          ls.setEntries([entry, ...ls.entries])
          useProjectStore.getState().markDirty()
          break
        }
        case 'update-entry': {
          const [guid, title, content] = args
          ls.updateEntry(guid, title, content)
          break
        }
        case 'remove-entry': {
          const [guid] = args
          ls.removeEntry(guid)
          break
        }
      }
    })
    return unsub
  }, [])

  // Listen for final query results from the query builder window
  useEffect(() => {
    const unsub = window.api.onQueryFromBuilder((query, editSavedQueryGuid, graphLayout) => {
      if (editSavedQueryGuid) {
        const qs = useQueryStore.getState()
        // Update the saved query's payload + graph layout, but
        // preserve its existing name. The user may have renamed the
        // query inline via the title-row suffix, and subsequent
        // edits + Update Query should never silently overwrite
        // that with an auto-generated description.
        qs.updateSavedQuery(editSavedQueryGuid, query, graphLayout)
        qs.runSavedQuery(editSavedQueryGuid)
        setPulsedQueryGuid(editSavedQueryGuid)
        setTimeout(() => setPulsedQueryGuid(null), 1500)
      } else {
        useQueryStore.getState().setComplexQuery(query, graphLayout)
      }
    })
    return unsub
  }, [])

  return (
    <div
      style={{ height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column' }}
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length === 0) return
        e.preventDefault()
        const paths = Array.from(e.dataTransfer.files).map((f) => f.path).filter(Boolean)
        if (paths.length > 0) handleOSFileDrop(paths)
      }}
    >
      {/* ── Toolbar ── */}
      <div
        className="app-toolbar"
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto 1fr',
          alignItems: 'center',
          // Vertical padding only here. Horizontal padding lives in
          // .app-toolbar so the macOS-only override can replace the
          // left edge with the traffic-light indent.
          paddingTop: 6,
          paddingBottom: 6,
          borderBottom: '1px solid var(--border-color)',
          background: 'var(--bg-secondary)',
          flexShrink: 0,
          height: 54
        }}
      >
        {/* Left cell: Magnolia wordmark, themed to match the rest of
            the toolbar's icon hue. Click opens the Preferences window
            — the wordmark doubles as a discreet entry point to
            Settings. The outer button gives the same hover rectangle
            the other toolbar buttons use; the inner masked div paints
            the actual glyph (using magnolia.svg, the short toolbar-
            tuned variant of the wordmark; the welcome screen and PDF
            exports use the longer magnoliaqda.svg form instead). The
            mask can't share a single element with a hover background
            — `background` is what fills the masked region, so changing
            it on hover would recolour the glyph. */}
        <button
          type="button"
          onClick={() => useDocumentStore.getState().openToolTab(PREFERENCES_TAB_ID)}
          title="Settings"
          aria-label="Open Settings"
          style={{
            justifySelf: 'start',
            // Right margin guarantees breathing room between the
            // wordmark and the centred icon row, even on narrower
            // windows where the 1fr columns shrink.
            marginRight: 32,
            padding: '4px 6px',
            border: 'none',
            background: 'transparent',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
            transition: 'background 0.12s',
            display: 'flex',
            alignItems: 'center'
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary)' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
        >
          <div
            aria-hidden
            style={{
              // magnolia.svg viewBox is 241×49 (~4.92:1), so sizing
              // to 104×21 keeps the mask filling the box with no
              // padding while preserving the original ~22px height.
              width: 104,
              height: 21,
              background: 'var(--text-secondary)',
              WebkitMaskImage: `url(${magnoliaUrl})`,
              maskImage: `url(${magnoliaUrl})`,
              WebkitMaskRepeat: 'no-repeat',
              maskRepeat: 'no-repeat',
              WebkitMaskSize: 'contain',
              maskSize: 'contain',
              WebkitMaskPosition: 'left center',
              maskPosition: 'left center',
              pointerEvents: 'none'
            }}
          />
        </button>

        {/* Center cell: icons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {[
            { icon: faBook, label: 'Codebook', action: () => openCodebook() },
            { icon: faNotebookPen, label: 'Logbook', action: () => openLogbook() },
            { icon: faTags, label: 'Tags', action: () => setShowManageDocTags(true) }
          ].map((item) => (
            <button
              key={item.label}
              className="app-toolbar-btn"
              title={item.label}
              onClick={item.action}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 3,
                padding: '4px 12px',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                background: 'transparent',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                lineHeight: 1,
                transition: 'background 0.12s, color 0.12s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--bg-tertiary)'
                e.currentTarget.style.color = 'var(--text-primary)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.color = 'var(--text-secondary)'
              }}
            >
              <Icon icon={item.icon} style={{ fontSize: 20 }} />
              <span className="toolbar-label" style={{ fontSize: 9, whiteSpace: 'nowrap', fontWeight: 400 }}>{item.label}</span>
            </button>
          ))}

          {/* Separator */}
          <div style={{ width: 1, height: 34, background: 'var(--border-color)', margin: '0 8px' }} />

          {/* Query Builder stays as its own top-level button — it's
              the primary way users move between document inspection
              and analysis, distinct enough from the seven analysis
              tools that hiding it inside the popover would feel
              wrong. */}
          <button
            className="app-toolbar-btn"
            title="Query"
            onClick={() => openQueryBuilder()}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 3,
              padding: '4px 12px',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              background: 'transparent',
              cursor: 'pointer',
              lineHeight: 1,
              transition: 'background 0.12s'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--bg-tertiary)';
              (e.currentTarget.querySelector('.toolbar-label') as HTMLElement).style.color = 'var(--text-primary)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              (e.currentTarget.querySelector('.toolbar-label') as HTMLElement).style.color = 'var(--text-secondary)'
            }}
          >
            <Icon icon={faMagnifyingGlass} style={{ fontSize: 20 }} />
            <span className="toolbar-label" style={{ fontSize: 9, whiteSpace: 'nowrap', fontWeight: 400, color: 'var(--text-secondary)', transition: 'color 0.12s' }}>Query</span>
          </button>

          {/* Seven analysis tools (Codes in Docs / Results in Docs /
              Co-Occurrences / Code Frequencies / Code Orders / Word
              Frequencies / Relationships) collapse behind one
              "Analysis ▾" button that opens a tile-grid popover.
              See AnalysisPopover for the popover UI. */}
          <AnalysisPopover onSelect={(toolType) => openAnalysis(toolType)} />
        </div>

        {/* Right cell: Licence button. Opens a dialog explaining that
            Magnolia is FOSS (EUPL-1.2) and listing the main bundled
            libraries with their licences. Mirrors the
            icon-over-label style of the centre-cell buttons but sits
            justifySelf: 'end' so it hugs the right edge — visually
            balances the wordmark in the left cell. */}
        <div style={{ justifySelf: 'end', display: 'flex', alignItems: 'center', gap: 6, height: '100%' }}>
        {/* Studio: show/hide the workspace panels. The cross-platform
            home for the native View menu's panel toggles — on
            Windows/Linux the frameless window hides the menu bar, so
            without this a closed panel could never be reopened. Sits in
            the right cell beside the Licence button. */}
        <StudioPopover
          panels={[
            { id: 'documents', label: 'Documents', visible: panelVisibility.documents },
            { id: 'codes', label: 'Codes', visible: panelVisibility.codes },
            { id: 'queries', label: 'Queries', visible: !queryResultsClosed },
            { id: 'memos', label: 'Memos', visible: panelVisibility.memos },
            { id: 'quotes', label: 'Quotes', visible: panelVisibility.quotes },
            { id: 'analyses', label: 'Analyses', visible: panelVisibility.analyses },
          ]}
          onToggle={(id) => {
            if (id === 'queries') setQueryResultsClosed((prev) => !prev)
            else togglePanel(id as PanelId)
          }}
        />
        <button
          className="app-toolbar-btn"
          title="Licence & attributions"
          aria-label="Show licence and attributions"
          onClick={() => setShowLicenceDialog(true)}
          style={{
            justifySelf: 'end',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 3,
            padding: '4px 12px',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            background: 'transparent',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            lineHeight: 1,
            transition: 'background 0.12s, color 0.12s'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--bg-tertiary)'
            e.currentTarget.style.color = 'var(--text-primary)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
            e.currentTarget.style.color = 'var(--text-secondary)'
          }}
        >
          <span className="toolbar-label" style={{ fontSize: 9, whiteSpace: 'nowrap', fontWeight: 400 }}>European Union Public Licence</span>
        </button>
          <WindowControls />
        </div>
      </div>

      <PanelGroup direction="vertical" className="app-main-panels" style={{ flex: 1 }}>
        <Panel defaultSize={queryResultsHidden ? 100 : 70} minSize={30}>
          {/* The left and right side columns each conditionally
              render only when at least one of their child panels
              is visible (and the adjacent col-resize handle drops
              with them), so the Viewer expands into the freed
              space — same pattern the Queries pane below uses.
              The PanelGroup carries a key reflecting both sides'
              visibility so react-resizable-panels remounts cleanly
              instead of trying to match Panel positions across
              renders with different child counts. */}
          <PanelGroup
            direction="horizontal"
            key={`hg-${leftHasVisiblePanels}-${rightHasVisiblePanels}`}
          >
            {leftHasVisiblePanels && (
              <Panel defaultSize={18} minSize={12} maxSize={35}>
                {(() => {
                  const leftKey = `left-${panelVisibility.documents}-${panelVisibility.codes}`
                  const rh = { height: 1, background: 'var(--border-color)', cursor: 'row-resize' as const }
                  const panels: React.ReactNode[] = []
                  if (panelVisibility.documents) {
                    if (panels.length > 0) panels.push(<PanelResizeHandle key="rh-d" style={rh} />)
                    panels.push(
                      <Panel key="documents" defaultSize={35} minSize={15}>
                        <div style={{ height: '100%' }} onMouseDown={() => setActivePanel('documents')}>
                          <DocumentBrowser
                            onImport={handleImportDocument}
                            onSurveyImport={queueSurveyImport}
                            showManageDocTags={showManageDocTags}
                            onCloseManageDocTags={() => setShowManageDocTags(false)}

                            onClose={() => closePanel('documents')}
                          />
                        </div>
                      </Panel>
                    )
                  }
                  if (panelVisibility.codes) {
                    if (panels.length > 0) panels.push(<PanelResizeHandle key="rh-c" style={rh} />)
                    panels.push(
                      <Panel key="codes" defaultSize={35} minSize={15}>
                        <div style={{ height: '100%' }} onMouseDown={() => setActivePanel('codes')}>
                          <CodeBrowser onNewCode={handleNewCode} onClose={() => closePanel('codes')} />
                        </div>
                      </Panel>
                    )
                  }
                  return <PanelGroup direction="vertical" key={leftKey}>{panels}</PanelGroup>
                })()}
              </Panel>
            )}
            {leftHasVisiblePanels && (
              <PanelResizeHandle
                style={{
                  width: 1,
                  background: 'var(--border-color)',
                  cursor: 'col-resize'
                }}
              />
            )}
            <Panel defaultSize={64} minSize={25}>
              <div style={{ height: '100%' }} onMouseDown={() => setActivePanel('viewer')}>
                <DocumentViewer />
              </div>
            </Panel>
            {rightHasVisiblePanels && (
              <PanelResizeHandle
                style={{
                  width: 1,
                  background: 'var(--border-color)',
                  cursor: 'col-resize'
                }}
              />
            )}
            {rightHasVisiblePanels && (
              <Panel defaultSize={18} minSize={12} maxSize={35} collapsible>
                {(() => {
                  const rightKey = `right-${panelVisibility.memos}-${panelVisibility.quotes}-${panelVisibility.analyses}`
                  const rh = { height: 1, background: 'var(--border-color)', cursor: 'row-resize' as const }
                  const panels: React.ReactNode[] = []
                  if (panelVisibility.memos) {
                    if (panels.length > 0) panels.push(<PanelResizeHandle key="rh-m" style={rh} />)
                    panels.push(
                      <Panel key="memos" defaultSize={33} minSize={15}>
                        <MemosPane onClose={() => closePanel('memos')} />
                      </Panel>
                    )
                  }
                  if (panelVisibility.quotes) {
                    if (panels.length > 0) panels.push(<PanelResizeHandle key="rh-qt" style={rh} />)
                    panels.push(
                      <Panel key="quotes" defaultSize={33} minSize={15}>
                        <QuotesPane onClose={() => closePanel('quotes')} />
                      </Panel>
                    )
                  }
                  if (panelVisibility.analyses) {
                    if (panels.length > 0) panels.push(<PanelResizeHandle key="rh-a" style={rh} />)
                    panels.push(
                      <Panel key="analyses" defaultSize={34} minSize={15}>
                        <SavedAnalyses
                          onOpen={openSavedAnalysis}
                          onClose={() => closePanel('analyses')}
                          findMemoGuidForAnalysis={findMemoGuidForAnalysis}
                          onOpenAnalysisMemo={openOrCreateAnalysisMemo}
                        />
                      </Panel>
                    )
                  }
                  return <PanelGroup direction="vertical" key={rightKey}>{panels}</PanelGroup>
                })()}
              </Panel>
            )}
          </PanelGroup>
        </Panel>
        {!queryResultsHidden && (
          <PanelResizeHandle
            style={{
              height: 1,
              background: 'var(--border-color)',
              cursor: 'row-resize'
            }}
          />
        )}
        {!queryResultsHidden && (
          <Panel defaultSize={30} minSize={10} collapsible>
          <QueryResultViewer
            sidebar={
              <SavedQueries
                savedQueries={queryStore.savedQueries}
                currentQuery={queryStore.currentQuery}
                isActive={queryStore.isActive}
                onRunQuery={(guid) => queryStore.runSavedQuery(guid)}
                onDeleteQuery={(guid) => queryStore.deleteSavedQuery(guid)}
                onRenameQuery={(guid, name) => queryStore.renameSavedQuery(guid, name)}
                onEditQuery={(guid) => openQueryBuilder(guid)}
                findMemoGuidForQuery={findMemoGuidForQuery}
                onOpenQueryMemo={openOrCreateQueryMemo}
                onCreateQueryMemo={openOrCreateQueryMemo}
                pulsedQueryGuid={pulsedQueryGuid}
              />
            }
            sidebarDefaultSize={18}
            sidebarMinSize={10}
            sidebarMaxSize={40}
            onPopOut={popOutQueryResults}
            onClose={() => setQueryResultsClosed(true)}
            queryName={
              queryStore.isActive && queryStore.currentQuery
                ? (() => {
                    // Check if this matches a saved query
                    const saved = queryStore.savedQueries.find(
                      (sq) => JSON.stringify(sq.query) === JSON.stringify(queryStore.currentQuery)
                    )
                    return saved
                      ? saved.name
                      : describeQuery(queryStore.currentQuery, codeStore.findCode, documentStore.sources, tagStore.tags)
                  })()
                : undefined
            }
            onEditQuery={() => {
              // Check if the current query matches a saved query
              const saved = queryStore.savedQueries.find(
                (sq) => JSON.stringify(sq.query) === JSON.stringify(queryStore.currentQuery)
              )
              if (saved) {
                openQueryBuilder(saved.guid)
              } else {
                openQueryBuilder(undefined, true)
              }
            }}
            onSaveQuery={() => {
              const q = queryStore.currentQuery
              const defaultName = q
                ? describeQuery(q, codeStore.findCode, documentStore.sources, tagStore.tags)
                : ''
              setSaveQueryName(defaultName)
              setShowSaveQueryDialog(true)
            }}
            onCodeAllNewCode={() => {
              // Set a flag so that when the new code is created, it gets applied to all results
              setPendingCodeAllNewCode(true)
              setShowNewCodeDialog(true)
            }}
            onApplyCodeToResults={(codeGuid) => {
              const qs = useQueryStore.getState()
              const ds = useDocumentStore.getState()
              for (const r of qs.results) {
                const isRealSelection = !r.selectionGuid.startsWith('text-match-')
                if (isRealSelection) {
                  const alreadyApplied = r.matchedCodes.some((c) => c.guid === codeGuid)
                  if (!alreadyApplied) {
                    ds.addCodingToSelection(r.sourceGuid, r.selectionGuid, codeGuid)
                  }
                } else {
                  const selGuid = ds.addSelection(r.sourceGuid, r.startPosition, r.endPosition, r.matchedText)
                  ds.addCodingToSelection(r.sourceGuid, selGuid, codeGuid)
                }
              }
            }}
          />
        </Panel>
        )}
      </PanelGroup>

      {showNewCodeDialog && (
        <CodeEditDialog
          onSave={handleCreateCode}
          onClose={() => { setShowNewCodeDialog(false); setPendingCodeAllNewCode(false) }}
          initialColor={(() => {
            const presets = [
              '#e05050', '#e08050', '#e0c050', '#50c050', '#5080e0',
              '#8050e0', '#e050a0', '#50c0c0', '#c07030', '#7070e0',
              '#a0a040', '#40a0a0', '#a040a0', '#e07070', '#70b070'
            ]
            const allCodes = codeStore.flatCodes()
            if (allCodes.length === 0) return presets[0]
            const lastColor = allCodes[allCodes.length - 1]?.color
            const idx = lastColor ? presets.indexOf(lastColor) : -1
            return presets[(idx + 1) % presets.length]
          })()}
        />
      )}

      {showSaveQueryDialog && (
        <div className="modal-overlay" onClick={() => setShowSaveQueryDialog(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Save Query</h2>
            <div style={{ marginBottom: 12 }}>
              <input
                type="text"
                value={saveQueryName}
                onChange={(e) => setSaveQueryName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && saveQueryName.trim()) {
                    queryStore.saveCurrentQuery(saveQueryName.trim(), useQueryStore.getState().currentGraphLayout ?? undefined)
                    setShowSaveQueryDialog(false)
                  }
                }}
                placeholder="Query name..."
                autoFocus
                style={{ width: '100%' }}
              />
            </div>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setShowSaveQueryDialog(false)}>
                Cancel
              </button>
              <button
                onClick={() => {
                  if (saveQueryName.trim()) {
                    queryStore.saveCurrentQuery(saveQueryName.trim(), useQueryStore.getState().currentGraphLayout ?? undefined)
                    setShowSaveQueryDialog(false)
                  }
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      <ProjectDetailsDialog open={showProjectDetails} onClose={() => setShowProjectDetails(false)} />
      <LicenceDialog open={showLicenceDialog} onClose={() => setShowLicenceDialog(false)} />
      <UpdateDialog info={updateInfo} onDismiss={() => setUpdateInfo(null)} />

      {(() => {
        const source = documentStore.sources.find((s) => s.guid === documentStore.viewedDocumentGuid)
        if (!source) return null
        return (
          <FindDialog
            open={showFindDialog}
            sourceGuid={source.guid}
            sourceName={source.name}
            onClose={() => setShowFindDialog(false)}
          />
        )
      })()}

      {loadProgress && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 20000,
            backdropFilter: 'blur(2px)'
          }}
        >
          <div
            style={{
              background: 'var(--bg-primary)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-md, 8px)',
              padding: '20px 24px',
              width: 340,
              boxShadow: '0 10px 40px rgba(0,0,0,0.3)'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{loadProgress.stage}</span>
              {loadProgress.total > 0 && (
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  {loadProgress.current} / {loadProgress.total}
                </span>
              )}
            </div>
            <div
              style={{
                height: 6,
                background: 'var(--bg-tertiary, var(--border-color))',
                borderRadius: 3,
                overflow: 'hidden',
                position: 'relative'
              }}
            >
              {loadProgress.total > 0 ? (
                <div
                  style={{
                    height: '100%',
                    width: `${Math.min(100, Math.round((loadProgress.current / loadProgress.total) * 100))}%`,
                    background: 'var(--accent, #3b82f6)',
                    transition: 'width 0.15s ease-out'
                  }}
                />
              ) : (
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    height: '100%',
                    width: '35%',
                    background: 'var(--accent, #3b82f6)',
                    borderRadius: 3,
                    animation: 'magnolia-indeterminate 1.2s ease-in-out infinite'
                  }}
                />
              )}
            </div>
          </div>
          <style>{`
            @keyframes magnolia-indeterminate {
              0%   { left: -35%; }
              100% { left: 100%; }
            }
          `}</style>
        </div>
      )}

      {surveyImportQueue.length > 0 && (
        <SurveyImportDialog
          initial={surveyImportQueue[0].parsed}
          suggestedName={surveyImportQueue[0].suggestedName}
          rawCsv={surveyImportQueue[0].csv}
          detectedFormat={surveyImportQueue[0].detectedFormat}
          detectionConfident={surveyImportQueue[0].detectionConfident}
          onCancel={() => setSurveyImportQueue((prev) => prev.slice(1))}
          onConfirm={(survey) => {
            const head = surveyImportQueue[0]
            const formatData: SurveyFormatData = { survey, rawCsv: head.csv }
            const guid = documentStore.addSource(survey.name, head.csv, 'survey', formatData)
            if (head.folderGuid) {
              documentStore.moveSourceToFolder(guid, head.folderGuid)
            }
            setSurveyImportQueue((prev) => prev.slice(1))
          }}
        />
      )}
    </div>
  )
}

export default App
