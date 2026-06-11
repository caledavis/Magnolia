import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import type { AnalysisInitData, SurveyCellScopeArgs, SurveyEntityRef } from '../../models/types'
import { Icon, faChartBar, faChevronDown, faChevronRight, faCircleInfo } from '../Icon'
import { toolColors } from '../../utils/tool-colors'
import {
  DocumentSelector,
  emptyDocumentFilter,
  type DocumentFilterState
} from '../DocumentSelector/DocumentSelector'
import { truncate, codeFrequencyInSource, toCsv, resolveFilteredSources, applySurveyCellScope } from './analysis-helpers'
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
import { useThemeSvgColors, SVG_FONT_FAMILY } from '../../utils/use-theme-svg-colors'

interface Props {
  data: AnalysisInitData
  savedConfig?: {
    codeGuids: string[]
    docFilter: DocumentFilterState
    groupByTags?: string[]
    groupBy?: GroupByEntry[]
    questionScope?: QuestionScopeRef[]
    guid: string
    name: string
  }
  /** When set, the tool is hosted inside a Document Viewer tab instead of
   *  its own window. Save/Close go through the host instead of window.close. */
  inTab?: {
    onClose: () => void
    onSaved: (savedGuid: string, name: string) => void
    onDirtyChange?: (dirty: boolean) => void
    tabId?: string
  }
}

export function CodeFrequencies({ data: propData, savedConfig, inTab }: Props) {
  const [docFilter, setDocFilter] = useState<DocumentFilterState>(savedConfig?.docFilter ?? emptyDocumentFilter())
  const [codeGuids, setCodeGuids] = useState<string[]>(savedConfig?.codeGuids ?? [])
  const [groupBy, setGroupBy] = useState<GroupByEntry[]>(
    () => savedConfig?.groupBy ?? migrateLegacyGroupBy(savedConfig?.groupByTags)
  )
  const [questionScope, setQuestionScope] = useState<QuestionScopeRef[]>(savedConfig?.questionScope ?? [])
  const respondentsDismissed = useRef(false)
  const live = useLiveAnalysisData()
  // Scope survey-cell selections to the tag filter so all metrics are
  // cell-precise (a survey tagged via one respondent counts only that
  // respondent's coded cells). No-op when no tag constraint is active.
  // The Questions scope narrows the analysis to the chosen survey
  // questions on top of that.
  const data = useMemo(() => {
    const base = applySurveyCellScope({ ...propData, ...live }, docFilter)
    return questionScope.length > 0 ? applySurveyCellScope(base, { questionScope }) : base
  }, [propData, live, docFilter, questionScope])
  const [docSectionOpen, setDocSectionOpen] = useState(false)
  const [dropOver, setDropOver] = useState(false)
  const [tagDropOver, setTagDropOver] = useState(false)
  const chartRef = useRef<SVGSVGElement>(null)
  const themeColors = useThemeSvgColors()
  const [analysisGuid] = useState(savedConfig?.guid ?? generateGuid())
  const [analysisName, setAnalysisName] = useState(savedConfig?.name ?? '')
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const isExisting = !!savedConfig?.guid

  // Dirty tracking (see useToolDirtyState — baseline is the saved
  // config or empty defaults; refreshed on save, restored on discard).
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

  // Survey-cell scope carried into a generated query so it re-runs
  // against the same subset: the tool-level Questions scope plus, for a
  // respondent / tagged column, that column's narrowing.
  const surveyScope = useCallback((col?: { respondentRef?: SurveyEntityRef; tagScopeGuids?: string[] }): SurveyCellScopeArgs | undefined => {
    const s: SurveyCellScopeArgs = {}
    if (questionScope.length > 0) s.questionScope = questionScope.map((q) => ({ sourceGuid: q.sourceGuid, id: q.id }))
    if (col?.respondentRef) s.respondentScope = [col.respondentRef]
    if (col?.tagScopeGuids?.length) s.tagGuids = col.tagScopeGuids
    return s.questionScope || s.respondentScope || s.tagGuids ? s : undefined
  }, [questionScope])

  // Auto-add "Respondents" grouping when a survey first enters scope on a
  // fresh, never-saved analysis. Removing the chip sets the dismissed
  // flag so it isn't re-added.
  useEffect(() => {
    if (respondentsDismissed.current || savedConfig) return
    if (groupBy.some((e) => e.kind === 'respondents')) return
    if (hasSurveyInScope(filteredSourceGuids, data)) {
      setGroupBy((p) => mergeGroupBy(p, [{ kind: 'respondents' }]))
    }
  }, [filteredSourceGuids, data, groupBy, savedConfig])

  const codeMap = useMemo(() => {
    const m = new Map<string, { name: string; color?: string }>()
    for (const c of data.codes) m.set(c.guid, { name: c.name, color: c.color })
    return m
  }, [data.codes])

  const sourceMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of data.sources) m.set(s.guid, s.name)
    return m
  }, [data.sources])

  // Column build via the shared, survey-aware builder. Subtotals are
  // skipped because cells here are percentages, where a "sum" is a
  // misleading weighted average rather than a meaningful subtotal.
  const { columns, headerGroups, hasGroupedHeader } = useMemo(
    () => buildSurveyAwareColumns(groupBy, data, filteredSourceGuids, sourceMap, { includeSubtotals: false }),
    [filteredSourceGuids, groupBy, data, sourceMap]
  )

  // Grid: percentage values
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
        if (col.sourceGuids.length === 0) return 0
        const cd = colData.get(col.id) || data
        const total = col.sourceGuids.reduce(
          (sum, sg) => sum + codeFrequencyInSource(cd, sg, codeGuid),
          0
        )
        return total / col.sourceGuids.length
      })
    )
  }, [codeGuids, columns, data])

  // Per-column band membership + reusable tint constants. Replaces the
  // bracket-of-vertical-lines around the band with a faint background
  // tint so the grouped columns read as a unit.
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

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const multiJson = e.dataTransfer.getData('application/x-magnolia-codes')
    const singleJson = e.dataTransfer.getData('application/x-magnolia-code')
    try {
      let codes: { guid: string }[]
      if (multiJson) codes = JSON.parse(multiJson)
      else if (singleJson) codes = [JSON.parse(singleJson)]
      else return
      setCodeGuids((prev) => {
        const existing = new Set(prev)
        return [...prev, ...codes.filter((c) => !existing.has(c.guid)).map((c) => c.guid)]
      })
    } catch { /* ignore */ }
  }, [])

  const handleExportCsv = useCallback(() => {
    const colNames = columns.map((c) => c.label)
    const rows: string[][] = [['Code', ...colNames]]
    for (let i = 0; i < codeGuids.length; i++) {
      rows.push([codeMap.get(codeGuids[i])?.name || '', ...grid[i].map((v) => v.toFixed(1) + '%')])
    }
    window.api.exportCsv(toCsv(rows), 'code-frequencies.csv')
  }, [columns, codeGuids, grid, codeMap])

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
      toolType: 'code-frequencies',
      name,
      config: { codeGuids, docFilter, groupBy, questionScope }
    })
    setBaseline({ codeGuids, docFilter, groupBy, questionScope })
    if (inTab) inTab.onSaved(analysisGuid, name)
    else setTimeout(() => window.close(), 200)
  }, [analysisGuid, codeGuids, docFilter, groupBy, questionScope, inTab, setBaseline])

  useRegisterToolSave(inTab?.tabId, () => {
    if (isExisting) {
      handleSave(analysisName)
      return true
    }
    setShowSaveDialog(true)
    return false
  })

  // Bar chart dimensions, scaled to data so the chart looks
  // proportionate regardless of how many codes / series are shown.
  const chartW = Math.max(400, codeGuids.length * (columns.length * 16 + 30) + 60)
  // Height grows with the number of codes (groups). Driving from
  // codeGuids.length is more visible than tracking chartW, because
  // chartW already grows quickly with series and would otherwise
  // dominate the formula. The clamp keeps a usable plot area for
  // a single code and bounds the chart at ~one screen tall.
  const chartH = Math.min(560, Math.max(220, 160 + codeGuids.length * 24))

  // Font sizes scale with chart height. The 8 px floor matches the
  // previous fixed value (legible on the smallest chart); the upper
  // bound keeps text from looking oversized on tall charts.
  const axisFontSize = Math.min(13, Math.max(8, Math.round(chartH / 32)))
  const labelFontSize = Math.min(13, Math.max(8, Math.round(chartH / 30)))
  const labelMaxChars = Math.min(20, Math.max(10, Math.round(chartH / 22)))

  const marginLeft = 40
  // Reserve enough room below the x-axis for the (possibly larger)
  // code label text. `max(40, …)` keeps the original spacing on
  // small charts while still growing for taller fonts.
  const marginBottom = Math.max(40, labelFontSize + 28)
  const barMaxH = chartH - marginBottom - 10
  const maxPct = useMemo(() => Math.max(1, ...grid.flat()), [grid])

  // Assign colors to columns for chart series
  const seriesColors = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16']

  const handleExportChart = useCallback(() => {
    if (!chartRef.current) return

    // Lay the legend out as native SVG primitives above the chart so
    // it travels with the export. The live UI keeps its HTML legend
    // (cheaper to lay out, easier to wrap responsively); only the
    // exported file gains the SVG version.
    const SWATCH = 10
    const SWATCH_GAP = 4
    const ITEM_GAP = 12
    const FONT_SIZE = 10
    const LINE_HEIGHT = 18
    const PADDING_X = 10
    const PADDING_Y = 8
    // Approx px-per-char for 10 px sans-serif — close enough for the
    // legend, which only needs to wrap reasonably.
    const CHAR_W = 5.5

    const items = columns.map((col, ci) => {
      const label = truncate(col.label, 20)
      return {
        color: seriesColors[ci % seriesColors.length],
        label,
        width: SWATCH + SWATCH_GAP + label.length * CHAR_W
      }
    })

    const maxRowWidth = chartW - PADDING_X * 2
    const rows: (typeof items)[] = [[]]
    let rowWidth = 0
    for (const item of items) {
      const sep = rowWidth > 0 ? ITEM_GAP : 0
      if (rowWidth > 0 && rowWidth + sep + item.width > maxRowWidth) {
        rows.push([item])
        rowWidth = item.width
      } else {
        rows[rows.length - 1].push(item)
        rowWidth += sep + item.width
      }
    }
    const legendH = rows.length * LINE_HEIGHT + PADDING_Y * 2

    const escapeXml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

    const legendParts: string[] = []
    for (let r = 0; r < rows.length; r++) {
      const yBase = PADDING_Y + r * LINE_HEIGHT
      const swatchY = yBase + (LINE_HEIGHT - SWATCH) / 2
      const textY = yBase + LINE_HEIGHT * 0.7
      let x = PADDING_X
      for (const item of rows[r]) {
        legendParts.push(
          `<rect x="${x.toFixed(1)}" y="${swatchY.toFixed(1)}" width="${SWATCH}" height="${SWATCH}" rx="2" fill="${item.color}"/>`
        )
        legendParts.push(
          `<text x="${(x + SWATCH + SWATCH_GAP).toFixed(1)}" y="${textY.toFixed(1)}" font-size="${FONT_SIZE}" font-family="${SVG_FONT_FAMILY.replace(/"/g, '&quot;')}" fill="${themeColors.textPrimary}">${escapeXml(item.label)}</text>`
        )
        x += item.width + ITEM_GAP
      }
    }

    const totalH = legendH + chartH
    const chartHtml = chartRef.current.outerHTML
    const combined = `<svg xmlns="http://www.w3.org/2000/svg" width="${chartW}" height="${totalH}" viewBox="0 0 ${chartW} ${totalH}"><rect width="${chartW}" height="${totalH}" fill="#ffffff"/>${legendParts.join('')}<g transform="translate(0, ${legendH})">${chartHtml}</g></svg>`

    window.api.exportSvg(combined, 'code-frequencies-chart.svg')
  }, [columns, seriesColors, themeColors, chartW, chartH])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '14px 20px 6px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)' }}>
          <Icon icon={faChartBar} className="analysis-header-icon" style={{ fontSize: 16 }} />
          Code Frequencies{isExisting ? ':' : ''}
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
        {/* Document Selector */}
        <div className="analysis-section" style={{ marginBottom: 14 }}>
          <div onClick={() => setDocSectionOpen(!docSectionOpen)} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
            <Icon icon={docSectionOpen ? faChevronDown : faChevronRight} style={{ fontSize: 12, color: 'var(--text-muted)' }} />
            <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--text-secondary)' }}>Select Documents</span>
          </div>
          {docSectionOpen && (
            <div style={{ marginTop: 10, minHeight: 160 }}>
              <DocumentSelector sources={data.sources} tags={data.tags} categories={data.categories} folders={data.folders} sourceFolder={data.sourceFolder} tagMembers={data.tagMembers} respondentTagMembers={data.respondentTagMembers} questionTagMembers={data.questionTagMembers} surveyEntityLabels={data.surveyEntityLabels} filter={docFilter} onChange={setDocFilter} />
            </div>
          )}
        </div>

        {/* Group by \u2014 entire section is the drop target. */}
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
          style={{ marginBottom: 14, position: 'relative' }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('application/x-magnolia-code') || e.dataTransfer.types.includes('application/x-magnolia-codes')) {
              e.preventDefault()
              setDropOver(true)
            }
          }}
          onDragLeave={() => setDropOver(false)}
          onDrop={(e) => { setDropOver(false); handleDrop(e) }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, position: 'relative', zIndex: 1 }}>
            <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--text-secondary)' }}>Frequency Grid</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, position: 'relative' }}>
              <button className="secondary" style={{ fontSize: 10, padding: '3px 8px' }} onClick={handleExportCsv} disabled={codeGuids.length === 0}>
                Export CSV
              </button>
              <button
                onClick={() => setShowInfo((v) => !v)}
                title="How are these percentages calculated?"
                aria-label="How are these percentages calculated?"
                style={{
                  background: 'none', border: 'none', padding: 2,
                  color: showInfo ? 'var(--accent)' : 'var(--text-muted)',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center'
                }}
              >
                <Icon icon={faCircleInfo} style={{ fontSize: 14 }} />
              </button>
              {showInfo && (
                <>
                  {/* Click-outside dismiss */}
                  <div
                    style={{ position: 'fixed', inset: 0, zIndex: 99 }}
                    onClick={() => setShowInfo(false)}
                  />
                  <div
                    style={{
                      position: 'absolute', top: '100%', right: 0, marginTop: 6,
                      width: 360, padding: '12px 14px',
                      background: 'var(--bg-panel)',
                      border: '1px solid var(--border-color)',
                      borderRadius: 'var(--radius-md)',
                      boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
                      fontSize: 11,
                      lineHeight: 1.5,
                      color: 'var(--text-primary)',
                      zIndex: 100
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>How frequencies are calculated</div>
                    <div style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>
                      Each cell shows the proportion of one source covered by one code, expressed as a percentage. The denominator depends on the source kind:
                    </div>
                    <ul style={{ margin: '0 0 8px 16px', padding: 0, color: 'var(--text-secondary)' }}>
                      <li style={{ marginBottom: 4 }}><strong>Text / Markdown:</strong> % of characters covered (overlapping codings counted once).</li>
                      <li style={{ marginBottom: 4 }}><strong>Audio / Video:</strong> % of duration covered by the union of time-range codings.</li>
                      <li style={{ marginBottom: 4 }}><strong>PDF (text codings):</strong> % of extracted-text characters covered.</li>
                      <li style={{ marginBottom: 4 }}><strong>PDF (region codings):</strong> % of region selections coded with this code.</li>
                      <li style={{ marginBottom: 4 }}><strong>PDF (mixed):</strong> weighted average of the two above, by the count of each kind of selection in the source.</li>
                      <li><strong>Image:</strong> % of region selections coded with this code.</li>
                    </ul>
                  </div>
                </>
              )}
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
                      {headerGroups.map((g) => (
                        <th
                          key={`hg:${g.id}`}
                          colSpan={g.span}
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
                    </tr>
                  )}
                  <tr>
                    <th style={{ padding: 4, borderBottom: '1px solid var(--border-color)', textAlign: 'left', minWidth: 100, verticalAlign: 'bottom' }}>Code</th>
                    {columns.map((col, j) => (
                      <th
                        key={col.id}
                        style={{
                          width: 60, minWidth: 60, maxWidth: 60,
                          borderBottom: '1px solid var(--border-color)',
                          background: inBand[j] ? BAND_TINT : undefined,
                          verticalAlign: 'bottom', height: 80, padding: 0, position: 'relative'
                        }}
                      >
                        <div style={{ position: 'absolute', bottom: 6, left: '50%', transformOrigin: 'bottom left', transform: 'rotate(-20deg)', whiteSpace: 'nowrap', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 130 }}>
                          {truncate(col.label, 24)}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {codeGuids.map((codeGuid, i) => (
                    <tr key={codeGuid}>
                      <td style={{ padding: '4px 6px', borderBottom: '1px solid var(--border-color)', fontWeight: 600, maxWidth: 120, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: codeMap.get(codeGuid)?.color || '#888', marginRight: 4, verticalAlign: 'middle' }} />
                        {truncate(codeMap.get(codeGuid)?.name || '', 16)}
                        <span onClick={() => setCodeGuids((p) => p.filter((g) => g !== codeGuid))} style={{ marginLeft: 4, fontSize: 9, color: 'var(--text-muted)', cursor: 'pointer' }}>x</span>
                      </td>
                      {columns.map((col, j) => {
                        const val = grid[i][j]
                        return (
                          <td
                            key={col.id}
                            style={{
                              padding: '4px 6px',
                              borderBottom: '1px solid var(--border-color)',
                              background: inBand[j] ? BAND_TINT : undefined,
                              textAlign: 'center',
                              color: val === 0 ? 'var(--text-muted)' : undefined,
                              opacity: val === 0 ? 0.4 : 1,
                              cursor: val > 0 ? 'pointer' : undefined
                            }}
                            onClick={() => {
                              if (val > 0) {
                                window.api.sendAnalysisAction('run-code-in-doc-query', codeGuid, col.sourceGuids, filteredSourceGuids, surveyScope(col))
                              }
                            }}
                          >
                            {val.toFixed(1)}%
                          </td>
                        )
                      })}
                    </tr>
                  ))}
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

        {/* Bar Chart */}
        {codeGuids.length > 0 && columns.length > 0 && (
          <div className="analysis-section">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--text-secondary)' }}>Chart</span>
              <button className="secondary" style={{ fontSize: 10, padding: '3px 8px' }} onClick={handleExportChart}>
                Export SVG
              </button>
            </div>

            {/* Legend */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
              {columns.map((col, ci) => (
                <div key={col.id} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }}>
                  <div style={{ width: 10, height: 10, background: seriesColors[ci % seriesColors.length], borderRadius: 2 }} />
                  {truncate(col.label, 20)}
                </div>
              ))}
            </div>

            <div style={{ overflowX: 'auto' }}>
              <svg ref={chartRef} width={chartW} height={chartH} style={{ background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)' }}>
                {/* Y axis */}
                <line x1={marginLeft} y1={5} x2={marginLeft} y2={chartH - marginBottom} stroke={themeColors.borderColor} />
                {[0, 25, 50, 75, 100].map((pct) => {
                  const y = chartH - marginBottom - (pct / Math.max(maxPct, 100)) * barMaxH
                  return (
                    <g key={pct}>
                      <line x1={marginLeft - 4} y1={y} x2={marginLeft} y2={y} stroke={themeColors.textMuted} />
                      <text x={marginLeft - 6} y={y + Math.round(axisFontSize * 0.35)} textAnchor="end" fontSize={axisFontSize} fontFamily={SVG_FONT_FAMILY} fill={themeColors.textMuted}>{pct}%</text>
                    </g>
                  )
                })}
                {/* X axis */}
                <line x1={marginLeft} y1={chartH - marginBottom} x2={chartW} y2={chartH - marginBottom} stroke={themeColors.borderColor} />
                {/* Bars */}
                {codeGuids.map((codeGuid, ci) => {
                  const groupW = columns.length * 14 + 10
                  const groupX = marginLeft + 20 + ci * (groupW + 16)
                  return (
                    <g key={codeGuid}>
                      {columns.map((col, si) => {
                        const val = grid[ci][si]
                        const barH = (val / Math.max(maxPct, 100)) * barMaxH
                        const barX = groupX + si * 14
                        const barY = chartH - marginBottom - barH
                        return (
                          <rect
                            key={col.id}
                            x={barX}
                            y={barY}
                            width={12}
                            height={Math.max(0, barH)}
                            fill={seriesColors[si % seriesColors.length]}
                            opacity={0.85}
                            rx={1}
                            style={{ cursor: val > 0 ? 'pointer' : undefined }}
                            onClick={() => {
                              if (val > 0) {
                                if (groupBy.length > 0) {
                                  if (col.id === '__other') {
                                    const tagGuids = groupBy.flatMap((g) => g.kind === 'tag' ? [g.tagGuid] : [])
                                    window.api.sendAnalysisAction('run-code-in-tag-query', codeGuid, null, tagGuids, surveyScope())
                                  } else {
                                    window.api.sendAnalysisAction('run-code-in-tag-query', codeGuid, col.id, undefined, surveyScope())
                                  }
                                } else {
                                  window.api.sendAnalysisAction('run-code-in-doc-query', codeGuid, col.sourceGuids, filteredSourceGuids, surveyScope(col))
                                }
                              }
                            }}
                          >
                            <title>{`${codeMap.get(codeGuid)?.name}: ${val.toFixed(1)}% in ${col.label}`}</title>
                          </rect>
                        )
                      })}
                      <text
                        x={groupX + (columns.length * 14) / 2}
                        y={chartH - marginBottom + labelFontSize + 4}
                        textAnchor="middle"
                        fontSize={labelFontSize}
                        fontFamily={SVG_FONT_FAMILY}
                        fill={themeColors.textMuted}
                      >
                        {truncate(codeMap.get(codeGuid)?.name || '', labelMaxChars)}
                      </text>
                    </g>
                  )
                })}
              </svg>
            </div>
          </div>
        )}
      </div>

    </div>
  )
}
