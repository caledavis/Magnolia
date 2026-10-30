import { useState, useMemo, useCallback } from 'react'
import type { AnalysisInitData, SurveyCellScopeArgs } from '../../models/types'
import { Icon, faSquaresIntersect } from '../Icon'
import { toolColors } from '../../utils/tool-colors'
import {
  emptyDocumentFilter,
  type DocumentFilterState
} from '../DocumentSelector/DocumentSelector'
import { DocumentsSection } from './DocumentsSection'
import { documentFilterFromConfig } from './documents-filter'
import { truncate, countCoOccurrences, toCsv, pctOfTotal, resolveFilteredSources, applySurveyCellScope, binarizeGrid } from './analysis-helpers'
import type { QuestionScopeRef } from './survey-grouping'
import { generateGuid } from '../../utils/guid'
import { useLiveAnalysisData } from './use-live-analysis-data'
import { SankeyView } from './SankeyView'
import { SegmentedControl, type GridView } from './SegmentedControl'
import { EditableTitleSuffix } from '../EditableTitleSuffix'
import { renameSavedAnalysis } from '../../utils/rename-saved-analysis'
import { useToolDirtyState } from '../../hooks/use-tool-dirty-state'
import { useRegisterToolSave } from '../../hooks/use-register-tool-save'

interface Props {
  data: AnalysisInitData
  savedConfig?: { rowCodeGuids: string[]; colCodeGuids: string[]; docFilter: DocumentFilterState; /** Up to 1.9; now in docFilter. */ questionScope?: QuestionScopeRef[]; guid: string; name: string }
  inTab?: {
    onClose: () => void
    onSaved: (savedGuid: string, name: string) => void
    onDirtyChange?: (dirty: boolean) => void
    tabId?: string
  }
}

/** Parse dragged code guids from a drag event. */
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

const dropZoneStyle: React.CSSProperties = {
  padding: '8px 12px',
  border: '2px dashed var(--border-color)',
  borderRadius: 'var(--radius-md)',
  textAlign: 'center',
  fontSize: 11,
  color: 'var(--text-muted)',
  cursor: 'default',
  transition: 'border-color 0.15s, background 0.15s'
}

const dropZoneActiveStyle: React.CSSProperties = {
  borderColor: 'var(--accent)',
  background: 'color-mix(in srgb, var(--accent) 8%, transparent)'
}

function CodeDropZone({ label, onDrop: onDropCodes, existingGuids }: {
  label: string
  onDrop: (guids: string[]) => void
  existingGuids: string[]
}) {
  const [over, setOver] = useState(false)
  return (
    <div
      style={{ ...dropZoneStyle, ...(over ? dropZoneActiveStyle : {}), flex: 1 }}
      onDragOver={(e) => { if (isCodeDrag(e)) { e.preventDefault(); setOver(true) } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setOver(false)
        const guids = parseDraggedCodes(e)
        const existing = new Set(existingGuids)
        const newGuids = guids.filter((g) => !existing.has(g))
        if (newGuids.length > 0) onDropCodes(newGuids)
      }}
    >
      {label}
    </div>
  )
}

export function CodeCoOccurrences({ data: propData, savedConfig, inTab }: Props) {
  const [docFilter, setDocFilter] = useState<DocumentFilterState>(documentFilterFromConfig(savedConfig))
  const [rowCodeGuids, setRowCodeGuids] = useState<string[]>(savedConfig?.rowCodeGuids ?? [])
  const [colCodeGuids, setColCodeGuids] = useState<string[]>(savedConfig?.colCodeGuids ?? [])
  // Live store reads override the equivalent (potentially stale) fields
  // on the data snapshot. Every `data.X` reference below transparently
  // picks up codes/tags/categories/folders/tagMembers/sourceFolder from
  // the zustand stores; non-overridden fields (sources, sourceContents,
  // sourceSelections) still fall through to the snapshot. See
  // use-live-analysis-data.ts for the rationale.
  const live = useLiveAnalysisData()
  const data = useMemo(() => {
    return applySurveyCellScope({ ...propData, ...live }, docFilter)
  }, [propData, live, docFilter])
  const [view, setView] = useState<GridView>('table')
  const visualMode = view === 'visual'
  const sankeyMode = view === 'sankey'
  const [binaryMode, setBinaryMode] = useState(false)
  const [analysisGuid] = useState(savedConfig?.guid ?? generateGuid())
  const [analysisName, setAnalysisName] = useState(savedConfig?.name ?? '')
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const isExisting = !!savedConfig?.guid

  // Dirty tracking (see useToolDirtyState).
  const currentConfig = useMemo(
    () => ({ rowCodeGuids, colCodeGuids, docFilter }),
    [rowCodeGuids, colCodeGuids, docFilter]
  )
  const initialBaseline = useMemo(() => ({
    rowCodeGuids: savedConfig?.rowCodeGuids ?? [],
    colCodeGuids: savedConfig?.colCodeGuids ?? [],
    docFilter: documentFilterFromConfig(savedConfig),
  }), [])
  const { dirty, baseline, setBaseline } = useToolDirtyState(currentConfig, initialBaseline, inTab)

  const handleDiscard = useCallback(() => {
    setRowCodeGuids(baseline.rowCodeGuids)
    setColCodeGuids(baseline.colCodeGuids)
    setDocFilter(baseline.docFilter)
  }, [baseline])

  const filteredSourceGuids = useMemo(
    () => resolveFilteredSources(data, docFilter.sourceGuids, docFilter.tagGuids, docFilter.tagExcludeGuids, docFilter.typeInclude, docFilter.typeExclude),
    [data, docFilter]
  )

  // Survey-cell scope carried into a generated drill-down query so it
  // re-runs against the same subset the table reflects.
  const surveyScope = useCallback((): SurveyCellScopeArgs | undefined => {
    const { questionScope, respondentScope } = docFilter
    if (!questionScope?.length && !respondentScope?.length) return undefined
    return { questionScope, respondentScope }
  }, [docFilter])

  const codeMap = useMemo(() => {
    const m = new Map<string, { name: string; color?: string; parentGuid?: string }>()
    for (const c of data.codes) m.set(c.guid, { name: c.name, color: c.color, parentGuid: c.parentGuid })
    return m
  }, [data.codes])

  // Compute co-occurrence matrix (rows x columns)
  const matrix = useMemo(() => {
    const grid: number[][] = []
    for (let i = 0; i < rowCodeGuids.length; i++) {
      const row: number[] = []
      for (let j = 0; j < colCodeGuids.length; j++) {
        if (rowCodeGuids[i] === colCodeGuids[j]) {
          row.push(0)
        } else {
          row.push(countCoOccurrences(data, filteredSourceGuids, rowCodeGuids[i], colCodeGuids[j]))
        }
      }
      grid.push(row)
    }
    return grid
  }, [rowCodeGuids, colCodeGuids, filteredSourceGuids, data])

  const rowTotals = useMemo(() => matrix.map((row) => row.reduce((a, b) => a + b, 0)), [matrix])
  const colTotals = useMemo(() => {
    if (matrix.length === 0) return colCodeGuids.map(() => 0)
    return colCodeGuids.map((_, j) => matrix.reduce((sum, row) => sum + row[j], 0))
  }, [matrix, colCodeGuids])
  const grandTotal = useMemo(() => rowTotals.reduce((a, b) => a + b, 0), [rowTotals])
  const maxVal = useMemo(() => Math.max(1, ...matrix.flat()), [matrix])

  // Binary (incidence) view: each cell shows 1 if the codes co-occur
  // at all, else 0; the margins re-sum those 0/1s so a total reads as
  // "co-occurs with N codes". Recomputed with the same reducers as the
  // count totals above, just on the binarised grid.
  const binaryMatrix = useMemo(() => binarizeGrid(matrix), [matrix])
  const binaryRowTotals = useMemo(() => binaryMatrix.map((row) => row.reduce((a, b) => a + b, 0)), [binaryMatrix])
  const binaryColTotals = useMemo(
    () => (binaryMatrix.length === 0 ? colCodeGuids.map(() => 0) : colCodeGuids.map((_, j) => binaryMatrix.reduce((sum, row) => sum + row[j], 0))),
    [binaryMatrix, colCodeGuids]
  )
  const binaryGrandTotal = useMemo(() => binaryRowTotals.reduce((a, b) => a + b, 0), [binaryRowTotals])

  const showMatrix = binaryMode ? binaryMatrix : matrix
  const showRowTotals = binaryMode ? binaryRowTotals : rowTotals
  const showColTotals = binaryMode ? binaryColTotals : colTotals
  const showGrandTotal = binaryMode ? binaryGrandTotal : grandTotal
  const showMaxVal = binaryMode ? 1 : maxVal

  const handleGridDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const guids = parseDraggedCodes(e)
    if (guids.length === 0) return
    setRowCodeGuids((prev) => {
      const existing = new Set(prev)
      return [...prev, ...guids.filter((g) => !existing.has(g))]
    })
    setColCodeGuids((prev) => {
      const existing = new Set(prev)
      return [...prev, ...guids.filter((g) => !existing.has(g))]
    })
  }, [])

  const handleDoubleClick = useCallback((rowIdx: number, colIdx: number) => {
    if (rowCodeGuids[rowIdx] === colCodeGuids[colIdx]) return
    const val = matrix[rowIdx][colIdx]
    if (val === 0) return
    window.api.sendAnalysisAction('run-cooccurrence-query', rowCodeGuids[rowIdx], colCodeGuids[colIdx], filteredSourceGuids, surveyScope())
  }, [matrix, rowCodeGuids, colCodeGuids, filteredSourceGuids, surveyScope])

  const handleRowTotalClick = useCallback((rowIdx: number) => {
    if (rowTotals[rowIdx] === 0) return
    // Show all occurrences of this row's code across filtered docs
    window.api.sendAnalysisAction('run-code-in-doc-query', rowCodeGuids[rowIdx], filteredSourceGuids, filteredSourceGuids, surveyScope())
  }, [rowTotals, rowCodeGuids, filteredSourceGuids, surveyScope])

  const handleColTotalClick = useCallback((colIdx: number) => {
    if (colTotals[colIdx] === 0) return
    window.api.sendAnalysisAction('run-code-in-doc-query', colCodeGuids[colIdx], filteredSourceGuids, filteredSourceGuids, surveyScope())
  }, [colTotals, colCodeGuids, filteredSourceGuids, surveyScope])

  const handleGrandTotalClick = useCallback(() => {
    if (grandTotal === 0) return
    const allGuids = Array.from(new Set([...rowCodeGuids, ...colCodeGuids]))
    window.api.sendAnalysisAction('run-codes-in-doc-query', allGuids, filteredSourceGuids, surveyScope())
  }, [grandTotal, rowCodeGuids, colCodeGuids, filteredSourceGuids, surveyScope])

  // Sankey view: row codes on the left, column codes on the right; a
  // band's width is how often the pair co-occurs.
  const sankeyLeft = useMemo(
    () => rowCodeGuids.map((g) => ({ id: g, label: codeMap.get(g)?.name || '', color: codeMap.get(g)?.color })),
    [rowCodeGuids, codeMap]
  )
  const sankeyRight = useMemo(
    () => colCodeGuids.map((g) => ({ id: g, label: codeMap.get(g)?.name || '', color: codeMap.get(g)?.color })),
    [colCodeGuids, codeMap]
  )

  const handleExportCsv = useCallback(() => {
    const colNames = colCodeGuids.map((g) => codeMap.get(g)?.name || 'Code')
    const rowNames = rowCodeGuids.map((g) => codeMap.get(g)?.name || 'Code')
    const rows: string[][] = [['', ...colNames, 'Total', '% of Total']]
    for (let i = 0; i < rowCodeGuids.length; i++) {
      rows.push([rowNames[i], ...showMatrix[i].map(String), String(showRowTotals[i]), pctOfTotal(showRowTotals[i], showGrandTotal)])
    }
    rows.push(['Total', ...showColTotals.map(String), String(showGrandTotal), pctOfTotal(showGrandTotal, showGrandTotal)])
    window.api.exportCsv(toCsv(rows), 'code-cooccurrences.csv')
  }, [rowCodeGuids, colCodeGuids, showMatrix, codeMap, showRowTotals, showColTotals, showGrandTotal])

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
      toolType: 'code-cooccurrences',
      name,
      config: { rowCodeGuids, colCodeGuids, docFilter }
    })
    setBaseline({ rowCodeGuids, colCodeGuids, docFilter })
    if (inTab) inTab.onSaved(analysisGuid, name)
    else setTimeout(() => window.close(), 200)
  }, [analysisGuid, rowCodeGuids, colCodeGuids, docFilter, inTab, setBaseline])

  useRegisterToolSave(inTab?.tabId, () => {
    if (isExisting) {
      handleSave(analysisName)
      return true
    }
    setShowSaveDialog(true)
    return false
  })

  const hasAnyCodes = rowCodeGuids.length > 0 || colCodeGuids.length > 0

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '14px 20px 6px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)' }}>
          <Icon icon={faSquaresIntersect} className="analysis-header-icon" style={{ fontSize: 16 }} />
          Code Co-Occurrences{isExisting ? ':' : ''}
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
        <DocumentsSection data={data} filter={docFilter} onChange={setDocFilter} filteredSourceGuids={filteredSourceGuids} />

        {/* Results Grid */}
        <div
          className="analysis-section"
          onDragOver={(e) => { if (isCodeDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } }}
          onDrop={handleGridDrop}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--text-secondary)', marginRight: 4 }}>Results</span>
              <SegmentedControl
                label="View"
                value={view}
                onChange={setView}
                options={[
                  { value: 'table', label: 'Table', title: 'Show the grid as numbers.' },
                  { value: 'visual', label: 'Visual', title: 'Show each cell as a box sized and shaded by its value.' },
                  { value: 'sankey', label: 'Sankey', title: 'Show the grid as a Sankey diagram linking row codes to the column codes they co-occur with.' }
                ]}
              />
              <SegmentedControl
                label="Values"
                value={binaryMode ? 'binary' : 'counts'}
                onChange={(v) => setBinaryMode(v === 'binary')}
                options={[
                  { value: 'counts', label: 'Counts', title: 'Show how many coded segments each cell holds.' },
                  { value: 'binary', label: 'Binary', title: "Show each cell as 1 (codes co-occur) or 0 (they don't); totals count the cells." }
                ]}
              />
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="secondary" style={{ fontSize: 10, padding: '3px 8px' }} onClick={handleExportCsv} disabled={!hasAnyCodes}>
                Export CSV
              </button>
            </div>
          </div>

          {/* Row and Column drop zones */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
            <CodeDropZone
              label={rowCodeGuids.length === 0 ? 'Drop codes here for rows' : `Rows: ${rowCodeGuids.length} code${rowCodeGuids.length !== 1 ? 's' : ''} \u2014 drop more`}
              existingGuids={rowCodeGuids}
              onDrop={(guids) => setRowCodeGuids((prev) => [...prev, ...guids])}
            />
            <CodeDropZone
              label={colCodeGuids.length === 0 ? 'Drop codes here for columns' : `Columns: ${colCodeGuids.length} code${colCodeGuids.length !== 1 ? 's' : ''} \u2014 drop more`}
              existingGuids={colCodeGuids}
              onDrop={(guids) => setColCodeGuids((prev) => [...prev, ...guids])}
            />
          </div>

          {!hasAnyCodes ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)', border: '2px dashed var(--border-color)', borderRadius: 'var(--radius-md)' }}>
              Drag codes from the Code Browser into the row or column drop zones above, or drop anywhere here to add to both
            </div>
          ) : sankeyMode ? (
            <div style={{ overflowX: 'auto' }}>
              <SankeyView
                left={sankeyLeft}
                right={sankeyRight}
                values={showMatrix}
                leftTitle="Row codes"
                rightTitle="Column codes"
                onLinkClick={handleDoubleClick}
                onLeftClick={handleRowTotalClick}
                onRightClick={handleColTotalClick}
              />
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr>
                    <th style={{ padding: 4, borderBottom: '1px solid var(--border-color)', textAlign: 'left', minWidth: 100 }} />
                    {colCodeGuids.map((g) => (
                      <th key={g} style={{ width: 50, minWidth: 50, maxWidth: 50, borderBottom: '1px solid var(--border-color)', verticalAlign: 'bottom', height: 80, padding: 0, position: 'relative' }}>
                        <div style={{ position: 'absolute', bottom: 6, left: '50%', transformOrigin: 'bottom left', transform: 'rotate(-20deg)', whiteSpace: 'nowrap', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 130, display: 'flex', alignItems: 'center', gap: 3 }}>
                          <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: codeMap.get(g)?.color || '#888', flexShrink: 0 }} />
                          {truncate(codeMap.get(g)?.name || '', 22)}
                          <span onClick={() => setColCodeGuids((p) => p.filter((x) => x !== g))} style={{ fontSize: 9, color: 'var(--text-muted)', cursor: 'pointer', flexShrink: 0 }}>x</span>
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
                  {rowCodeGuids.map((rowGuid, i) => {
                    let depth = 0
                    let parentGuid = codeMap.get(rowGuid)?.parentGuid
                    while (parentGuid) {
                      if (rowCodeGuids.includes(parentGuid)) depth++
                      parentGuid = codeMap.get(parentGuid)?.parentGuid
                    }
                    return (
                    <tr key={rowGuid}>
                      <td style={{ padding: '4px 6px', paddingLeft: 6 + depth * 14, borderBottom: '1px solid var(--border-color)', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 140 }}>
                        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: codeMap.get(rowGuid)?.color || '#888', marginRight: 4, verticalAlign: 'middle' }} />
                        {truncate(codeMap.get(rowGuid)?.name || '', 14)}
                        <span onClick={() => setRowCodeGuids((p) => p.filter((x) => x !== rowGuid))} style={{ marginLeft: 4, fontSize: 9, color: 'var(--text-muted)', cursor: 'pointer' }}>x</span>
                      </td>
                      {colCodeGuids.map((colGuid, j) => {
                        const val = showMatrix[i][j]
                        const isSame = rowGuid === colGuid
                        const ratio = val > 0 ? val / showMaxVal : 0
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
                          <td
                            key={colGuid}
                            onClick={() => handleDoubleClick(i, j)}
                            style={{
                              width: 50, minWidth: 50, maxWidth: 50, padding: 0,
                              borderBottom: '1px solid var(--border-color)',
                              cursor: !isSame && val > 0 ? 'pointer' : 'default',
                              background: isSame ? 'var(--bg-secondary)' : undefined,
                              color: isSame ? 'var(--text-muted)' : val === 0 ? 'var(--text-muted)' : undefined,
                              opacity: isSame ? 1 : val === 0 ? 0.4 : 1
                            }}
                          >
                            {/* Fixed-height inner box pins the cell to
                                32 px in both modes \u2014 see CodesInDocs. */}
                            <div style={{ height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              {isSame ? '\u2014' : visualMode ? (
                                <div style={{ width: boxSize, height: boxSize, background: boxColor, borderRadius: 2 }} title={String(val)} />
                              ) : val}
                            </div>
                          </td>
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
                        background: 'color-mix(in srgb, var(--text-secondary) 6%, transparent)',
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
                      <td key={colCodeGuids[j]} onClick={() => handleColTotalClick(j)} style={{
                        width: 50, minWidth: 50, maxWidth: 50, height: 32,
                        borderTop: '2px solid var(--border-color)',
                        textAlign: 'center',
                        fontWeight: 700,
                        cursor: ct > 0 ? 'pointer' : 'default',
                        color: ct === 0 ? 'var(--text-muted)' : undefined,
                        opacity: ct === 0 ? 0.4 : 1
                      }}>
                        {ct}
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
        </div>
      </div>

    </div>
  )
}
