// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { renderAnalysisItemHtml } from '../../src/renderer/components/Analysis/report-analysis'
import { useDocumentStore } from '../../src/renderer/stores/document-store'
import { useCodeStore } from '../../src/renderer/stores/code-store'
import { useProjectStore } from '../../src/renderer/stores/project-store'
import type { Code, SavedAnalysis, TextSource } from '../../src/renderer/models/types'

// Reports rebuild each saved analysis's table from the project as it is
// now. Their numbers must be the ones the tool shows: here they're checked
// against counts worked out by hand, not against the helpers they use.

const code = (guid: string, name: string): Code => ({ guid, name, isCodable: true, children: [] })
const sel = (guid: string, start: number, end: number, codes: string[]) => ({
  guid, startPosition: start, endPosition: end,
  codings: codes.map((c) => ({ guid: `${guid}-${c}`, codeGuid: c }))
})

/** The table's body rows: name, the cells shown, and the row total. */
function rows(html: string): { name: string; cells: string[]; total: string }[] {
  return [...html.matchAll(/<tr><td class="rowname">(?:<[^>]*>)*([^<]*)<\/td>(.*?)<td class="totalcell">([^<]*)<\/td>/g)]
    .map((m) => ({ name: m[1], cells: [...m[2].matchAll(/<div class="cw">([^<]*)<\/div>/g)].map((c) => c[1]), total: m[3] }))
}

const item = (refGuid: string, options = {}) =>
  ({ id: 'i', kind: 'analysis' as const, refGuid, toolType: 'codes-in-documents', options })

function saved(guid: string, toolType: string, config: unknown, name = 'My analysis'): SavedAnalysis {
  return { guid, toolType, name, config, createdDateTime: '2026-01-01T00:00:00Z' } as SavedAnalysis
}

describe('report tables', () => {
  beforeEach(() => {
    // Interview 1: A once alone, then A and B on one passage. Interview 2: B once.
    useDocumentStore.setState({
      sources: [
        { guid: 'd1', name: 'Interview 1', sourceType: 'text', selections: [sel('s1', 0, 5, ['A']), sel('s2', 10, 15, ['A', 'B'])] },
        { guid: 'd2', name: 'Interview 2', sourceType: 'text', selections: [sel('s3', 0, 4, ['B'])] }
      ] as unknown as TextSource[],
      sourceContents: { d1: 'aaaaa bbbb ccccc', d2: 'dddd' }
    })
    useCodeStore.setState({ codes: [code('A', 'Alpha'), code('B', 'Beta')] })
    useProjectStore.setState({
      savedAnalyses: [
        saved('cid', 'codes-in-documents', { codeGuids: ['A', 'B'] }),
        saved('broken', 'codes-in-documents', { codeGuids: 5 }),
        saved('future', 'some-tool-from-a-newer-version', {}),
        saved('named', 'codes-in-documents', { codeGuids: ['A'] }, '<b>Mine</b> & "yours"')
      ]
    })
  })

  it('Codes in Documents counts each code in each document, with totals', () => {
    const r = rows(renderAnalysisItemHtml(item('cid'), 'a'))
    expect(r).toEqual([
      { name: 'Alpha', cells: ['2', '0'], total: '2' },
      { name: 'Beta', cells: ['1', '1'], total: '2' }
    ])
  })

  it('Binary shows whether each code is in each document', () => {
    const r = rows(renderAnalysisItemHtml(item('cid', { binary: true }), 'a'))
    expect(r.map((x) => x.cells)).toEqual([['1', '0'], ['1', '1']])
  })

  it('says so when the saved analysis has been deleted, rather than failing', () => {
    const html = renderAnalysisItemHtml(item('gone'), 'a')
    expect(html).toContain('class="empty"')
    expect(rows(html)).toEqual([])
  })

  it('a saved analysis it can’t rebuild leaves a note, and the rest of the report renders', () => {
    const html = renderAnalysisItemHtml(item('broken'), 'a')
    expect(html).toContain('class="empty"')
    expect(html).toContain('id="a"')
  })

  it('a tool it doesn’t know gets a placeholder, not an error', () => {
    expect(renderAnalysisItemHtml(item('future'), 'a')).toContain('class="empty"')
  })

  it('escapes the analysis’s name', () => {
    const html = renderAnalysisItemHtml(item('named'), 'a')
    expect(html).not.toContain('<b>Mine</b>')
    expect(html).toContain('&lt;b&gt;Mine&lt;/b&gt; &amp;')
  })
})
