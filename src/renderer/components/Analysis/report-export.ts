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
import { TOOL_REGISTRY } from '../../utils/tool-registry'
import { renderAnalysisItemHtml, REPORT_TABLE_CSS } from './report-analysis'
import { renderQueryItemHtml, REPORT_QUERY_CSS } from './report-query'
import type { AnalysisToolType, Quote, SurveyFormatData } from '../../models/types'

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
  /** Word Frequencies visualisation choice. */
  vizMode?: string
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

/** For a survey-cell quote, a citation fragment naming the respondent and
 *  the question (number + text). Empty for non-survey quotes or when the
 *  survey can't be resolved. Returns HTML-escaped content. */
function surveyCitation(q: Quote): string {
  if (!q.surveyCell) return ''
  const src = useDocumentStore.getState().sources.find((s) => s.guid === q.sourceGuid)
  const survey = (src?.formatData as SurveyFormatData | undefined)?.survey
  if (!survey) return ''
  const rIdx = survey.respondents.findIndex((r) => r.id === q.surveyCell!.respondentId)
  const qIdx = survey.questions.findIndex((qq) => qq.id === q.surveyCell!.questionId)
  const respLabel = (rIdx >= 0 ? survey.respondents[rIdx]?.displayName : '') || (rIdx >= 0 ? `Respondent ${rIdx + 1}` : 'Respondent')
  let cite = ` · ${escHtml(respLabel)}`
  if (qIdx >= 0) {
    const qText = (survey.questions[qIdx]?.text ?? '').trim()
    cite += ` · Q${qIdx + 1}${qText ? `: “${escHtml(qText)}”` : ''}`
  }
  return cite
}

const EXPORT_CSS = `
  .report-toc { margin: 8px 0 24px 0; }
  .report-toc ol { margin: 6px 0 0 0; padding-left: 22px; }
  .report-toc li { margin: 2px 0; font-size: 11px; }
  .report-toc a { color: #1155cc; text-decoration: none; }
  .report-block { margin: 0 0 20px 0; break-inside: avoid; page-break-inside: avoid; }
  h2.report-section { font-weight: 600; color: #222; margin: 24px 0 9px 0; }
  h2.report-section.report-h1 { font-size: 16px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  h2.report-section.report-h2 { font-size: 13px; color: #333; }
  .report-item-head { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: #999; margin: 0 0 4px 0; }
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

/** Runs in the export window (before printToPDF) to shrink any analysis
 *  table that's wider than the page to fit, preserving aspect ratio, so
 *  wide grids (many documents / respondents) don't clip off the page. */
const FIT_WIDE_TABLES_SCRIPT = `<script>
(function () {
  var wraps = document.querySelectorAll('.report-wide');
  for (var i = 0; i < wraps.length; i++) {
    var wrap = wraps[i];
    var table = wrap.querySelector('table');
    if (!table) continue;
    var avail = wrap.clientWidth;
    var w = table.scrollWidth;
    if (avail > 0 && w > avail) {
      var scale = avail / w;
      table.style.transformOrigin = 'top left';
      table.style.transform = 'scale(' + scale + ')';
      wrap.style.height = Math.ceil(table.scrollHeight * scale) + 'px';
      wrap.style.overflow = 'hidden';
    }
  }
})();
</script>`

/** Build the report body (TOC + items). Each item gets an anchor the TOC
 *  links to. */
function buildReportBody(items: ReportItem[]): string {
  const toc = items
    .map(
      (it) =>
        `<li><a href="#${reportAnchorId(it)}">${escHtml(resolveItemLabel(it))}</a></li>`
    )
    .join('')
  const tocHtml = items.length
    ? `<div class="report-toc"><div class="section-heading">Contents</div><ol>${toc}</ol></div>`
    : ''

  const body = items.map((it) => renderItem(it)).join('')
  return tocHtml + body + FIT_WIDE_TABLES_SCRIPT
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
