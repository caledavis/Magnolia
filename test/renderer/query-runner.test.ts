import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  setQueryWorkerFactory,
  runQueryInWorker,
  QueryWorkerUnavailable,
  type QueryRunInputs,
  type QueryWorkerRequest,
  type QueryWorkerResponse
} from '../../src/renderer/workers/query-runner'
import { useQueryStore } from '../../src/renderer/stores/query-store'
import { useCodeStore } from '../../src/renderer/stores/code-store'
import { useTagStore } from '../../src/renderer/stores/tag-store'
import { useDocumentStore } from '../../src/renderer/stores/document-store'
import { executeQuery } from '../../src/renderer/utils/query-engine'
import type { Query, TextSource } from '../../src/renderer/models/types'

// Queries for the results panel run in a worker so the window stays
// responsive. The worker keeps the project data between runs, is sent only
// what changed, runs one query at a time and skips requests a newer one
// replaced while it was busy.

/** A stand-in worker that holds its data like the real one and answers
 *  when `answer()` is called, so tests control when a run finishes. */
class FakeWorker {
  onmessage: ((e: MessageEvent<QueryWorkerResponse>) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  received: QueryWorkerRequest[] = []
  data: any = {}
  postMessage(msg: QueryWorkerRequest) {
    this.received.push(msg)
    Object.assign(this.data, msg.data)
  }
  terminate() {}
  answer() {
    const msg = this.received[this.received.length - 1]
    const d = this.data
    const results = executeQuery(msg.query, d.sources, d.sourceContents, d.codes, d.tags, d.sourceFolder, d.folders)
    this.onmessage?.({ data: { id: msg.id, results } } as MessageEvent<QueryWorkerResponse>)
  }
}

const textQuery = (searchText: string): Query =>
  ({ documentFilter: {}, codeCondition: { type: 'text', searchText } }) as Query

const source = {
  guid: 'doc',
  name: 'Doc',
  plainTextContent: 'alpha beta gamma',
  selections: []
} as unknown as TextSource

const inputs = (over: Partial<QueryRunInputs> = {}): QueryRunInputs => ({
  sources: [source],
  sourceContents: { doc: source.plainTextContent! },
  codeTree: [],
  flatCodes: () => [],
  tags: [],
  sourceFolder: {},
  folders: [],
  ...over
})

let fake: FakeWorker
beforeEach(() => {
  fake = new FakeWorker()
  setQueryWorkerFactory(() => fake as any)
})
afterEach(() => setQueryWorkerFactory(() => null))

describe('query worker runner', () => {
  it('sends project data once and then only what changed', async () => {
    const base = inputs()
    const first = runQueryInWorker(textQuery('alpha'), base)
    fake.answer()
    expect((await first)?.map((r) => r.matchedText)).toEqual(['alpha'])
    expect(Object.keys(fake.received[0].data).sort()).toEqual(
      ['codes', 'folders', 'sourceContents', 'sourceFolder', 'sources', 'tags']
    )

    const second = runQueryInWorker(textQuery('beta'), base)
    fake.answer()
    expect((await second)?.map((r) => r.matchedText)).toEqual(['beta'])
    expect(fake.received[1].data).toEqual({})

    const third = runQueryInWorker(textQuery('beta'), { ...base, tags: [] })
    fake.answer()
    await third
    expect(Object.keys(fake.received[2].data)).toEqual(['tags'])
  })

  it('runs only the latest of the requests made while it was busy', async () => {
    const base = inputs()
    const a = runQueryInWorker(textQuery('a'), base)
    const ab = runQueryInWorker(textQuery('al'), base)
    const abc = runQueryInWorker(textQuery('alp'), base)
    expect(await ab).toBeNull()
    expect(fake.received).toHaveLength(1)
    fake.answer()
    await a
    expect(fake.received.map((m) => (m.query.codeCondition as any).searchText)).toEqual(['a', 'alp'])
    fake.answer()
    expect((await abc)?.map((r) => r.matchedText)).toEqual(['alp'])
  })

  it('reports the worker unavailable when it fails, so callers run on the main thread', async () => {
    const run = runQueryInWorker(textQuery('alpha'), inputs())
    fake.onerror?.(new Event('error'))
    await expect(run).rejects.toBeInstanceOf(QueryWorkerUnavailable)
    await expect(runQueryInWorker(textQuery('alpha'), inputs())).rejects.toBeInstanceOf(QueryWorkerUnavailable)
  })
})

describe('query store with the worker', () => {
  beforeEach(() => {
    useQueryStore.getState().clearAll()
    useCodeStore.setState({ codes: [] })
    useTagStore.setState({ tags: [], categories: [] })
    useDocumentStore.setState({ sources: [source], sourceContents: { doc: source.plainTextContent! }, folders: [], sourceFolder: {} })
  })

  it('stays loading until the worker answers, then publishes the latest text', async () => {
    const settle = () => new Promise((r) => setTimeout(r, 0))
    useQueryStore.getState().setComplexQuery(textQuery('a'))
    await settle()
    useQueryStore.getState().setComplexQuery(textQuery('ga'))
    useQueryStore.getState().setComplexQuery(textQuery('gam'))
    await settle()
    expect(useQueryStore.getState().isLoading).toBe(true)
    fake.answer() // 'a' — superseded, not published
    await settle()
    expect(useQueryStore.getState().isLoading).toBe(true)
    expect(useQueryStore.getState().results).toEqual([])
    fake.answer() // 'gam'
    await settle()
    expect(useQueryStore.getState().isLoading).toBe(false)
    expect(useQueryStore.getState().results.map((r) => r.matchedText)).toEqual(['gam'])
  })
})
