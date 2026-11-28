import { Trans } from 'react-i18next'
import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import type { AnalysisInitData, SurveyEntityRef } from '../../models/types'
import { Icon, faChartBar, faCircleInfo } from '../Icon'
import { type DocumentFilterState } from '../DocumentSelector/DocumentSelector'
import { DocumentsSection } from './DocumentsSection'
import { documentFilterFromConfig } from './documents-filter'
import { truncate, codeFrequencyInSource, sizeEstimated, isAverageColumn, toCsv, filteredSourcesOf, applySurveyCellScope, cellScopeOf } from './analysis-helpers'
import { usePageSizes } from '../../utils/region-sizes'
import { useDocumentStore } from '../../stores/document-store'
import { generateGuid } from '../../utils/guid'
import {
  type GroupByEntry,
  parseGroupByDrop,
  isGroupByDrag,
  mergeGroupBy,
  groupByKey,
  migrateLegacyGroupBy,
  GroupByChips,
  useAutoGroupBy
} from './group-by'
import {
  buildSurveyAwareColumns,
  type QuestionScopeRef
} from './survey-grouping'
import { useLiveAnalysisData } from './use-live-analysis-data'
import { EditableTitleSuffix } from '../EditableTitleSuffix'
import { renameSavedAnalysis } from '../../utils/rename-saved-analysis'
import { useToolDirtyState } from '../../hooks/use-tool-dirty-state'
import { useRegisterToolSave } from '../../hooks/use-register-tool-save'
import { useThemeSvgColors, SVG_FONT_FAMILY } from '../../utils/use-theme-svg-colors'
import { useTranslation } from 'react-i18next'
import { formatPercent, t as tr } from '../../i18n'
import { draggedCodeGuids } from '../../utils/code-drag'
import type { CellScope } from '../../utils/narrow-query'
import { keyActivate, dropZone } from '../../utils/key-activate'
import { gridCell, useGridKeyboard } from '../../utils/use-grid-keyboard'
import { ZERO_CELL } from './zero-cell'
import { useColumnWindow, useScrollView } from '../../utils/use-column-window'
import { flushSync } from 'react-dom'
import { reportExportFailure } from '../../utils/report-export-failure'

interface Props {
  data: AnalysisInitData
  savedConfig?: {
    codeGuids: string[]
    docFilter: DocumentFilterState
    groupByTags?: string[]
    groupBy?: GroupByEntry[]
    /** Up to 1.9; now in docFilter (see documentFilterFromConfig). */
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

/** A column's heading: a column of several documents shows the average of
 *  their percentages, and says so. The name is shortened to `max`
 *  characters, the "(average)" kept whole. */
function columnLabel(col: { label: string; sourceGuids: string[] }, max?: number): string {
  const name = max ? truncate(col.label, max) : col.label
  return isAverageColumn(col) ? tr('codeFreq.averageLabel', { label: name }) : name
}

/** Colours for the chart's series, one per column. */
const SERIES_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16']

export function CodeFrequencies({ data: propData, savedConfig, inTab }: Props) {
  const { t } = useTranslation()
  const tableKeys = useGridKeyboard(t('tools.codeFrequencies.label'))
  const [docFilter, setDocFilter] = useState<DocumentFilterState>(documentFilterFromConfig(savedConfig))
  const [codeGuids, setCodeGuids] = useState<string[]>(savedConfig?.codeGuids ?? [])
  const [groupBy, setGroupBy] = useState<GroupByEntry[]>(
    () => savedConfig?.groupBy ?? migrateLegacyGroupBy(savedConfig?.groupByTags)
  )
  const live = useLiveAnalysisData()
  // Scope survey-cell selections to the tag filter so all metrics are
  // cell-precise (a survey tagged via one respondent counts only that
  // respondent's coded cells). No-op when no tag constraint is active.
  // The survey questions and respondents chosen in From these documents
  // narrow it further.
  // Image and page sizes, read from the files, measure box codings by area.
  const pageSizes = usePageSizes(useDocumentStore((s) => s.sources))
  const data = useMemo(() => {
    return applySurveyCellScope({ ...propData, ...live, pageSizes }, docFilter)
  }, [propData, live, pageSizes, docFilter])
  const [dropOver, setDropOver] = useState(false)
  const [tagDropOver, setTagDropOver] = useState(false)
  const chartRef = useRef<SVGSVGElement>(null)
  const themeColors = useThemeSvgColors()
  const [analysisGuid] = useState(savedConfig?.guid ?? generateGuid())
  const [analysisName, setAnalysisName] = useState(savedConfig?.name ?? '')
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  // The info panel is placed against the window, not the Results box
  // (which would cut it off), and kept inside it.
  const infoButtonRef = useRef<HTMLButtonElement>(null)
  const [infoPlace, setInfoPlace] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null)
  useEffect(() => {
    if (!showInfo || !infoButtonRef.current) return
    const update = () => {
      const r = infoButtonRef.current!.getBoundingClientRect()
      const width = Math.min(400, window.innerWidth - 32)
      const rtl = getComputedStyle(infoButtonRef.current!).direction === 'rtl'
      const left = rtl ? Math.min(r.left, window.innerWidth - width - 16) : Math.max(16, r.right - width)
      const top = r.bottom + 6
      setInfoPlace({ left, top, width, maxHeight: Math.max(160, window.innerHeight - top - 16) })
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [showInfo])
  const isExisting = !!savedConfig?.guid

  // Dirty tracking (see useToolDirtyState — baseline is the saved
  // config or empty defaults; refreshed on save, restored on discard).
  const currentConfig = useMemo(
    () => ({ codeGuids, docFilter, groupBy }),
    [codeGuids, docFilter, groupBy]
  )
  const [initialBaseline] = useState(() => ({
    codeGuids: savedConfig?.codeGuids ?? [],
    docFilter: documentFilterFromConfig(savedConfig),
    groupBy: savedConfig?.groupBy ?? migrateLegacyGroupBy(savedConfig?.groupByTags),
  }))
  const { dirty, baseline, setBaseline } = useToolDirtyState(currentConfig, initialBaseline, inTab)

  const handleDiscard = useCallback(() => {
    setCodeGuids(baseline.codeGuids)
    setDocFilter(baseline.docFilter)
    setGroupBy(baseline.groupBy)
  }, [baseline])

  const filteredSourceGuids = useMemo(
    () => filteredSourcesOf(data, docFilter),
    [data, docFilter]
  )

  // Survey-cell scope carried into a generated query so it re-runs
  // against the same subset: the survey questions and respondents
  // chosen in From these documents plus, for a
  // respondent / tagged column, that column's narrowing.
  const surveyScope = useCallback(
    (col?: { respondentRef?: SurveyEntityRef; tagScopeGuids?: string[] }): CellScope | undefined => cellScopeOf(docFilter, col),
    [docFilter]
  )

  // Auto-add a Group-by chip for each survey and notebook in scope.
  const dismissAutoGroup = useAutoGroupBy(filteredSourceGuids, data, savedConfig, setGroupBy)

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

  // Documents whose size had to be estimated (an image or page that
  // couldn't be read, a recording of unknown length), for the note.
  const estimatedNames = useMemo(
    () => filteredSourceGuids.filter((g) => sizeEstimated(data, g)).map((g) => sourceMap.get(g) ?? ''),
    [filteredSourceGuids, data, sourceMap]
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

  // Only the table's columns in view are drawn (see use-column-window).
  const colWidths = useMemo(() => columns.map(() => 60), [columns])
  const win = useColumnWindow(colWidths)
  const shown = columns.slice(win.start, win.end)
  const spacer = (px: number) =>
    px > 0 ? <td aria-hidden="true" style={{ width: px, minWidth: px, maxWidth: px, padding: 0, borderBottom: '1px solid var(--border-color)' }} /> : null
  const shownGroups = useMemo(() => {
    const out: { g: (typeof headerGroups)[number]; span: number }[] = []
    let cursor = 0
    for (const g of headerGroups) {
      const span = Math.max(0, Math.min(cursor + g.span, win.end) - Math.max(cursor, win.start))
      if (span > 0) out.push({ g, span })
      cursor += g.span
    }
    return out
  }, [headerGroups, win.start, win.end])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const guids = draggedCodeGuids(e)
    if (guids.length === 0) return
    setCodeGuids((prev) => {
      const existing = new Set(prev)
      return [...prev, ...guids.filter((g) => !existing.has(g))]
    })
  }, [])

  const handleExportCsv = useCallback(() => {
    const colNames = columns.map((c) => columnLabel(c))
    const rows: string[][] = [[t('analysis.code'), ...colNames]]
    for (let i = 0; i < codeGuids.length; i++) {
      rows.push([codeMap.get(codeGuids[i])?.name || '', ...grid[i].map((v) => v.toFixed(1) + '%')])
    }
    window.api.exportCsv(toCsv(rows), 'code-frequencies.csv').catch(reportExportFailure)
  }, [columns, t, codeGuids, codeMap, grid])

  const handleTagDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setTagDropOver(false)
    const fresh = parseGroupByDrop(e)
    if (fresh.length > 0) setGroupBy((p) => mergeGroupBy(p, fresh))
  }, [])

  const handleRemoveGroupBy = useCallback((entry: GroupByEntry) => {
    dismissAutoGroup(entry)
    const key = groupByKey(entry)
    setGroupBy((p) => p.filter((e) => groupByKey(e) !== key))
  }, [dismissAutoGroup])

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
      config: { codeGuids, docFilter, groupBy }
    })
    setBaseline({ codeGuids, docFilter, groupBy })
    if (inTab) inTab.onSaved(analysisGuid, name)
    else setTimeout(() => window.close(), 200)
  }, [analysisGuid, codeGuids, docFilter, groupBy, inTab, setBaseline])

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
  // Exactly as wide as its bars: each code's group is a 14 px bar per
  // column plus 10, groups 16 apart, after the 40 px axis margin and a 20
  // px gap (as the bars are placed below), with 20 px to spare.
  const chartW = Math.max(400, 40 + 20 + codeGuids.length * (columns.length * 14 + 10 + 16) + 20)
  // Height grows with the number of codes (groups). Driving from
  // codeGuids.length is more visible than tracking chartW, because
  // chartW already grows quickly with series and would otherwise
  // dominate the formula. The clamp keeps a usable plot area for
  // a single code and bounds the chart at ~one screen tall.
  const chartH = Math.min(560, Math.max(220, 160 + codeGuids.length * 24))
  // Only the bars in view are drawn (a bar per code per column is tens of
  // thousands on a large project), except while the chart is exported.
  const chartView = useScrollView(chartW > 6000)
  const [drawAllBars, setDrawAllBars] = useState(false)
  const barRange = (groupX: number, n: number): [number, number] => {
    if (drawAllBars || chartW <= 6000) return [0, n]
    const lo = chartView.view.offset - chartView.margin - groupX
    const hi = chartView.view.offset + chartView.view.width + chartView.margin - groupX
    return [Math.max(0, Math.floor(lo / 14)), Math.min(n, Math.ceil(hi / 14))]
  }

  // Font sizes scale with chart height. The 8 px floor matches the
  // previous fixed value (legible on the smallest chart); the upper
  // bound keeps text from looking oversized on tall charts.
  const axisFontSize = Math.min(13, Math.max(8, Math.round(chartH / 32)))
  const labelFontSize = Math.min(13, Math.max(8, Math.round(chartH / 30)))
  const labelMaxChars = Math.min(20, Math.max(10, Math.round(chartH / 22)))

  const marginInlineStart = 40
  // Reserve enough room below the x-axis for the (possibly larger)
  // code label text. `max(40, …)` keeps the original spacing on
  // small charts while still growing for taller fonts.
  const marginBottom = Math.max(40, labelFontSize + 28)
  const barMaxH = chartH - marginBottom - 10
  const maxPct = useMemo(() => Math.max(1, ...grid.flat()), [grid])


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
      const label = columnLabel(col, 20)
      return {
        color: SERIES_COLORS[ci % SERIES_COLORS.length],
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
    // Every bar, not just those in view.
    flushSync(() => setDrawAllBars(true))
    const chartHtml = chartRef.current.outerHTML
    setDrawAllBars(false)
    const combined = `<svg xmlns="http://www.w3.org/2000/svg" width="${chartW}" height="${totalH}" viewBox="0 0 ${chartW} ${totalH}"><rect width="${chartW}" height="${totalH}" fill="#ffffff"/>${legendParts.join('')}<g transform="translate(0, ${legendH})">${chartHtml}</g></svg>`

    window.api.exportSvg(combined, 'code-frequencies-chart.svg').catch(reportExportFailure)
  }, [columns, themeColors, chartW, chartH])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '14px 20px 6px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)' }}>
          <Icon icon={faChartBar} className="analysis-header-icon" style={{ fontSize: 16 }} />
          {t('tools.codeFrequencies.label')}{isExisting ? ':' : ''}
          {isExisting && <EditableTitleSuffix name={analysisName} onRename={handleRename} />}
        </h2>
        <div style={{ flex: 1 }} />
        <button className="secondary" style={{ fontSize: 11, padding: '4px 14px' }} onClick={() => inTab ? inTab.onClose() : window.close()}>
          {t('common.close')}
        </button>
        {isExisting && dirty && (
          <button className="secondary" style={{ fontSize: 11, padding: '4px 14px' }} onClick={handleDiscard}>
            {t('common.discardChanges')}
          </button>
        )}
        {isExisting ? (
          <button
            style={{ fontSize: 11, padding: '4px 14px' }}
            disabled={!dirty}
            onClick={() => { handleSave(analysisName) }}
          >
            {dirty ? t('analysis.update') : t('analysis.saved')}
          </button>
        ) : (
          <button style={{ fontSize: 11, padding: '4px 14px' }} onClick={() => setShowSaveDialog(true)}>
            {t('analysis.save')}
          </button>
        )}
        {/* Clearance for the floating MemoFab. */}
        <div style={{ width: 36, flexShrink: 0 }} />
      </div>

      {showSaveDialog && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{t('analysis.save')}</h2>
            <input
              autoFocus
              type="text"
              defaultValue={analysisName}
              placeholder={t('analysis.namePlaceholder')}
              style={{ width: '100%' }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave((e.target as HTMLInputElement).value.trim() || t('common.untitled'))
                if (e.key === 'Escape') setShowSaveDialog(false)
              }}
            />
            <div className="modal-actions">
              <button className="secondary" onClick={() => setShowSaveDialog(false)}>{t('common.cancel')}</button>
              <button onClick={(e) => {
                const input = (e.target as HTMLElement).parentElement!.parentElement!.querySelector('input') as HTMLInputElement
                handleSave(input.value.trim() || t('common.untitled'))
              }}>{t('common.save')}</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: '14px 20px' }}>
        <DocumentsSection data={data} filter={docFilter} onChange={setDocFilter} filteredSourceGuids={filteredSourceGuids} />

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
          {...dropZone(t('analysis.groupedBy'))}
          onDrop={handleTagDrop}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: groupBy.length > 0 ? 8 : 0, position: 'relative', zIndex: 1 }}>
            <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('analysis.groupedBy')}</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {t('analysis.dragGroupHint')}
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
          {...dropZone(t('analysis.results'))}
          onDrop={(e) => { setDropOver(false); handleDrop(e) }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, position: 'relative', zIndex: 1 }}>
            <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('analysis.results')}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, position: 'relative' }}>
              <button className="secondary" style={{ fontSize: 10, padding: '3px 8px' }} onClick={handleExportCsv} disabled={codeGuids.length === 0}>
                {t('analysis.exportCsv')}
              </button>
              <button
                ref={infoButtonRef}
                onClick={() => setShowInfo((v) => !v)}
                title={t('codeFreq.howCalculated')}
                aria-label={t('codeFreq.howCalculated')}
                style={{
                  background: 'none', border: 'none', padding: 2,
                  color: showInfo ? 'var(--accent)' : 'var(--text-muted)',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center'
                }}
              >
                <Icon icon={faCircleInfo} style={{ fontSize: 14 }} />
              </button>
              {showInfo && infoPlace && (
                <>
                  {/* Click-outside dismiss */}
                  <div
                    style={{ position: 'fixed', inset: 0, zIndex: 99 }}
                    onClick={() => setShowInfo(false)}
                  />
                  <div
                    style={{
                      position: 'fixed', left: infoPlace.left, top: infoPlace.top,
                      width: infoPlace.width, maxHeight: infoPlace.maxHeight, overflow: 'auto', padding: '12px 14px',
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
                    <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>{t('codeFreq.howHeading')}</div>
                    <div style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>
                      {t('codeFreq.howIntro')}
                    </div>
                    <ul style={{ margin: '0 0 8px 16px', padding: 0, color: 'var(--text-secondary)' }}>
                      <li style={{ marginBottom: 4 }}><Trans i18nKey="codeFreq.howText" components={{ b: <strong /> }} /></li>
                      <li style={{ marginBottom: 4 }}><Trans i18nKey="codeFreq.howSurvey" components={{ b: <strong /> }} /></li>
                      <li style={{ marginBottom: 4 }}><Trans i18nKey="codeFreq.howMedia" components={{ b: <strong /> }} /></li>
                      <li style={{ marginBottom: 4 }}><Trans i18nKey="codeFreq.howPdfText" components={{ b: <strong /> }} /></li>
                      <li style={{ marginBottom: 4 }}><Trans i18nKey="codeFreq.howPdfRegion" components={{ b: <strong /> }} /></li>
                      <li style={{ marginBottom: 4 }}><Trans i18nKey="codeFreq.howPdfMixed" components={{ b: <strong /> }} /></li>
                      <li><Trans i18nKey="codeFreq.howImage" components={{ b: <strong /> }} /></li>
                    </ul>
                    <div style={{ color: 'var(--text-secondary)', marginBottom: 6 }}><Trans i18nKey="codeFreq.howGroups" components={{ b: <strong /> }} /></div>
                    <div style={{ color: 'var(--text-secondary)' }}>{t('codeFreq.howEstimated')}</div>
                  </div>
                </>
              )}
            </div>
          </div>

          {codeGuids.length === 0 ? (
            <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)', position: 'relative', zIndex: 1 }}>
              {t('analysis.buildGridHint')}
            </div>
          ) : (
            <div ref={win.ref} style={{ overflowX: 'auto' }} tabIndex={0} role="region" aria-label={t('tools.codeFrequencies.label')}>
              {/* Room at the end for the last column's slanted label, so the
                  scroll width is the same whether it's drawn or not. */}
              <table {...tableKeys} style={{ borderCollapse: 'collapse', fontSize: 11, marginInlineEnd: 140 }}>
                <thead>
                  {hasGroupedHeader && (
                    <tr>
                      <th style={{ padding: '0 6px 4px', borderBottom: '1px solid var(--border-color)' }} />
                      {spacer(win.before)}
                      {shownGroups.map(({ g, span }) => (
                        <th
                          key={`hg:${g.id}`}
                          colSpan={span}
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
                      {spacer(win.after)}
                    </tr>
                  )}
                  <tr>
                    <th style={{ padding: 4, borderBottom: '1px solid var(--border-color)', textAlign: 'start', minWidth: 100, verticalAlign: 'bottom' }}>{t('analysis.code')}</th>
                    {spacer(win.before)}
                    {shown.map((col, k) => { const j = win.start + k; return (
                      <th
                        key={col.id}
                        style={{
                          width: 60, minWidth: 60, maxWidth: 60,
                          borderBottom: '1px solid var(--border-color)',
                          background: inBand[j] ? BAND_TINT : undefined,
                          verticalAlign: 'bottom', height: 80, padding: 0, position: 'relative'
                        }}
                      >
                        <div
                          title={isAverageColumn(col) ? `${col.label}: ${t('codeFreq.averageTitle')}` : col.label}
                          style={{ position: 'absolute', bottom: 6, left: '50%', transformOrigin: 'bottom left', transform: 'rotate(-20deg)', whiteSpace: 'nowrap', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 170 }}
                        >
                          {columnLabel(col, 24)}
                        </div>
                      </th>
                    ) })}
                    {spacer(win.after)}
                  </tr>
                </thead>
                <tbody>
                  {codeGuids.map((codeGuid, i) => (
                    <tr key={codeGuid}>
                      <td style={{ padding: '4px 6px', borderBottom: '1px solid var(--border-color)', fontWeight: 600, maxWidth: 120, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: codeMap.get(codeGuid)?.color || '#888', marginInlineEnd: 4, verticalAlign: 'middle' }} />
                        {truncate(codeMap.get(codeGuid)?.name || '', 16)}
                        <span {...keyActivate({ label: t('common.remove') })} onClick={() => setCodeGuids((p) => p.filter((g) => g !== codeGuid))} style={{ marginInlineStart: 4, fontSize: 9, color: 'var(--text-muted)', cursor: 'pointer' }}>x</span>
                      </td>
                      {spacer(win.before)}
                      {shown.map((col, k) => {
                        const j = win.start + k
                        const val = grid[i][j]
                        return (
                          <td
                            key={col.id}
                            {...gridCell()}
                            style={{
                              padding: '4px 6px',
                              borderBottom: '1px solid var(--border-color)',
                              background: inBand[j] ? BAND_TINT : undefined,
                              textAlign: 'center',
                              // A zero recedes, still readable (zero-cell.ts).
                              ...(val === 0 ? ZERO_CELL : null),
                              cursor: val > 0 ? 'pointer' : undefined
                            }}
                            onClick={() => {
                              if (val > 0) {
                                window.api.sendAnalysisAction('run-code-in-doc-query', codeGuid, col.sourceGuids, filteredSourceGuids, surveyScope(col))
                              }
                            }}
                          >
                            {formatPercent(val)}
                          </td>
                        )
                      })}
                      {spacer(win.after)}
                    </tr>
                  ))}
                </tbody>
              </table>
              {estimatedNames.length > 0 && (
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
                  {t('codeFreq.estimatedNote', { names: estimatedNames.join(', ') })}
                </div>
              )}
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
              <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('codeFreq.chart')}</span>
              <button className="secondary" style={{ fontSize: 10, padding: '3px 8px' }} onClick={handleExportChart}>
                {t('analysis.exportSvg')}
              </button>
            </div>

            {/* Legend */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
              {columns.map((col, ci) => (
                <div key={col.id} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }}>
                  <div style={{ width: 10, height: 10, background: SERIES_COLORS[ci % SERIES_COLORS.length], borderRadius: 2 }} />
                  {columnLabel(col, 20)}
                </div>
              ))}
            </div>

            <div ref={chartView.ref} style={{ overflowX: 'auto' }} tabIndex={0} role="region" aria-label={t('tools.codeFrequencies.label')}>
              <svg ref={chartRef} width={chartW} height={chartH} style={{ background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)' }}>
                {/* Y axis */}
                <line x1={marginInlineStart} y1={5} x2={marginInlineStart} y2={chartH - marginBottom} stroke={themeColors.borderColor} />
                {[0, 25, 50, 75, 100].map((pct) => {
                  const y = chartH - marginBottom - (pct / Math.max(maxPct, 100)) * barMaxH
                  return (
                    <g key={pct}>
                      <line x1={marginInlineStart - 4} y1={y} x2={marginInlineStart} y2={y} stroke={themeColors.textMuted} />
                      <text x={marginInlineStart - 6} y={y + Math.round(axisFontSize * 0.35)} textAnchor="end" fontSize={axisFontSize} fontFamily={SVG_FONT_FAMILY} fill={themeColors.textMuted}>{pct}%</text>
                    </g>
                  )
                })}
                {/* X axis */}
                <line x1={marginInlineStart} y1={chartH - marginBottom} x2={chartW} y2={chartH - marginBottom} stroke={themeColors.borderColor} />
                {/* Bars */}
                {codeGuids.map((codeGuid, ci) => {
                  const groupW = columns.length * 14 + 10
                  const groupX = marginInlineStart + 20 + ci * (groupW + 16)
                  const [from, to] = barRange(groupX, columns.length)
                  return (
                    <g key={codeGuid}>
                      {columns.slice(from, to).map((col, k) => {
                        const si = from + k
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
                            fill={SERIES_COLORS[si % SERIES_COLORS.length]}
                            opacity={0.85}
                            rx={1}
                            style={{ cursor: val > 0 ? 'pointer' : undefined }}
                            onClick={() => {
                              // As in the table: the code in the column's cells.
                              if (val > 0) window.api.sendAnalysisAction('run-code-in-doc-query', codeGuid, col.sourceGuids, filteredSourceGuids, surveyScope(col))
                            }}
                          >
                            <title>{t('codeFreq.barTitle', { code: codeMap.get(codeGuid)?.name, value: formatPercent(val), column: columnLabel(col) })}</title>
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
