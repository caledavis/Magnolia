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

export type Metric = 'agreement' | 'kappa' | 'alpha' | 'agreed' | 'segments'

export interface MetricCol {
  /** Index into results.pairs; null for a measure over all coders. */
  pair: number | null
  metric: Metric
}

export function metricColumns(measure: Measure, coderCount: number): MetricCol[] {
  const pairs = (coderCount * (coderCount - 1)) / 2
  const out: MetricCol[] = []
  for (let p = 0; p < pairs; p++) {
    if (measure === 'characters') out.push({ pair: p, metric: 'agreement' }, { pair: p, metric: 'kappa' })
    else out.push({ pair: p, metric: 'agreed' }, { pair: p, metric: 'segments' }, { pair: p, metric: 'agreement' })
  }
  if (measure === 'characters' && coderCount >= 3) out.push({ pair: null, metric: 'alpha' })
  return out
}

export function metricValue(cell: CellResult | undefined, col: MetricCol, measure: Measure): number | null {
  if (!cell) return null
  if (col.metric === 'alpha') {
    if (cell.pooledAlpha !== undefined) return cell.pooledAlpha ? pooledAlpha(cell.pooledAlpha) : null
    return cell.alpha ? krippendorffAlpha(cell.alpha) : null
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

/** Display text for a value; '–' where it can't be computed. */
export function formatMetric(v: number | null, metric: Metric): string {
  if (v === null) return '–'
  if (metric === 'agreement') return formatPercent(v * 100, 1)
  if (metric === 'kappa' || metric === 'alpha') return formatFixed(v, 2)
  return formatNumber(v)
}

export function metricLabel(metric: Metric): string {
  switch (metric) {
    case 'agreement': return t('intercoder.metricAgreement')
    case 'kappa': return t('intercoder.metricKappa')
    case 'alpha': return t('intercoder.metricAlpha')
    case 'agreed': return t('intercoder.metricAgreed')
    case 'segments': return t('intercoder.metricSegments')
  }
}

export function metricTitle(metric: Metric): string {
  switch (metric) {
    case 'agreement': return t('intercoder.metricAgreementTitle')
    case 'kappa': return t('intercoder.metricKappaTitle')
    case 'alpha': return t('intercoder.metricAlphaTitle')
    case 'agreed': return t('intercoder.metricAgreedTitle')
    case 'segments': return t('intercoder.metricSegmentsTitle')
  }
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
export function exportRows(snap: IntercoderSnapshot): string[][] {
  const cols = metricColumns(snap.measure, snap.coders.length)
  const head = [t('intercoder.code'), t('intercoder.document'), ...cols.map((c) => `${pairLabel(snap, c.pair)}: ${metricLabel(c.metric)}`)]
  const body = tableRows(snap, 'all').map((r) => [
    r.kind === 'overall' ? t('intercoder.allCodes') : (snap.codes.find((c) => c.key === r.codeKey)?.path ?? r.label),
    r.kind === 'doc' ? r.label : t('intercoder.allDocuments'),
    ...cols.map((c) => {
      const v = metricValue(r.cell, c, snap.measure)
      return v === null ? '' : formatMetric(v, c.metric)
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
