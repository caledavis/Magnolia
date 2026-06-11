/**
 * Reports — headless regeneration of analysis tables into HTML for the
 * report PDF. Each generator rebuilds the tool's grid from the saved
 * config against fresh init data (so the PDF never carries stale data),
 * mirroring the on-screen computation, and emits a print-friendly table
 * honouring the per-item display options (Totals Only / Binary /
 * Visual).
 *
 * Tools land here one at a time; anything not yet implemented falls back
 * to a short placeholder so the rest of the report still renders.
 */
import { buildAnalysisInitData } from '../../utils/build-analysis-init-data'
import {
  applySurveyCellScope,
  resolveFilteredSources,
  countCodeInSource,
  codeFrequencyInSource,
  countCoOccurrences,
  binarizeGrid
} from './analysis-helpers'
import { buildSurveyAwareColumns, type AnalysisColumn } from './survey-grouping'
import { buildExportSvg } from './RelationshipMap/svg-export'
import { emptyDocumentFilter } from '../DocumentSelector/DocumentSelector'
import { executeQuery } from '../../utils/query-engine'
import { stripFormatting } from '../../utils/strip-formatting'
import { escHtml } from '../../utils/pdf-export'
import { TOOL_REGISTRY } from '../../utils/tool-registry'
import { useProjectStore } from '../../stores/project-store'
import type { AnalysisInitData, QueryResult } from '../../models/types'
import type { AnalysisItemOptions, ReportItem } from './report-export'

/** CSS for the report's regenerated analysis tables, appended to the
 *  export document's styles. */
export const REPORT_TABLE_CSS = `
  table.report-table { width: auto; border-collapse: collapse; font-size: 10px; margin: 2px 0 6px 0; }
  table.report-table th, table.report-table td { border: 1px solid #ddd; padding: 3px 6px; text-align: center; white-space: nowrap; }
  table.report-table th.rowhead, table.report-table td.rowhead { text-align: left; font-weight: 600; }
  table.report-table th { background: #f3f4f6; color: #555; font-size: 9px; font-weight: 600; }
  table.report-table td.zero { color: #bbb; }
  table.report-co td.co-seq { text-align: left; white-space: normal; line-height: 1.8; }
  .co-chip { display: inline-block; white-space: nowrap; }
  .co-chip .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 3px; vertical-align: middle; }
  .co-arrow { color: #aaa; margin: 0 5px; }
  /* Grid tables, matching the on-screen Codes-in-Documents / Results-in-
     Documents / Co-Occurrences look: rotated headers, fixed 50x32 cells,
     subtotal / band tints, and (in Visual mode) sized colour boxes. */
  table.report-grid { border-collapse: collapse; font-size: 10px; margin: 4px 0 12px 0; }
  table.report-grid th, table.report-grid td { border: 1px solid #dde2e8; }
  table.report-grid th.corner { text-align: left; vertical-align: bottom; padding: 5px 8px; font-weight: 700; color: #444; font-size: 10px; background: #f4f6f8; }
  table.report-grid th.col { width: 30px; min-width: 30px; max-width: 30px; vertical-align: bottom; padding: 6px 0 5px; background: #f4f6f8; }
  /* Vertical headers (read bottom-to-top) keep long document / respondent
     names from overflowing the way the on-screen diagonal labels would in
     a fixed-width PDF page. */
  table.report-grid th.col .vlabel { writing-mode: vertical-rl; transform: rotate(180deg); white-space: nowrap; font-size: 9px; color: #586271; margin: 0 auto; max-height: 130px; }
  table.report-grid th.col.sub { background: #e6ebf1; }
  table.report-grid th.col.sub .vlabel { font-style: italic; font-weight: 700; color: #3a4a60; }
  table.report-grid th.col.band { background: #eef2f6; }
  table.report-grid th.col.totalhead { background: #e9edf2; }
  table.report-grid th.col.totalhead .vlabel { font-weight: 700; color: #2a3340; }
  table.report-grid th.band-label { text-align: center; font-size: 9px; font-weight: 700; color: #3a4a60; background: #eef2f6; padding: 3px 4px; white-space: nowrap; overflow: hidden; }
  table.report-grid td.rowname { text-align: left; font-weight: 600; padding: 4px 8px; max-width: 190px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #222; }
  table.report-grid td.cell { width: 30px; height: 26px; padding: 0; text-align: center; color: #333; }
  table.report-grid td.cell.sub { background: #eef1f6; font-weight: 700; }
  table.report-grid td.cell.band { background: #f6f8fb; }
  table.report-grid td.cell.zero { color: #c8cdd4; }
  table.report-grid td.totalcell { min-width: 32px; height: 26px; padding: 0 6px; text-align: center; font-weight: 700; border-left: 2px solid #c4ccd6; color: #222; }
  table.report-grid td.pctcell { min-width: 42px; height: 26px; padding: 0 6px; text-align: center; font-style: italic; font-size: 9px; color: #6a7b90; background: #f7f9fb; }
  table.report-grid tr.total td { border-top: 2px solid #aab4c0; font-weight: 700; background: #eef1f5; }
  .cw { height: 26px; display: flex; align-items: center; justify-content: center; }
  .report-map { margin: 6px 0 10px; text-align: center; }
  .report-map svg { max-width: 100%; height: auto; display: inline-block; }
  .report-wf-viz { margin: 8px 0 12px; text-align: center; break-inside: avoid; page-break-inside: avoid; }
  .report-wf-viz svg.wf-viz { max-width: 100%; height: auto; display: inline-block; }
`

function pctOf(value: number, total: number): string {
  if (!total) return ''
  return ((value / total) * 100).toFixed(1) + '%'
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

/** A sized colour box for a "Visual" cell, replicating the on-screen
 *  grid exactly: box size 6→24px and an rgb red ramp scaled by the
 *  value's share of the (non-subtotal) max; empty cells get a tiny grey
 *  square. */
function visualBox(v: number, maxVal: number): string {
  const ratio = v > 0 ? Math.min(1, v / Math.max(1, maxVal)) : 0
  const size = v > 0 ? 5 + ratio * 15 : 3
  const r = Math.round(180 + ratio * 75)
  const g = Math.round(180 - ratio * 100)
  const b = Math.round(180 - ratio * 100)
  const color = v > 0 ? `rgb(${r},${g},${b})` : '#e9eef5'
  return `<div style="width:${size}px;height:${size}px;background:${color};border-radius:2px"></div>`
}

/** Wrap a table; flag wide ones so the export CSS can rotate/scale them
 *  (handled in a later phase). */
function wrapTable(inner: string, dataColCount: number): string {
  const wide = dataColCount > 12
  return `<div class="report-wide${wide ? ' report-wide-rotate' : ''}"><table class="report-table">${inner}</table></div>`
}

/** Shared renderer for the count grids (Codes in Documents, Results in
 *  Documents): rows × survey-aware columns, with subtotal columns + a
 *  "%" column each, a Total column, and a "% of Total" column, plus the
 *  bottom Total row. `grid` is already binarised when `opts.binary`. */
function renderGridTableHtml(
  rowLabel: string,
  rowNames: string[],
  columns: AnalysisColumn[],
  headerGroups: { label: string | null; span: number }[],
  grid: number[][],
  opts: { binary: boolean; visual: boolean; totalsOnly: boolean }
): string {
  const { binary, visual, totalsOnly } = opts
  const rowTotals = grid.map((row) => row.reduce((s, v, j) => (columns[j].isSubtotal ? s : s + v), 0))
  const colTotals = columns.map((_, j) => grid.reduce((s, row) => s + row[j], 0))
  const grandTotal = rowTotals.reduce((a, b) => a + b, 0)
  let maxVal = 1
  for (let i = 0; i < grid.length; i++) for (let j = 0; j < columns.length; j++) if (!columns[j].isSubtotal && grid[i][j] > maxVal) maxVal = grid[i][j]

  // Band membership (labelled groups), for the faint tint behind grouped
  // columns — matches the on-screen treatment.
  const inBand = new Array(columns.length).fill(false)
  {
    let cursor = 0
    for (const g of headerGroups) {
      if (g.label !== null) for (let i = 0; i < g.span; i++) inBand[cursor + i] = true
      cursor += g.span
    }
  }
  const colCls = (j: number) => (columns[j].isSubtotal ? ' sub' : inBand[j] ? ' band' : '')

  const visIdx = columns.map((_, j) => j).filter((j) => (totalsOnly ? columns[j].isSubtotal : true))
  const grouped = !totalsOnly && headerGroups.some((g) => g.label !== null)

  // Grouped band header row (spanning category/folder/survey names).
  let groupedRow = ''
  if (grouped) {
    const spans: number[] = []
    let cursor = 0
    for (const g of headerGroups) {
      let extra = 0
      for (let k = cursor; k < cursor + g.span; k++) if (columns[k]?.isSubtotal) extra++
      spans.push(g.span + extra)
      cursor += g.span
    }
    const cells = headerGroups
      .map((g, gi) => (g.label !== null ? `<th class="band-label" colspan="${spans[gi]}">${escHtml(g.label)}</th>` : `<th colspan="${spans[gi]}"></th>`))
      .join('')
    groupedRow = `<tr><th class="corner"></th>${cells}<th></th><th></th></tr>`
  }

  // Rotated column header row.
  const headCells = visIdx
    .map((j) => {
      const th = `<th class="col${colCls(j)}"><div class="vlabel">${escHtml(trunc(columns[j].label, 26))}</div></th>`
      const pctTh = columns[j].isSubtotal ? `<th class="col sub"><div class="vlabel">%</div></th>` : ''
      return th + pctTh
    })
    .join('')
  const headerRow = `<tr><th class="corner">${escHtml(rowLabel)}</th>${headCells}<th class="col totalhead"><div class="vlabel">Total</div></th><th class="col totalhead"><div class="vlabel">% of Total</div></th></tr>`

  // Body rows — Visual mode draws a sized box; Numeric shows the count.
  const body = rowNames
    .map((name, i) => {
      const cells = visIdx
        .map((j) => {
          const v = grid[i][j]
          const zero = v === 0 && !columns[j].isSubtotal
          const inner = visual ? visualBox(v, maxVal) : String(v)
          const cell = `<td class="cell${colCls(j)}${zero ? ' zero' : ''}"><div class="cw">${inner}</div></td>`
          const pctCell = columns[j].isSubtotal ? `<td class="pctcell">${binary ? '–' : pctOf(v, rowTotals[i]) || '–'}</td>` : ''
          return cell + pctCell
        })
        .join('')
      return `<tr><td class="rowname">${escHtml(name)}</td>${cells}<td class="totalcell">${rowTotals[i]}</td><td class="pctcell">${pctOf(rowTotals[i], grandTotal) || '–'}</td></tr>`
    })
    .join('')

  // Total row is always numeric (the on-screen margins never become boxes).
  const totalCells = visIdx
    .map((j) => {
      const cell = `<td class="cell${colCls(j)}"><div class="cw">${colTotals[j]}</div></td>`
      const pctCell = columns[j].isSubtotal ? `<td class="pctcell">${binary ? '–' : pctOf(colTotals[j], grandTotal) || '–'}</td>` : ''
      return cell + pctCell
    })
    .join('')
  const totalRow = `<tr class="total"><td class="rowname">Total</td>${totalCells}<td class="totalcell">${grandTotal}</td><td class="pctcell">${grandTotal ? '100.0%' : '–'}</td></tr>`

  const wide = visIdx.length > 12
  return `<div class="report-wide${wide ? ' report-wide-rotate' : ''}"><table class="report-grid">${groupedRow}${headerRow}${body}${totalRow}</table></div>`
}

/** Per-column survey-cell scope, exactly as the grid tools do it. */
function buildColData(columns: AnalysisColumn[], data: AnalysisInitData): Map<string, AnalysisInitData> {
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
  return colData
}

function scopedData(toolType: AnalysisInitData['toolType'], config: any): { data: AnalysisInitData; docFilter: any } {
  const docFilter = config?.docFilter ?? emptyDocumentFilter()
  const base = buildAnalysisInitData(toolType)
  let data = applySurveyCellScope(base, docFilter)
  const questionScope = config?.questionScope ?? []
  if (questionScope.length) data = applySurveyCellScope(data, { questionScope })
  return { data, docFilter }
}

// ── Codes in Documents ─────────────────────────────────────────────

function codesInDocumentsHtml(config: any, options: AnalysisItemOptions): string {
  const codeGuids: string[] = config?.codeGuids ?? []
  if (codeGuids.length === 0) return '<div class="empty">(no codes in this analysis)</div>'
  const { data, docFilter } = scopedData('codes-in-documents', config)
  const filtered = resolveFilteredSources(data, docFilter.sourceGuids ?? [], docFilter.tagGuids ?? [], docFilter.tagExcludeGuids ?? [], docFilter.typeInclude ?? [], docFilter.typeExclude ?? [])
  const sourceMap = new Map<string, string>(data.sources.map((s) => [s.guid, s.name]))
  const codeMap = new Map(data.codes.map((c) => [c.guid, c]))
  const { columns, headerGroups } = buildSurveyAwareColumns(config?.groupBy ?? [], data, filtered, sourceMap)
  const colData = buildColData(columns, data)
  let grid = codeGuids.map((cg) =>
    columns.map((col) => {
      const cd = colData.get(col.id) || data
      return col.sourceGuids.reduce((sum, sg) => sum + countCodeInSource(cd, sg, cg), 0)
    })
  )
  if (options.binary) grid = binarizeGrid(grid)
  const names = codeGuids.map((cg) => codeMap.get(cg)?.name ?? 'Code')
  return renderGridTableHtml('Code', names, columns, headerGroups, grid, { binary: !!options.binary, visual: !!options.visual, totalsOnly: !!options.totalsOnly })
}

// ── Results in Documents ───────────────────────────────────────────

function resultsInDocumentsHtml(config: any, options: AnalysisItemOptions): string {
  const queryGuids: string[] = config?.queryGuids ?? []
  if (queryGuids.length === 0) return '<div class="empty">(no queries in this analysis)</div>'

  const base = buildAnalysisInitData('results-in-documents')
  const questionScope = config?.questionScope ?? []
  const data = questionScope.length ? applySurveyCellScope(base, { questionScope }) : base

  const queryMap = new Map<string, { name: string; query?: any }>()
  for (const sq of data.savedQueries || []) queryMap.set(sq.guid, { name: sq.name, query: sq.query })
  const sourceMap = new Map<string, string>(data.sources.map((s) => [s.guid, s.name]))

  const execSources = data.sources.map((s) => ({
    guid: s.guid,
    name: s.name,
    selections: (data.sourceSelections[s.guid] || []).map((sel: any) => ({ ...sel, codings: sel.codings || [] }))
  }))
  const execCodes = data.codes.map((c) => ({ guid: c.guid, name: c.name, color: c.color, isCodable: c.isCodable, children: [] }))
  const execTags = data.tags.map((t) => ({ guid: t.guid, name: t.name, memberSourceGuids: data.tagMembers[t.guid] || [] }))
  const execFolders = (data.folders || []).map((f) => ({ guid: f.guid, name: f.name, parentGuid: f.parentGuid }))

  const queryResults = new Map<string, QueryResult[]>()
  for (const qGuid of queryGuids) {
    const sq = queryMap.get(qGuid)
    if (!sq?.query) continue
    queryResults.set(
      qGuid,
      executeQuery(sq.query, execSources as any, data.sourceContents, execCodes as any, execTags as any, data.sourceFolder, execFolders)
    )
  }

  const resultSourceGuids = new Set<string>()
  for (const results of queryResults.values()) for (const r of results) resultSourceGuids.add(r.sourceGuid)

  const { columns, headerGroups } = buildSurveyAwareColumns(config?.groupBy ?? [], data, Array.from(resultSourceGuids), sourceMap)

  let grid = queryGuids.map((qGuid) => {
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
  if (options.binary) grid = binarizeGrid(grid)
  const names = queryGuids.map((g) => queryMap.get(g)?.name ?? 'Query')
  return renderGridTableHtml('Query', names, columns, headerGroups, grid, { binary: !!options.binary, visual: !!options.visual, totalsOnly: !!options.totalsOnly })
}

// ── Code Frequencies (percentage grid, no totals/subtotals) ─────────

function codeFrequenciesHtml(config: any, options: AnalysisItemOptions): string {
  const codeGuids: string[] = config?.codeGuids ?? []
  if (codeGuids.length === 0) return '<div class="empty">(no codes in this analysis)</div>'
  const { data, docFilter } = scopedData('code-frequencies', config)
  const filtered = resolveFilteredSources(data, docFilter.sourceGuids ?? [], docFilter.tagGuids ?? [], docFilter.tagExcludeGuids ?? [], docFilter.typeInclude ?? [], docFilter.typeExclude ?? [])
  const sourceMap = new Map<string, string>(data.sources.map((s) => [s.guid, s.name]))
  const codeMap = new Map(data.codes.map((c) => [c.guid, c]))
  const { columns } = buildSurveyAwareColumns(config?.groupBy ?? [], data, filtered, sourceMap, { includeSubtotals: false })
  const colData = buildColData(columns, data)
  const grid = codeGuids.map((cg) =>
    columns.map((col) => {
      if (col.sourceGuids.length === 0) return 0
      const cd = colData.get(col.id) || data
      const total = col.sourceGuids.reduce((sum, sg) => sum + codeFrequencyInSource(cd, sg, cg), 0)
      return total / col.sourceGuids.length
    })
  )
  const thead = `<tr><th class="rowhead">Code</th>${columns.map((c) => `<th>${escHtml(c.label)}</th>`).join('')}</tr>`
  const body = codeGuids
    .map((cg, i) => {
      const cells = columns
        .map((_, j) => {
          const v = grid[i][j]
          return `<td class="${v === 0 ? 'zero' : ''}">${v.toFixed(1)}%</td>`
        })
        .join('')
      return `<tr><td class="rowhead">${escHtml(codeMap.get(cg)?.name ?? 'Code')}</td>${cells}</tr>`
    })
    .join('')
  return wrapTable(`<thead>${thead}</thead><tbody>${body}</tbody>`, columns.length)
}

// ── Code Co-Occurrences ────────────────────────────────────────────

function codeCoOccurrencesHtml(config: any, options: AnalysisItemOptions): string {
  const rowCodeGuids: string[] = config?.rowCodeGuids ?? []
  const colCodeGuids: string[] = config?.colCodeGuids ?? []
  if (rowCodeGuids.length === 0 || colCodeGuids.length === 0) return '<div class="empty">(no codes in this analysis)</div>'
  const { data, docFilter } = scopedData('code-cooccurrences', config)
  const filtered = resolveFilteredSources(data, docFilter.sourceGuids ?? [], docFilter.tagGuids ?? [], docFilter.tagExcludeGuids ?? [], docFilter.typeInclude ?? [], docFilter.typeExclude ?? [])
  const codeMap = new Map(data.codes.map((c) => [c.guid, c]))

  let matrix = rowCodeGuids.map((rg) => colCodeGuids.map((cg) => (rg === cg ? 0 : countCoOccurrences(data, filtered, rg, cg))))
  const binary = !!options.binary
  if (binary) matrix = binarizeGrid(matrix)

  const rowTotals = matrix.map((row) => row.reduce((a, b) => a + b, 0))
  const colTotals = colCodeGuids.map((_, j) => matrix.reduce((s, row) => s + row[j], 0))
  const grandTotal = rowTotals.reduce((a, b) => a + b, 0)
  let maxVal = 1
  for (const row of matrix) for (const v of row) if (v > maxVal) maxVal = v
  const visual = !!options.visual
  const totalsOnly = !!options.totalsOnly
  const dot = (color?: string) => `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${color || '#888'};flex-shrink:0"></span>`

  const colHead = totalsOnly
    ? ''
    : colCodeGuids.map((g) => `<th class="col"><div class="vlabel">${escHtml(trunc(codeMap.get(g)?.name ?? 'Code', 26))}</div></th>`).join('')
  const headerRow = `<tr><th class="corner"></th>${colHead}<th class="col totalhead"><div class="vlabel">Total</div></th><th class="col totalhead"><div class="vlabel">% of Total</div></th></tr>`

  const body = rowCodeGuids
    .map((rg, i) => {
      const name = codeMap.get(rg)?.name ?? 'Code'
      const cells = totalsOnly
        ? ''
        : colCodeGuids
            .map((cg, j) => {
              if (rg === cg) return '<td class="cell zero"><div class="cw">—</div></td>'
              const v = matrix[i][j]
              const inner = visual ? visualBox(v, maxVal) : String(v)
              return `<td class="cell${v === 0 ? ' zero' : ''}"><div class="cw">${inner}</div></td>`
            })
            .join('')
      return `<tr><td class="rowname"><span style="display:inline-flex;align-items:center;gap:4px">${dot(codeMap.get(rg)?.color)}${escHtml(name)}</span></td>${cells}<td class="totalcell">${rowTotals[i]}</td><td class="pctcell">${pctOf(rowTotals[i], grandTotal) || '–'}</td></tr>`
    })
    .join('')

  const totalCells = totalsOnly ? '' : colTotals.map((ct) => `<td class="cell"><div class="cw">${ct}</div></td>`).join('')
  const totalRow = `<tr class="total"><td class="rowname">Total</td>${totalCells}<td class="totalcell">${grandTotal}</td><td class="pctcell">${grandTotal ? '100.0%' : '–'}</td></tr>`

  const wide = (totalsOnly ? 0 : colCodeGuids.length) > 12
  return `<div class="report-wide${wide ? ' report-wide-rotate' : ''}"><table class="report-grid">${headerRow}${body}${totalRow}</table></div>`
}

// ── Code Orders (ordered code sequence per document) ───────────────

function orderedCodeChips(
  d: AnalysisInitData,
  sourceGuids: string[],
  codeGuids: string[],
  codeMap: Map<string, { name: string; color?: string }>
): string {
  const seq: { name: string; color: string }[] = []
  for (const sg of sourceGuids) {
    const sels = d.sourceSelections[sg] || []
    const local: { start: number; name: string; color: string }[] = []
    for (const sel of sels) {
      for (const coding of sel.codings) {
        if (!codeGuids.includes(coding.codeGuid)) continue
        const info = codeMap.get(coding.codeGuid)
        local.push({ start: sel.startPosition, name: info?.name || 'Code', color: info?.color || '#888' })
      }
    }
    local.sort((a, b) => a.start - b.start)
    for (const l of local) seq.push({ name: l.name, color: l.color })
  }
  if (seq.length === 0) return '<span class="empty">(no codes)</span>'
  return seq
    .map((s) => `<span class="co-chip"><span class="dot" style="background:${s.color}"></span>${escHtml(s.name)}</span>`)
    .join('<span class="co-arrow">→</span>')
}

function codeOrdersHtml(config: any, _options: AnalysisItemOptions): string {
  const codeGuids: string[] = config?.codeGuids ?? []
  if (codeGuids.length === 0) return '<div class="empty">(no codes in this analysis)</div>'
  const { data, docFilter } = scopedData('code-orders', config)
  const filtered = resolveFilteredSources(data, docFilter.sourceGuids ?? [], docFilter.tagGuids ?? [], docFilter.tagExcludeGuids ?? [], docFilter.typeInclude ?? [], docFilter.typeExclude ?? [])
  const sourceMap = new Map<string, string>(data.sources.map((s) => [s.guid, s.name]))
  const codeMap = new Map(data.codes.map((c) => [c.guid, { name: c.name, color: c.color }]))
  const { columns: rows } = buildSurveyAwareColumns(config?.groupBy ?? [], data, filtered, sourceMap, { includeSubtotals: false })
  if (rows.length === 0) return '<div class="empty">(no documents in scope)</div>'
  const body = rows
    .map((row) => {
      const rd = row.respondentRef
        ? applySurveyCellScope(data, { respondentScope: [row.respondentRef] })
        : row.tagScopeGuids
          ? applySurveyCellScope(data, { tagGuids: row.tagScopeGuids })
          : data
      return `<tr><td class="rowhead">${escHtml(row.label)}</td><td class="co-seq">${orderedCodeChips(rd, row.sourceGuids, codeGuids, codeMap)}</td></tr>`
    })
    .join('')
  return `<div class="report-wide"><table class="report-table report-co"><thead><tr><th class="rowhead">Document</th><th class="rowhead">Order of codes</th></tr></thead><tbody>${body}</tbody></table></div>`
}

// ── Word Frequencies (top words × series) ──────────────────────────

function parseWordSet(s: string): Set<string> {
  return new Set((s || '').split(/[,\n]+/).map((w) => w.trim().toLowerCase()).filter(Boolean))
}

function countWordsIn(d: AnalysisInitData, sourceGuids: string[], excludeSet: Set<string>, includeSet: Set<string> | null): Map<string, number> {
  const freq = new Map<string, number>()
  for (const sg of sourceGuids) {
    const src = d.sources.find((s) => s.guid === sg)
    const st = (src as { sourceType?: string } | undefined)?.sourceType
    let text: string | undefined
    if (st === 'survey') {
      text = (d.surveyCodableCells?.[sg] || []).map((c) => c.text).join('\n')
    } else {
      text = d.sourceContents[sg]
      if (text && st && st !== 'text') {
        try { text = stripFormatting(text, st as any) } catch { /* keep raw */ }
      }
    }
    if (!text) continue
    const words = text.toLowerCase().match(/\b[a-zA-ZÀ-ɏ']+\b/g) || []
    for (const w of words) {
      if (w.length < 2) continue
      if (excludeSet.has(w)) continue
      if (includeSet && !includeSet.has(w)) continue
      freq.set(w, (freq.get(w) || 0) + 1)
    }
  }
  return freq
}

// ── Word Frequencies visualisations (bar chart + word cloud) ───────
// Faithful headless SVG versions of the on-screen Word Frequencies
// charts, so a report can include them as well as the table.

const WF_ACCENT_HSL = { h: 222, s: 65, l: 50 }
const WF_SERIES_COLORS = ['#4f6bed', '#e8703a', '#2ba84a', '#9b59b6', '#e4b400', '#16a2b8']
const WF_BORDER = '#cfd6df'
const WF_TEXT = '#333'

function hslToRgb(h: number, s: number, l: number): string {
  s /= 100; l /= 100
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))))
  return `rgb(${f(0)},${f(8)},${f(4)})`
}

/** Archimedean-spiral word-cloud layout, ported from the tool so the
 *  placement matches. */
function wordCloudSvg(words: [string, number][], maxFreq: number): string {
  if (words.length === 0) return ''
  const cloudW = 600, cloudH = 380
  const cx = cloudW / 2, cy = cloudH / 2
  const minSize = 11, maxSize = 48, padding = 1
  const placed: { x: number; y: number; w: number; h: number }[] = []
  const palette = words.map((_, i) => {
    const t = words.length > 1 ? 1 - i / (words.length - 1) : 1
    const sat = Math.round(WF_ACCENT_HSL.s * t)
    const light = Math.round(WF_ACCENT_HSL.l + (1 - t) * (60 - WF_ACCENT_HSL.l))
    return hslToRgb(WF_ACCENT_HSL.h, sat, light)
  })
  const texts: string[] = []
  for (let i = 0; i < words.length; i++) {
    const [word, count] = words[i]
    const size = minSize + Math.pow(count / maxFreq, 0.6) * (maxSize - minSize)
    const estW = word.length * size * 0.55 + padding * 2
    const estH = size * 0.95 + padding * 2
    let px = cx, py = cy, found = false
    for (let step = 0; step < 1600; step++) {
      px = cx + Math.cos(step * 0.18) * (step * 0.22)
      py = cy + Math.sin(step * 0.18) * (step * 0.22) * 0.65
      const rect = { x: px - estW / 2, y: py - estH / 2, w: estW, h: estH }
      if (rect.x < 2 || rect.y < 2 || rect.x + rect.w > cloudW - 2 || rect.y + rect.h > cloudH - 2) continue
      if (!placed.some((p) => rect.x < p.x + p.w && rect.x + rect.w > p.x && rect.y < p.y + p.h && rect.y + rect.h > p.y)) {
        placed.push(rect); found = true; break
      }
    }
    if (found) {
      const weight = size > 30 ? 700 : size > 20 ? 600 : 500
      texts.push(`<text x="${px.toFixed(1)}" y="${py.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="${size.toFixed(1)}" font-weight="${weight}" fill="${palette[i]}" opacity="0.9">${escHtml(word)}</text>`)
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cloudW} ${cloudH}" class="wf-viz">${texts.join('')}</svg>`
}

/** Grouped vertical bar chart, ported from the tool. */
function wordBarChartSvg(words: [string, number][], series: AnalysisColumn[], seriesFreqs: Map<string, number>[], maxFreq: number): string {
  if (words.length === 0) return ''
  const barW = 600, barH = 380, barMaxH = 200, marginB = 160
  const nSeries = series.length
  const yAxisW = 38, plotPad = 4
  const maxPlotW = barW - yAxisW * 2
  let groupW: number, subBarW: number, groupGap: number
  if (nSeries <= 1) {
    const gap = Math.max(1, Math.min(4, (maxPlotW / words.length) * 0.15))
    subBarW = Math.max(2, (maxPlotW - gap * words.length) / words.length)
    groupW = subBarW; groupGap = gap
  } else {
    subBarW = Math.max(2, Math.min(14, (maxPlotW / words.length - 4) / nSeries))
    groupW = subBarW * nSeries
    groupGap = Math.max(2, Math.min(8, subBarW * 0.4))
  }
  const step = groupW + groupGap
  const plotContentW = words.length * step
  const labelFontSize = Math.round(Math.min(17, Math.max(7, 24 - words.length * 0.45)))
  const charW = labelFontSize * 0.6
  const firstWord = words[0]?.[0] || ''
  const requiredLeftPad = (firstWord.length * charW) / Math.SQRT2 - plotPad - groupW / 2 + 4
  const plotLeft = Math.max(Math.max(yAxisW, (barW - plotContentW) / 2), requiredLeftPad)
  const plotRight = plotLeft + plotContentW + plotPad
  const effectiveBarW = Math.max(barW, plotRight + 10)
  const tickCount = 5
  const rawInterval = maxFreq / tickCount
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(rawInterval, 1))))
  const niceInterval = Math.ceil(rawInterval / mag) * mag
  const yMax = niceInterval * tickCount
  const xAxisY = barH - marginB
  const xAxisLabelOffsetY = Math.round(7 + labelFontSize * 0.6)

  const parts: string[] = []
  parts.push(`<line x1="${plotLeft}" y1="${xAxisY - barMaxH - 5}" x2="${plotLeft}" y2="${xAxisY}" stroke="${WF_BORDER}"/>`)
  parts.push(`<line x1="${plotLeft}" y1="${xAxisY}" x2="${plotRight}" y2="${xAxisY}" stroke="${WF_BORDER}"/>`)
  for (let t = 0; t <= tickCount; t++) {
    const value = niceInterval * t
    const y = xAxisY - (value / yMax) * barMaxH
    parts.push(`<line x1="${plotLeft - 4}" y1="${y}" x2="${plotLeft}" y2="${y}" stroke="${WF_BORDER}"/>`)
    parts.push(`<line x1="${plotLeft}" y1="${y}" x2="${plotRight}" y2="${y}" stroke="${WF_BORDER}" opacity="0.15"/>`)
    parts.push(`<text x="${plotLeft - 7}" y="${(y + labelFontSize * 0.35).toFixed(1)}" text-anchor="end" font-size="${labelFontSize}" fill="${WF_TEXT}">${value}</text>`)
  }
  words.forEach(([word], wi) => {
    const groupX = plotLeft + plotPad + wi * step
    const tickX = groupX + groupW / 2
    series.forEach((_s, si) => {
      const count = seriesFreqs[si].get(word) || 0
      const bH = count > 0 ? (count / yMax) * barMaxH : 0
      const bX = groupX + (nSeries > 1 ? si * subBarW : 0)
      const color = WF_SERIES_COLORS[si % WF_SERIES_COLORS.length]
      parts.push(`<rect x="${bX.toFixed(1)}" y="${(xAxisY - bH).toFixed(1)}" width="${subBarW.toFixed(1)}" height="${bH.toFixed(1)}" fill="${color}" opacity="0.85" rx="${Math.min(2, subBarW / 4).toFixed(1)}"/>`)
    })
    parts.push(`<line x1="${tickX.toFixed(1)}" y1="${xAxisY}" x2="${tickX.toFixed(1)}" y2="${xAxisY + 4}" stroke="${WF_BORDER}"/>`)
    const ly = xAxisY + xAxisLabelOffsetY
    parts.push(`<text x="${tickX.toFixed(1)}" y="${ly}" text-anchor="end" font-size="${labelFontSize}" fill="${WF_TEXT}" transform="rotate(-45, ${tickX.toFixed(1)}, ${ly})">${escHtml(word)}</text>`)
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${effectiveBarW} ${barH}" class="wf-viz">${parts.join('')}</svg>`
}

function wordFrequenciesHtml(config: any, options: AnalysisItemOptions): string {
  const { data, docFilter } = scopedData('word-frequencies', config)
  const filtered = resolveFilteredSources(data, docFilter.sourceGuids ?? [], docFilter.tagGuids ?? [], docFilter.tagExcludeGuids ?? [], docFilter.typeInclude ?? [], docFilter.typeExclude ?? [])
  const sourceMap = new Map<string, string>(data.sources.map((s) => [s.guid, s.name]))
  const excludeSet = parseWordSet(config?.excludeWords ?? '')
  const incl = parseWordSet(config?.includeWords ?? '')
  const includeSet = incl.size > 0 ? incl : null
  const wordCount: number = config?.wordCount ?? 30
  const groupBy = config?.groupBy ?? []
  const series: AnalysisColumn[] =
    groupBy.length === 0
      ? [{ id: '__all', label: 'All', sourceGuids: filtered }]
      : buildSurveyAwareColumns(groupBy, data, filtered, sourceMap, { includeSubtotals: true }).columns
  const seriesFreqs = series.map((s) =>
    countWordsIn(s.respondentRef ? applySurveyCellScope(data, { respondentScope: [s.respondentRef] }) : data, s.sourceGuids, excludeSet, includeSet)
  )
  const total = new Map<string, number>()
  for (const fm of seriesFreqs) for (const [w, c] of fm) total.set(w, (total.get(w) || 0) + c)
  const ranked = Array.from(total.entries()).sort((a, b) => b[1] - a[1]).slice(0, wordCount)
  if (ranked.length === 0) return '<div class="empty">(no words)</div>'

  const single = series.length === 1
  const thead = single
    ? `<tr><th class="rowhead">Word</th><th>Frequency</th></tr>`
    : `<tr><th class="rowhead">Word</th>${series.map((s) => `<th>${escHtml(s.label)}</th>`).join('')}<th>Total</th></tr>`
  const body = ranked
    .map(([w, tot]) => {
      if (single) return `<tr><td class="rowhead">${escHtml(w)}</td><td>${tot}</td></tr>`
      const cells = series.map((_, j) => { const c = seriesFreqs[j].get(w) || 0; return `<td class="${c === 0 ? 'zero' : ''}">${c}</td>` }).join('')
      return `<tr><td class="rowhead">${escHtml(w)}</td>${cells}<td>${tot}</td></tr>`
    })
    .join('')
  const table = wrapTable(`<thead>${thead}</thead><tbody>${body}</tbody>`, single ? 1 : series.length)

  // Optional visualisations, matching the entry count of the table.
  let maxFreq = 1
  for (const [w] of ranked) for (const fm of seriesFreqs) maxFreq = Math.max(maxFreq, fm.get(w) || 0)
  let viz = ''
  if (options.barChart) viz += `<div class="report-wf-viz">${wordBarChartSvg(ranked, series, seriesFreqs, maxFreq)}</div>`
  if (options.wordCloud) viz += `<div class="report-wf-viz">${wordCloudSvg(ranked, maxFreq)}</div>`
  return table + viz
}

/** Render one analysis item: regenerate its table fresh, or a short
 *  placeholder for tools not yet implemented / deleted analyses. */
// ── Relationship Map (static SVG snapshot) ─────────────────────────

/** Render a saved Relationship Map to an inline SVG scaled to the page
 *  width, via the same headless exporter as the tool's "Export SVG". */
function relationshipMapHtml(config: any): string {
  const svg = buildExportSvg(config?.elements ?? [], config?.connections ?? [], config?.freeTexts ?? [])
  return `<div class="report-map">${svg}</div>`
}

export function renderAnalysisItemHtml(
  item: Extract<ReportItem, { kind: 'analysis' }>,
  anchor: string
): string {
  const sa = useProjectStore.getState().savedAnalyses?.find((a) => a.guid === item.refGuid)
  const toolLabel = TOOL_REGISTRY[item.toolType]?.label ?? 'Analysis'
  if (!sa) {
    return `<div class="report-block" id="${anchor}"><div class="report-item-head">${escHtml(toolLabel)}</div><div class="empty">(deleted analysis)</div></div>`
  }
  const head = `<div class="report-item-head">${escHtml(toolLabel)} — ${escHtml(sa.name)}</div>`
  let inner: string
  try {
    switch (sa.toolType) {
      case 'codes-in-documents':
        inner = codesInDocumentsHtml(sa.config, item.options)
        break
      case 'results-in-documents':
        inner = resultsInDocumentsHtml(sa.config, item.options)
        break
      case 'code-frequencies':
        inner = codeFrequenciesHtml(sa.config, item.options)
        break
      case 'code-cooccurrences':
        inner = codeCoOccurrencesHtml(sa.config, item.options)
        break
      case 'code-orders':
        inner = codeOrdersHtml(sa.config, item.options)
        break
      case 'word-frequencies':
        inner = wordFrequenciesHtml(sa.config, item.options)
        break
      case 'relationship-map':
        inner = relationshipMapHtml(sa.config)
        break
      default:
        inner = `<div class="empty">${escHtml(sa.name)} — table generation for ${escHtml(toolLabel)} is coming soon.</div>`
    }
  } catch {
    inner = '<div class="empty">Could not regenerate this analysis.</div>'
  }
  return `<div class="report-block" id="${anchor}">${head}${inner}</div>`
}
