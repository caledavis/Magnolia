import { describe, it, expect } from 'vitest'
import { executeQuery } from '../../src/renderer/utils/query-engine'
import { queryForCell } from '../../src/renderer/utils/narrow-query'
import { applySurveyCellScope, cellScopeOf, filteredSourcesOf, resolveFilteredSources } from '../../src/renderer/components/Analysis/analysis-helpers'
import { tagMembershipFromTags } from '../../src/renderer/utils/survey-cell-scope'
import { emptyDocumentFilter, resolveDocGraph, type DNode, type DConn, type DocumentFilterState } from '../../src/renderer/utils/document-graph'
import type { AnalysisInitData, Code, PlainTextSelection, QDASet, QueryResult, SurveyEntityRef, TextSource } from '../../src/renderer/models/types'

// The analysis tools count a cell under their own document filter: its
// documents, its tags and choices applied to survey cells, then the
// clicked column. Clicking the number must show exactly those passages.

const X = 'code-x'
const codes = [{ guid: X, name: 'X', children: [] }] as unknown as Code[]
let n = 0
const coded = (surveyCell?: { respondentId: string; questionId: string }): PlainTextSelection => {
  n++
  return { guid: `sel-${n}`, startPosition: n, endPosition: n + 1, codings: [{ guid: `c-${n}`, codeGuid: X }], ...(surveyCell ? { surveyCell } : {}) } as PlainTextSelection
}
const doc = (guid: string): TextSource =>
  ({ guid, name: `${guid}.txt`, sourceType: 'text', plainTextContent: 'x'.repeat(200), selections: [coded(), coded()] }) as unknown as TextSource
const survey = (guid: string): TextSource => ({
  guid, name: guid, sourceType: 'survey', plainTextContent: 'x'.repeat(200),
  selections: ['r1', 'r2', 'r3', 'r4'].flatMap((r) => ['q1', 'q2'].map((q) => coded({ respondentId: r, questionId: q })))
}) as unknown as TextSource
const sources = [doc('d1'), doc('d2'), doc('d3'), doc('d4'), survey('s1'), survey('s2')]
const surveys = new Set(['s1', 's2'])

const ref = (sourceGuid: string, id: string): SurveyEntityRef => ({ sourceGuid, id })
const tag = (guid: string, docs: string[], resp: SurveyEntityRef[] = [], quest: SurveyEntityRef[] = []): QDASet => ({
  guid, name: guid, memberSourceGuids: docs, memberCodeGuids: [], memberSurveyRespondents: resp, memberSurveyQuestions: quest
})
const tags = [
  tag('A', ['d1', 'd2'], [ref('s1', 'r1'), ref('s1', 'r2')]),
  tag('T', ['d2', 'd3'], [ref('s1', 'r2'), ref('s1', 'r3')]),
  tag('Q', [], [], [ref('s1', 'q1')]),
  tag('W', ['s2'])
]
const membership = tagMembershipFromTags(tags)
const data = {
  toolType: 'code-frequencies', theme: '', folders: [], codes: [], categories: [],
  tags: tags.map((t) => ({ guid: t.guid, name: t.name })),
  sources: sources.map((s) => ({ guid: s.guid, name: s.name, sourceType: s.sourceType })),
  sourceContents: {},
  sourceSelections: Object.fromEntries(sources.map((s) => [s.guid, s.selections])),
  tagMembers: membership.sourceMembersByTag,
  respondentTagMembers: membership.respondentMembersByTag,
  questionTagMembers: membership.questionMembersByTag,
  sourceFolder: {}
} as unknown as AnalysisInitData

/** A filter as the Document Selector saves it from a graph: what the graph
 *  resolves to, and the tags it uses. */
function drawn(nodes: DNode[], conns: DConn[], tagGuids: string[], tagExcludeGuids: string[] = []): DocumentFilterState {
  const resolved = resolveDocGraph(nodes, conns, {
    sources: data.sources, tags: data.tags, tagMembers: data.tagMembers, folders: [], sourceFolder: {},
    respondentTagMembers: data.respondentTagMembers!, questionTagMembers: data.questionTagMembers!
  })
  return { ...emptyDocumentFilter(), sourceGuids: resolved, tagGuids, tagExcludeGuids, graph: { nodes, conns } }
}
const tagNode = (id: string, tagGuid: string): DNode => ({ id, kind: 'tag', x: 0, y: 0, tagGuid })
const result: DNode = { id: 'result', kind: 'result', x: 0, y: 0 }
const graphAandT = drawn(
  [tagNode('a', 'A'), tagNode('t', 'T'), { id: 'op', kind: 'setOp', x: 0, y: 0, setOps: ['intersect'] }, result],
  [{ id: 'c1', from: 'a', to: 'op', toPort: 0 }, { id: 'c2', from: 't', to: 'op', toPort: 1 }, { id: 'c3', from: 'op', to: 'result', toPort: 0 }],
  ['A', 'T']
)
const graphAorDoc4 = drawn(
  [tagNode('a', 'A'), { id: 'd', kind: 'docs', x: 0, y: 0, docGuids: ['d4', 's2'] }, { id: 'op', kind: 'setOp', x: 0, y: 0, setOps: ['union'] }, result],
  [{ id: 'c1', from: 'a', to: 'op', toPort: 0 }, { id: 'c2', from: 'd', to: 'op', toPort: 1 }, { id: 'c3', from: 'op', to: 'result', toPort: 0 }],
  ['A']
)

const filters: Record<string, DocumentFilterState> = {
  none: emptyDocumentFilter(),
  'tag A (flat)': { ...emptyDocumentFilter(), tagGuids: ['A'] },
  'tag Q (flat)': { ...emptyDocumentFilter(), tagGuids: ['Q'] },
  'graph: A and T': graphAandT,
  'graph: A, or d4 and s2': graphAorDoc4,
  'question 2': { ...emptyDocumentFilter(), questionScope: [ref('s1', 'q2')] },
  'respondents 1–2': { ...emptyDocumentFilter(), respondentScope: [ref('s1', 'r1'), ref('s1', 'r2')] },
  'excluding T': { ...emptyDocumentFilter(), tagExcludeGuids: ['T'] }
}
type Col = { sourceGuids: string[]; tagScopeGuids?: string[]; respondentRef?: SurveyEntityRef }
const tagDocs = (t: string) => {
  const m = tags.find((x) => x.guid === t)!
  return [...new Set([...m.memberSourceGuids, ...(m.memberSurveyRespondents ?? []).map((r) => r.sourceGuid), ...(m.memberSurveyQuestions ?? []).map((r) => r.sourceGuid)])]
}
const columns: Record<string, Col> = {
  d1: { sourceGuids: ['d1'] },
  d4: { sourceGuids: ['d4'] },
  s1: { sourceGuids: ['s1'] },
  s2: { sourceGuids: ['s2'] },
  'tag T': { sourceGuids: tagDocs('T'), tagScopeGuids: ['T'] },
  'tag Q': { sourceGuids: tagDocs('Q'), tagScopeGuids: ['Q'] },
  'respondent 2': { sourceGuids: ['s1'], respondentRef: ref('s1', 'r2') }
}

const ids = (rs: { sourceGuid: string; selectionGuid?: string }[]) => rs.map((r) => `${r.sourceGuid}:${r.selectionGuid}`).sort()

/** What a tool counts in a column (see CodeFrequencies / CodesInDocuments). */
function counted(f: DocumentFilterState, col: Col): string[] {
  const filtered = new Set(filteredSourcesOf(data, f))
  const scoped = applySurveyCellScope(data, f)
  const colData = col.respondentRef
    ? applySurveyCellScope(scoped, { respondentScope: [col.respondentRef] })
    : col.tagScopeGuids ? applySurveyCellScope(scoped, { tagGuids: col.tagScopeGuids }) : scoped
  return ids(col.sourceGuids.filter((g) => filtered.has(g)).flatMap((g) =>
    (colData.sourceSelections[g] ?? []).filter((s) => s.codings.some((c) => c.codeGuid === X)).map((s) => ({ sourceGuid: g, selectionGuid: s.guid }))
  ))
}
/** What clicking it shows (the 'run-code-in-doc-query' handler). */
function shown(f: DocumentFilterState, col: Col): string[] {
  const filtered = filteredSourcesOf(data, f)
  const docs = filtered.length ? col.sourceGuids.filter((g) => filtered.includes(g)) : col.sourceGuids
  const q = queryForCell({ documentFilter: {}, codeCondition: { type: 'code', codeGuid: X } }, docs, cellScopeOf(f, col), membership, surveys)
  return q ? ids(executeQuery(q, sources, {}, codes, tags) as QueryResult[]) : []
}

describe('a tool’s clicked number', () => {
  for (const [fName, f] of Object.entries(filters)) {
    for (const [cName, col] of Object.entries(columns)) {
      it(`shows what was counted: filter ${fName}, column ${cName}`, () => {
        expect(shown(f, col)).toEqual(counted(f, col))
      })
    }
  }
})

describe('filteredSourcesOf', () => {
  it('takes a drawn filter’s documents from its graph, not adding up its tags', () => {
    expect(filteredSourcesOf(data, graphAandT).sort()).toEqual(['d2', 's1'])
    // The old reading added up the graph's documents and every tag it used.
    expect(resolveFilteredSources(data, graphAandT.sourceGuids, graphAandT.tagGuids).sort()).toEqual(['d1', 'd2', 'd3', 's1'])
  })

  it('resolves the graph live, so documents tagged since count', () => {
    const later = { ...data, tagMembers: { ...data.tagMembers, A: ['d1', 'd2', 'd3'] } }
    expect(filteredSourcesOf(later, graphAandT).sort()).toEqual(['d2', 'd3', 's1'])
  })

  it('adds up a flat filter’s parts, as before', () => {
    expect(filteredSourcesOf(data, { ...emptyDocumentFilter(), sourceGuids: ['d4'], tagGuids: ['A'] }).sort()).toEqual(['d1', 'd2', 'd4', 's1'])
    expect(filteredSourcesOf(data, emptyDocumentFilter()).length).toBe(sources.length)
  })
})
