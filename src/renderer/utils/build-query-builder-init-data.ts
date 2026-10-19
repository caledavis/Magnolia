/**
 * Builds the QueryBuilderInitData payload from current Zustand stores.
 * Single source of truth for what the Query Builder needs to render
 * when InlineAnalysisTab mounts it.
 *
 * Mirrors build-analysis-init-data.ts but for the Query Builder's
 * different shape (no per-source content, no tag members keyed in the
 * same way, but adds savedQueries-style edit fields).
 */
import type { Code, QueryBuilderInitData } from '../models/types'
import { buildSurveyEntityLabels } from './survey/survey-labels'
import { useDocumentStore } from '../stores/document-store'
import { useCodeStore } from '../stores/code-store'
import { useTagStore } from '../stores/tag-store'
import { useQueryStore, flushPendingQueryLayout } from '../stores/query-store'

function flattenCodesWithParent(
  codes: Code[],
  parentGuid?: string
): { guid: string; name: string; color?: string; isCodable: boolean; parentGuid?: string }[] {
  const out: { guid: string; name: string; color?: string; isCodable: boolean; parentGuid?: string }[] = []
  for (const c of codes) {
    out.push({ guid: c.guid, name: c.name, color: c.color, isCodable: c.isCodable, parentGuid })
    out.push(...flattenCodesWithParent(c.children, c.guid))
  }
  return out
}

export function buildQueryBuilderInitData(opts?: {
  editSavedQueryGuid?: string
  editCurrentQuery?: boolean
}): QueryBuilderInitData {
  const docStore = useDocumentStore.getState()
  const cdStore = useCodeStore.getState()
  const tgStore = useTagStore.getState()
  // Reopening the builder reads the current query's layout; apply any
  // node move still being held back from the store first.
  flushPendingQueryLayout()
  const qStore = useQueryStore.getState()

  const initData: QueryBuilderInitData = {
    sources: docStore.sources.map((s) => ({ guid: s.guid, name: s.name, sourceType: s.sourceType })),
    folders: docStore.folders.map((f) => ({ guid: f.guid, name: f.name, parentGuid: f.parentGuid ?? null })),
    sourceFolder: docStore.sourceFolder,
    codes: flattenCodesWithParent(cdStore.codes),
    tags: tgStore.tags.map((t) => ({ guid: t.guid, name: t.name, categoryGuid: t.categoryGuid, value: t.value })),
    categories: tgStore.categories.map((c) => ({ guid: c.guid, name: c.name, type: c.type, listOptions: c.listOptions })),
    tagMembers: tgStore.tags.reduce((acc, t) => {
      acc[t.guid] = t.memberSourceGuids
      return acc
    }, {} as Record<string, string[]>),
    respondentTagMembers: tgStore.tags.reduce((acc, t) => {
      if (t.memberSurveyRespondents?.length) acc[t.guid] = t.memberSurveyRespondents
      return acc
    }, {} as Record<string, import('../models/types').SurveyEntityRef[]>),
    questionTagMembers: tgStore.tags.reduce((acc, t) => {
      if (t.memberSurveyQuestions?.length) acc[t.guid] = t.memberSurveyQuestions
      return acc
    }, {} as Record<string, import('../models/types').SurveyEntityRef[]>),
    surveyEntityLabels: buildSurveyEntityLabels(docStore.sources),
    priorQuery: qStore.currentQuery
  }
  if (opts?.editSavedQueryGuid) {
    const sq = qStore.savedQueries.find((q) => q.guid === opts.editSavedQueryGuid)
    if (sq) {
      initData.editSavedQueryGuid = sq.guid
      initData.editQuery = sq.query
      initData.editGraphLayout = sq.graphLayout
    }
  } else if (opts?.editCurrentQuery && qStore.currentQuery) {
    initData.editQuery = qStore.currentQuery
    // Restore the authored code graph (when the current query came from
    // the builder) so reopening doesn't re-derive nodes from the
    // flattened condition — which would re-expand an "And subcodes"
    // parent into one node per subcode. The document graph travels
    // inside editQuery.documentFilter.graph.
    initData.editGraphLayout = qStore.currentGraphLayout ?? undefined
  }
  ;(initData as any).theme = document.documentElement.getAttribute('data-theme') || ''
  return initData
}
