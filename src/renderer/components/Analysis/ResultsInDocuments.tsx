import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import type { AnalysisInitData, Query, QueryResult, SurveyEntityRef, SurveyCellScopeArgs } from '../../models/types'
import { Icon, faFileSearchCorner, faChevronDown, faChevronRight, faXmark } from '../Icon'
import { toolColors } from '../../utils/tool-colors'
import { executeQuery } from '../../utils/query-engine'
import { truncate, toCsv, pctOfTotal, binarizeGrid, applySurveyCellScope } from './analysis-helpers'
import { generateGuid } from '../../utils/guid'
import {
  parseGroupByDrop,
  mergeGroupBy,
  groupByKey,
  GroupByChips
} from './group-by'
import {
  buildSurveyAwareColumns,
  hasSurveyInScope,
  QuestionScopeBox,
  type QuestionScopeRef
} from './survey-grouping'
import { useLiveAnalysisData } from './use-live-analysis-data'
import { EditableTitleSuffix } from '../EditableTitleSuffix'
import { renameSavedAnalysis } from '../../utils/rename-saved-analysis'
import { useToolDirtyState } from '../../hooks/use-tool-dirty-state'
import { useRegisterToolSave } from '../../hooks/use-register-tool-save'

/** Each "Group by" entry is one of:
 *   - a single tag → one row in the grid;
 *   - a category → one row per child tag, with a spanning category
 *     header and a subtotal row at the bottom of the band;
 *   - a folder → one row per descendant document, with a spanning
 *     folder header and a subtotal row.
 *  Sub-folders are flattened into the same band; if the user wants a
 *  per-sub-folder breakdown, they can drop those sub-folders separately. */
type GroupByEntry =
  | { kind: 'tag'; tagGuid: string }
  | { kind: 'category'; categoryGuid: string }
  | { kind: 'folder'; folderGuid: string }
  // Each in-scope survey becomes a band of its respondents.
  | { kind: 'respondents' }

interface Props {
  data: AnalysisInitData
  savedConfig?: {
    queryGuids: string[]
    /** New shape — tags or categories, in user-chosen order. */
    groupBy?: GroupByEntry[]
    /** Legacy shape, pre-category support. Migrated on load. */
    groupByTags?: string[]
    /** Survey questions the analysis is scoped to (empty = all). */
    questionScope?: QuestionScopeRef[]
    guid: string
    name: string
  }
  inTab?: {
    onClose: () => void
    onSaved: (savedGuid: string, name: string) => void
    onDirtyChange?: (dirty: boolean) => void
    tabId?: string
  }
}

function parseQueryDrag(e: React.DragEvent): { guid: string; name: string }[] {
  const json = e.dataTransfer.getData('application/x-magnolia-query')
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch { return [] }
}

function isQueryDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes('application/x-magnolia-query')
}

export function ResultsInDocuments({ data: propData, savedConfig, inTab }: Props) {
  const live = useLiveAnalysisData()
  const [questionScope, setQuestionScope] = useState<QuestionScopeRef[]>(savedConfig?.questionScope ?? [])
  const data = useMemo(() => {
    const base = { ...propData, ...live }
    // Scope survey selections to the chosen questions so query results
    // (built from these selections) honour the Questions box.
    return questionScope.length > 0 ? applySurveyCellScope(base, { questionScope }) : base
  }, [propData, live, questionScope])
  // Once the user removes the auto-added Respondents grouping, don't
  // re-seed it (they can drag it back from the Document Browser).
  const respondentsDismissed = useRef(false)
  const [queryGuids, setQueryGuids] = useState<string[]>(savedConfig?.queryGuids ?? [])
  // Initial group-by state. Prefer the new `groupBy` if present, else
  // migrate the legacy `groupByTags` (string[] of tag guids) into the
  // tagged-union shape. Saved analyses created before category support
  // still load correctly; new saves only write `groupBy`.
  const [groupBy, setGroupBy] = useState<GroupByEntry[]>(() => {
    if (savedConfig?.groupBy) return savedConfig.groupBy
    if (savedConfig?.groupByTags) {
      return savedConfig.groupByTags.map((tagGuid) => ({ kind: 'tag', tagGuid }) as const)
    }
    return []
  })
  const [visualMode, setVisualMode] = useState(false)
  const [binaryMode, setBinaryMode] = useState(false)
  const [dropOver, setDropOver] = useState(false)
  const [tagDropOver, setTagDropOver] = useState(false)
  const [analysisGuid] = useState(savedConfig?.guid ?? generateGuid())
  const [analysisName, setAnalysisName] = useState(savedConfig?.name ?? '')
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const isExisting = !!savedConfig?.guid

  // Dirty tracking (see useToolDirtyState).
  const currentConfig = useMemo(
    () => ({ queryGuids, groupBy, questionScope }),
    [queryGuids, groupBy, questionScope]
  )
  const initialBaseline = useMemo(() => {
    let initialGroupBy: GroupByEntry[] = []
    if (savedConfig?.groupBy) initialGroupBy = savedConfig.groupBy
    else if (savedConfig?.groupByTags) {
      initialGroupBy = savedConfig.groupByTags.map((tagGuid) => ({ kind: 'tag' as const, tagGuid }))
    }
    return {
      queryGuids: savedConfig?.queryGuids ?? [],
      groupBy: initialGroupBy,
      questionScope: savedConfig?.questionScope ?? []
    }
  }, [])
  const { dirty, baseline, setBaseline } = useToolDirtyState(currentConfig, initialBaseline, inTab)

  const handleDiscard = useCallback(() => {
    setQueryGuids(baseline.queryGuids)
    setGroupBy(baseline.groupBy)
    setQuestionScope(baseline.questionScope ?? [])
  }, [baseline])

  // Map saved query guids to their definitions
  const queryMap = useMemo(() => {
    const m = new Map<string, { name: string; query?: Query }>()
    for (const sq of data.savedQueries || []) {
      m.set(sq.guid, { name: sq.name, query: sq.query })
    }
    return m
  }, [data.savedQueries])

  const sourceMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of data.sources) m.set(s.guid, s.name)
    return m
  }, [data.sources])

  // Build sources/codes in format executeQuery expects
  const execSources = useMemo(() => data.sources.map((s) => ({
    guid: s.guid,
    name: s.name,
    selections: (data.sourceSelections[s.guid] || []).map((sel: any) => ({
      ...sel,
      codings: sel.codings || []
    })),
    creatingUser: '',
    creationDateTime: '',
    modifyingUser: '',
    modifiedDateTime: ''
  })), [data.sources, data.sourceSelections])

  const execCodes = useMemo(() => data.codes.map((c) => ({
    guid: c.guid,
    name: c.name,
    color: c.color,
    isCodable: c.isCodable,
    children: []
  })), [data.codes])

  const execTags = useMemo(() => data.tags.map((t) => ({
    guid: t.guid,
    name: t.name,
    memberSourceGuids: data.tagMembers[t.guid] || []
  })), [data.tags, data.tagMembers])

  const execFolders = useMemo(() => (data.folders || []).map((f) => ({
    guid: f.guid,
    name: f.name,
    parentGuid: f.parentGuid
  })), [data.folders])

  // Execute each query and cache results; track missing documents
  const { queryResults, missingDocCount } = useMemo(() => {
    const map = new Map<string, QueryResult[]>()
    const existingGuids = new Set(data.sources.map((s) => s.guid))
    let missing = 0
    for (const qGuid of queryGuids) {
      const sq = queryMap.get(qGuid)
      if (!sq?.query) continue
      if (sq.query.documentFilter.sourceGuids?.length) {
        for (const sg of sq.query.documentFilter.sourceGuids) {
          if (!existingGuids.has(sg)) missing++
        }
      }
      const results = executeQuery(
        sq.query,
        execSources as any,
        data.sourceContents,
        execCodes as any,
        execTags as any,
        data.sourceFolder,
        execFolders
      )
      map.set(qGuid, results)
    }
    return { queryResults: map, missingDocCount: missing }
  }, [queryGuids, queryMap, execSources, data.sourceContents, data.sources, execCodes, execTags, data.sourceFolder, execFolders])

  // Columns: union of all documents that appear in any query's results
  const resultSourceGuids = useMemo(() => {
    const guids = new Set<string>()
    for (const results of queryResults.values()) {
      for (const r of results) guids.add(r.sourceGuid)
    }
    return Array.from(guids)
  }, [queryResults])

  // Column build via the shared, survey-aware builder. Candidate sources
  // are the documents that appear in any query's results; surveys among
  // them expand into per-respondent bands when "Respondents" is active.
  const { columns, headerGroups, hasGroupedHeader } = useMemo(
    () => buildSurveyAwareColumns(groupBy, data, resultSourceGuids, sourceMap),
    [resultSourceGuids, groupBy, data, sourceMap]
  )

  // Auto-add "Respondents" grouping when survey results first appear on a
  // fresh, never-saved analysis; removing the chip prevents re-adding.
  useEffect(() => {
    if (respondentsDismissed.current || savedConfig) return
    if (groupBy.some((e) => e.kind === 'respondents')) return
    if (hasSurveyInScope(resultSourceGuids, data)) {
      setGroupBy((p) => mergeGroupBy(p, [{ kind: 'respondents' }]))
    }
  }, [resultSourceGuids, data, groupBy, savedConfig])

  // Grid: queryGuids.length rows × columns.length cols. A respondent
  // column counts only the results from that respondent's cells (query
  // results carry surveyCell.respondentId); other columns match by
  // source guid as before.
  const grid = useMemo(() => {
    return queryGuids.map((qGuid) => {
      const results = queryResults.get(qGuid) || []
      return columns.map((col) => {
        if (col.respondentRef) {
          const { sourceGuid, id } = col.respondentRef
          return results.filter((r) => r.sourceGuid === sourceGuid && r.surveyCell?.respondentId === id).length
        }
        const colGuids = new Set(col.sourceGuids)
        return results.filter((r) => colGuids.has(r.sourceGuid)).length
      })
    })
  }, [queryGuids, queryResults, columns])

  // Row totals exclude subtotal columns: a category subtotal already
  // re-counts hits that appear in its child-tag columns, so summing both
  // would inflate the row total and the grand total derived from it.
  const rowTotals = useMemo(
    () => grid.map((row) => row.reduce((sum, val, j) => columns[j].isSubtotal ? sum : sum + val, 0)),
    [grid, columns]
  )
  const colTotals = useMemo(() => {
    if (grid.length === 0) return columns.map(() => 0)
    return columns.map((_, j) => grid.reduce((sum, row) => sum + row[j], 0))
  }, [grid, columns])
  const grandTotal = useMemo(() => rowTotals.reduce((a, b) => a + b, 0), [rowTotals])
  // Heatmap intensity is calibrated to the tag-cell range so that
  // subtotals (which are typically much larger) don't drown out the
  // individual tag colours.
  const maxVal = useMemo(() => {
    let m = 1
    for (let i = 0; i < grid.length; i++) {
      for (let j = 0; j < grid[i].length; j++) {
        if (columns[j].isSubtotal) continue
        if (grid[i][j] > m) m = grid[i][j]
      }
    }
    return m
  }, [grid, columns])

  // Binary (incidence) view: each cell shows 1 if the query returned
  // any hits in that document/group, else 0; the margins re-sum those
  // 0/1s (so a query total reads as "matched in N documents").
  // Recomputed with the same reducers as the count totals above —
  // including the subtotal-column exclusion from row totals.
  const binaryGrid = useMemo(() => binarizeGrid(grid), [grid])
  const binaryRowTotals = useMemo(
    () => binaryGrid.map((row) => row.reduce((sum, val, j) => (columns[j].isSubtotal ? sum : sum + val), 0)),
    [binaryGrid, columns]
  )
  const binaryColTotals = useMemo(
    () => (binaryGrid.length === 0 ? columns.map(() => 0) : columns.map((_, j) => binaryGrid.reduce((sum, row) => sum + row[j], 0))),
    [binaryGrid, columns]
  )
  const binaryGrandTotal = useMemo(() => binaryRowTotals.reduce((a, b) => a + b, 0), [binaryRowTotals])

  const showGrid = binaryMode ? binaryGrid : grid
  const showRowTotals = binaryMode ? binaryRowTotals : rowTotals
  const showColTotals = binaryMode ? binaryColTotals : colTotals
  const showGrandTotal = binaryMode ? binaryGrandTotal : grandTotal
  const showMaxVal = binaryMode ? 1 : maxVal

  // Per-row metadata for the flipped table layout. Each entry mirrors a
  // column-spec but tells the renderer whether to draw the spanning
  // category-name cell on the left for that row (only for the first row
  // of each category band) and how many rows the band covers.
  const rowLayout = useMemo(() => {
    const layout: { groupLabel: string | null; isGroupStart: boolean; groupSpan: number }[] = []
    for (const g of headerGroups) {
      for (let i = 0; i < g.span; i++) {
        layout.push({ groupLabel: g.label, isGroupStart: i === 0, groupSpan: g.span })
      }
    }
    while (layout.length < columns.length) {
      layout.push({ groupLabel: null, isGroupStart: true, groupSpan: 1 })
    }
    return layout
  }, [columns, headerGroups])

  const addQueries = useCallback((items: { guid: string }[]) => {
    setQueryGuids((prev) => {
      const existing = new Set(prev)
      return [...prev, ...items.map((q) => q.guid).filter((g) => !existing.has(g))]
    })
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDropOver(false)
    const items = parseQueryDrag(e)
    if (items.length > 0) addQueries(items)
  }, [addQueries])

  // Survey-cell scope carried into a generated query: the tool-level
  // Questions scope plus, for a respondent / tagged item column, that
  // column's narrowing. Items are the table's columns here (the layout
  // is transposed), so `col` is an item column.
  const surveyScope = useCallback((col?: { respondentRef?: SurveyEntityRef; tagScopeGuids?: string[] }): SurveyCellScopeArgs | undefined => {
    const s: SurveyCellScopeArgs = {}
    if (questionScope.length > 0) s.questionScope = questionScope.map((q) => ({ sourceGuid: q.sourceGuid, id: q.id }))
    if (col?.respondentRef) s.respondentScope = [col.respondentRef]
    if (col?.tagScopeGuids?.length) s.tagGuids = col.tagScopeGuids
    return s.questionScope || s.respondentScope || s.tagGuids ? s : undefined
  }, [questionScope])

  const handleCellClick = useCallback((rowIdx: number, colIdx: number) => {
    const val = grid[rowIdx][colIdx]
    if (val === 0) return
    const qGuid = queryGuids[rowIdx]
    const sq = queryMap.get(qGuid)
    if (!sq?.query) return
    const col = columns[colIdx]
    // Send the original query + the column's source GUIDs to the main window
    window.api.sendAnalysisAction('run-query-in-docs', sq.query, col.sourceGuids, surveyScope(col))
  }, [grid, queryGuids, queryMap, columns, surveyScope])

  const handleRowTotalClick = useCallback((rowIdx: number) => {
    if (rowTotals[rowIdx] === 0) return
    const qGuid = queryGuids[rowIdx]
    const sq = queryMap.get(qGuid)
    if (!sq?.query) return
    // Run query across all result documents
    window.api.sendAnalysisAction('run-query-in-docs', sq.query, resultSourceGuids, surveyScope())
  }, [rowTotals, queryGuids, queryMap, resultSourceGuids, surveyScope])

  const handleColTotalClick = useCallback((colIdx: number) => {
    if (colTotals[colIdx] === 0) return
    const col = columns[colIdx]
    // Run all queries scoped to this column's documents, combined as OR
    const allQueries = queryGuids.map((g) => queryMap.get(g)?.query).filter(Boolean) as any[]
    if (allQueries.length === 1) {
      window.api.sendAnalysisAction('run-query-in-docs', allQueries[0], col.sourceGuids, surveyScope(col))
    } else if (allQueries.length > 1) {
      // Combine code conditions with OR
      const combined = { type: 'or', conditions: allQueries.map((q: any) => q.codeCondition) }
      window.api.sendAnalysisAction('run-query-in-docs', { documentFilter: {}, codeCondition: combined }, col.sourceGuids, surveyScope(col))
    }
  }, [colTotals, columns, queryGuids, queryMap, surveyScope])

  const handleGrandTotalClick = useCallback(() => {
    if (grandTotal === 0) return
    const allQueries = queryGuids.map((g) => queryMap.get(g)?.query).filter(Boolean) as any[]
    if (allQueries.length === 1) {
      window.api.sendAnalysisAction('run-query-in-docs', allQueries[0], resultSourceGuids, surveyScope())
    } else if (allQueries.length > 1) {
      const combined = { type: 'or', conditions: allQueries.map((q: any) => q.codeCondition) }
      window.api.sendAnalysisAction('run-query-in-docs', { documentFilter: {}, codeCondition: combined }, resultSourceGuids, surveyScope())
    }
  }, [grandTotal, queryGuids, queryMap, resultSourceGuids, surveyScope])

  const handleExportCsv = useCallback(() => {
    // CSV mirrors the on-screen orientation: items down the rows,
    // queries across the columns. With a category in play, the leading
    // column carries the category name (repeated across its rows so a
    // spreadsheet can pivot/group on it).
    const queryNames = queryGuids.map((g) => queryMap.get(g)?.name || '')
    const headerRow: string[] = []
    if (hasGroupedHeader) headerRow.push('Category')
    headerRow.push('Item', ...queryNames, 'Total', '% of Total')
    const rows: string[][] = [headerRow]
    for (let j = 0; j < columns.length; j++) {
      const col = columns[j]
      const layout = rowLayout[j]
      const row: string[] = []
      if (hasGroupedHeader) row.push(layout.groupLabel ?? '')
      row.push(col.label)
      for (let i = 0; i < queryGuids.length; i++) row.push(String(showGrid[i][j]))
      row.push(String(showColTotals[j]), pctOfTotal(showColTotals[j], showGrandTotal))
      rows.push(row)
    }
    const totalRow: string[] = []
    if (hasGroupedHeader) totalRow.push('')
    totalRow.push('Total', ...showRowTotals.map(String), String(showGrandTotal), pctOfTotal(showGrandTotal, showGrandTotal))
    rows.push(totalRow)
    window.api.exportCsv(toCsv(rows), 'results-in-documents.csv')
  }, [columns, rowLayout, queryGuids, showGrid, queryMap, showRowTotals, showColTotals, showGrandTotal, hasGroupedHeader])

  const handleTagDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setTagDropOver(false)
    // Shared parser + merge so all tools handle tag/category/folder/
    // respondents drops identically.
    const fresh = parseGroupByDrop(e)
    if (fresh.length > 0) setGroupBy((p) => mergeGroupBy(p, fresh))
  }, [])

  const handleRemoveGroupBy = useCallback((entry: GroupByEntry) => {
    if (entry.kind === 'respondents') respondentsDismissed.current = true
    const key = groupByKey(entry)
    setGroupBy((p) => p.filter((e) => groupByKey(e) !== key))
  }, [])

  const handleRename = useCallback((newName: string) => {
    setAnalysisName(newName)
    renameSavedAnalysis(analysisGuid, newName)
    if (inTab) inTab.onSaved('', newName)
  }, [analysisGuid, inTab])

  const handleSave = useCallback((name: string) => {
    setAnalysisName(name)
    setShowSaveDialog(false)
    window.api.sendAnalysisAction('save-analysis', {
      guid: analysisGuid,
      toolType: 'results-in-documents',
      name,
      config: { queryGuids, groupBy, questionScope }
    })
    setBaseline({ queryGuids, groupBy, questionScope })
    if (inTab) inTab.onSaved(analysisGuid, name)
    else setTimeout(() => window.close(), 200)
  }, [analysisGuid, queryGuids, groupBy, questionScope, inTab, setBaseline])

  useRegisterToolSave(inTab?.tabId, () => {
    if (isExisting) {
      handleSave(analysisName)
      return true
    }
    setShowSaveDialog(true)
    return false
  })

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '14px 20px 6px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)' }}>
          <Icon icon={faFileSearchCorner} className="analysis-header-icon" style={{ fontSize: 16 }} />
          Results in Documents{isExisting ? ':' : ''}
          {isExisting && <EditableTitleSuffix name={analysisName} onRename={handleRename} />}
        </h2>
        <div style={{ flex: 1 }} />
        <button className="secondary" style={{ fontSize: 11, padding: '4px 14px' }} onClick={() => inTab ? inTab.onClose() : window.close()}>
          Close
        </button>
        {isExisting && dirty && (
          <button className="secondary" style={{ fontSize: 11, padding: '4px 14px' }} onClick={handleDiscard}>
            Discard Changes
          </button>
        )}
        {isExisting ? (
          <button
            style={{ fontSize: 11, padding: '4px 14px' }}
            disabled={!dirty}
            onClick={() => { handleSave(analysisName) }}
          >
            {dirty ? 'Update Analysis' : 'Saved'}
          </button>
        ) : (
          <button style={{ fontSize: 11, padding: '4px 14px' }} onClick={() => setShowSaveDialog(true)}>
            Save Analysis
          </button>
        )}
        {/* Clearance for the floating MemoFab. */}
        <div style={{ width: 36, flexShrink: 0 }} />
      </div>

      {showSaveDialog && (
        <div className="modal-overlay" onClick={() => setShowSaveDialog(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Save Analysis</h2>
            <input
              autoFocus
              type="text"
              defaultValue={analysisName}
              placeholder="Analysis name"
              style={{ width: '100%' }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave((e.target as HTMLInputElement).value.trim() || 'Untitled')
                if (e.key === 'Escape') setShowSaveDialog(false)
              }}
            />
            <div className="modal-actions">
              <button className="secondary" onClick={() => setShowSaveDialog(false)}>Cancel</button>
              <button onClick={(e) => {
                const input = (e.target as HTMLElement).parentElement!.parentElement!.querySelector('input') as HTMLInputElement
                handleSave(input.value.trim() || 'Untitled')
              }}>Save</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: '14px 20px' }}>
        {/* Group by \u2014 entire section is the drop target. */}
        <div
          className="analysis-section"
          style={{ marginBottom: 14, position: 'relative' }}
          onDragOver={(e) => {
            const types = e.dataTransfer.types
            if (
              types.includes('application/x-magnolia-tag') ||
              types.includes('application/x-magnolia-category') ||
              types.includes('application/x-magnolia-folder')
            ) {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
              setTagDropOver(true)
            }
          }}
          onDragLeave={() => setTagDropOver(false)}
          onDrop={handleTagDrop}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: groupBy.length > 0 ? 8 : 0, position: 'relative', zIndex: 1 }}>
            <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--text-secondary)' }}>Group by</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Drag tags, categories, or folders here
            </span>
          </div>
          {tagDropOver && (
            <div style={{
              position: 'absolute', inset: 0,
              background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
              border: '2px dashed var(--accent)',
              borderRadius: 'var(--radius-md)',
              pointerEvents: 'none'
            }} />
          )}
          <div style={{ position: 'relative', zIndex: 1 }}>
            <GroupByChips
              groupBy={groupBy}
              data={data}
              candidateSourceGuids={resultSourceGuids}
              onRemove={handleRemoveGroupBy}
            />
          </div>
        </div>

        {/* Questions scope — only meaningful when a survey is analysed. */}
        {hasSurveyInScope(resultSourceGuids, data) && (
          <QuestionScopeBox value={questionScope} onChange={setQuestionScope} data={data} />
        )}

        {/* Missing documents warning */}
        {missingDocCount > 0 && (
          <div
            style={{
              padding: '8px 12px',
              marginBottom: 14,
              borderRadius: 'var(--radius-md)',
              background: 'color-mix(in srgb, #e0a020 12%, transparent)',
              border: '1px solid color-mix(in srgb, #e0a020 30%, transparent)',
              fontSize: 'var(--font-size-sm)',
              color: 'var(--text-secondary)'
            }}
          >
            {missingDocCount} document{missingDocCount !== 1 ? 's' : ''} referenced by {missingDocCount !== 1 ? 'these queries are' : 'a query is'} no longer in the project.
          </div>
        )}

        {/* Results Grid \u2014 entire section accepts query drops. */}
        <div
          className="analysis-section"
          style={{ position: 'relative' }}
          onDragOver={(e) => { if (isQueryDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDropOver(true) } }}
          onDragLeave={() => setDropOver(false)}
          onDrop={handleDrop}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, position: 'relative', zIndex: 1 }}>
            <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--text-secondary)' }}>Results</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="secondary" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => setVisualMode(!visualMode)}>
                {visualMode ? 'Numeric' : 'Visual'}
              </button>
              <button className="secondary" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => setBinaryMode(!binaryMode)} title="Show each cell as 1 (query matched) or 0 (no match); totals count the cells.">
                {binaryMode ? 'Counts' : 'Binary'}
              </button>
              <button className="secondary" style={{ fontSize: 10, padding: '3px 8px' }} onClick={handleExportCsv} disabled={queryGuids.length === 0}>
                Export CSV
              </button>
            </div>
          </div>

          {queryGuids.length === 0 ? (
            <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)', position: 'relative', zIndex: 1 }}>
              Drag saved queries from the Queries panel to build the grid
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr>
                    {/* Empty cells above the left-side label column(s).
                        With grouping, two label columns: outer (category)
                        + inner (tag/subtotal label). Without grouping,
                        one label column. */}
                    <th
                      colSpan={hasGroupedHeader ? 2 : 1}
                      style={{
                        padding: 4,
                        borderBottom: '1px solid var(--border-color)',
                        textAlign: 'left',
                        minWidth: hasGroupedHeader ? 240 : 140
                      }}
                    />
                    {queryGuids.map((qGuid) => (
                      <th
                        key={qGuid}
                        style={{
                          width: 50, minWidth: 50, maxWidth: 50,
                          borderBottom: '1px solid var(--border-color)',
                          verticalAlign: 'bottom', height: 80, padding: 0, position: 'relative'
                        }}
                      >
                        {/* Remove button anchored top-right so it doesn't
                            collide with the rotated label at the bottom. */}
                        <span
                          onClick={() => setQueryGuids((p) => p.filter((g) => g !== qGuid))}
                          title="Remove query"
                          style={{
                            position: 'absolute', top: 2, right: 2,
                            fontSize: 9, color: 'var(--text-muted)',
                            cursor: 'pointer', padding: '0 3px',
                            opacity: 0.5,
                            transition: 'opacity 0.1s'
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                          onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.5')}
                        >
                          <Icon icon={faXmark} />
                        </span>
                        <div style={{
                          position: 'absolute', bottom: 6, left: '50%',
                          transformOrigin: 'bottom left', transform: 'rotate(-20deg)',
                          whiteSpace: 'nowrap', fontSize: 10,
                          overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 130
                        }}>
                          {truncate(queryMap.get(qGuid)?.name || 'Query', 24)}
                        </div>
                      </th>
                    ))}
                    <th style={{ width: 50, minWidth: 50, maxWidth: 50, borderBottom: '1px solid var(--border-color)', verticalAlign: 'bottom', height: 80, padding: 0, position: 'relative' }}>
                      <div style={{ position: 'absolute', bottom: 6, left: '50%', transformOrigin: 'bottom left', transform: 'rotate(-20deg)', whiteSpace: 'nowrap', fontSize: 10, fontWeight: 700 }}>Total</div>
                    </th>
                    <th title="Row total as % of grand total" style={{ width: 50, minWidth: 50, maxWidth: 50, background: 'color-mix(in srgb, var(--text-secondary) 6%, transparent)', borderBottom: '1px solid var(--border-color)', verticalAlign: 'bottom', height: 80, padding: 0, position: 'relative' }}>
                      <div style={{ position: 'absolute', bottom: 6, left: '50%', transformOrigin: 'bottom left', transform: 'rotate(-20deg)', whiteSpace: 'nowrap', fontSize: 10, fontWeight: 700, fontStyle: 'italic', color: 'var(--text-secondary)' }}>% of Total</div>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {columns.map((col, j) => {
                    const layout = rowLayout[j]
                    return (
                      <tr key={col.id}>
                        {/* Left label cell(s). When grouped, the outer cell
                            holds the category name and rowSpans across all
                            of its children + subtotal; standalone tag rows
                            merge the two label columns with colSpan. */}
                        {hasGroupedHeader ? (
                          layout.isGroupStart ? (
                            layout.groupLabel === null ? (
                              <td
                                colSpan={2}
                                style={{
                                  padding: '4px 6px',
                                  borderBottom: '1px solid var(--border-color)',
                                  fontWeight: 600,
                                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                  maxWidth: 240,
                                  fontStyle: col.isSubtotal ? 'italic' : undefined,
                                  color: col.isSubtotal ? 'var(--text-secondary)' : undefined
                                }}
                              >
                                {truncate(col.label, 36)}
                              </td>
                            ) : (
                              <>
                                <td
                                  rowSpan={layout.groupSpan}
                                  style={{
                                    padding: '4px 6px',
                                    borderBottom: '1px solid var(--border-color)',
                                    borderRight: '1px solid var(--border-color)',
                                    fontWeight: 700,
                                    fontSize: 10,
                                    color: 'var(--text-secondary)',
                                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                    maxWidth: 140,
                                    verticalAlign: 'top'
                                  }}
                                  title={layout.groupLabel}
                                >
                                  {layout.groupLabel}
                                </td>
                                <td style={{
                                  padding: '4px 6px',
                                  borderBottom: '1px solid var(--border-color)',
                                  borderTop: col.isSubtotal ? '1px solid var(--border-color)' : undefined,
                                  fontWeight: col.isSubtotal ? 700 : 500,
                                  fontStyle: col.isSubtotal ? 'italic' : undefined,
                                  color: col.isSubtotal ? 'var(--text-secondary)' : undefined,
                                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                  maxWidth: 140
                                }}>
                                  {truncate(col.label, 22)}
                                </td>
                              </>
                            )
                          ) : (
                            <td style={{
                              padding: '4px 6px',
                              borderBottom: '1px solid var(--border-color)',
                              borderTop: col.isSubtotal ? '1px solid var(--border-color)' : undefined,
                              fontWeight: col.isSubtotal ? 700 : 500,
                              fontStyle: col.isSubtotal ? 'italic' : undefined,
                              color: col.isSubtotal ? 'var(--text-secondary)' : undefined,
                              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                              maxWidth: 140
                            }}>
                              {truncate(col.label, 22)}
                            </td>
                          )
                        ) : (
                          <td style={{
                            padding: '4px 6px',
                            borderBottom: '1px solid var(--border-color)',
                            fontWeight: 600,
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                            maxWidth: 200
                          }}>
                            {truncate(col.label, 28)}
                          </td>
                        )}
                        {/* One cell per query column */}
                        {queryGuids.map((qGuid, i) => {
                          const val = showGrid[i][j]
                          // Clamp the ratio at 1: subtotal cells exceed
                          // maxVal (which deliberately excludes subtotals
                          // so the heatmap isn't dominated by them), and
                          // an unclamped ratio would push the box past
                          // the cell height and stretch the row.
                          const ratio = val > 0 ? Math.min(1, val / showMaxVal) : 0
                          // Max box size = cell height (32) − vertical
                          // padding (2 × 4 px), with a small breathing
                          // gap so visual-mode rows match numeric-mode
                          // rows exactly (no anti-aliasing / line-box jump).
                          const boxSize = val > 0 ? 6 + ratio * 18 : 3
                          const r = Math.round(180 + ratio * 75)
                          const g = Math.round(180 - ratio * 100)
                          const b = Math.round(180 - ratio * 100)
                          const boxColor = val > 0 ? `rgb(${r},${g},${b})` : 'var(--bg-tertiary)'
                          return (
                            <td key={qGuid} onClick={() => handleCellClick(i, j)} style={{
                              width: 50, minWidth: 50, maxWidth: 50, padding: 0,
                              borderBottom: '1px solid var(--border-color)',
                              // Subtotal rows: bold, faint band background,
                              // top border marking the aggregate row at the
                              // bottom of the category band.
                              borderTop: col.isSubtotal ? '1px solid var(--border-color)' : undefined,
                              background: col.isSubtotal ? 'color-mix(in srgb, var(--text-secondary) 6%, transparent)' : undefined,
                              fontWeight: col.isSubtotal ? 700 : undefined,
                              cursor: val > 0 ? 'pointer' : 'default',
                              color: val === 0 ? 'var(--text-muted)' : undefined,
                              opacity: val === 0 ? 0.4 : 1
                            }}>
                              {/* Fixed-height inner box pins the cell to
                                  32 px in both modes — see CodesInDocs. */}
                              <div style={{ height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                {visualMode ? (
                                  <div style={{ width: boxSize, height: boxSize, background: boxColor, borderRadius: 2 }} title={String(val)} />
                                ) : val}
                              </div>
                            </td>
                          )
                        })}
                        {/* Per-row total (across queries) */}
                        <td onClick={() => handleColTotalClick(j)} style={{
                          width: 50, minWidth: 50, maxWidth: 50, height: 32,
                          borderBottom: '1px solid var(--border-color)',
                          borderLeft: '2px solid var(--border-color)',
                          borderTop: col.isSubtotal ? '1px solid var(--border-color)' : undefined,
                          background: col.isSubtotal ? 'color-mix(in srgb, var(--text-secondary) 6%, transparent)' : undefined,
                          textAlign: 'center',
                          fontWeight: 700,
                          cursor: showColTotals[j] > 0 ? 'pointer' : 'default',
                          color: showColTotals[j] === 0 ? 'var(--text-muted)' : undefined,
                          opacity: showColTotals[j] === 0 ? 0.4 : 1
                        }}>
                          {showColTotals[j]}
                        </td>
                        {/* Row total as % of grand total */}
                        <td style={{
                          width: 50, minWidth: 50, maxWidth: 50, height: 32,
                          borderBottom: '1px solid var(--border-color)',
                          borderTop: col.isSubtotal ? '1px solid var(--border-color)' : undefined,
                          background: 'color-mix(in srgb, var(--text-secondary) 6%, transparent)',
                          textAlign: 'center', fontStyle: 'italic', fontWeight: 600, fontSize: 10,
                          color: 'var(--text-secondary)'
                        }}>
                          {pctOfTotal(showColTotals[j], showGrandTotal) || '–'}
                        </td>
                      </tr>
                    )
                  })}
                  {/* Total row: per-query totals across rows + grand total */}
                  <tr>
                    <td
                      colSpan={hasGroupedHeader ? 2 : 1}
                      style={{ padding: '4px 6px', borderTop: '2px solid var(--border-color)', fontWeight: 700 }}
                    >
                      Total
                    </td>
                    {showRowTotals.map((rt, i) => (
                      <td key={queryGuids[i]} onClick={() => handleRowTotalClick(i)} style={{
                        width: 50, minWidth: 50, maxWidth: 50, height: 32,
                        borderTop: '2px solid var(--border-color)',
                        textAlign: 'center',
                        fontWeight: 700,
                        cursor: rt > 0 ? 'pointer' : 'default',
                        color: rt === 0 ? 'var(--text-muted)' : undefined,
                        opacity: rt === 0 ? 0.4 : 1
                      }}>
                        {rt}
                      </td>
                    ))}
                    <td onClick={handleGrandTotalClick} style={{
                      width: 50, minWidth: 50, maxWidth: 50, height: 32,
                      borderTop: '2px solid var(--border-color)',
                      borderLeft: '2px solid var(--border-color)',
                      textAlign: 'center',
                      fontWeight: 700,
                      cursor: showGrandTotal > 0 ? 'pointer' : 'default',
                      color: showGrandTotal === 0 ? 'var(--text-muted)' : undefined,
                      opacity: showGrandTotal === 0 ? 0.4 : 1
                    }}>
                      {showGrandTotal}
                    </td>
                    <td style={{
                      width: 50, minWidth: 50, maxWidth: 50, height: 32,
                      borderTop: '2px solid var(--border-color)',
                      background: 'color-mix(in srgb, var(--text-secondary) 6%, transparent)',
                      textAlign: 'center', fontStyle: 'italic', fontWeight: 600, fontSize: 10,
                      color: 'var(--text-secondary)'
                    }}>
                      {pctOfTotal(showGrandTotal, showGrandTotal) || '–'}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          {dropOver && (
            <div style={{
              position: 'absolute', inset: 0,
              background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
              border: '2px dashed var(--accent)',
              borderRadius: 'var(--radius-md)',
              pointerEvents: 'none'
            }} />
          )}
        </div>
      </div>

    </div>
  )
}
