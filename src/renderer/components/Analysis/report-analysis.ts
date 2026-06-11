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
  table.report-table td.sub { background: #eef1f5; font-weight: 600; }
  table.report-table td.pct { background: #f6f7f9; font-style: italic; color: #666; }
  table.report-table tr.total td { border-top: 2px solid #bbb; font-weight: 700; }
  table.report-table td.zero { color: #bbb; }
  table.report-co td.co-seq { text-align: left; white-space: normal; line-height: 1.8; }
  .co-chip { display: inline-block; white-space: nowrap; }
  .co-chip .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 3px; vertical-align: middle; }
  .co-arrow { color: #aaa; margin: 0 5px; }
`

function pctOf(value: number, total: number): string {
  if (!total) return ''
  return ((value / total) * 100).toFixed(1) + '%'
}

/** Light→strong tint for a "visual" heatmap cell, mirroring the on-screen
 *  red ramp. */
function heatStyle(value: number, maxVal: number): string {
  if (value <= 0) return ''
  const ratio = Math.min(1, value / Math.max(1, maxVal))
  const g = Math.round(235 - ratio * 150)
  const b = Math.round(235 - ratio * 150)
  return ` style="background:rgb(255,${g},${b})"`
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
  grid: number[][],
  opts: { binary: boolean; visual: boolean; totalsOnly: boolean }
): string {
  const rowTotals = grid.map((row) => row.reduce((s, v, j) => (columns[j].isSubtotal ? s : s + v), 0))
  const colTotals = columns.map((_, j) => grid.reduce((s, row) => s + row[j], 0))
  const grandTotal = rowTotals.reduce((a, b) => a + b, 0)
  let maxVal = 1
  for (let i = 0; i < grid.length; i++) for (let j = 0; j < columns.length; j++) if (!columns[j].isSubtotal && grid[i][j] > maxVal) maxVal = grid[i][j]

  const { binary, visual, totalsOnly } = opts
  const visIdx = columns.map((_, j) => j).filter((j) => (totalsOnly ? columns[j].isSubtotal : true))

  const headCells = visIdx
    .map((j) => `<th class="${columns[j].isSubtotal ? 'sub' : ''}">${escHtml(columns[j].label)}</th>${columns[j].isSubtotal ? '<th class="sub">%</th>' : ''}`)
    .join('')
  const thead = `<tr><th class="rowhead">${escHtml(rowLabel)}</th>${headCells}<th>Total</th><th>% of Total</th></tr>`

  const body = rowNames
    .map((name, i) => {
      const cells = visIdx
        .map((j) => {
          const v = grid[i][j]
          const cls = columns[j].isSubtotal ? 'sub' : v === 0 ? 'zero' : ''
          const style = visual && !columns[j].isSubtotal ? heatStyle(v, maxVal) : ''
          const main = `<td class="${cls}"${style}>${v}</td>`
          const pctCell = columns[j].isSubtotal ? `<td class="pct">${binary ? '–' : pctOf(grid[i][j], rowTotals[i]) || '–'}</td>` : ''
          return main + pctCell
        })
        .join('')
      return `<tr><td class="rowhead">${escHtml(name)}</td>${cells}<td>${rowTotals[i]}</td><td class="pct">${pctOf(rowTotals[i], grandTotal) || '–'}</td></tr>`
    })
    .join('')

  const totalCells = visIdx
    .map((j) => {
      const ct = colTotals[j]
      const cls = columns[j].isSubtotal ? 'sub' : ''
      const pctCell = columns[j].isSubtotal ? `<td class="pct">${binary ? '–' : pctOf(ct, grandTotal) || '–'}</td>` : ''
      return `<td class="${cls}">${ct}</td>${pctCell}`
    })
    .join('')
  const totalRow = `<tr class="total"><td class="rowhead">Total</td>${totalCells}<td>${grandTotal}</td><td class="pct">${grandTotal ? '100.0%' : '–'}</td></tr>`

  return wrapTable(`<thead>${thead}</thead><tbody>${body}${totalRow}</tbody>`, visIdx.length)
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
  const { columns } = buildSurveyAwareColumns(config?.groupBy ?? [], data, filtered, sourceMap)
  const colData = buildColData(columns, data)
  let grid = codeGuids.map((cg) =>
    columns.map((col) => {
      const cd = colData.get(col.id) || data
      return col.sourceGuids.reduce((sum, sg) => sum + countCodeInSource(cd, sg, cg), 0)
    })
  )
  if (options.binary) grid = binarizeGrid(grid)
  const names = codeGuids.map((cg) => codeMap.get(cg)?.name ?? 'Code')
  return renderGridTableHtml('Code', names, columns, grid, { binary: !!options.binary, visual: !!options.visual, totalsOnly: !!options.totalsOnly })
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

  const { columns } = buildSurveyAwareColumns(config?.groupBy ?? [], data, Array.from(resultSourceGuids), sourceMap)

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
  return renderGridTableHtml('Query', names, columns, grid, { binary: !!options.binary, visual: !!options.visual, totalsOnly: !!options.totalsOnly })
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
  const visual = !!options.visual
  const thead = `<tr><th class="rowhead">Code</th>${columns.map((c) => `<th>${escHtml(c.label)}</th>`).join('')}</tr>`
  const body = codeGuids
    .map((cg, i) => {
      const cells = columns
        .map((_, j) => {
          const v = grid[i][j]
          const style = visual ? heatStyle(v, 100) : ''
          return `<td class="${v === 0 ? 'zero' : ''}"${style}>${v.toFixed(1)}%</td>`
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

  const thead = totalsOnly
    ? `<tr><th class="rowhead"></th><th>Total</th><th>% of Total</th></tr>`
    : `<tr><th class="rowhead"></th>${colCodeGuids.map((g) => `<th>${escHtml(codeMap.get(g)?.name ?? 'Code')}</th>`).join('')}<th>Total</th><th>% of Total</th></tr>`

  const body = rowCodeGuids
    .map((rg, i) => {
      const name = codeMap.get(rg)?.name ?? 'Code'
      const cells = totalsOnly
        ? ''
        : colCodeGuids
            .map((cg, j) => {
              if (rg === cg) return '<td class="zero">—</td>'
              const v = matrix[i][j]
              const style = visual ? heatStyle(v, maxVal) : ''
              return `<td class="${v === 0 ? 'zero' : ''}"${style}>${v}</td>`
            })
            .join('')
      return `<tr><td class="rowhead">${escHtml(name)}</td>${cells}<td>${rowTotals[i]}</td><td class="pct">${pctOf(rowTotals[i], grandTotal) || '–'}</td></tr>`
    })
    .join('')

  const totalRow = totalsOnly
    ? `<tr class="total"><td class="rowhead">Total</td><td>${grandTotal}</td><td class="pct">${grandTotal ? '100.0%' : '–'}</td></tr>`
    : `<tr class="total"><td class="rowhead">Total</td>${colTotals.map((ct) => `<td>${ct}</td>`).join('')}<td>${grandTotal}</td><td class="pct">${grandTotal ? '100.0%' : '–'}</td></tr>`

  return wrapTable(`<thead>${thead}</thead><tbody>${body}${totalRow}</tbody>`, totalsOnly ? 0 : colCodeGuids.length)
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

function wordFrequenciesHtml(config: any, _options: AnalysisItemOptions): string {
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
  return wrapTable(`<thead>${thead}</thead><tbody>${body}</tbody>`, single ? 1 : series.length)
}

/** Render one analysis item: regenerate its table fresh, or a short
 *  placeholder for tools not yet implemented / deleted analyses. */
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
      default:
        inner = `<div class="empty">${escHtml(sa.name)} — table generation for ${escHtml(toolLabel)} is coming soon.</div>`
    }
  } catch {
    inner = '<div class="empty">Could not regenerate this analysis.</div>'
  }
  return `<div class="report-block" id="${anchor}">${head}${inner}</div>`
}
