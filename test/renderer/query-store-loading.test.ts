import { describe, it, expect, beforeEach } from 'vitest'
import { useQueryStore } from '../../src/renderer/stores/query-store'
import { useCodeStore } from '../../src/renderer/stores/code-store'
import { useTagStore } from '../../src/renderer/stores/tag-store'
import { useDocumentStore } from '../../src/renderer/stores/document-store'
import type { Query, TextSource } from '../../src/renderer/models/types'

// Runs are deferred until the loading bar has painted (in node there is no
// requestAnimationFrame, so they resolve on a microtask) and only the latest
// request publishes results.

const codeQuery = (codeGuid: string): Query =>
  ({ documentFilter: {}, codeCondition: { type: 'code', codeGuid } }) as Query

const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  useQueryStore.getState().clearAll()
  useCodeStore.setState({
    codes: [
      { guid: 'a', name: 'A', isCodable: true, children: [] },
      { guid: 'b', name: 'B', isCodable: true, children: [] }
    ]
  })
  useTagStore.setState({ tags: [], categories: [] })
  const source = {
    guid: 'doc',
    name: 'Doc',
    plainTextContent: 'alpha beta gamma',
    selections: [
      { guid: 's1', startPosition: 0, endPosition: 5, codings: [{ guid: 'c1', codeGuid: 'a' }] },
      { guid: 's2', startPosition: 6, endPosition: 10, codings: [{ guid: 'c2', codeGuid: 'b' }] },
      { guid: 's3', startPosition: 11, endPosition: 16, codings: [{ guid: 'c3', codeGuid: 'b' }] }
    ]
  } as unknown as TextSource
  useDocumentStore.setState({ sources: [source], sourceContents: { doc: source.plainTextContent! }, folders: [], sourceFolder: {} })
})

describe('query store loading state', () => {
  it('is loading until the deferred run publishes its results', async () => {
    useQueryStore.getState().setComplexQuery(codeQuery('a'))
    expect(useQueryStore.getState().isLoading).toBe(true)
    expect(useQueryStore.getState().isActive).toBe(true)
    expect(useQueryStore.getState().results).toEqual([])
    await settle()
    expect(useQueryStore.getState().isLoading).toBe(false)
    expect(useQueryStore.getState().results.map((r) => r.selectionGuid)).toEqual(['s1'])
  })

  it('keeps the previous results visible while a re-run is pending', async () => {
    useQueryStore.getState().setComplexQuery(codeQuery('a'))
    await settle()
    useQueryStore.getState().runQuery()
    expect(useQueryStore.getState().isLoading).toBe(true)
    expect(useQueryStore.getState().results).toHaveLength(1)
    await settle()
    expect(useQueryStore.getState().isLoading).toBe(false)
  })

  it('publishes only the latest of several rapid runs', async () => {
    useQueryStore.getState().setComplexQuery(codeQuery('a'))
    useQueryStore.getState().setComplexQuery(codeQuery('b'))
    await settle()
    const s = useQueryStore.getState()
    expect(s.isLoading).toBe(false)
    expect(s.results.map((r) => r.selectionGuid)).toEqual(['s2', 's3'])
  })

  it('does not re-run when only the builder layout changes', async () => {
    const graphAt = (x: number) => ({ nodes: [{ id: 'n', kind: 'code', x, y: 0 }], conns: [] })
    // A real document graph (docs node wired to Result) whose node
    // positions travel inside the query's documentFilter.
    const withDocGraph = (x: number): Query =>
      ({
        ...codeQuery('a'),
        documentFilter: {
          sourceGuids: ['doc'],
          graph: {
            nodes: [
              { id: 'd', kind: 'docs', docGuids: ['doc'], x, y: 0 },
              { id: 'r', kind: 'result', x: 300, y: 0 }
            ],
            conns: [{ id: 'c', from: 'd', to: 'r', toPort: 0 }]
          }
        }
      }) as Query
    useQueryStore.getState().setComplexQuery(withDocGraph(0), graphAt(0))
    await settle()
    const before = useQueryStore.getState().results
    expect(before).toHaveLength(1)
    // Same executed query; only node positions differ in both graphs.
    useQueryStore.getState().setComplexQuery(withDocGraph(50), graphAt(50))
    expect(useQueryStore.getState().isLoading).toBe(false)
    expect(useQueryStore.getState().currentGraphLayout).toEqual(graphAt(50))
    await settle()
    expect(useQueryStore.getState().results).toBe(before)
  })

  it('re-runs when the executed query changes', async () => {
    useQueryStore.getState().setComplexQuery(codeQuery('a'))
    await settle()
    useQueryStore.getState().setComplexQuery(codeQuery('b'))
    expect(useQueryStore.getState().isLoading).toBe(true)
    await settle()
    expect(useQueryStore.getState().results.map((r) => r.selectionGuid)).toEqual(['s2', 's3'])
  })

  it('re-runs an unchanged query after it was cleared', async () => {
    useQueryStore.getState().setComplexQuery(codeQuery('a'))
    await settle()
    useQueryStore.getState().clearQuery()
    useQueryStore.getState().setComplexQuery(codeQuery('a'))
    expect(useQueryStore.getState().isLoading).toBe(true)
    await settle()
    expect(useQueryStore.getState().results).toHaveLength(1)
  })

  it('a clear cancels a pending run', async () => {
    useQueryStore.getState().setComplexQuery(codeQuery('a'))
    useQueryStore.getState().clearQuery()
    await settle()
    const s = useQueryStore.getState()
    expect(s.isLoading).toBe(false)
    expect(s.isActive).toBe(false)
    expect(s.results).toEqual([])
  })
})
