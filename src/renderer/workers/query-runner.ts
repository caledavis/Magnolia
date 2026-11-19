/**
 * Main-thread side of the query worker (query-worker.ts). Queries for the
 * Query Results panel run there so the window stays responsive while they
 * calculate.
 *
 * - Project data is sent only when it changes. Each field is compared by
 *   identity (the stores replace, never mutate), so a run while the user
 *   types in the Query Builder sends just the query.
 * - One query runs at a time. A request made meanwhile waits, and a newer
 *   request replaces it, so fast typing runs the first and the latest text,
 *   not every keystroke in between.
 * - Where there is no worker (unit tests) or it fails to start, the caller
 *   runs the query on the main thread as before.
 */
import type { Code, QDASet, Query, QueryResult, TextSource } from '../models/types'

export interface QueryWorkerData {
  sources: TextSource[]
  sourceContents: Record<string, string>
  codes: Code[]
  tags: QDASet[]
  sourceFolder: Record<string, string>
  folders: { guid: string; parentGuid: string | null }[]
}

export interface QueryWorkerRequest {
  id: number
  query: Query
  /** Only the fields that changed since the last request. */
  data: Partial<QueryWorkerData>
}

export type QueryWorkerResponse =
  | { id: number; results: QueryResult[]; error?: undefined }
  | { id: number; error: string; results?: undefined }

/** The data a run needs, as the stores hold it. `codeTree` is the code
 *  store's tree: its identity says whether `flatCodes()` must be resent. */
export interface QueryRunInputs {
  sources: TextSource[]
  sourceContents: Record<string, string>
  codeTree: unknown
  flatCodes: () => Code[]
  tags: QDASet[]
  sourceFolder: Record<string, string>
  folders: { guid: string; parentGuid: string | null }[]
}

/** Thrown when the worker can't be used; the caller runs on the main thread. */
export class QueryWorkerUnavailable extends Error {}

type WorkerLike = Pick<Worker, 'postMessage' | 'terminate'> & {
  onmessage: ((e: MessageEvent<QueryWorkerResponse>) => void) | null
  onerror: ((e: ErrorEvent | Event) => void) | null
}

let makeWorker: () => WorkerLike | null = () => {
  if (typeof Worker === 'undefined') return null
  return new Worker(new URL('./query-worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike
}

/** For tests: replace how the worker is created, and start afresh. */
export function setQueryWorkerFactory(factory: () => WorkerLike | null): void {
  resetQueryWorker()
  makeWorker = factory
  broken = false
}

let worker: WorkerLike | null = null
let broken = false
/** What the worker holds, by identity (codeTree stands in for codes). */
let sent: Partial<Record<keyof QueryWorkerData | 'codeTree', unknown>> = {}
let nextId = 0

interface Job {
  query: Query
  inputs: QueryRunInputs
  resolve: (r: QueryResult[] | null) => void
  reject: (e: unknown) => void
}
let running: { id: number; job: Job } | null = null
let queued: Job | null = null

function resetQueryWorker(): void {
  worker?.terminate()
  worker = null
  sent = {}
  const pending = [running?.job, queued].filter((j): j is Job => !!j)
  running = null
  queued = null
  for (const j of pending) j.reject(new QueryWorkerUnavailable('Query worker stopped'))
}

function ensureWorker(): WorkerLike | null {
  if (broken) return null
  if (worker) return worker
  try {
    worker = makeWorker()
  } catch {
    worker = null
  }
  if (!worker) {
    broken = true
    return null
  }
  worker.onmessage = (e) => {
    const done = running
    if (!done || e.data.id !== done.id) return
    running = null
    if (e.data.error !== undefined) done.job.reject(new Error(e.data.error))
    else done.job.resolve(e.data.results)
    startNext()
  }
  worker.onerror = () => {
    // A worker that failed to load (or crashed) isn't retried; queries
    // fall back to the main thread from here on.
    broken = true
    resetQueryWorker()
  }
  return worker
}

function changedData(inputs: QueryRunInputs): Partial<QueryWorkerData> {
  const data: Partial<QueryWorkerData> = {}
  if (sent.sources !== inputs.sources) data.sources = inputs.sources
  if (sent.sourceContents !== inputs.sourceContents) data.sourceContents = inputs.sourceContents
  if (sent.codeTree !== inputs.codeTree) data.codes = inputs.flatCodes()
  if (sent.tags !== inputs.tags) data.tags = inputs.tags
  if (sent.sourceFolder !== inputs.sourceFolder) data.sourceFolder = inputs.sourceFolder
  if (sent.folders !== inputs.folders) data.folders = inputs.folders
  return data
}

function startNext(): void {
  const job = queued
  queued = null
  if (!job) return
  const w = ensureWorker()
  if (!w) {
    job.reject(new QueryWorkerUnavailable('No query worker'))
    return
  }
  const id = ++nextId
  const data = changedData(job.inputs)
  try {
    w.postMessage({ id, query: job.query, data } satisfies QueryWorkerRequest)
  } catch (err) {
    // Data that can't be copied to the worker: run this one on the main thread.
    job.reject(new QueryWorkerUnavailable(String(err)))
    return
  }
  const i = job.inputs
  sent = {
    sources: i.sources,
    sourceContents: i.sourceContents,
    codeTree: i.codeTree,
    tags: i.tags,
    sourceFolder: i.sourceFolder,
    folders: i.folders
  }
  running = { id, job }
}

/** Run `query` (document filter already resolved) in the worker. Resolves
 *  with its results, or null when a newer request replaced it before it
 *  started. Rejects with QueryWorkerUnavailable when the caller should run
 *  it on the main thread instead. */
export function runQueryInWorker(query: Query, inputs: QueryRunInputs): Promise<QueryResult[] | null> {
  if (!ensureWorker()) return Promise.reject(new QueryWorkerUnavailable('No query worker'))
  return new Promise((resolve, reject) => {
    queued?.resolve(null)
    queued = { query, inputs, resolve, reject }
    if (!running) startNext()
  })
}
