/**
 * InlineAnalysisTab — host wrapper for any in-tab tool that hangs off
 * the analysis-tabs-store: the six analysis tools (CodeFrequencies /
 * CodesInDocuments / ResultsInDocuments / CodeOrders / CodeCoOccurrences
 * / WordFrequencies) plus the Query Builder. Relationship Maps have their
 * own InlineRelationshipMap because they're backed by a different store.
 *
 * Responsibilities:
 *  - Build the tool's init payload from current stores (no IPC; this
 *    lives in the renderer that owns the stores).
 *  - Resolve savedConfig (analysis tools): from project.savedAnalyses if
 *    the tab is backed by a SavedAnalysis, otherwise from the per-tab
 *    adhoc config in analysis-tabs-store.



 *  - inTab callbacks: onClose closes the tab; onSaved stamps
 *    savedAnalysisGuid + title onto the existing instance. The tab id
 *    is NOT renamed (that would remount the tool component and race
 *    with the IPC roundtrip that populates project.savedAnalyses).
 */
import { useMemo } from 'react'
import { useAnalysisTabsStore, type ToolKind } from '../../stores/analysis-tabs-store'
import { useDocumentStore } from '../../stores/document-store'
import { useProjectStore } from '../../stores/project-store'
import { buildAnalysisInitData } from '../../utils/build-analysis-init-data'
import { buildQueryBuilderInitData } from '../../utils/build-query-builder-init-data'
import { CodeCoOccurrences } from './CodeCoOccurrences'
import { CodesInDocuments } from './CodesInDocuments'
import { FrameworkMatrix } from './FrameworkMatrix'
import { CodeFrequencies } from './CodeFrequencies'
import { CodeOrders } from './CodeOrders'
import { WordFrequencies } from './WordFrequencies'
import { ResultsInDocuments } from './ResultsInDocuments'
import { Reports } from './Reports'
import { QueryBuilderWindow } from '../QueryBuilder/QueryBuilderWindow'
import { MemoFab } from '../Memos/MemoFab'
import type { AnalysisToolType } from '../../models/types'

interface Props {
  tabId: string
}

export function InlineAnalysisTab({ tabId }: Props) {
  const instance = useAnalysisTabsStore((s) => s.instances[tabId])
  const savedAnalyses = useProjectStore((s) => s.savedAnalyses)

  const isQueryBuilder = instance?.toolType === 'query-builder'

  // Build the per-render init payload. Analysis tools use AnalysisInitData;
  // Query Builder uses QueryBuilderInitData. The tools own their internal
  // state via useState — these payloads are read-only input.
  const analysisData = useMemo(() => {
    if (!instance || isQueryBuilder) return null
    return buildAnalysisInitData(instance.toolType as AnalysisToolType, {
      savedConfig: resolveSavedConfig(instance, savedAnalyses ?? [])
    })
    // Re-derive only when the tool identity / saved analyses change — NOT on
    // every ad-hoc config write. A tool reads savedConfig once on mount and
    // gets live store data from useLiveAnalysisData, so rebuilding on each
    // config write (e.g. a Report persisting its items per edit) would be
    // wasted work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance?.toolType, instance?.savedAnalysisGuid, savedAnalyses, isQueryBuilder])

  const queryBuilderData = useMemo(() => {
    if (!instance || !isQueryBuilder) return null
    // For an ad-hoc Query Builder tab the config snapshot persisted in
    // analysis-tabs-store carries editSavedQueryGuid / editCurrentQuery
    // hints; fall back to a fresh build when there's no snapshot.
    return buildQueryBuilderInitData({
      editSavedQueryGuid: instance.config?.editSavedQueryGuid,
      editCurrentQuery: instance.config?.editCurrentQuery
    })
  }, [instance, isQueryBuilder])

  if (!instance) return null
  const toolType = instance.toolType as ToolKind

  const handleClose = () => {
    useDocumentStore.getState().closeToolTab(tabId)
    useAnalysisTabsStore.getState().remove(tabId)
  }

  const handleSaved = (savedGuid: string, name: string) => {
    // Don't rename the tab id — that would remount the tool component and
    // race with the savedAnalyses IPC roundtrip. Stamp savedAnalysisGuid
    // + title on the existing instance instead. Single-tab-per-saved-
    // analysis enforcement in openSavedAnalysis searches by guid, not id.
    const ats = useAnalysisTabsStore.getState()
    if (savedGuid) ats.setSavedGuid(tabId, savedGuid)
    if (name) ats.setTitle(tabId, name)
    // A fresh save means the tool has matched its baseline — clear the
    // unsaved-changes flag in case the tool's onDirtyChange callback
    // hasn't fired yet (the baseline update + dirty-recompute happen on
    // the same render the tool reports the save).
    ats.setDirty(tabId, false)
  }

  const handleDirtyChange = (dirty: boolean) => {
    useAnalysisTabsStore.getState().setDirty(tabId, dirty)
  }

  const inTab = { onClose: handleClose, onSaved: handleSaved, onDirtyChange: handleDirtyChange, tabId }

  // The MemoFab is always rendered for tool tabs. When a saved guid
  // exists (saved analysis / saved query), the FAB targets that —
  // memos attach by guid. When the tab is unsaved (a fresh analysis
  // or a brand-new query), the FAB still shows in a ghost state and
  // tells the user to save first when clicked, so the user always
  // knows where to find it.
  const fabKind: 'saved-analysis' | 'saved-query' = isQueryBuilder ? 'saved-query' : 'saved-analysis'
  const fabTargetGuid: string | undefined = isQueryBuilder
    ? instance?.config?.editSavedQueryGuid
    : instance?.savedAnalysisGuid

  // No header bar — the tab itself carries the title and the Pop-out
  // affordance lives in the tab next to the X. The tool fills the
  // available area edge-to-edge.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', position: 'relative' }}>
      {isQueryBuilder
        ? (queryBuilderData
            ? <QueryBuilderWindow
                initData={queryBuilderData}
                inTab={{
                  onClose: handleClose,
                  onSaved: (n, savedGuid) => {
                    // Stamp the saved-query identity onto this tab
                    // instance so (a) the "Edit this saved query"
                    // navigation finds the existing tab via the
                    // savedAnalysisGuid match in App.tsx, and (b) the
                    // tab's config carries editSavedQueryGuid so a
                    // project-reload rehydrates the same saved query
                    // back into this builder.
                    handleSaved(savedGuid ?? '', n)
                    if (savedGuid) {
                      const ats = useAnalysisTabsStore.getState()
                      const cur = ats.instances[tabId]
                      if (cur) {
                        ats.setConfig(tabId, { ...(cur.config ?? {}), editSavedQueryGuid: savedGuid })
                      }
                    }
                  },
                  onDirtyChange: handleDirtyChange,
                  tabId
                }}
              />
            : null)
        : (analysisData
            ? dispatch(
                toolType as AnalysisToolType,
                analysisData,
                instance.savedAnalysisGuid ? analysisData.savedConfig : (instance.config ?? analysisData.savedConfig),
                inTab
              )
            : null)}
      <MemoFab kind={fabKind} targetGuid={fabTargetGuid} />
    </div>
  )
}

function resolveSavedConfig(
  instance: { savedAnalysisGuid?: string; config?: any },
  savedAnalyses: { guid: string; name: string; toolType: string; config: any }[]
): any | undefined {
  if (instance.savedAnalysisGuid) {
    const sa = savedAnalyses.find((a) => a.guid === instance.savedAnalysisGuid)
    if (sa) return { ...sa.config, guid: sa.guid, name: sa.name }
    return undefined
  }
  return instance.config
}

function dispatch(
  toolType: AnalysisToolType,
  data: any,
  savedConfig: any,
  inTab: {
    onClose: () => void
    onSaved: (savedGuid: string, name: string) => void
    onDirtyChange?: (dirty: boolean) => void
    tabId?: string
  }
) {
  switch (toolType) {
    case 'code-cooccurrences':
      return <CodeCoOccurrences data={data} savedConfig={savedConfig} inTab={inTab} />
    case 'codes-in-documents':
      return <CodesInDocuments data={data} savedConfig={savedConfig} inTab={inTab} />
    case 'framework-matrix':
      return <FrameworkMatrix data={data} savedConfig={savedConfig} inTab={inTab} />
    case 'results-in-documents':
      return <ResultsInDocuments data={data} savedConfig={savedConfig} inTab={inTab} />
    case 'code-frequencies':
      return <CodeFrequencies data={data} savedConfig={savedConfig} inTab={inTab} />
    case 'code-orders':
      return <CodeOrders data={data} savedConfig={savedConfig} inTab={inTab} />
    case 'word-frequencies':
      return <WordFrequencies data={data} savedConfig={savedConfig} inTab={inTab} />
    case 'reports':
      return <Reports data={data} savedConfig={savedConfig} inTab={inTab} />
    default:
      return <div style={{ padding: 20, color: 'var(--text-muted)' }}>Unknown tool: {toolType}</div>
  }
}
