/**
 * The project as it is saved: gathered from the stores.
 */
import { useProjectStore } from '../stores/project-store'
import { useDocumentStore } from '../stores/document-store'
import { useCodeStore } from '../stores/code-store'
import { tagsWithMembersIn, useTagStore } from '../stores/tag-store'
import { useQueryStore } from '../stores/query-store'
import { useLogbookStore } from '../stores/logbook-store'
import { useMemoStore } from '../stores/memo-store'
import { useQuoteStore } from '../stores/quote-store'
import { useAnalysisTabsStore } from '../stores/analysis-tabs-store'
import { isAnalysisTab, isMapTab, isQueryBuilderTab, isNotebookTab, notebookGuidFromTabId, mapGuidFromTabId, parseAnalysisTabId } from '../utils/tab-ids'
import type { PersistedTab, PersistedTabState } from '../models/types'
import type { Project } from '../models/types'

/** The project, from the stores, as it is saved: with its open tabs, so
 *  it reopens as it was left. */
export function collectProject(): Project {
  const projectStore = useProjectStore.getState()
  const documentStore = useDocumentStore.getState()
  const codeStore = useCodeStore.getState()
  const tagStore = useTagStore.getState()
  const sourceGuids = new Set(documentStore.sources.map((s) => s.guid))
  const ats = useAnalysisTabsStore.getState()
  const ds = documentStore
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
    if (isNotebookTab(id)) {
      return { id, kind: 'notebook', folderGuid: notebookGuidFromTabId(id) ?? '' }
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
    description: projectStore.description,
    creatingUserGUID: projectStore.creatingUserGUID,
    creationDateTime: projectStore.creationDateTime,
    modifyingUserGUID: projectStore.modifyingUserGUID,
    modifiedDateTime: projectStore.modifiedDateTime,
    users: projectStore.users,
    codes: codeStore.codes,
    sources: documentStore.sources,
    sets: tagsWithMembersIn(tagStore.tags, (guid) => sourceGuids.has(guid)),
    notes: [],
    tagCategories: tagStore.categories,
    savedQueries: useQueryStore.getState().savedQueries,
    logbookEntries: useLogbookStore.getState().entries,
    memos: useMemoStore.getState().memos,
    quotes: useQuoteStore.getState().quotes,
    savedAnalyses: projectStore.savedAnalyses,
    folders: documentStore.folders,
    sourceFolder: documentStore.sourceFolder,
    tabState
  }
}
