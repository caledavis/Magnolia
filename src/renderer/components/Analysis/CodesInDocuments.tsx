import { Fragment, useState, useMemo, useCallback, useRef, useEffect } from 'react'
import type { AnalysisInitData, SurveyCellScopeArgs, SurveyEntityRef } from '../../models/types'
import { Icon, faFileCodeCorner, faChevronDown, faChevronRight } from '../Icon'
import { toolColors } from '../../utils/tool-colors'
import {
  DocumentSelector,
  emptyDocumentFilter,
  type DocumentFilterState
} from '../DocumentSelector/DocumentSelector'
import { truncate, countCodeInSource, toCsv, pctOfTotal, resolveFilteredSources, applySurveyCellScope, binarizeGrid } from './analysis-helpers'
import { generateGuid } from '../../utils/guid'
import {
  type GroupByEntry,
  parseGroupByDrop,
  isGroupByDrag,
  mergeGroupBy,
  groupByKey,
  migrateLegacyGroupBy,
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

interface Props {
  data: AnalysisInitData
  savedConfig?: {
    codeGuids: string[]
    docFilter: DocumentFilterState
    /** Legacy: pre-category support. Migrated on load. */
    groupByTags?: string[]
    /** New shape: tags + categories + folders + respondents. */
    groupBy?: GroupByEntry[]
    /** Survey questions the analysis is scoped to (empty = all). */
    questionScope?: QuestionScopeRef[]
    guid: string
    name: string
  }
  inTab?: {
    onClose: () => void
    onSaved: (savedGuid: string, name: string) => void
    onDirtyChange?: (dirty: boolean) => void
    /** Tab id (when hosted inline) — used to register the save
     *  handler with the global registry the close-confirm dialog
     *  invokes. Absent in popout-window mode. */
    tabId?: string
  }
}

function parseDraggedCodes(e: React.DragEvent): string[] {
  const multiJson = e.dataTransfer.getData('application/x-magnolia-codes')
  const singleJson = e.dataTransfer.getData('application/x-magnolia-code')
  try {
    let codes: { guid: string }[]
    if (multiJson) codes = JSON.parse(multiJson)
    else if (singleJson) codes = [JSON.parse(singleJson)]
    else return []
    return codes.map((c) => c.guid)
  } catch { return [] }
}

function isCodeDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes('application/x-magnolia-code') ||
    e.dataTransfer.types.includes('application/x-magnolia-codes')
}

export function CodesInDocuments({ data: propData, savedConfig, inTab }: Props) {
  const [docFilter, setDocFilter] = useState<DocumentFilterState>(savedConfig?.docFilter ?? emptyDocumentFilter())
  const [codeGuids, setCodeGuids] = useState<string[]>(savedConfig?.codeGuids ?? [])
  const [groupBy, setGroupBy] = useState<GroupByEntry[]>(
    () => savedConfig?.groupBy ?? migrateLegacyGroupBy(savedConfig?.groupByTags)
  )
  const [questionScope, setQuestionScope] = useState<QuestionScopeRef[]>(savedConfig?.questionScope ?? [])
  // Once the user removes the auto-added Respondents grouping, don't
  // re-seed it (they can drag it back from the Document Browser).
  const respondentsDismissed = useRef(false)
  const live = useLiveAnalysisData()
  const data = useMemo(() => {
    const base = applySurveyCellScope({ ...propData, ...live }, docFilter)
    // Question scope narrows the whole analysis to the chosen survey
    // questions (surveys with no chosen question keep all of theirs).
    return questionScope.length > 0 ? applySurveyCellScope(base, { questionScope }) : base
  }, [propData, live, docFilter, questionScope])
  const [visualMode, setVisualMode] = useState(false)
  const [binaryMode, setBinaryMode] = useState(false)
  const [docSectionOpen, setDocSectionOpen] = useState(false)
  const [dropOver, setDropOver] = useState(false)
  const [tagDropOver, setTagDropOver] = useState(false)
  const [analysisGuid] = useState(savedConfig?.guid ?? generateGuid())
  const [analysisName, setAnalysisName] = useState(savedConfig?.name ?? '')
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const isExisting = !!savedConfig?.guid

  // Dirty tracking. Baseline is the saved config (or empty defaults for
  // never-saved tools). Save updates the baseline; Discard restores the
  // working state from it.
  const currentConfig = useMemo(
    () => ({ codeGuids, docFilter, groupBy, questionScope }),
    [codeGuids, docFilter, groupBy, questionScope]
  )
  const initialBaseline = useMemo(() => ({
    codeGuids: savedConfig?.codeGuids ?? [],
    docFilter: savedConfig?.docFilter ?? emptyDocumentFilter(),
    groupBy: savedConfig?.groupBy ?? migrateLegacyGroupBy(savedConfig?.groupByTags),
    questionScope: savedConfig?.questionScope ?? []
  }), [])
  const { dirty, baseline, setBaseline } = useToolDirtyState(currentConfig, initialBaseline, inTab)

  const handleDiscard = useCallback(() => {
    setCodeGuids(baseline.codeGuids)
    setDocFilter(baseline.docFilter)
    setGroupBy(baseline.groupBy)
    setQuestionScope(baseline.questionScope ?? [])
  }, [baseline])

  const filteredSourceGuids = useMemo(
    () => resolveFilteredSources(data, docFilter.sourceGuids, docFilter.tagGuids, docFilter.tagExcludeGuids, docFilter.typeInclude, docFilter.typeExclude),
    [data, docFilter]
  )

  // Auto-add "Respondents" grouping the first time a survey is in scope
  // (for a fresh, never-saved analysis). Saved analyses keep exactly the
  // grouping they were saved with; removing the chip sets the dismissed
  // flag so it isn't re-added.
  useEffect(() => {
    if (respondentsDismissed.current || savedConfig) return
    if (groupBy.some((e) => e.kind === 'respondents')) return
    if (hasSurveyInScope(filteredSourceGuids, data)) {
      setGroupBy((p) => mergeGroupBy(p, [{ kind: 'respondents' }]))
    }
  }, [filteredSourceGuids, data, groupBy, savedConfig])

  const codeMap = useMemo(() => {
    const m = new Map<string, { name: string; color?: string; parentGuid?: string }>()
    for (const c of data.codes) m.set(c.guid, { name: c.name, color: c.color, parentGuid: c.parentGuid })
    return m
  }, [data.codes])

  const sourceMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of data.sources) m.set(s.guid, s.name)
    return m
  }, [data.sources])

  // Column build via the shared, survey-aware builder (handles tags,
  // categories, folders, the Respondents grouping, and the "Other"
  // catch-all) — the same builder every grid tool uses.
  const { columns, headerGroups, hasGroupedHeader } = useMemo(
    () => buildSurveyAwareColumns(groupBy, data, filteredSourceGuids, sourceMap),
    [filteredSourceGuids, groupBy, data, sourceMap]
  )

  const grid = useMemo(() => {
    // Per-column survey-cell scope: a tag column counts only that tag's
    // cells; a respondent column counts only that respondent's cells.
    const colData = new Map<string, AnalysisInitData>()
    for (const col of columns) {
      colData.set(
        col.id,
        col.respondentRef
          ? applySurveyCellScope(data, { respondentScope: [col.respondentRef] })
          : col.tagScopeGuids
            ? applySurveyCellScope(data, { tagGuids: col.tagScopeGuids })
            : data
      )
    }
    return codeGuids.map((codeGuid) =>
      columns.map((col) => {
        const cd = colData.get(col.id) || data
        return col.sourceGuids.reduce((sum, sg) => sum + countCodeInSource(cd, sg, codeGuid), 0)
      })
    )
  }, [codeGuids, columns, data])

  // Row totals exclude subtotal columns: a category subtotal already
  // re-counts hits that appear in its child-tag columns.
  const rowTotals = useMemo(
    () => grid.map((row) => row.reduce((sum, val, j) => columns[j].isSubtotal ? sum : sum + val, 0)),
    [grid, columns]
  )
  const colTotals = useMemo(() => {
    if (grid.length === 0) return columns.map(() => 0)
    return columns.map((_, j) => grid.reduce((sum, row) => sum + row[j], 0))
  }, [grid, columns])
  const grandTotal = useMemo(() => rowTotals.reduce((a, b) => a + b, 0), [rowTotals])
  // Heatmap calibration excludes subtotal cells so the colour ramp
  // isn't dominated by category aggregates.
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

  // Binary (incidence) view: each cell shows 1 if the code occurs at
  // all in that document/group, else 0; the margins re-sum those 0/1s
  // (so a row total reads as "present in N documents"). Recomputed
  // with the same reducers as the count totals above — including the
  // subtotal-column exclusion from row totals — on the binarised grid.
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

  // For each column, whether it lives inside a labeled band (category
  // or folder). Drives the band-tint background that replaces the old
  // bracket-of-vertical-lines treatment so the band reads as a unit.
  const inBand = useMemo(() => {
    const flags: boolean[] = new Array(columns.length).fill(false)
    let cursor = 0
    for (const g of headerGroups) {
      if (g.label !== null) {
        for (let i = 0; i < g.span; i++) flags[cursor + i] = true
      }
      cursor += g.span
    }
    return flags
  }, [columns, headerGroups])
  const BAND_TINT = 'color-mix(in srgb, var(--text-secondary) 4%, transparent)'
  const SUBTOTAL_TINT = 'color-mix(in srgb, var(--text-secondary) 10%, transparent)'
  // Tint for the derived percentage columns (subtotal-% and % of total).
  const PCT_TINT = 'color-mix(in srgb, var(--text-secondary) 6%, transparent)'

  // Each subtotal column is followed by an adjacent "% of row total"
  // column, so a category/folder band's spanning header must widen by
  // the number of subtotal columns it contains.
  const headerGroupSpans = useMemo(() => {
    const spans: number[] = []
    let cursor = 0
    for (const g of headerGroups) {
      let extra = 0
      for (let k = cursor; k < cursor + g.span; k++) if (columns[k]?.isSubtotal) extra++
      spans.push(g.span + extra)
      cursor += g.span
    }
    return spans
  }, [headerGroups, columns])

  const addCodes = useCallback((guids: string[]) => {
    setCodeGuids((prev) => {
      const existing = new Set(prev)
      return [...prev, ...guids.filter((g) => !existing.has(g))]
    })
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDropOver(false)
    const guids = parseDraggedCodes(e)
    if (guids.length > 0) addCodes(guids)
  }, [addCodes])

  // Survey-cell scope carried into a generated query so it re-runs
  // against the same subset the clicked cell/column represented: the
  // tool-level Questions scope plus, for a respondent or tagged column,
  // that column's respondent / tag narrowing. Returns undefined when
  // there's nothing to scope (the common non-survey case).
  const surveyScope = useCallback((col?: { respondentRef?: SurveyEntityRef; tagScopeGuids?: string[] }): SurveyCellScopeArgs | undefined => {
    const s: SurveyCellScopeArgs = {}
    if (questionScope.length > 0) s.questionScope = questionScope.map((q) => ({ sourceGuid: q.sourceGuid, id: q.id }))
    if (col?.respondentRef) s.respondentScope = [col.respondentRef]
    if (col?.tagScopeGuids?.length) s.tagGuids = col.tagScopeGuids
    return s.questionScope || s.respondentScope || s.tagGuids ? s : undefined
  }, [questionScope])

  const handleDoubleClick = useCallback((rowIdx: number, colIdx: number) => {
    const val = grid[rowIdx][colIdx]
    if (val === 0) return
    const col = columns[colIdx]
    // Always run the query against the column's actual sourceGuids
    // (works for tags, category sub-tags, category subtotals, folders,
    // folder docs, folder subtotals, and the catch-all "Other"). The
    // legacy run-code-in-tag-query path was specific to the old flat-
    // tag world and didn't generalise; the doc-scoped query does.
    window.api.sendAnalysisAction('run-code-in-doc-query', codeGuids[rowIdx], col.sourceGuids, filteredSourceGuids, surveyScope(col))
  }, [grid, codeGuids, columns, filteredSourceGuids, surveyScope])

  const handleRowTotalClick = useCallback((rowIdx: number) => {
    if (rowTotals[rowIdx] === 0) return
    window.api.sendAnalysisAction('run-code-in-doc-query', codeGuids[rowIdx], filteredSourceGuids, filteredSourceGuids, surveyScope())
  }, [rowTotals, codeGuids, filteredSourceGuids, surveyScope])

  const handleColTotalClick = useCallback((colIdx: number) => {
    if (colTotals[colIdx] === 0) return
    const col = columns[colIdx]
    // Run an OR query for all codes in this column's documents
    window.api.sendAnalysisAction('run-codes-in-doc-query', codeGuids, col.sourceGuids, surveyScope(col))
  }, [colTotals, columns, codeGuids, surveyScope])

  const handleGrandTotalClick = useCallback(() => {
    if (grandTotal === 0) return
    window.api.sendAnalysisAction('run-codes-in-doc-query', codeGuids, filteredSourceGuids, surveyScope())
  }, [grandTotal, codeGuids, filteredSourceGuids, surveyScope])

  const handleExportCsv = useCallback(() => {
    // Header: each subtotal column gains a "% of Row Total" column, and
    // a "% of Total" column follows the grand Total.
    const header: string[] = ['Code']
    columns.forEach((c) => {
      header.push(c.label)
      if (c.isSubtotal) header.push('% of Row Total')
    })
    header.push('Total', '% of Total')
    const rows: string[][] = [header]
    for (let i = 0; i < codeGuids.length; i++) {
      const cells: string[] = [codeMap.get(codeGuids[i])?.name || '']
      columns.forEach((c, j) => {
        cells.push(String(showGrid[i][j]))
        // R1 (subtotal as % of row total) is not meaningful in Binary
        // view — see the on-screen guard.
        if (c.isSubtotal) cells.push(binaryMode ? '' : pctOfTotal(showGrid[i][j], showRowTotals[i]))
      })
      cells.push(String(showRowTotals[i]), pctOfTotal(showRowTotals[i], showGrandTotal))
      rows.push(cells)
    }
    const totalRow: string[] = ['Total']
    columns.forEach((c, j) => {
      totalRow.push(String(showColTotals[j]))
      if (c.isSubtotal) totalRow.push(binaryMode ? '' : pctOfTotal(showColTotals[j], showGrandTotal))
    })
    totalRow.push(String(showGrandTotal), pctOfTotal(showGrandTotal, showGrandTotal))
    rows.push(totalRow)
    window.api.exportCsv(toCsv(rows), 'codes-in-documents.csv')
  }, [columns, codeGuids, showGrid, codeMap, showRowTotals, showColTotals, showGrandTotal, binaryMode])

  const handleTagDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setTagDropOver(false)
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
      toolType: 'codes-in-documents',
      name,
      config: { codeGuids, docFilter, groupBy, questionScope }
    })
    setBaseline({ codeGuids, docFilter, groupBy, questionScope })
    if (inTab) inTab.onSaved(analysisGuid, name)
    else setTimeout(() => window.close(), 200)
  }, [analysisGuid, codeGuids, docFilter, groupBy, questionScope, inTab, setBaseline])

  // Register the save handler so the TabBar's unsaved-changes dialog
  // can fire it when the user picks Save while closing this tab.
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
          <Icon icon={faFileCodeCorner} className="analysis-header-icon" style={{ fontSize: 16 }} />
          Codes in Documents{isExisting ? ':' : ''}
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
        {/* Clearance for the floating MemoFab (28 px circle + ~8 gap)
            so the action buttons don't slide under it. */}
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
        {/* Document Selector */}
        <div className="analysis-section" style={{ marginBottom: 14 }}>
          <div onClick={() => setDocSectionOpen(!docSectionOpen)} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
            <Icon icon={docSectionOpen ? faChevronDown : faChevronRight} style={{ fontSize: 12, color: 'var(--text-muted)' }} />
            <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--text-secondary)' }}>Select Documents</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>{filteredSourceGuids.length} document{filteredSourceGuids.length !== 1 ? 's' : ''}</span>
          </div>
          {docSectionOpen && (
            <div style={{ marginTop: 10, minHeight: 160 }}>
              <DocumentSelector sources={data.sources} tags={data.tags} categories={data.categories} folders={data.folders} sourceFolder={data.sourceFolder} tagMembers={data.tagMembers} respondentTagMembers={data.respondentTagMembers} questionTagMembers={data.questionTagMembers} surveyEntityLabels={data.surveyEntityLabels} filter={docFilter} onChange={setDocFilter} />
            </div>
          )}
        </div>

        {/* Group by \u2014 entire section is the drop target. The dashed
            "drop here" box has been replaced by an absolute-positioned
            tint overlay shown only while a compatible item is dragged
            over, plus a small inline hint in the header. */}
        <div
          className="analysis-section"
          style={{ marginBottom: 14, position: 'relative' }}
          onDragOver={(e) => {
            if (isGroupByDrag(e)) {
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
          <div style={{ position: 'relative', zIndex: 1 }}>
            <GroupByChips
              groupBy={groupBy}
              data={data}
              candidateSourceGuids={filteredSourceGuids}
              onRemove={handleRemoveGroupBy}
            />
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
        </div>

        {/* Questions scope \u2014 only meaningful when a survey is analysed. */}
        {hasSurveyInScope(filteredSourceGuids, data) && (
          <QuestionScopeBox value={questionScope} onChange={setQuestionScope} data={data} />
        )}

        {/* Results Grid \u2014 entire section accepts code drops. */}
        <div
          className="analysis-section"
          style={{ position: 'relative' }}
          onDragOver={(e) => { if (isCodeDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDropOver(true) } }}
          onDragLeave={() => setDropOver(false)}
          onDrop={handleDrop}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, position: 'relative', zIndex: 1 }}>
            <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--text-secondary)' }}>Results</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="secondary" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => setVisualMode(!visualMode)}>
                {visualMode ? 'Numeric' : 'Visual'}
              </button>
              <button className="secondary" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => setBinaryMode(!binaryMode)} title="Show each cell as 1 (code present) or 0 (absent); totals count the cells.">
                {binaryMode ? 'Counts' : 'Binary'}
              </button>
              <button className="secondary" style={{ fontSize: 10, padding: '3px 8px' }} onClick={handleExportCsv} disabled={codeGuids.length === 0}>
                Export CSV
              </button>
            </div>
          </div>

          {codeGuids.length === 0 ? (
            <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)', position: 'relative', zIndex: 1 }}>
              Drag codes from the Code Browser to build the grid
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  {hasGroupedHeader && (
                    <tr>
                      <th style={{ padding: '0 6px 4px', borderBottom: '1px solid var(--border-color)' }} />
                      {headerGroups.map((g, gi) => (
                        <th
                          key={`hg:${g.id}`}
                          colSpan={headerGroupSpans[gi]}
                          style={{
                            padding: '4px 6px',
                            borderBottom: '1px solid var(--border-color)',
                            background: g.label !== null ? BAND_TINT : undefined,
                            textAlign: 'center',
                            fontSize: 10,
                            fontWeight: 700,
                            color: 'var(--text-secondary)',
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                          }}
                          title={g.label ?? undefined}
                        >
                          {g.label ?? ''}
                        </th>
                      ))}
                      {/* Spacers above the Total and % of Total columns. */}
                      <th style={{ borderBottom: '1px solid var(--border-color)' }} />
                      <th style={{ borderBottom: '1px solid var(--border-color)' }} />
                    </tr>
                  )}
                  <tr>
                    <th style={{ padding: 4, borderBottom: '1px solid var(--border-color)', textAlign: 'left', minWidth: 100, verticalAlign: 'bottom' }}>Code</th>
                    {columns.map((col, j) => (
                      <Fragment key={col.id}>
                        <th
                          style={{
                            width: 50, minWidth: 50, maxWidth: 50,
                            borderBottom: '1px solid var(--border-color)',
                            background: col.isSubtotal ? SUBTOTAL_TINT : (inBand[j] ? BAND_TINT : undefined),
                            verticalAlign: 'bottom', height: 80, padding: 0, position: 'relative'
                          }}
                        >
                          <div style={{
                            position: 'absolute', bottom: 6, left: '50%',
                            transformOrigin: 'bottom left', transform: 'rotate(-20deg)',
                            whiteSpace: 'nowrap', fontSize: 10,
                            overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 130,
                            fontStyle: col.isSubtotal ? 'italic' : undefined,
                            fontWeight: col.isSubtotal ? 700 : undefined,
                            color: col.isSubtotal ? 'var(--text-secondary)' : undefined
                          }}>
                            {truncate(col.label, 24)}
                          </div>
                        </th>
                        {col.isSubtotal && (
                          <th title="Subtotal as % of row total" style={{ width: 50, minWidth: 50, maxWidth: 50, background: SUBTOTAL_TINT, borderBottom: '1px solid var(--border-color)', verticalAlign: 'bottom', height: 80, padding: 0, position: 'relative' }}>
                            <div style={{ position: 'absolute', bottom: 6, left: '50%', transformOrigin: 'bottom left', transform: 'rotate(-20deg)', whiteSpace: 'nowrap', fontSize: 10, fontWeight: 700, fontStyle: 'italic', color: 'var(--text-secondary)' }}>%</div>
                          </th>
                        )}
                      </Fragment>
                    ))}
                    <th style={{ width: 50, minWidth: 50, maxWidth: 50, borderBottom: '1px solid var(--border-color)', verticalAlign: 'bottom', height: 80, padding: 0, position: 'relative' }}>
                      <div style={{ position: 'absolute', bottom: 6, left: '50%', transformOrigin: 'bottom left', transform: 'rotate(-20deg)', whiteSpace: 'nowrap', fontSize: 10, fontWeight: 700 }}>Total</div>
                    </th>
                    <th title="Row total as % of grand total" style={{ width: 50, minWidth: 50, maxWidth: 50, background: PCT_TINT, borderBottom: '1px solid var(--border-color)', verticalAlign: 'bottom', height: 80, padding: 0, position: 'relative' }}>
                      <div style={{ position: 'absolute', bottom: 6, left: '50%', transformOrigin: 'bottom left', transform: 'rotate(-20deg)', whiteSpace: 'nowrap', fontSize: 10, fontWeight: 700, fontStyle: 'italic', color: 'var(--text-secondary)' }}>% of Total</div>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {codeGuids.map((codeGuid, i) => {
                    // Compute nesting depth: count how many ancestors are also rows
                    let depth = 0
                    let parentGuid = codeMap.get(codeGuid)?.parentGuid
                    while (parentGuid) {
                      if (codeGuids.includes(parentGuid)) depth++
                      parentGuid = codeMap.get(parentGuid)?.parentGuid
                    }
                    return (
                    <tr key={codeGuid}>
                      <td style={{ padding: '4px 6px', paddingLeft: 6 + depth * 14, borderBottom: '1px solid var(--border-color)', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 140 }}>
                        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: codeMap.get(codeGuid)?.color || '#888', marginRight: 4, verticalAlign: 'middle' }} />
                        {truncate(codeMap.get(codeGuid)?.name || '', 16)}
                        <span onClick={() => setCodeGuids((p) => p.filter((g) => g !== codeGuid))} style={{ marginLeft: 4, fontSize: 9, color: 'var(--text-muted)', cursor: 'pointer' }}>x</span>
                      </td>
                      {columns.map((col, j) => {
                        const val = showGrid[i][j]
                        // Clamp the ratio at 1: subtotal cells exceed
                        // maxVal (which deliberately excludes subtotals
                        // so the heatmap isn't dominated by them), and
                        // an unclamped ratio would push the box past
                        // the cell height and stretch the row.
                        const ratio = val > 0 ? Math.min(1, val / showMaxVal) : 0
                        // Max box size = cell height (32) − vertical
                        // padding (2 × 4 px), so the box sits inside the
                        // existing 32 px cell with a small breathing
                        // gap. The padding absorbs anti-aliasing /
                        // line-box quirks that were nudging visual-mode
                        // rows ~1–4 px taller than numeric-mode rows.
                        const boxSize = val > 0 ? 6 + ratio * 18 : 3
                        const r = Math.round(180 + ratio * 75)
                        const g = Math.round(180 - ratio * 100)
                        const b = Math.round(180 - ratio * 100)
                        const boxColor = val > 0 ? `rgb(${r},${g},${b})` : 'var(--bg-tertiary)'
                        return (
                          <Fragment key={col.id}>
                          <td onClick={() => handleDoubleClick(i, j)} style={{
                            width: 50, minWidth: 50, maxWidth: 50, padding: 0,
                            borderBottom: '1px solid var(--border-color)',
                            background: col.isSubtotal ? SUBTOTAL_TINT : (inBand[j] ? BAND_TINT : undefined),
                            fontWeight: col.isSubtotal ? 700 : undefined,
                            cursor: val > 0 ? 'pointer' : 'default',
                            color: val === 0 ? 'var(--text-muted)' : undefined,
                            opacity: val === 0 ? 0.4 : 1
                          }}>
                            {/* Fixed-height inner box pins the cell to
                                exactly 32 px regardless of content type
                                (text vs square). Without this, baseline
                                alignment of the inline text vs the block
                                square caused a 1–2 px row-height jump on
                                Visual ↔ Numeric toggle. */}
                            <div style={{ height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              {visualMode ? (
                                <div style={{ width: boxSize, height: boxSize, background: boxColor, borderRadius: 2 }} title={String(val)} />
                              ) : val}
                            </div>
                          </td>
                          {col.isSubtotal && (
                            <td style={{
                              width: 50, minWidth: 50, maxWidth: 50, height: 32,
                              borderBottom: '1px solid var(--border-color)',
                              background: SUBTOTAL_TINT,
                              textAlign: 'center', fontStyle: 'italic', fontWeight: 600, fontSize: 10,
                              color: 'var(--text-secondary)'
                            }}>
                              {/* In Binary view the subtotal collapses to a
                                  0/1 incidence flag while the row total sums
                                  individual incidences, so the ratio is not
                                  on a comparable scale — show "–" instead. */}
                              {binaryMode ? '–' : (pctOfTotal(showGrid[i][j], showRowTotals[i]) || '–')}
                            </td>
                          )}
                          </Fragment>
                        )
                      })}
                      <td onClick={() => handleRowTotalClick(i)} style={{
                        width: 50, minWidth: 50, maxWidth: 50, height: 32,
                        borderBottom: '1px solid var(--border-color)',
                        borderLeft: '2px solid var(--border-color)',
                        textAlign: 'center',
                        fontWeight: 700,
                        cursor: showRowTotals[i] > 0 ? 'pointer' : 'default',
                        color: showRowTotals[i] === 0 ? 'var(--text-muted)' : undefined,
                        opacity: showRowTotals[i] === 0 ? 0.4 : 1
                      }}>
                        {showRowTotals[i]}
                      </td>
                      <td style={{
                        width: 50, minWidth: 50, maxWidth: 50, height: 32,
                        borderBottom: '1px solid var(--border-color)',
                        background: PCT_TINT,
                        textAlign: 'center', fontStyle: 'italic', fontWeight: 600, fontSize: 10,
                        color: 'var(--text-secondary)'
                      }}>
                        {pctOfTotal(showRowTotals[i], showGrandTotal) || '–'}
                      </td>
                    </tr>
                    )
                  })}
                  {/* Total row */}
                  <tr>
                    <td style={{ padding: '4px 6px', borderTop: '2px solid var(--border-color)', fontWeight: 700 }}>Total</td>
                    {showColTotals.map((ct, j) => (
                      <Fragment key={columns[j].id}>
                      <td onClick={() => handleColTotalClick(j)} style={{
                        width: 50, minWidth: 50, maxWidth: 50, height: 32,
                        borderTop: '2px solid var(--border-color)',
                        background: columns[j].isSubtotal ? SUBTOTAL_TINT : (inBand[j] ? BAND_TINT : undefined),
                        textAlign: 'center',
                        fontWeight: 700,
                        cursor: ct > 0 ? 'pointer' : 'default',
                        color: ct === 0 ? 'var(--text-muted)' : undefined,
                        opacity: ct === 0 ? 0.4 : 1
                      }}>
                        {ct}
                      </td>
                      {columns[j].isSubtotal && (
                        <td style={{
                          width: 50, minWidth: 50, maxWidth: 50, height: 32,
                          borderTop: '2px solid var(--border-color)',
                          background: SUBTOTAL_TINT,
                          textAlign: 'center', fontStyle: 'italic', fontWeight: 600, fontSize: 10,
                          color: 'var(--text-secondary)'
                        }}>
                          {binaryMode ? '–' : (pctOfTotal(ct, showGrandTotal) || '–')}
                        </td>
                      )}
                      </Fragment>
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
                      background: PCT_TINT,
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
