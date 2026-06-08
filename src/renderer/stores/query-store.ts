import { create } from 'zustand'
import type { Query, QueryResult, SavedQuery } from '../models/types'
import { executeQuery } from '../utils/query-engine'
import { resolveDocGraph, type DocGraphData } from '../utils/document-graph'
import type { SurveyEntityRef } from '../models/types'
import { useDocumentStore } from './document-store'
import { useCodeStore } from './code-store'
import { useTagStore } from './tag-store'
import { generateGuid } from '../utils/guid'
import { useProjectStore } from './project-store'
import { makeHmrSafe } from './hmr-preserve'

interface QueryState {
  currentQuery: Query | null
  /** Code node graph for `currentQuery`, when it was authored in the
   *  Query Builder. Mirrors the document graph that now rides inside
   *  `currentQuery.documentFilter.graph`, but the code graph isn't part
   *  of the Query shape so it's tracked here. Lets "Edit current query"
   *  reopen the builder from the authored graph rather than re-deriving
   *  (and expanding "And subcodes") from the flattened condition. Null
   *  for queries set by drilldowns / Find, which carry no authored graph. */
  currentGraphLayout: { nodes: any[]; conns: any[] } | null
  results: QueryResult[]
  isActive: boolean
  /** Names of documents referenced by the current query that no longer exist */
  missingDocuments: string[]
  savedQueries: SavedQuery[]

  setComplexQuery: (query: Query, graphLayout?: { nodes: any[]; conns: any[] }) => void
  clearQuery: () => void
  runQuery: () => void
  /** Persists `currentQuery` as a SavedQuery. The optional `guid` lets
   *  callers (typically the Query Builder) supply a client-generated
   *  identifier so they can reference the saved query immediately,
   *  before the round-tripped savedQueries change re-renders the
   *  rest of the app. Falls back to a fresh guid when omitted. */
  saveCurrentQuery: (name: string, graphLayout?: { nodes: any[]; conns: any[] }, guid?: string) => string | null
  deleteSavedQuery: (guid: string) => void
  updateSavedQuery: (guid: string, query: Query, graphLayout?: { nodes: any[]; conns: any[] }) => void
  renameSavedQuery: (guid: string, name: string) => void
  runSavedQuery: (guid: string) => void
  setSavedQueries: (queries: SavedQuery[]) => void
  clearAll: () => void
}

/** Re-resolve a query's document filter against the CURRENT project data
 *  when it carries a selector graph, so saved filters are LIVE — they pick up
 *  newly-tagged documents (etc.) instead of being frozen to the doc set that
 *  matched at save time, matching how the code side now re-expands subcodes
 *  at run time. Returns the filter to execute with plus a `noDocs` flag: a
 *  graph that resolves to zero documents must produce no results, NOT fall
 *  through executeQuery's "empty sourceGuids = all documents" shortcut.
 *  Filters with no graph (drilldowns, legacy saves) pass through untouched. */
function liveResolveFilter(df: Query['documentFilter']): {
  documentFilter: Query['documentFilter']
  noDocs: boolean
} {
  const graph = df.graph
  if (!graph || !graph.nodes || graph.nodes.length === 0) return { documentFilter: df, noDocs: false }
  const docState = useDocumentStore.getState()
  const tagState = useTagStore.getState()
  const data: DocGraphData = {
    sources: docState.sources.map((s) => ({ guid: s.guid, name: s.name })),
    tags: tagState.tags.map((t) => ({ guid: t.guid, name: t.name, categoryGuid: t.categoryGuid, value: t.value })),
    tagMembers: tagState.tags.reduce((acc, t) => {
      acc[t.guid] = t.memberSourceGuids
      return acc
    }, {} as Record<string, string[]>),
    folders: docState.folders.map((f) => ({ guid: f.guid, name: f.name, parentGuid: f.parentGuid ?? null })),
    sourceFolder: docState.sourceFolder,
    respondentTagMembers: tagState.tags.reduce((acc, t) => {
      if (t.memberSurveyRespondents?.length) acc[t.guid] = t.memberSurveyRespondents
      return acc
    }, {} as Record<string, SurveyEntityRef[]>),
    questionTagMembers: tagState.tags.reduce((acc, t) => {
      if (t.memberSurveyQuestions?.length) acc[t.guid] = t.memberSurveyQuestions
      return acc
    }, {} as Record<string, SurveyEntityRef[]>)
  }
  const fresh = resolveDocGraph(graph.nodes, graph.conns, data)
  if (fresh.length === 0) return { documentFilter: { ...df, sourceGuids: [] }, noDocs: true }
  return { documentFilter: { ...df, sourceGuids: fresh }, noDocs: false }
}

/** Run a query against current data with the document filter re-resolved
 *  live (see liveResolveFilter). */
function runQueryLive(query: Query): { results: QueryResult[]; missingDocuments: string[] } {
  const docState = useDocumentStore.getState()
  const { documentFilter, noDocs } = liveResolveFilter(query.documentFilter)
  // "Missing documents" only applies to frozen (graph-less) filters. A
  // graph-based filter re-resolves against current docs, so a deleted doc
  // just drops out — nothing is missing.
  const missingDocuments: string[] = []
  if (!query.documentFilter.graph && query.documentFilter.sourceGuids?.length) {
    const existing = new Set(docState.sources.map((s) => s.guid))
    for (const sg of query.documentFilter.sourceGuids) if (!existing.has(sg)) missingDocuments.push(sg)
  }
  const results = noDocs
    ? []
    : executeQuery(
        { ...query, documentFilter },
        docState.sources,
        docState.sourceContents,
        useCodeStore.getState().flatCodes(),
        useTagStore.getState().tags,
        docState.sourceFolder,
        docState.folders
      )
  return { results, missingDocuments }
}

export const useQueryStore = create<QueryState>((set, get) => ({
  currentQuery: null,
  currentGraphLayout: null,
  results: [],
  isActive: false,
  missingDocuments: [],
  savedQueries: [],

  setComplexQuery: (query, graphLayout) => {
    // `currentQuery` keeps the AUTHORED query (graph + the original resolved
    // snapshot); execution re-resolves the document filter live so results
    // reflect the current project, not the doc set frozen at save time.
    const { results, missingDocuments } = runQueryLive(query)
    // Track the authored code graph alongside the query. Pass null when
    // no graph is supplied (drilldowns, Find) so "Edit current query"
    // doesn't restore a stale graph from a previous builder session.
    set({ currentQuery: query, currentGraphLayout: graphLayout ?? null, isActive: true, results, missingDocuments })
  },

  clearQuery: () => set({ currentQuery: null, currentGraphLayout: null, results: [], isActive: false, missingDocuments: [] }),

  runQuery: () => {
    const { currentQuery } = get()
    if (!currentQuery) {
      set({ results: [], missingDocuments: [] })
      return
    }
    // Re-resolve the document filter live on every run — this is also what
    // the auto-rerun (on code/doc/tag changes) calls, so a saved tag-based
    // query reflects newly-tagged documents without re-opening it.
    const { results, missingDocuments } = runQueryLive(currentQuery)
    set({ results, missingDocuments })
  },

  saveCurrentQuery: (name, graphLayout, guid) => {
    const { currentQuery } = get()
    if (!currentQuery) return null
    const finalGuid = guid ?? generateGuid()
    const saved: SavedQuery = {
      guid: finalGuid,
      name,
      query: currentQuery,
      createdDateTime: new Date().toISOString(),
      graphLayout
    }
    set((state) => ({ savedQueries: [...state.savedQueries, saved] }))
    useProjectStore.getState().markDirty()
    return finalGuid
  },

  deleteSavedQuery: (guid) => {
    set((state) => ({
      savedQueries: state.savedQueries.filter((q) => q.guid !== guid)
    }))
    // Cascade: drop the saved-query memo (if any) so it doesn't
    // become an orphan invisible everywhere in the UI. Lazy import
    // breaks the circular dependency between memo-store and
    // query-store.
    import('./memo-store').then(({ useMemoStore }) => {
      const m = useMemoStore.getState().memos.find(
        (m) => m.type === 'saved-query' && m.queryGuid === guid
      )
      if (m) useMemoStore.getState().removeMemo(m.guid)
    }).catch(() => { /* ignore — tests or ssr may not have this */ })
    useProjectStore.getState().markDirty()
  },

  updateSavedQuery: (guid, query, graphLayout) => {
    set((state) => ({
      savedQueries: state.savedQueries.map((q) =>
        q.guid === guid ? { ...q, query, ...(graphLayout !== undefined ? { graphLayout } : {}) } : q
      )
    }))
    useProjectStore.getState().markDirty()
  },

  renameSavedQuery: (guid, name) => {
    set((state) => ({
      savedQueries: state.savedQueries.map((q) =>
        q.guid === guid ? { ...q, name } : q
      )
    }))
    useProjectStore.getState().markDirty()
  },

  runSavedQuery: (guid) => {
    const saved = get().savedQueries.find((q) => q.guid === guid)
    if (!saved) return
    // Use setComplexQuery which handles missing document detection. Carry
    // the saved code graph through so a later "Edit current query" reopens
    // from the authored graph, not a re-derived one. The document graph
    // already rides inside saved.query.documentFilter.graph.
    get().setComplexQuery(saved.query, saved.graphLayout)
  },

  setSavedQueries: (queries) => set({ savedQueries: queries }),

  clearAll: () => set({ currentQuery: null, currentGraphLayout: null, results: [], isActive: false, savedQueries: [] })
}))

makeHmrSafe('queryStore', useQueryStore)

// Auto re-run the active query whenever its inputs change. Without this
// the Query Results panel shows a snapshot frozen at the moment the
// user last clicked Run — coding new text, removing a coding, renaming
// a code, deleting a doc, or changing a tag wouldn't move a row in or
// out of the visible results until the user re-ran the query manually.
//
// We gate on currentQuery + isActive so re-runs only happen when the
// panel is actually showing something. The check is cheap; query
// execution scales with project size but is in-process and runs on
// store mutations the user is making themselves, so they're already
// paying for the work.
//
// Note: useQuoteStore is not subscribed because query-engine.ts doesn't
// read quotes — quote add/edit/delete affects the Quotes pane only.
function rerunIfActive(): void {
  const s = useQueryStore.getState()
  if (s.currentQuery && s.isActive) s.runQuery()
}
useDocumentStore.subscribe((state, prev) => {
  if (state.sources === prev.sources &&
      state.sourceContents === prev.sourceContents &&
      state.sourceFolder === prev.sourceFolder &&
      state.folders === prev.folders) return
  rerunIfActive()
})
useCodeStore.subscribe((state, prev) => {
  if (state.codes === prev.codes) return
  rerunIfActive()
})
useTagStore.subscribe((state, prev) => {
  if (state.tags === prev.tags) return
  rerunIfActive()
})
