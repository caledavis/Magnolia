/**
 * Tab IDs in the Document Viewer are opaque strings. Plain document tabs
 * use the source GUID directly. Tool tabs are namespaced so they coexist
 * in the same openTabs list and the same `viewedDocumentGuid` slot:
 *
 *   map:<mapGuid>                            — Relationship Map tabs
 *   analysis:<toolType>:<instanceId>         — analysis tool tabs
 *                                              (instanceId == saved guid for
 *                                              saved analyses; fresh guid for
 *                                              ad-hoc runs)
 *   query-builder:<instanceId>               — Query Builder tabs
 *
 * Consumers that do per-document work (e.g. "find the source for the active
 * tab") should call isToolTab() first and bail out.
 */

const MAP_TAB_PREFIX = 'map:'
const ANALYSIS_TAB_PREFIX = 'analysis:'
const QUERY_BUILDER_TAB_PREFIX = 'query-builder:'
/** Singleton id for the Preferences tab — there's only ever one
 *  open at a time, so a fixed id is enough (no per-instance suffix). */
export const PREFERENCES_TAB_ID = 'preferences'
/** Singleton id for the merge-review tab — only one comparison can be
 *  in progress at a time. */
export const MERGE_TAB_ID = 'merge'

export function makeMapTabId(guid: string): string {
  return `${MAP_TAB_PREFIX}${guid}`
}

export function isMapTab(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(MAP_TAB_PREFIX)
}

/** Returns the map guid if id is a map tab id, otherwise null. */
export function mapGuidFromTabId(id: string | null | undefined): string | null {
  return isMapTab(id) ? (id as string).slice(MAP_TAB_PREFIX.length) : null
}

export function makeAnalysisTabId(toolType: string, instanceId: string): string {
  return `${ANALYSIS_TAB_PREFIX}${toolType}:${instanceId}`
}

export function isAnalysisTab(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(ANALYSIS_TAB_PREFIX)
}

/** Returns { toolType, instanceId } for an analysis tab id, otherwise null.
 *  toolType strings can contain hyphens (e.g. "code-cooccurrences") so we
 *  split on the first colon only. */
export function parseAnalysisTabId(
  id: string | null | undefined
): { toolType: string; instanceId: string } | null {
  if (!isAnalysisTab(id)) return null
  const rest = (id as string).slice(ANALYSIS_TAB_PREFIX.length)
  const colon = rest.indexOf(':')
  if (colon < 0) return null
  return { toolType: rest.slice(0, colon), instanceId: rest.slice(colon + 1) }
}

export function makeQueryBuilderTabId(instanceId: string): string {
  return `${QUERY_BUILDER_TAB_PREFIX}${instanceId}`
}

export function isQueryBuilderTab(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(QUERY_BUILDER_TAB_PREFIX)
}

export function queryBuilderInstanceIdFromTabId(id: string | null | undefined): string | null {
  return isQueryBuilderTab(id) ? (id as string).slice(QUERY_BUILDER_TAB_PREFIX.length) : null
}

export function isPreferencesTab(id: string | null | undefined): boolean {
  return id === PREFERENCES_TAB_ID
}

export function isMergeTab(id: string | null | undefined): boolean {
  return id === MERGE_TAB_ID
}

/** True for any non-document tab id (map, analysis, query-builder, preferences, merge). */
export function isToolTab(id: string | null | undefined): boolean {
  return isMapTab(id) || isAnalysisTab(id) || isQueryBuilderTab(id) || isPreferencesTab(id) || isMergeTab(id)
}
