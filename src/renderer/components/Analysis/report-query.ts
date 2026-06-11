/**
 * Reports — regenerate a saved query's results into HTML for the report
 * PDF. The query is re-run through the query engine against fresh init
 * data at export time (no stale data) and rendered as matches grouped by
 * document, mirroring the Query Results export.
 */
import { buildAnalysisInitData } from '../../utils/build-analysis-init-data'
import { executeQuery } from '../../utils/query-engine'
import { groupByDocument } from '../QueryResultViewer/QueryResultsBody'
import { escHtml } from '../../utils/pdf-export'
import { useQueryStore } from '../../stores/query-store'
import { useDocumentStore } from '../../stores/document-store'
import { surveyCellCitation } from './report-survey-cite'

export const REPORT_QUERY_CSS = `
  .report-query .report-query-meta { font-size: 10px; color: #888; margin: 0 0 8px 0; }
  .report-query .doc-group { margin-bottom: 12px; }
  .report-query h3.q-doc { font-size: 12px; margin: 0 0 5px; padding: 3px 8px; background: #f3f4f6; border-radius: 4px; font-weight: 600; break-after: avoid; page-break-after: avoid; }
  .report-query h3.q-doc .count { font-weight: 400; color: #888; font-size: 10px; }
  .report-query .q-result { padding: 4px 8px 4px 14px; border-bottom: 1px solid #eee; break-inside: avoid; page-break-inside: avoid; }
  .report-query .q-cite { font-size: 9.5px; color: #888; margin-bottom: 3px; }
  .report-query .codes { margin-bottom: 3px; }
  .report-query .code-badge { display: inline-block; font-size: 9px; padding: 1px 6px; margin-right: 4px; background: #f3f4f6; border-radius: 3px; }
  .report-query .context { white-space: pre-wrap; font-size: 10.5px; }
  .report-query .match { color: #222; }
`

/** Render a saved-query item: re-run it and render the matches, or a
 *  short placeholder if the query was deleted / is empty. */
export function renderQueryItemHtml(refGuid: string, anchor: string): string {
  const sq = useQueryStore.getState().savedQueries.find((q) => q.guid === refGuid)
  if (!sq?.query) {
    return `<div class="report-block" id="${anchor}"><div class="report-item-head">Query</div><div class="empty">(deleted query)</div></div>`
  }

  const base = buildAnalysisInitData('reports')
  // Use the full document-store sources so executeQuery can resolve survey
  // cell text (it reads source.formatData.survey). The trimmed
  // base.sources omit formatData, which left every survey match's text
  // blank in the report.
  const execSources = useDocumentStore.getState().sources.map((s) => ({
    guid: s.guid,
    name: s.name,
    sourceType: (s as any).sourceType,
    formatData: (s as any).formatData,
    selections: ((s as any).selections || []).map((sel: any) => ({ ...sel, codings: sel.codings || [] }))
  }))
  const execCodes = base.codes.map((c) => ({ guid: c.guid, name: c.name, color: c.color, isCodable: c.isCodable, children: [] }))
  const execTags = base.tags.map((t) => ({ guid: t.guid, name: t.name, memberSourceGuids: base.tagMembers[t.guid] || [] }))
  const execFolders = (base.folders || []).map((f) => ({ guid: f.guid, name: f.name, parentGuid: f.parentGuid }))

  let results
  try {
    results = executeQuery(sq.query, execSources as any, base.sourceContents, execCodes as any, execTags as any, base.sourceFolder, execFolders)
  } catch {
    return `<div class="report-block" id="${anchor}"><div class="report-item-head">Query — ${escHtml(sq.name)}</div><div class="empty">Could not run this query.</div></div>`
  }

  const groups = groupByDocument(results)
  const meta = `${results.length} match${results.length === 1 ? '' : 'es'} in ${groups.length} document${groups.length === 1 ? '' : 's'}`

  let body = `<div class="report-block report-query" id="${anchor}"><div class="report-item-head">Query — ${escHtml(sq.name)}</div>`
  body += `<div class="report-query-meta">${meta}</div>`
  if (results.length === 0) {
    body += '<div class="empty">(no matches)</div>'
  }
  for (const group of groups) {
    body += `<div class="doc-group"><h3 class="q-doc">${escHtml(group.sourceName)} <span class="count">(${group.results.length} match${group.results.length === 1 ? '' : 'es'})</span></h3>`
    for (const r of group.results) {
      const codes = r.matchedCodes
        .map((c) => `<span class="code-badge" style="border-left:3px solid ${c.color || '#888'}">${escHtml(c.name)}</span>`)
        .join(' ')
      body += '<div class="q-result">'
      if (r.surveyCell) {
        // Survey matches cite the respondent + question, the same shared
        // way survey quotes do (the doc-group header already names the
        // survey, so the leading separator is dropped here).
        const cite = surveyCellCitation(r.sourceGuid, r.surveyCell)
        if (cite) body += `<div class="q-cite">${cite.replace(/^ · /, '')}</div>`
      }
      if (codes) body += `<div class="codes">${codes}</div>`
      const ctxB = r.contextBefore || ''
      const ctxA = r.contextAfter || ''
      body += '<div class="context">'
      body += `<span class="muted">${ctxB ? '…' + escHtml(ctxB) : ''}</span>`
      body += `<span class="match">${escHtml(r.matchedText || '')}</span>`
      body += `<span class="muted">${ctxA ? escHtml(ctxA) + '…' : ''}</span>`
      body += '</div></div>'
    }
    body += '</div>'
  }
  body += '</div>'
  return body
}
