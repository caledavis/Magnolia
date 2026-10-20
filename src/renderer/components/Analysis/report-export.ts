/**
 * Reports tool — data model + PDF assembly.
 *
 * A report is an ordered list of items (sections, free text, saved
 * queries, saved analyses, quotes, memos, documents) plus a title.
 * Everything is regenerated from the live stores at export time so the
 * PDF never carries stale data. The document is built with the shared
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
import { renderPdfPagesToImages } from '../../utils/pdf-thumbnail'
import {
  buildSurveySummaryBody,
  buildSurveyQuestionBody,
  buildSurveyRespondentBody,
  buildSurveyCellBody,
  SURVEY_SUMMARY_CSS
} from '../SurveyViewer/SurveyViewer'
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
  | { id: string; kind: 'document'; refGuid: string }
  | { id: string; kind: 'survey-question'; surveyGuid: string; questionId: string }
  | { id: string; kind: 'survey-respondent'; surveyGuid: string; respondentId: string }
  | { id: string; kind: 'survey-cell'; surveyGuid: string; respondentId: string; questionId: string }
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
    case 'document': {
      const src = useDocumentStore.getState().sources.find((s) => s.guid === item.refGuid)
      return src?.name ?? '(deleted document)'
    }
    case 'survey-question': {
      const q = findSurveyQuestion(item.surveyGuid, item.questionId)
      return q?.text ?? '(deleted question)'
    }
    case 'survey-respondent': {
      const r = findSurveyRespondent(item.surveyGuid, item.respondentId)
      return r?.displayName ?? '(deleted respondent)'
    }
    case 'survey-cell': {
      const r = findSurveyRespondent(item.surveyGuid, item.respondentId)
      const q = findSurveyQuestion(item.surveyGuid, item.questionId)
      if (!r || !q) return '(deleted answer)'
      return `${r.displayName} — ${q.text}`
    }
  }
}

/** Resolve a survey's parsed data from the live document store, or null. */
function findSurvey(surveyGuid: string) {
  const src = useDocumentStore.getState().sources.find((s) => s.guid === surveyGuid)
  return (src?.formatData as SurveyFormatData | undefined)?.survey ?? null
}

/** Resolve a survey question by its survey guid + stable question id.
 *  Null when the survey or question is gone. */
function findSurveyQuestion(surveyGuid: string, questionId: string) {
  return findSurvey(surveyGuid)?.questions.find((q) => q.id === questionId) ?? null
}

/** Resolve a survey respondent by its survey guid + stable id. */
function findSurveyRespondent(surveyGuid: string, respondentId: string) {
  return findSurvey(surveyGuid)?.respondents.find((r) => r.id === respondentId) ?? null
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
  if (item.kind === 'document') {
    const src = useDocumentStore.getState().sources.find((s) => s.guid === item.refGuid)
    if (!src) return null
    return useDocumentStore.getState().sourceContents[item.refGuid] || ''
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
    case 'document':
      return 'Document'
    case 'survey-question':
      return 'Survey Question'
    case 'survey-respondent':
      return 'Respondent'
    case 'survey-cell':
      return 'Answer'
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
  .report-toc .toc-num { flex-shrink: 0; margin-right: 7px; font-variant-numeric: tabular-nums; }
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
  /* The Contents number echoed on each body heading so the two agree. */
  .report-item-num { color: #888; font-weight: 600; font-variant-numeric: tabular-nums; margin-right: 3px; }
  .report-text { font-size: 11px; color: #222; }
  .report-text p { margin: 0 0 6px 0; }
  .report-text u { text-decoration: underline; }
  .report-quote { border-left: 3px solid #ccc; padding: 2px 0 2px 12px; margin: 0; color: #333; }
  .report-quote .src { display: block; font-style: normal; font-size: 10px; color: #888; margin-top: 4px; }
  .report-memo .memo-content { font-size: 11px; color: #222; }
  /* Every document starts on a fresh page, and — unlike the other blocks,
     which avoid breaking — a document's content (full text, a long
     transcript, a multi-page PDF) is allowed to flow across pages. */
  .report-document { break-inside: auto; page-break-inside: auto; page-break-before: always; }
  /* Survey questions / single cells embedded in a report flow inline with
     the surrounding items (no forced page break), but may still break
     across pages so a long open-ended question isn't trapped on one. */
  .report-survey-inline { break-inside: auto; page-break-inside: auto; }
  .report-document .doc-content { font-size: 11px; color: #222; white-space: pre-wrap; }
  .report-survey-sub { font-size: 10px; color: #888; margin: 0 0 8px; }
  /* Embedded media (image source / video first frame). Width/height caps
     that scale each to fit the page are injected per-export (they depend
     on the chosen paper size). */
  .report-media { text-align: center; margin: 4px 0; }
  .report-media-img { display: block; margin: 0 auto; }
  /* Each rasterised PDF page sits on its own report page, scaled to fit,
     so the embedded PDF reads like the original. The first page shares the
     document heading's page rather than forcing a blank one. */
  .report-pdf-page { text-align: center; margin: 0; break-inside: avoid; page-break-inside: avoid; page-break-before: always; }
  .report-pdf-page.first { page-break-before: auto; }
  .report-pdf-img { display: block; margin: 0 auto; border: 1px solid #ddd; }
  /* A survey's embedded summary can run long, so let it break across pages. */
  .survey-summary { break-inside: auto; page-break-inside: auto; }
  /* Wide analysis tables that overflow the page get rotated + scaled in
     a later phase; this wrapper is the hook for that. */
  .report-wide { overflow: hidden; }
` + REPORT_TABLE_CSS + REPORT_QUERY_CSS + SURVEY_SUMMARY_CSS

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
    // A block that forces a page break before it (e.g. every document)
    // starts a fresh page in the estimate too.
    if ((cs.breakBefore === 'page' || cs.breakBefore === 'always') && y > 0) { page++; y = 0; }
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

/** Hierarchical number (1, 1.1, 1.1.1) and indent depth for every item
 *  that earns a Contents entry, keyed by item id. Sections set the
 *  current depth; content items sit one level under the heading in
 *  effect. Free-text blocks are body prose — skipped here so they
 *  neither appear in the Contents nor consume a number. Shared by the
 *  TOC and the body headings so the two never drift. */
function computeItemNumbers(items: ReportItem[]): Map<string, { num: string; depth: number }> {
  const out = new Map<string, { num: string; depth: number }>()
  let headingDepth = -1
  const counters = [0, 0, 0]
  for (const it of items) {
    if (it.kind === 'text') continue
    let depth: number
    if (it.kind === 'section') {
      depth = it.level === 2 ? 1 : 0
      headingDepth = depth
    } else {
      depth = Math.max(0, headingDepth + 1)
    }
    depth = Math.min(depth, 2)
    counters[depth]++
    for (let k = depth + 1; k < counters.length; k++) counters[k] = 0
    out.set(it.id, { num: counters.slice(0, depth + 1).join('.'), depth })
  }
  return out
}

/** Leading number badge for an item's heading, matching its Contents
 *  entry. Empty for items with no number (free text). */
function numBadge(num: string): string {
  return num ? `<span class="report-item-num">${num}</span> ` : ''
}

/** Build the report body (TOC + items). Each item gets an anchor the TOC
 *  links to. `assets` carries the pre-resolved media (images, video frames,
 *  rasterised PDF pages) keyed by source guid. */
function buildReportBody(items: ReportItem[], assets: Map<string, DocAsset>): string {
  // Shared hierarchical numbers so the Contents entries and the body
  // headings always agree. Indent each TOC entry by its level: a Section
  // sits at the left, a Subsection one step in, and content items under
  // whichever heading currently applies (one step deeper than that
  // heading). Numbering (1, 1.1, 1.1.1) tracks the same depth.
  const numbers = computeItemNumbers(items)
  const toc = items
    // Free-text blocks are body prose, not navigable headings — keep them out
    // of the Contents (and out of the hierarchical numbering).
    .filter((it) => it.kind !== 'text')
    .map((it) => {
      const id = reportAnchorId(it)
      const info = numbers.get(it.id)
      const depth = info?.depth ?? 0
      return `<a class="toc-entry toc-l${depth}" href="#${id}"><span class="toc-num">${info?.num ?? ''}</span><span class="toc-label">${escHtml(resolveItemLabel(it))}</span><span class="toc-dots"></span><span class="toc-page" data-toc="${id}"></span></a>`
    })
    .join('')
  const tocHtml = items.length
    ? `<div class="report-toc"><div class="section-heading">Contents</div><div class="toc-list">${toc}</div></div>`
    : ''

  const body = items.map((it) => renderItem(it, assets, numbers.get(it.id)?.num ?? '')).join('')
  const { h, w } = pageMetrics()
  // Cap embedded media to the page box so an image / PDF page / video frame
  // scales down to fit (a little headroom leaves room for the document
  // heading that shares the first page). Injected here because the cap
  // depends on the user's chosen paper size.
  const mediaCss = `<style>.report-media-img,.report-pdf-img{max-width:100%;max-height:${Math.max(120, h - 30)}px;}</style>`
  return mediaCss + tocHtml + body + buildExportScript(h, w)
}

function renderItem(item: ReportItem, assets: Map<string, DocAsset>, num: string): string {
  const anchor = reportAnchorId(item)
  const prefix = numBadge(num)
  switch (item.kind) {
    case 'section':
      return `<h2 class="report-section report-h${item.level ?? 1}" id="${anchor}">${prefix}${escHtml(item.title || 'Section')}</h2>`
    case 'text':
      return `<div class="report-block report-text" id="${anchor}">${markdownToHtml(item.content)}</div>`
    case 'query':
      return renderQueryItemHtml(item.refGuid, anchor, prefix)
    case 'quote':
      return renderQuote(item.refGuid, anchor, prefix)
    case 'memo':
      return renderMemo(item.refGuid, anchor, prefix)
    case 'document':
      return renderDocument(item.refGuid, anchor, assets, prefix)
    case 'survey-question':
      return renderSurveyQuestion(item.surveyGuid, item.questionId, anchor, prefix)
    case 'survey-respondent':
      return renderSurveyRespondent(item.surveyGuid, item.respondentId, anchor, prefix)
    case 'survey-cell':
      return renderSurveyCell(item.surveyGuid, item.respondentId, item.questionId, anchor, prefix)
    case 'analysis':
      return renderAnalysisItemHtml(item, anchor, prefix)
  }
}

/** A single survey question, presented exactly as in the Survey
 *  Overview page (the Questions-section row, open-ended answers
 *  inlined). Wrapped in `.survey-summary` so the scoped survey CSS
 *  applies, matching how survey documents embed their summary. */
function renderSurveyQuestion(surveyGuid: string, questionId: string, anchor: string, prefix = ''): string {
  const src = useDocumentStore.getState().sources.find((s) => s.guid === surveyGuid)
  const survey = (src?.formatData as SurveyFormatData | undefined)?.survey
  if (!survey) {
    return `<div class="report-block report-survey-inline" id="${anchor}"><div class="report-item-head">${prefix}Survey Question</div><div class="empty">(survey unavailable)</div></div>`
  }
  const head = `<div class="report-item-head">${prefix}Survey Question — ${escHtml(src?.name ?? '')}</div>`
  return (
    `<div class="report-block report-survey-inline" id="${anchor}">` +
    head +
    `<div class="survey-summary">${buildSurveyQuestionBody(survey, questionId)}</div>` +
    `</div>`
  )
}

/** A single respondent, presented as their answers to every question —
 *  the way the on-screen Respondent view shows them. */
function renderSurveyRespondent(surveyGuid: string, respondentId: string, anchor: string, prefix = ''): string {
  const src = useDocumentStore.getState().sources.find((s) => s.guid === surveyGuid)
  const survey = (src?.formatData as SurveyFormatData | undefined)?.survey
  const respondent = survey?.respondents.find((r) => r.id === respondentId)
  if (!survey || !respondent) {
    return `<div class="report-block report-document" id="${anchor}"><div class="report-item-head">${prefix}Respondent</div><div class="empty">(respondent unavailable)</div></div>`
  }
  const head = `<div class="report-item-head">${prefix}Respondent — ${escHtml(respondent.displayName)}</div>`
  return (
    `<div class="report-block report-document" id="${anchor}">` +
    head +
    `<div class="report-survey-sub">${escHtml(src?.name ?? '')}</div>` +
    `<div class="survey-summary">${buildSurveyRespondentBody(survey, respondentId)}</div>` +
    `</div>`
  )
}

/** A single survey cell — one respondent's answer to one question,
 *  rendered the same way that cell appears in the Respondent view. */
function renderSurveyCell(surveyGuid: string, respondentId: string, questionId: string, anchor: string, prefix = ''): string {
  const src = useDocumentStore.getState().sources.find((s) => s.guid === surveyGuid)
  const survey = (src?.formatData as SurveyFormatData | undefined)?.survey
  const respondent = survey?.respondents.find((r) => r.id === respondentId)
  if (!survey || !respondent) {
    return `<div class="report-block report-survey-inline" id="${anchor}"><div class="report-item-head">${prefix}Answer</div><div class="empty">(answer unavailable)</div></div>`
  }
  const head = `<div class="report-item-head">${prefix}Answer — ${escHtml(respondent.displayName)}</div>`
  return (
    `<div class="report-block report-survey-inline" id="${anchor}">` +
    head +
    `<div class="report-survey-sub">${escHtml(src?.name ?? '')}</div>` +
    `<div class="survey-summary">${buildSurveyCellBody(survey, respondentId, questionId)}</div>` +
    `</div>`
  )
}

function renderQuote(guid: string, anchor: string, prefix = ''): string {
  const q = useQuoteStore.getState().quotes.find((s) => s.guid === guid)
  if (!q) return `<div class="report-block" id="${anchor}"><div class="empty">(deleted quote)</div></div>`
  const text = freshQuoteText(q)
  return (
    `<div class="report-block report-quote-block" id="${anchor}">` +
    `<blockquote class="report-quote">${escHtml(text)}` +
    `<span class="src">${prefix}— ${escHtml(q.sourceName)}${surveyCitation(q)}</span>` +
    `</blockquote></div>`
  )
}

function renderMemo(guid: string, anchor: string, prefix = ''): string {
  const m = useMemoStore.getState().findMemo(guid)
  if (!m) return `<div class="report-block" id="${anchor}"><div class="empty">(deleted memo)</div></div>`
  return (
    `<div class="report-block report-memo" id="${anchor}">` +
    `<div class="report-item-head">${prefix}${escHtml(m.title || 'Memo')}</div>` +
    `<div class="memo-content">${markdownToHtml(m.content || '')}</div>` +
    `</div>`
  )
}

/** Wrap a document's rendered inner HTML in its report block. */
function wrapDocument(anchor: string, inner: string): string {
  return `<div class="report-block report-document" id="${anchor}">${inner}</div>`
}

function renderDocument(guid: string, anchor: string, assets: Map<string, DocAsset>, prefix = ''): string {
  const src = useDocumentStore.getState().sources.find((s) => s.guid === guid)
  if (!src) {
    return wrapDocument(anchor, `<div class="report-item-head">${prefix}Document</div><div class="empty">(deleted document)</div>`)
  }
  const head = `<div class="report-item-head">${prefix}Document — ${escHtml(src.name)}</div>`
  const asset = assets.get(guid)

  // Survey: embed the exact content the survey overview's "Export PDF"
  // produces (Contents / Questions / Respondents), under a survey heading.
  if (src.sourceType === 'survey') {
    const survey = (src.formatData as SurveyFormatData | undefined)?.survey
    if (!survey) return wrapDocument(anchor, head + `<div class="empty">(survey data unavailable)</div>`)
    const r = survey.respondents.length
    const q = survey.questions.length
    const sub = `${r} respondent${r === 1 ? '' : 's'} · ${q} question${q === 1 ? '' : 's'}`
    return wrapDocument(
      anchor,
      `<div class="report-item-head">${prefix}Survey — ${escHtml(src.name)}</div>` +
        `<div class="report-survey-sub">${sub}</div>` +
        `<div class="survey-summary">${buildSurveySummaryBody(survey)}</div>`
    )
  }

  // Image: the picture itself, scaled to fit the page.
  if (src.sourceType === 'image') {
    if (asset?.kind === 'image') {
      return wrapDocument(anchor, head + `<div class="report-media"><img class="report-media-img" src="${asset.dataUrl}" alt="${escHtml(src.name)}" /></div>`)
    }
    return wrapDocument(anchor, head + `<div class="empty">(image unavailable)</div>`)
  }

  // PDF: the original pages, rasterised and scaled to fit — one per page.
  if (src.sourceType === 'pdf') {
    if (asset?.kind === 'pdf' && asset.pages.length > 0) {
      const pages = asset.pages
        .map((p, i) => `<div class="report-pdf-page${i === 0 ? ' first' : ''}"><img class="report-pdf-img" src="${p}" alt="${escHtml(src.name)} page ${i + 1}" /></div>`)
        .join('')
      return wrapDocument(anchor, head + pages)
    }
    return wrapDocument(anchor, head + `<div class="empty">(PDF unavailable)</div>`)
  }

  // Video: the first frame plus any transcript text.
  if (src.sourceType === 'video') {
    const transcript = (useDocumentStore.getState().sourceContents[guid] || '').trim()
    const frameHtml =
      asset?.kind === 'video' && asset.frame
        ? `<div class="report-media"><img class="report-media-img" src="${asset.frame}" alt="${escHtml(src.name)} first frame" /></div>`
        : ''
    const transcriptHtml = transcript ? `<div class="doc-content">${escHtml(transcript)}</div>` : ''
    const body = frameHtml + transcriptHtml || `<div class="empty">(no preview available)</div>`
    return wrapDocument(anchor, head + body)
  }

  // Text / markdown / audio transcript / anything else: the text content.
  const content = useDocumentStore.getState().sourceContents[guid] || ''
  const body = content.trim()
    ? `<div class="doc-content">${escHtml(content)}</div>`
    : `<div class="empty">(no text content)</div>`
  return wrapDocument(anchor, head + body)
}

/** Build the full report HTML using the shared export template. */
export function buildReportHtml(
  title: string,
  items: ReportItem[],
  exportedAt: string,
  assets: Map<string, DocAsset> = new Map()
): string {
  const reportTitle = title.trim() || 'Report'
  const subtitle = `${items.length} item${items.length === 1 ? '' : 's'} — exported ${exportedAt}`
  return buildPdfDocument({
    title: reportTitle,
    subtitle: escHtml(subtitle),
    body: buildReportBody(items, assets),
    extraCss: EXPORT_CSS
  })
}

/** Build + save the report PDF. Returns the saved path, or null if the
 *  user cancelled the save dialog. */
export async function exportReportPdf(
  title: string,
  items: ReportItem[]
): Promise<string | null> {
  // Resolve media (images, video first frames, rasterised PDF pages) up
  // front — it's async (file reads + canvas work) and must be baked into
  // the HTML as data URLs before the string is handed to the main process,
  // whose isolated print window can't reach the renderer's blob URLs.
  const assets = await resolveDocAssets(items)
  const exportedAt = new Date().toLocaleString()
  const html = buildReportHtml(title, items, exportedAt, assets)
  const safeName = (title.trim() || 'Report').replace(/[^\w\d -]/g, '').slice(0, 80) || 'Report'
  return exportPdfWithHeader(html, safeName, 'Export Report as PDF')
}

// ── Media resolution ───────────────────────────────────────────────

/** Pre-resolved binary media for a document source, baked into the export
 *  HTML as data URLs. Text-based sources (text/markdown/audio transcript/
 *  survey) need no entry. */
type DocAsset =
  | { kind: 'image'; dataUrl: string }
  | { kind: 'pdf'; pages: string[] }
  | { kind: 'video'; frame: string | null }

/** Resolve the media for every document item, deduped by source guid. A
 *  source that fails to load is simply omitted; renderDocument then shows
 *  an "(… unavailable)" placeholder rather than failing the whole export. */
async function resolveDocAssets(items: ReportItem[]): Promise<Map<string, DocAsset>> {
  const assets = new Map<string, DocAsset>()
  const store = useDocumentStore.getState()
  const guids = new Set<string>()
  for (const it of items) if (it.kind === 'document') guids.add(it.refGuid)

  await Promise.all(
    Array.from(guids).map(async (guid) => {
      const src = store.sources.find((s) => s.guid === guid)
      if (!src) return
      const fd = (src.formatData ?? {}) as {
        imageFilePath?: string
        mimeType?: string
        pdfFilePath?: string
        pdfBase64?: string
        videoFilePath?: string
      }
      try {
        if (src.sourceType === 'image' && fd.imageFilePath) {
          const buf = await window.api.readImageFile(fd.imageFilePath)
          assets.set(guid, { kind: 'image', dataUrl: bytesToDataUrl(buf, fd.mimeType || 'image/png') })
        } else if (src.sourceType === 'pdf' && (fd.pdfFilePath || fd.pdfBase64)) {
          const pages = await renderPdfPagesToImages({ filePath: fd.pdfFilePath, pdfBase64: fd.pdfBase64, docKey: guid, scale: 2 })
          assets.set(guid, { kind: 'pdf', pages })
        } else if (src.sourceType === 'video' && fd.videoFilePath) {
          const frame = await captureVideoFirstFrame(fd.videoFilePath, fd.mimeType)
          assets.set(guid, { kind: 'video', frame })
        }
      } catch (err) {
        console.error(`Reports: failed to load media for "${src.name}"`, err)
      }
    })
  )
  return assets
}

/** ArrayBuffer → `data:<mime>;base64,…`, chunked so large files don't blow
 *  the argument limit of String.fromCharCode. */
function bytesToDataUrl(buf: ArrayBuffer, mime: string): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return `data:${mime};base64,${btoa(binary)}`
}

/** Load a video off disk and grab its first frame as a PNG data URL.
 *  Resolves null on any failure (decode error, no codec, timeout) so the
 *  export still produces a frame-less video entry. */
function captureVideoFirstFrame(filePath: string, mimeType?: string): Promise<string | null> {
  return window.api.readVideoFile(filePath).then(
    (buf) =>
      new Promise<string | null>((resolve) => {
        const url = URL.createObjectURL(new Blob([buf], { type: mimeType || 'video/mp4' }))
        const video = document.createElement('video')
        let done = false
        const finish = (result: string | null) => {
          if (done) return
          done = true
          URL.revokeObjectURL(url)
          resolve(result)
        }
        const timer = setTimeout(() => finish(null), 8000)
        const capture = () => {
          try {
            const canvas = document.createElement('canvas')
            canvas.width = video.videoWidth || 640
            canvas.height = video.videoHeight || 360
            const ctx = canvas.getContext('2d')
            if (!ctx) { clearTimeout(timer); return finish(null) }
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
            clearTimeout(timer)
            finish(canvas.toDataURL('image/png'))
          } catch {
            clearTimeout(timer)
            finish(null)
          }
        }
        video.muted = true
        video.preload = 'auto'
        video.addEventListener('error', () => { clearTimeout(timer); finish(null) }, { once: true })
        video.addEventListener('seeked', capture, { once: true })
        // Nudge off zero so a frame is guaranteed decoded before we draw.
        video.addEventListener('loadeddata', () => {
          try { video.currentTime = Math.min(0.1, (video.duration || 1) / 2) } catch { capture() }
        }, { once: true })
        video.src = url
      }),
    () => null
  )
}
