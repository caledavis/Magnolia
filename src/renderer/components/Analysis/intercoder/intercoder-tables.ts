/**
 * Inter-coder Agreement — the results as tables, shared by the tool's
 * on-screen table, its CSV export and the report. Everything
 * works from a snapshot (names plus computed results), which is also
 * what a saved analysis stores, so a report never needs the coders'
 * files.
 */
import {
  brennanPredigerKappa,
  cohensKappa,
  krippendorffAlpha,
  pooledKappa,
  pooledAlpha,
  percentAgreement,
  segmentAgreement,
  pairsOf,
  type AgreementResults,
  type CellResult,
  type Measure
} from './intercoder-model'
import { t, formatPercent, formatFixed, formatNumber, formatDateTime } from '../../../i18n'

export interface IntercoderSnapshot {
  /** ISO time the results were computed. */
  computedAt: string
  measure: Measure
  coders: { label: string; fileName: string }[]
  codes: { key: string; name: string; path: string; color?: string }[]
  docs: { key: string; name: string; sourceType?: string }[]
  results: AgreementResults
}

export type Metric =
  | 'agreement' | 'kappa' | 'alpha' | 'agreed' | 'segments' | 'avgAgreement'
  // By coder: the mean of the coder's pairs, and alpha without the coder.
  | 'coderAgreement' | 'coderKappa' | 'alphaWithout'

/** By pair (each pair of coders) or by coder (each coder against the rest). */
export type ResultsView = 'pairs' | 'coders'

export interface MetricCol {
  /** Index into results.pairs; null for a measure over all coders, or a
   *  coder's column. */
  pair: number | null
  metric: Metric
  /** By coder: the coder's index, and the pairs that include them. */
  coder?: number
  coderPairs?: number[]
}

/** The table's columns: the measure over all coders first (with three or
 *  more coders: alpha for Characters, the pairs' average agreement for
 *  Segments), then each pair's — or, by coder, each coder's. */
export function metricColumns(measure: Measure, coderCount: number, view: ResultsView = 'pairs'): MetricCol[] {
  const pairs = pairsOf(coderCount)
  const out: MetricCol[] = []
  if (coderCount >= 3) out.push({ pair: null, metric: measure === 'characters' ? 'alpha' : 'avgAgreement' })
  if (view === 'coders' && coderCount >= 3) {
    for (let k = 0; k < coderCount; k++) {
      const coderPairs = pairs.flatMap(([i, j], p) => (i === k || j === k ? [p] : []))
      // Characters leaves out the average % agreement: text nobody coded
      // counts as agreeing, so it reads high whoever the coder is.
      const metrics: Metric[] = measure === 'characters' ? ['coderKappa', 'alphaWithout'] : ['coderAgreement']
      for (const metric of metrics) out.push({ pair: null, metric, coder: k, coderPairs })
    }
    return out
  }
  for (let p = 0; p < pairs.length; p++) {
    if (measure === 'characters') out.push({ pair: p, metric: 'agreement' }, { pair: p, metric: 'kappa' })
    else out.push({ pair: p, metric: 'agreed' }, { pair: p, metric: 'segments' }, { pair: p, metric: 'agreement' })
  }
  return out
}

/** Which header group a column belongs to: all coders, a pair or a coder. */
export function columnGroup(c: MetricCol): string {
  return c.coder !== undefined ? `c${c.coder}` : c.pair === null ? 'all' : `p${c.pair}`
}

/** Whether a value is shaded by strength, and on which scale. Characters'
 *  % agreement isn't: text nobody coded counts as agreeing, so it reads
 *  high (and would shade green) even where kappa shows weak agreement. */
export function tintScale(metric: Metric, measure: Measure): 'segments' | 'kappa' | 'alpha' | null {
  if (metric === 'agreement' || metric === 'avgAgreement' || metric === 'coderAgreement') return measure === 'segments' ? 'segments' : null
  if (metric === 'kappa' || metric === 'coderKappa') return 'kappa'
  if (metric === 'alpha' || metric === 'alphaWithout') return 'alpha'
  return null
}

export function metricValue(cell: CellResult | undefined, col: MetricCol, measure: Measure): number | null {
  if (!cell) return null
  if (col.metric === 'coderAgreement' || col.metric === 'coderKappa') {
    // The mean over the coder's pairs, each counting equally (pairs that
    // can't be compared left out).
    const base: Metric = col.metric === 'coderKappa' ? 'kappa' : 'agreement'
    const vals = (col.coderPairs ?? []).map((p) => metricValue(cell, { pair: p, metric: base }, measure)).filter((v): v is number => v !== null)
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
  }
  if (col.metric === 'alphaWithout') {
    if (col.coder === undefined) return null
    if (cell.pooledAlphaWithout !== undefined) {
      const p = cell.pooledAlphaWithout[col.coder]
      return p ? pooledAlpha(p) : null
    }
    const tab = cell.alphaWithout?.[col.coder]
    return tab ? krippendorffAlpha(tab) : null
  }
  if (col.metric === 'alpha') {
    if (cell.pooledAlpha !== undefined) return cell.pooledAlpha ? pooledAlpha(cell.pooledAlpha) : null
    return cell.alpha ? krippendorffAlpha(cell.alpha) : null
  }
  if (col.metric === 'avgAgreement') {
    // Segments, all coders: the mean of the pairs' agreement, each pair
    // counting equally (pairs with no segments to compare left out).
    const vals = cell.segs.map((s) => (s ? segmentAgreement(s) : null)).filter((v): v is number => v !== null)
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
  }
  if (col.pair === null) return null
  if (measure === 'characters' && cell.pooled) {
    // All codes: the mean over codes (de Vries et al.'s pooled kappa).
    const p = cell.pooled[col.pair]
    if (!p) return null
    return col.metric === 'agreement' ? p.po : col.metric === 'kappa' ? pooledKappa(p) : null
  }
  if (measure === 'characters') {
    const tab = cell.chars[col.pair]
    if (!tab) return null
    return col.metric === 'agreement' ? percentAgreement(tab) : col.metric === 'kappa' ? cohensKappa(tab) : null
  }
  const s = cell.segs[col.pair]
  if (!s) return null
  if (col.metric === 'agreed') return s.agree
  if (col.metric === 'segments') return s.total
  if (col.metric === 'agreement') return segmentAgreement(s)
  return null
}

/** Alpha without a coder, less everyone's alpha: positive when agreement
 *  rises without them. Taken from the two values as shown (two decimals),
 *  so it matches what the reader would work out. null for other columns,
 *  or where either alpha can't be computed. */
export function alphaChange(cell: CellResult | undefined, col: MetricCol, measure: Measure): number | null {
  if (col.metric !== 'alphaWithout') return null
  const without = metricValue(cell, col, measure)
  const all = metricValue(cell, { pair: null, metric: 'alpha' }, measure)
  if (without === null || all === null) return null
  return asShown(asShown(without, 2) - asShown(all, 2), 2)
}

// Rounds as the display does. Number formatting rounds the decimal a
// number is written as, halves away from zero (0.015 → 0.02, −0.125 →
// −0.13), which Math.round and toFixed don't always match. The rounding
// is the same in every language, so a plain formatter will do.
const shownFormats = new Map<number, Intl.NumberFormat>()
/** A value rounded to `digits` decimals exactly as it is shown. */
export function asShown(x: number, digits: number): number {
  let f = shownFormats.get(digits)
  if (!f) shownFormats.set(digits, (f = new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false })))
  const v = Number(f.format(x))
  return v === 0 ? 0 : v
}

/** How strongly a change says the coder is out of step with the rest:
 *  agreement 0.10 or more higher without them ('clear'), 0.05 or more
 *  ('some'), else null — a few hundredths either way is usually chance. */
export function changeLevel(d: number): 'clear' | 'some' | null {
  return d >= 0.1 - 1e-9 ? 'clear' : d >= 0.05 - 1e-9 ? 'some' : null
}

/** "+0.26", "−0.05" or "0.00". */
export function formatChange(d: number): string {
  const s = formatFixed(Math.abs(d), 2)
  return d > 0 ? `+${s}` : d < 0 ? `−${s}` : s
}

/** Display text for a value; '–' where it can't be computed. */
export function formatMetric(v: number | null, metric: Metric): string {
  if (v === null) return '–'
  if (metric === 'agreement' || metric === 'avgAgreement' || metric === 'coderAgreement') return formatPercent(v * 100, 1)
  if (metric === 'kappa' || metric === 'alpha' || metric === 'coderKappa' || metric === 'alphaWithout') return formatFixed(v, 2)
  return formatNumber(v)
}

export function metricLabel(metric: Metric): string {
  switch (metric) {
    case 'coderAgreement': return t('intercoder.metricAvgAgreement')
    case 'coderKappa': return t('intercoder.metricCoderKappa')
    case 'alphaWithout': return t('intercoder.metricAlphaWithout')
    case 'agreement': return t('intercoder.metricAgreement')
    case 'kappa': return t('intercoder.metricKappa')
    case 'alpha': return t('intercoder.metricAlpha')
    case 'agreed': return t('intercoder.metricAgreed')
    case 'segments': return t('intercoder.metricSegments')
    case 'avgAgreement': return t('intercoder.metricAvgAgreement')
  }
}

export function metricTitle(metric: Metric, measure: Measure): string {
  switch (metric) {
    case 'coderAgreement': return t('intercoder.metricCoderSegAgreementTitle')
    case 'coderKappa': return t('intercoder.metricCoderKappaTitle')
    case 'alphaWithout': return t('intercoder.metricAlphaWithoutTitle')
    case 'agreement': return measure === 'segments' ? t('intercoder.metricSegAgreementTitle') : t('intercoder.metricAgreementTitle')
    case 'kappa': return t('intercoder.metricKappaTitle')
    case 'alpha': return t('intercoder.metricAlphaTitle')
    case 'agreed': return t('intercoder.metricAgreedTitle')
    case 'segments': return t('intercoder.metricSegmentsTitle')
    case 'avgAgreement': return t('intercoder.metricAvgAgreementTitle')
  }
}

/** The first header row: each run of columns in one group, with its
 *  heading and width in columns. */
export function headerGroups(snap: Pick<IntercoderSnapshot, 'coders' | 'results'>, cols: MetricCol[]): { label: string; title: string; span: number }[] {
  const out: { label: string; title: string; span: number; key: string }[] = []
  for (const c of cols) {
    const key = columnGroup(c)
    const last = out[out.length - 1]
    if (last && last.key === key) last.span++
    else out.push({ key, label: columnLabel(snap, c), title: columnTitle(snap, c), span: 1 })
  }
  return out.map(({ label, title, span }) => ({ label, title, span }))
}

/** A column group's tooltip: what the group's columns compare. */
export function columnTitle(snap: Pick<IntercoderSnapshot, 'coders' | 'results'>, c: MetricCol): string {
  if (c.coder !== undefined) return t('intercoder.coderTitle', { name: snap.coders[c.coder]?.label ?? '' })
  if (c.pair === null) return t('intercoder.allCodersTitle')
  const [i, j] = snap.results.pairs[c.pair]
  return t('intercoder.pairTitle', { first: snap.coders[i]?.label ?? '', second: snap.coders[j]?.label ?? '' })
}

/** A column group's heading: all coders, a pair ("Ana – Ben") or a coder. */
export function columnLabel(snap: Pick<IntercoderSnapshot, 'coders' | 'results'>, c: MetricCol): string {
  return c.coder !== undefined ? (snap.coders[c.coder]?.label ?? '') : pairLabel(snap, c.pair)
}

export function pairLabel(snap: Pick<IntercoderSnapshot, 'coders' | 'results'>, pair: number | null): string {
  if (pair === null) return t('intercoder.allCoders')
  const [i, j] = snap.results.pairs[pair]
  return t('intercoder.pair', { first: snap.coders[i]?.label ?? '', second: snap.coders[j]?.label ?? '' })
}

export interface TableRow {
  kind: 'code' | 'doc' | 'overall'
  codeKey?: string
  docKey?: string
  label: string
  title?: string
  cell: CellResult | undefined
}

/** Code rows (each followed by its documents when expanded) and the
 *  overall row. */
export function tableRows(snap: IntercoderSnapshot, expanded: Set<string> | 'all'): TableRow[] {
  const out: TableRow[] = []
  const docName = new Map(snap.docs.map((d) => [d.key, d.name]))
  for (const c of snap.codes) {
    out.push({ kind: 'code', codeKey: c.key, label: c.name, title: c.path, cell: snap.results.codeTotals[c.key] })
    if (expanded === 'all' || expanded.has(c.key)) {
      for (const dk of snap.results.docKeys) {
        out.push({ kind: 'doc', codeKey: c.key, docKey: dk, label: docName.get(dk) ?? '', cell: snap.results.cells[c.key]?.[dk] })
      }
    }
  }
  if (snap.codes.length > 1) out.push({ kind: 'overall', label: t('intercoder.allCodes'), cell: snap.results.overall })
  return out
}

/** Segments only: Brennan & Prediger's kappa over all codes, per pair
 *  ("Ana – Ben: 0.62"), or null with fewer than two codes. */
export function brennanPredigerLine(snap: IntercoderSnapshot): string | null {
  if (snap.measure !== 'segments' || snap.codes.length < 2) return null
  const parts = snap.results.pairs.map((_, p) => {
    const s = snap.results.overall.segs[p]
    const k = s ? brennanPredigerKappa(s, snap.codes.length) : null
    return `${pairLabel(snap, p)}: ${formatMetric(k, 'kappa')}`
  })
  return t('intercoder.bpKappaLine', { count: snap.codes.length, values: parts.join(' · ') })
}

/** The table as plain text rows, for the CSV export. */
export function exportRows(snap: IntercoderSnapshot, view: ResultsView = 'pairs'): string[][] {
  const cols = metricColumns(snap.measure, snap.coders.length, view)
  // Alpha without a coder is followed by its change from everyone's alpha.
  const head = [t('intercoder.code'), t('intercoder.document'), ...cols.flatMap((c) => {
    const h = `${columnLabel(snap, c)}: ${metricLabel(c.metric)}`
    return c.metric === 'alphaWithout' ? [h, `${columnLabel(snap, c)}: ${t('intercoder.metricAlphaChange')}`] : [h]
  })]
  const body = tableRows(snap, 'all').map((r) => [
    r.kind === 'overall' ? t('intercoder.allCodes') : (snap.codes.find((c) => c.key === r.codeKey)?.path ?? r.label),
    r.kind === 'doc' ? r.label : t('intercoder.allDocuments'),
    ...cols.flatMap((c) => {
      const v = metricValue(r.cell, c, snap.measure)
      const text = v === null ? '' : formatMetric(v, c.metric)
      if (c.metric !== 'alphaWithout') return [text]
      const d = alphaChange(r.cell, c, snap.measure)
      return [text, d === null ? '' : formatChange(d)]
    })
  ])
  return [head, ...body]
}

/** The settings behind the results, for the report note. */
export function settingsRows(snap: IntercoderSnapshot): string[][] {
  const docName = new Map(snap.docs.map((d) => [d.key, d.name]))
  const rows: string[][] = [
    [t('intercoder.measure'), snap.measure === 'characters' ? t('intercoder.measureCharacters') : t('intercoder.measureSegments')]
  ]
  if (snap.measure === 'segments') rows.push([t('intercoder.threshold'), formatPercent(snap.results.threshold * 100, 0)])
  snap.coders.forEach((c, i) => rows.push([t('intercoder.coderN', { n: i + 1 }), `${c.label} (${c.fileName})`]))
  rows.push([t('intercoder.documentsCompared'), formatNumber(snap.results.docKeys.length)])
  for (const s of snap.results.skippedDocs) {
    rows.push([t('intercoder.skipped'), `${docName.get(s.key) ?? ''} — ${s.reason === 'textDiffers' ? t('intercoder.textDiffers') : t('intercoder.singleProject')}`])
  }
  const bp = brennanPredigerLine(snap)
  if (bp) rows.push([t('intercoder.metricKappa'), bp])
  rows.push([t('intercoder.computed'), formatDateTime(snap.computedAt)])
  return rows
}
