/**
 * The main window's side of its conversations with the other windows: what
 * each window sends it (each hook subscribes once and acts on the project's
 * stores), and what it keeps them up to date with.
 */
import { codeAllResults } from './code-results'
import { liveResolveFilter, useQueryStore } from '../stores/query-store'
import { narrowQueryToCell, queryForCell, type CellScope } from '../utils/narrow-query'
import { tagMembershipFromTags } from '../utils/survey-cell-scope'
import { useEffect, type MutableRefObject } from 'react'
import type { SurveyData, SurveyFormatData, QueryResultsInitData, AnalysisToolType, Query, CodeCondition } from '../models/types'
import { useProjectStore } from '../stores/project-store'
import { usePreferencesStore } from '../stores/preferences-store'
import { codeColourPresetsFor } from '../utils/code-colours'
import { useDocumentStore, surveyEntityKey } from '../stores/document-store'
import { useCodeStore } from '../stores/code-store'
import { useTagStore } from '../stores/tag-store'
import { useLogbookStore } from '../stores/logbook-store'
import { useMemoStore } from '../stores/memo-store'
import { useRelationshipMapStore } from '../stores/relationship-map-store'
import { generateGuid } from '../utils/guid'
import { useTranslation } from 'react-i18next'
import { memosWindowData, sendCodebookData, checkoutLockedByNow, deleteMemoEverywhere, openMemoEditor } from './other-windows'
import { describeQuery, withinQueries } from './query-description'
import { wordCondition, sentenceCondition } from '../components/Analysis/word-counts'
import { useSurveyViewStore } from '../stores/survey-view-store'
import { showMemoLocation } from '../utils/show-memo'

/** Act on what the logbook window does: add, edit and remove entries. */
export function useLogbookMessages(): void {
  // Listen for logbook updates from the logbook window
  useEffect(() => {
    const unsub = window.api.onLogbookUpdate(({ action, args }) => {
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
}

/** Act on the Codebook window's right-click menu and edits, mirroring
 *  the Codes pane, and send it the codes again after each change. */
export function useCodebookMessages(): void {
  const { t } = useTranslation()
  // Listen for codebook updates from the codebook window. Actions from
  // its right-click menu mirror the Codes pane's; each that changes the
  // codes sends the Codebook its codes again so it shows the change.
  useEffect(() => {
    const unsub = window.api.onCodebookUpdate(({ action, args }) => {
      const cs = useCodeStore.getState()
      const lockedMutation = ['rename-code', 'recolor-code', 'add-child-code', 'move-code-to-top', 'delete-code'].includes(action)
      if (lockedMutation && checkoutLockedByNow()) {
        useProjectStore.getState().promptCheckoutConflict()
        return
      }
      switch (action) {
        case 'rename-code': {
          const [guid, name] = args
          if (name.trim()) cs.renameCode(guid, name.trim())
          sendCodebookData()
          break
        }
        case 'recolor-code': {
          const [guid, color] = args
          cs.recolorCode(guid, color)
          sendCodebookData()
          break
        }
        case 'add-child-code': {
          // As in the Codes pane: a "New Code" in the parent's colour,
          // which the Codebook then opens for renaming.
          const [parentGuid] = args
          const parent = cs.findCode(parentGuid)
          const color = parent?.color || codeColourPresetsFor(usePreferencesStore.getState())[0]
          const guid = cs.addCode(t('codes.defaultName'), color, parentGuid)
          sendCodebookData(guid)
          break
        }
        case 'move-code-to-top': {
          const [guid] = args
          cs.moveCode(guid, null)
          sendCodebookData()
          break
        }
        case 'delete-code': {
          const [guid] = args
          cs.removeCode(guid)
          sendCodebookData()
          break
        }
        case 'show-in-all-documents': {
          const [codeGuid] = args
          useQueryStore.getState().setComplexQuery({ documentFilter: {}, codeCondition: { type: 'code', codeGuid } })
          break
        }
        case 'show-in-active-document': {
          const [codeGuid] = args
          const viewedGuid = useDocumentStore.getState().viewedDocumentGuid
          if (!viewedGuid) break
          useQueryStore.getState().setComplexQuery({ documentFilter: { sourceGuids: [viewedGuid] }, codeCondition: { type: 'code', codeGuid } })
          break
        }
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
  }, [t])
}

/** The memo windows: act on memo edits, deletions and the Memos window's
 *  actions, and keep the Memos window showing the project's memos.
 *  `saveProjectRef` saves the project now (memo windows save as they close). */
export function useMemoWindowMessages(saveProjectRef: MutableRefObject<() => unknown>): void {
  // Listen for memo updates from the memo edit window
  useEffect(() => {
    const unsub = window.api.onMemoUpdate((memo) => {
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
  }, [saveProjectRef])

  // Listen for memo deletes from the memo edit window. Mirrors the
  // memo-update flow: remove from the store, drop matching memo
  // elements from any relationship-map tab, then flush the project
  // so the deletion sticks.
  useEffect(() => {
    const unsub = window.api.onMemoDelete((guid: string) => {
      deleteMemoEverywhere(guid)
      setTimeout(() => { saveProjectRef.current() }, 0)
    })
    return unsub
  }, [saveProjectRef])

  // The Memos window's actions. Edits are refused with the checkout
  // prompt while someone else has the project, as in the Saved Memos pane.
  useEffect(() => {
    const unsub = window.api.onMemosWindowAction(({ action, args }) => {
      const memo = (guid: string) => useMemoStore.getState().findMemo(guid)
      if (action === 'show') {
        const m = memo(args[0])
        if (m) showMemoLocation(m)
        return
      }
      if (checkoutLockedByNow()) {
        useProjectStore.getState().promptCheckoutConflict()
        return
      }
      if (action === 'edit') {
        const m = memo(args[0])
        if (m) openMemoEditor(m)
      } else if (action === 'new') {
        openMemoEditor({ guid: generateGuid(), type: 'project', title: '', content: '', createdDateTime: new Date().toISOString() }, true)
      } else if (action === 'delete') {
        for (const guid of args[0]) deleteMemoEverywhere(guid)
        setTimeout(() => { saveProjectRef.current() }, 0)
      }
    })
    return unsub
  }, [saveProjectRef])

  // Keep the Memos window up to date (a no-op while it's closed): memos,
  // and the names of what they're attached to, change from many places.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const push = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; window.api.updateMemosWindow(memosWindowData()) }, 150)
    }
    const watch = <S, T>(store: { subscribe: (l: (s: S, p: S) => void) => () => void }, pick: (s: S) => T) =>
      store.subscribe((s, p) => { if (pick(s) !== pick(p)) push() })
    const unsubs = [
      watch(useMemoStore, (s) => s.memos),
      watch(useDocumentStore, (s) => s.sources),
      watch(useDocumentStore, (s) => s.sourceContents),
      watch(useQueryStore, (s) => s.savedQueries),
      watch(useProjectStore, (s) => s.savedAnalyses),
      watch(useProjectStore, (s) => s.checkoutMarker)
    ]
    return () => { unsubs.forEach((u) => u()); if (timer) clearTimeout(timer) }
  }, [])
}

/** Act on the Query Builder window: preview its query live, save it, and
 *  run its final query (updating a saved query in place, which then
 *  pulses in the Queries pane: `pulseSavedQuery`). */
export function useQueryBuilderMessages(pulseSavedQuery: (guid: string | null) => void): void {
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
        pulseSavedQuery(editSavedQueryGuid)
        setTimeout(() => pulseSavedQuery(null), 1500)
      } else {
        useQueryStore.getState().setComplexQuery(query, graphLayout)
      }
    })
    return unsub
  }, [pulseSavedQuery])
}

/** What the popped-out Query Results window asks of the main window, and
 *  what App does in reply: it pops back in, jumps to a result, edits,
 *  saves or clears the query, codes or selects every result, and works
 *  with the saved queries. */
export interface QueryResultsWindowHandlers {
  openQueryBuilder: (editSavedQueryGuid?: string, editCurrentQuery?: boolean) => void
  setPoppedOut: (poppedOut: boolean) => void
  setClosed: (closed: boolean) => void
  /** Open the Save Query dialog with this name. */
  askToSaveQuery: (defaultName: string) => void
  /** Open the New Code dialog, to code every result with the new code. */
  askForCodeForAll: () => void
}

/** Act on the popped-out Query Results window. */
export function useQueryResultsWindowMessages({ openQueryBuilder, setPoppedOut, setClosed, askToSaveQuery, askForCodeForAll }: QueryResultsWindowHandlers): void {
  // Listen for query results window close (pop back in)
  useEffect(() => {
    const unsub = window.api.onQueryResultsClosed(() => {
      setPoppedOut(false)
    })
    return unsub
  }, [setPoppedOut])

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
    const unsub = window.api.onQueryResultsAction(({ action, payload }) => {
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
        case 'close-panel':
          // The pop-out's × closes the pane too, as the popped-in one's does.
          setClosed(true)
          break
        case 'save-query': {
          const q = useQueryStore.getState().currentQuery
          const defaultName = q
            ? describeQuery(q, useCodeStore.getState().findCode, useDocumentStore.getState().sources, useTagStore.getState().tags)
            : ''
          askToSaveQuery(defaultName)
          break
        }
        case 'code-all-new-code':
          askForCodeForAll()
          break
        case 'code-all-existing-code':
          // As from the pane: every result gets the code.
          codeAllResults(payload.guid)
          break
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
  }, [openQueryBuilder, setClosed, askToSaveQuery, askForCodeForAll])
}

/** Act on the analysis tools (in their tabs or popped out): save and
 *  delete analyses, run the queries their cells and rows stand for, and
 *  open tools and saved analyses. */
/** Run a clicked number's query: `codeCondition` (and any `within`) in
 *  `docs` (none for all) under the tool's filter, narrowed to the clicked
 *  column (see queryForCell). */
function runCellQuery(codeCondition: CodeCondition, docs: string[] | undefined, scope: CellScope | undefined, within?: Query[]): void {
  const sources = useDocumentStore.getState().sources
  const sourceGuids = docs?.length ? docs : sources.map((s) => s.guid)
  const surveys = new Set(sources.filter((s) => s.sourceType === 'survey').map((s) => s.guid))
  const membership = tagMembershipFromTags(useTagStore.getState().tags)
  const query = queryForCell({ documentFilter: {}, codeCondition, ...(within ? { within } : {}) }, sourceGuids, scope, membership, surveys)
  if (query) useQueryStore.getState().setComplexQuery(query)
}

export function useAnalysisMessages(
  openAnalysis: (toolType: AnalysisToolType, config?: any) => void,
  openSavedAnalysis: (toolType: AnalysisToolType, savedConfig: any) => void
): void {
  // Listen for analysis actions (save, run-query)
  useEffect(() => {
    const unsub = window.api.onAnalysisAction(({ action, args }) => {
      if (action === 'save-analysis') {
        const [analysis] = args
        const ps = useProjectStore.getState()
        const existing = ps.savedAnalyses ?? []
        const idx = existing.findIndex((a) => a.guid === analysis.guid)
        const now = new Date().toISOString()
        const entry = {
          guid: analysis.guid,
          toolType: analysis.toolType,
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
        // Where two codes overlap, in the tool's documents and filter.
        const [codeGuidA, codeGuidB, filteredGuids, scope] = args
        runCellQuery({
          type: 'overlap',
          condition1: { type: 'code', codeGuid: codeGuidA },
          condition2: { type: 'code', codeGuid: codeGuidB }
        }, filteredGuids, scope)
      } else if (action === 'run-code-in-doc-query') {
        // A code in some documents (a column's, within the tool's).
        const [codeGuid, sourceGuids, filteredGuids, scope] = args
        const docs = filteredGuids?.length ? sourceGuids.filter((g) => filteredGuids.includes(g)) : sourceGuids
        runCellQuery({ type: 'code', codeGuid }, docs, scope)
      } else if (action === 'run-codes-in-doc-query') {
        // Any of several codes in some documents (a total).
        const [codeGuids, sourceGuids, scope] = args
        runCellQuery(codeGuids.length === 1
          ? { type: 'code', codeGuid: codeGuids[0] }
          : { type: 'or', conditions: codeGuids.map((g) => ({ type: 'code' as const, codeGuid: g })) }, sourceGuids, scope)
      } else if (action === 'open-framework-matrix') {
        // Codes in Documents → "Open as Framework Matrix": a fresh,
        // unsaved matrix seeded with the grid's codes and documents.
        const [config] = args
        openAnalysis('framework-matrix', config)
      } else if (action === 'run-query-in-docs') {
        // A saved query's results in a cell (or total) of Results in
        // Documents: the query as it is, narrowed to the cell, so it shows
        // what was counted there.
        const [query, sourceGuids, scope] = args
        const { documentFilter, noDocs } = liveResolveFilter(query.documentFilter)
        const membership = tagMembershipFromTags(useTagStore.getState().tags)
        const narrowed = noDocs ? null : narrowQueryToCell({ ...query, documentFilter }, { sourceGuids, scope }, membership)
        if (narrowed) useQueryStore.getState().setComplexQuery(narrowed)
      } else if (action === 'run-word-query') {
        // A word in the tool's documents, limited to coded passages, or
        // to saved queries' results, when the tool counted those.
        const [word, filteredGuids, scope, codes, queryGuids] = args
        runCellQuery(wordCondition(word, codes), filteredGuids, scope, withinQueries(queryGuids))
      } else if (action === 'run-sentence-query') {
        // The sentences containing both words (Word Combinations' associations).
        const [word1, word2, filteredGuids, scope, codes, queryGuids] = args
        runCellQuery(sentenceCondition(word1, word2, codes), filteredGuids, scope, withinQueries(queryGuids))
      } else if (action === 'open-document') {
        const [sourceGuid] = args
        useDocumentStore.getState().viewDocument(sourceGuid)
      } else if (action === 'view-document-at') {
        const [sourceGuid, startCp, endCp] = args
        useDocumentStore.getState().viewDocumentAt(sourceGuid, startCp, endCp)
      } else if (action === 'run-code-query') {
        const [codeGuid] = args
        const query: Query = {
          documentFilter: {},
          codeCondition: { type: 'code', codeGuid }
        }
        useQueryStore.getState().setComplexQuery(query)
      } else if (action === 'open-memo') {
        const [memoGuid] = args
        const memo = useMemoStore.getState().findMemo(memoGuid)
        if (memo) {
          window.api.openMemoEditWindow({
            memo,
            theme: document.documentElement.getAttribute('data-theme') || ''
          })
        }
      } else if (action === 'run-saved-query') {
        const [queryGuid] = args
        useQueryStore.getState().runSavedQuery(queryGuid)
      } else if (action === 'select-tag-documents') {
        const [tagGuid] = args
        const tag = useTagStore.getState().tags.find((t) => t.guid === tagGuid)
        if (tag) {
          useDocumentStore.getState().selectDocuments(new Set(tag.memberSourceGuids))
        }
      } else if (action === 'select-tag-category-documents') {
        const [categoryGuid] = args
        const tgStore = useTagStore.getState()
        const categoryTags = tgStore.tags.filter((t) => t.categoryGuid === categoryGuid)
        const allGuids = new Set<string>()
        for (const tag of categoryTags) {
          for (const guid of tag.memberSourceGuids) allGuids.add(guid)
        }
        useDocumentStore.getState().selectDocuments(allGuids)
      } else if (action === 'select-folder-documents') {
        const [folderGuid] = args
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
        const [toolType, savedConfig] = args
        // Callers from other analysis windows only know the guid/name — look
        // up the full saved config from the project store.
        let finalConfig = savedConfig
        if (savedConfig?.guid) {
          const ps = useProjectStore.getState()
          const sa = (ps.savedAnalyses ?? []).find((a) => a.guid === savedConfig.guid)
          if (sa) finalConfig = { ...sa.config, guid: sa.guid, name: sa.name }
        }
        openSavedAnalysis(toolType, finalConfig)
      }
    })
    return unsub
  }, [openSavedAnalysis, openAnalysis])
}

/** While Query Results is popped out, send its window the results, and
 *  everything it needs to show them, whenever they change. */
export function useQueryResultsWindowUpdates(poppedOut: boolean): void {
  const { t } = useTranslation()
  const results = useQueryStore((s) => s.results)
  const currentQuery = useQueryStore((s) => s.currentQuery)
  const isActive = useQueryStore((s) => s.isActive)
  const isLoading = useQueryStore((s) => s.isLoading)
  const savedQueries = useQueryStore((s) => s.savedQueries)
  const findCode = useCodeStore((s) => s.findCode)
  const sources = useDocumentStore((s) => s.sources)
  const tags = useTagStore((s) => s.tags)

  // Push live updates to popped-out query results window
  useEffect(() => {
    if (!poppedOut) return
    const qs = useQueryStore.getState()
    const theme = document.documentElement.getAttribute('data-theme') || ''
    const qName = qs.currentQuery
      ? (() => {
          const saved = qs.savedQueries.find(
            (sq) => JSON.stringify(sq.query) === JSON.stringify(qs.currentQuery)
          )
          return saved
            ? saved.name
            : describeQuery(qs.currentQuery!, findCode, sources, tags)
        })()
      : t('results.title')
    const isUnsaved = qs.isActive && qs.currentQuery
      ? !qs.savedQueries.some((sq) => JSON.stringify(sq.query) === JSON.stringify(qs.currentQuery))
      : false
    const docStore = useDocumentStore.getState()
    const cdStore = useCodeStore.getState()
    const sourceSelections: Record<string, any[]> = {}
    const pdfFilePaths: Record<string, string> = {}
    const pdfPageOffsets: Record<string, number[]> = {}
    const videoFilePaths: Record<string, string> = {}
    const videoMimeTypes: Record<string, string> = {}
    const surveysByGuid: Record<string, SurveyData> = {}
    for (const src of docStore.sources) {
      if (src.selections.length > 0) sourceSelections[src.guid] = src.selections
      const fp = (src as any).formatData?.pdfFilePath ?? (src as any).formatData?.imageFilePath
      if (fp) pdfFilePaths[src.guid] = fp
      const po = (src as any).formatData?.pdfPageOffsets
      if (po?.length) pdfPageOffsets[src.guid] = po
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
      isLoading: qs.isLoading,
      isUnsaved,
      theme,
      sourceSelections,
      surveysByGuid,
      pdfFilePaths,
      pdfPageOffsets,
      videoFilePaths,
      videoMimeTypes,
      codes,
      savedQueries: qs.savedQueries,
      currentQuery: qs.currentQuery ?? undefined
    }
    window.api.updateQueryResultsWindow(initData)
  }, [poppedOut, results, currentQuery, isActive, isLoading, savedQueries, findCode, sources, tags, t])
}
