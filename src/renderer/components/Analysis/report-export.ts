/**
 * Reports tool — data model + PDF assembly.
 *
 * A report is an ordered list of items (sections, free text, saved
 * queries, saved analyses, quotes, memos) plus a title. Everything is
 * regenerated from the live stores at export time so the PDF never
 * carries stale data. The document is built with the shared
 * buildPdfDocument / exportPdfWithHeader template so it matches every
 * other Magnolia export (brand header, page numbers, typography).
 *
 * Analysis tables are produced by report-analysis.ts (a later phase);
 * here they render as a placeholder so the rest of the pipeline works
 * end-to-end.
 */
import { escHtml, buildPdfDocument, exportPdfWithHeader } from '../../utils/pdf-export'
import { markdownToHtml } from '../Markdown'
import { useQueryStore } from '../../stores/query-store'
import { useProjectStore } from '../../stores/project-store'
import { useQuoteStore } from '../../stores/quote-store'
import { useMemoStore } from '../../stores/memo-store'
import { useDocumentStore } from '../../stores/document-store'
import { usePreferencesStore } from '../../stores/preferences-store'
import { TOOL_REGISTRY } from '../../utils/tool-registry'
import { renderAnalysisItemHtml, REPORT_TABLE_CSS } from './report-analysis'
import { renderQueryItemHtml, REPORT_QUERY_CSS } from './report-query'
import { surveyCellCitation } from './report-survey-cite'
import type { AnalysisToolType, Quote } from '../../models/types'

/** Per-tool display options chosen for an analysis item, mirroring the
 *  toggles the analysis tool itself exposes. Applied when the table is
 *  regenerated at export time. */
export interface AnalysisItemOptions {
  /** Show only subtotal columns, percentage columns, and the totals
   *  row/column — hide the per-document/respondent body cells. */
  totalsOnly?: boolean
  /** Binary (incidence) instead of counts. */
  binary?: boolean
  /** Visual (heatmap / boxes) instead of numeric cells. */
  visual?: boolean
  /** Word Frequencies: also include a bar chart below the table. */
  barChart?: boolean
  /** Word Frequencies: also include a word cloud below the table. */
  wordCloud?: boolean
}

export type ReportItem =
  | { id: string; kind: 'section'; title: string; level?: 1 | 2 }
  | { id: string; kind: 'text'; content: string }
  | { id: string; kind: 'query'; refGuid: string }
  | { id: string; kind: 'quote'; refGuid: string }
  | { id: string; kind: 'memo'; refGuid: string }
  | {
      id: string
      kind: 'analysis'
      refGuid: string
      toolType: AnalysisToolType
      options: AnalysisItemOptions
    }

export interface ReportConfig {
  title: string
  items: ReportItem[]
}

/** Stable anchor id for an item, used by the TOC links and the section
 *  headings they jump to. */
export function reportAnchorId(item: ReportItem): string {
  return `report-item-${item.id}`
}

/** Human label for an item, resolved against the live stores. Shared by
 *  the on-screen cards and the PDF's table of contents. Returns a
 *  fallback when the referenced entity has been deleted. */
export function resolveItemLabel(item: ReportItem): string {
  switch (item.kind) {
    case 'section':
      return item.title || 'Section'
    case 'text': {
      const firstLine = item.content.split('\n').find((l) => l.trim().length > 0) ?? ''
      const stripped = firstLine.replace(/[#*_>`~-]/g, '').trim()
      return stripped ? stripped.slice(0, 60) : 'Text'
    }
    case 'query': {
      const q = useQueryStore.getState().savedQueries.find((s) => s.guid === item.refGuid)
      return q?.name ?? '(deleted query)'
    }
    case 'analysis': {
      const a = useProjectStore.getState().savedAnalyses?.find((s) => s.guid === item.refGuid)
      return a?.name ?? '(deleted analysis)'
    }
    case 'quote': {
      const qt = useQuoteStore.getState().quotes.find((s) => s.guid === item.refGuid)
      return qt ? `Quote — ${qt.sourceName}` : '(deleted quote)'
    }
    case 'memo': {
      const m = useMemoStore.getState().findMemo(item.refGuid)
      return m?.title ?? '(deleted memo)'
    }
  }
}

/** Content preview for a quote / memo, shown on the on-screen card.
 *  Null for item kinds that have no body of their own. */
export function resolveItemSnippet(item: ReportItem): string | null {
  if (item.kind === 'quote') {
    const qt = useQuoteStore.getState().quotes.find((s) => s.guid === item.refGuid)
    return qt ? qt.text : null
  }
  if (item.kind === 'memo') {
    const m = useMemoStore.getState().findMemo(item.refGuid)
    return m ? m.content || '' : null
  }
  return null
}

/** Icon/label hint for an item's type, for the on-screen card. */
export function reportItemTypeLabel(item: ReportItem): string {
  switch (item.kind) {
    case 'section':
      return item.level === 2 ? 'Subsection' : 'Section'
    case 'text':
      return 'Text'
    case 'query':
      return 'Query'
    case 'quote':
      return 'Quote'
    case 'memo':
      return 'Memo'
    case 'analysis':
      return TOOL_REGISTRY[item.toolType]?.label ?? 'Analysis'
  }
}

/** Regenerate a quote's text from the source's CURRENT content so an
 *  edited document doesn't leave a stale snippet in the report. Survey-
 *  cell quotes (cell-relative offsets) fall back to the stored text. */
function freshQuoteText(q: Quote): string {
  if (!q.surveyCell) {
    const content = useDocumentStore.getState().sourceContents[q.sourceGuid]
    if (content) {
      const sliced = Array.from(content).slice(q.startPosition, q.endPosition).join('')
      if (sliced.trim()) return sliced
    }
  }
  return q.text
}

/** For a survey-cell quote, the shared survey citation (respondent +
 *  question). Empty for non-survey quotes. */
function surveyCitation(q: Quote): string {
  return q.surveyCell ? surveyCellCitation(q.sourceGuid, q.surveyCell) : ''
}

const EXPORT_CSS = `
  .report-toc { margin: 8px 0 24px 0; page-break-after: always; break-after: page; }
  .report-toc .toc-list { margin-top: 6px; }
  .report-toc .toc-entry { display: flex; align-items: baseline; text-decoration: none; color: #1155cc; font-size: 11px; margin: 2px 0; }
  .report-toc .toc-l0 { font-weight: 600; margin-top: 7px; }
  .report-toc .toc-l1 { padding-left: 18px; }
  .report-toc .toc-l2 { padding-left: 36px; font-size: 10.5px; }
  .report-toc .toc-label { flex-shrink: 1; }
  .report-toc .toc-dots { flex: 1 1 auto; min-width: 14px; border-bottom: 1px dotted #bbb; margin: 0 5px; position: relative; top: -3px; }
  .report-toc .toc-page { flex-shrink: 0; color: #555; }
  .report-block { margin: 0 0 20px 0; break-inside: avoid; page-break-inside: avoid; }
  h2.report-section { font-weight: 600; color: #222; margin: 24px 0 9px 0; }
  h2.report-section.report-h1 { font-size: 16px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  h2.report-section.report-h2 { font-size: 13px; color: #333; }
  /* Per-item titles (Query / Analysis / Memo / Map) as a third heading
     level nested under Section (h1) and Subsection (h2): dark, semibold,
     sentence case — not the old grey all-caps. */
  .report-item-head { font-size: 12px; font-weight: 600; color: #333; margin: 0 0 7px 0; }
  .report-text { font-size: 11px; color: #222; }
  .report-text p { margin: 0 0 6px 0; }
  .report-text u { text-decoration: underline; }
  .report-quote { border-left: 3px solid #ccc; padding: 2px 0 2px 12px; margin: 0; color: #333; }
  .report-quote .src { display: block; font-style: normal; font-size: 10px; color: #888; margin-top: 4px; }
  .report-memo .memo-content { font-size: 11px; color: #222; }
  /* Wide analysis tables that overflow the page get rotated + scaled in
     a later phase; this wrapper is the hook for that. */
  .report-wide { overflow: hidden; }
` + REPORT_TABLE_CSS + REPORT_QUERY_CSS

// Paper dimensions (inches, portrait) for the supported export sizes.
const PAPER_INCHES: Record<string, [number, number]> = {
  A4: [8.27, 11.69], A3: [11.69, 16.54], A5: [5.83, 8.27],
  Letter: [8.5, 11], Legal: [8.5, 14], Tabloid: [11, 17]
}

/** The printable content box of one page, in CSS px (96 dpi), given the
 *  user's export paper size and the export's fixed margins (0.95in top/
 *  bottom for the header/footer, 0.5in sides). */
function pageMetrics(): { h: number; w: number } {
  const size = usePreferencesStore.getState().paperSize || 'A4'
  const [wIn, hIn] = PAPER_INCHES[size] || PAPER_INCHES.A4
  return { h: Math.round((hIn - 0.95 * 2) * 96), w: Math.round((wIn - 0.5 * 2) * 96) }
}

/** Runs in the export window before printToPDF: (1) scales over-wide
 *  analysis tables to fit, then (2) estimates each TOC target's page —
 *  Chromium printToPDF has no target-counter — and writes the numbers in.
 *  Pagination is simulated over the body's flow blocks (the report blocks
 *  are break-inside:avoid, so a block that won't fit jumps to the next
 *  page), starting after the TOC's own page break. */
function buildExportScript(pageH: number, pageW: number): string {
  return `<script>
(function () {
  var PAGE_H = ${pageH}, PAGE_W = ${pageW};
  if (PAGE_W > 0) document.body.style.width = PAGE_W + 'px';

  var wraps = document.querySelectorAll('.report-wide');
  for (var i = 0; i < wraps.length; i++) {
    var wrap = wraps[i], table = wrap.querySelector('table');
    if (!table) continue;
    var avail = wrap.clientWidth, w = table.scrollWidth;
    if (avail > 0 && w > avail) {
      var scale = avail / w;
      table.style.transformOrigin = 'top left';
      table.style.transform = 'scale(' + scale + ')';
      wrap.style.height = Math.ceil(table.scrollHeight * scale) + 'px';
      wrap.style.overflow = 'hidden';
    }
  }

  var toc = document.querySelector('.report-toc');
  if (!toc || !PAGE_H) return;
  var page = Math.floor((toc.offsetTop + toc.offsetHeight) / PAGE_H) + 2;
  var y = 0, pageOf = {}, passed = false, kids = document.body.children;
  for (var k = 0; k < kids.length; k++) {
    var el = kids[k];
    if (el === toc) { passed = true; continue; }
    if (!passed || el.tagName === 'SCRIPT') continue;
    var cs = getComputedStyle(el);
    var blockH = el.offsetHeight;
    var h = blockH + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
    if (cs.breakInside === 'avoid' && blockH <= PAGE_H && y > 0 && y + blockH > PAGE_H) { page++; y = 0; }
    if (el.id && pageOf[el.id] == null) pageOf[el.id] = page;
    var ids = el.querySelectorAll('[id]');
    for (var j = 0; j < ids.length; j++) if (pageOf[ids[j].id] == null) pageOf[ids[j].id] = page;
    y += h;
    while (y > PAGE_H) { page++; y -= PAGE_H; }
  }
  var spans = toc.querySelectorAll('.toc-page');
  for (var s = 0; s < spans.length; s++) {
    var id = spans[s].getAttribute('data-toc');
    if (pageOf[id] != null) spans[s].textContent = pageOf[id];
  }
})();
</script>`
}

/** Build the report body (TOC + items). Each item gets an anchor the TOC
 *  links to. */
function buildReportBody(items: ReportItem[]): string {
  // Indent each TOC entry by its level: a Section sits at the left, a
  // Subsection one step in, and content items under whichever heading
  // currently applies (one step deeper than that heading).
  let headingDepth = -1
  const toc = items
    .map((it) => {
      const id = reportAnchorId(it)
      let depth: number
      if (it.kind === 'section') {
        depth = it.level === 2 ? 1 : 0
        headingDepth = depth
      } else {
        depth = Math.max(0, headingDepth + 1)
      }
      depth = Math.min(depth, 2)
      return `<a class="toc-entry toc-l${depth}" href="#${id}"><span class="toc-label">${escHtml(resolveItemLabel(it))}</span><span class="toc-dots"></span><span class="toc-page" data-toc="${id}"></span></a>`
    })
    .join('')
  const tocHtml = items.length
    ? `<div class="report-toc"><div class="section-heading">Contents</div><div class="toc-list">${toc}</div></div>`
    : ''

  const body = items.map((it) => renderItem(it)).join('')
  const { h, w } = pageMetrics()
  return tocHtml + body + buildExportScript(h, w)
}

function renderItem(item: ReportItem): string {
  const anchor = reportAnchorId(item)
  switch (item.kind) {
    case 'section':
      return `<h2 class="report-section report-h${item.level ?? 1}" id="${anchor}">${escHtml(item.title || 'Section')}</h2>`
    case 'text':
      return `<div class="report-block report-text" id="${anchor}">${markdownToHtml(item.content)}</div>`
    case 'query':
      return renderQueryItemHtml(item.refGuid, anchor)
    case 'quote':
      return renderQuote(item.refGuid, anchor)
    case 'memo':
      return renderMemo(item.refGuid, anchor)
    case 'analysis':
      return renderAnalysisItemHtml(item, anchor)
  }
}

function renderQuote(guid: string, anchor: string): string {
  const q = useQuoteStore.getState().quotes.find((s) => s.guid === guid)
  if (!q) return `<div class="report-block" id="${anchor}"><div class="empty">(deleted quote)</div></div>`
  const text = freshQuoteText(q)
  return (
    `<div class="report-block report-quote-block" id="${anchor}">` +
    `<blockquote class="report-quote">${escHtml(text)}` +
    `<span class="src">— ${escHtml(q.sourceName)}${surveyCitation(q)}</span>` +
    `</blockquote></div>`
  )
}

function renderMemo(guid: string, anchor: string): string {
  const m = useMemoStore.getState().findMemo(guid)
  if (!m) return `<div class="report-block" id="${anchor}"><div class="empty">(deleted memo)</div></div>`
  return (
    `<div class="report-block report-memo" id="${anchor}">` +
    `<div class="report-item-head">Memo</div>` +
    `<div class="memo-content">${markdownToHtml(m.content || '')}</div>` +
    `</div>`
  )
}

/** Build the full report HTML using the shared export template. */
export function buildReportHtml(title: string, items: ReportItem[], exportedAt: string): string {
  const reportTitle = title.trim() || 'Report'
  const subtitle = `${items.length} item${items.length === 1 ? '' : 's'} — exported ${exportedAt}`
  return buildPdfDocument({
    title: reportTitle,
    subtitle: escHtml(subtitle),
    body: buildReportBody(items),
    extraCss: EXPORT_CSS
  })
}

/** Build + save the report PDF. Returns the saved path, or null if the
 *  user cancelled the save dialog. */
export async function exportReportPdf(
  title: string,
  items: ReportItem[]
): Promise<string | null> {
  const exportedAt = new Date().toLocaleString()
  const html = buildReportHtml(title, items, exportedAt)
  const safeName = (title.trim() || 'Report').replace(/[^\w\d -]/g, '').slice(0, 80) || 'Report'
  return exportPdfWithHeader(html, safeName, 'Export Report as PDF')
}
