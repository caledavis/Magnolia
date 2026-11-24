// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { graphFromFilter } from '../../src/renderer/components/DocumentSelector/DocumentSelector'
import { emptyDocumentFilter, resolveDocGraph, type DocGraphData } from '../../src/renderer/utils/document-graph'
import { executeQuery } from '../../src/renderer/utils/query-engine'
import { resolveFilteredSources } from '../../src/renderer/components/Analysis/analysis-helpers'
import type { AnalysisInitData } from '../../src/renderer/models/types'
import type { Code, QDASet, TextSource } from '../../src/renderer/models/types'

// A filter saved without a graph (e.g. a query made by clicking a number in
// an analysis) is drawn as a graph when the Query Builder opens it. The
// graph must select the documents the query engine applies the filter to,
// or editing the query changes what it finds.

const X = 'code-x'
const codes = [{ guid: X, name: 'X', children: [] }] as unknown as Code[]
const doc = (guid: string): TextSource =>
  ({ guid, name: guid, sourceType: 'text', plainTextContent: 'xxxx', selections: [{ guid: `s-${guid}`, startPosition: 0, endPosition: 2, codings: [{ guid: `c-${guid}`, codeGuid: X }] }] }) as unknown as TextSource
const sources = ['d1', 'd2', 'd3', 'd4'].map(doc)
const tags: QDASet[] = [
  { guid: 'A', name: 'A', memberSourceGuids: ['d1', 'd2'], memberCodeGuids: [] },
  { guid: 'B', name: 'B', memberSourceGuids: ['d2', 'd3'], memberCodeGuids: [] }
]
const folders = [{ guid: 'f1', name: 'F1', parentGuid: null }]
const sourceFolder = { d1: 'f1', d2: 'f1', d4: 'f1' }
const graphData: DocGraphData = {
  sources: sources.map((s) => ({ guid: s.guid, name: s.name, sourceType: 'text' })),
  tags: tags.map((t) => ({ guid: t.guid, name: t.name })),
  tagMembers: { A: ['d1', 'd2'], B: ['d2', 'd3'] },
  folders,
  sourceFolder,
  respondentTagMembers: {},
  questionTagMembers: {}
}

const filters = {
  'documents and a tag': { sourceGuids: ['d1', 'd3'], tagGuids: ['A'] },
  'documents less a tag': { sourceGuids: ['d1', 'd2', 'd3'], tagExcludeGuids: ['B'] },
  'either tag, in a folder': { tagGuids: ['A', 'B'], folderGuids: ['f1'] },
  'a tag, less a tag, in a folder': { tagGuids: ['A'], tagExcludeGuids: ['B'], folderGuids: ['f1'] },
  'documents only': { sourceGuids: ['d3'] },
  'a folder only': { folderGuids: ['f1'] },
  'two excluded tags': { tagExcludeGuids: ['A', 'B'] }
}

describe('graphFromFilter', () => {
  for (const [name, f] of Object.entries(filters)) {
    it(`selects what the query engine does: ${name}`, () => {
      const engine = new Set(
        executeQuery({ documentFilter: f, codeCondition: { type: 'code', codeGuid: X } }, sources, {}, codes, tags, sourceFolder, folders).map((r) => r.sourceGuid)
      )
      const graph = graphFromFilter({ ...emptyDocumentFilter(), ...f }, graphData.tags)!
      const drawn = new Set(resolveDocGraph(graph.nodes, graph.conns, graphData))
      expect([...drawn].sort()).toEqual([...engine].sort())
    })
  }

  // An analysis tool's flat filter adds its parts up (resolveFilteredSources).
  const toolFilters = {
    'documents and a tag': { sourceGuids: ['d4'], tagGuids: ['A'] },
    'two tags less one': { tagGuids: ['A', 'B'], tagExcludeGuids: ['B'] },
    'documents less a tag': { sourceGuids: ['d1', 'd2', 'd4'], tagExcludeGuids: ['A'] },
    'only excluded tags': { tagExcludeGuids: ['A', 'B'] },
    'one tag': { tagGuids: ['B'] }
  }
  const analysisData = { sources: graphData.sources, tagMembers: graphData.tagMembers } as unknown as AnalysisInitData
  for (const [name, f] of Object.entries(toolFilters)) {
    it(`draws a tool’s filter as the tool reads it: ${name}`, () => {
      const tool = resolveFilteredSources(analysisData, f.sourceGuids ?? [], f.tagGuids ?? [], f.tagExcludeGuids)
      const graph = graphFromFilter({ ...emptyDocumentFilter(), ...f }, graphData.tags, 'union')!
      expect(resolveDocGraph(graph.nodes, graph.conns, graphData).sort()).toEqual(tool.sort())
    })
  }

  it('draws nothing for a filter with no limits', () => {
    expect(graphFromFilter(emptyDocumentFilter(), [])).toBeNull()
  })
})
