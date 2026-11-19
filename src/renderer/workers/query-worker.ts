/// <reference lib="webworker" />
/**
 * Runs queries off the main thread. A text search over a large project can
 * take seconds, and the Query Builder re-runs its query on every keystroke
 * in a TEXT node; run on the main thread, that froze the whole window.
 *
 * The project data is sent only when it changes (see query-runner.ts) and
 * kept here between runs, so a run message carries just the query.
 */
import { executeQuery } from '../utils/query-engine'
import type { QueryWorkerRequest, QueryWorkerResponse, QueryWorkerData } from './query-runner'

const data: QueryWorkerData = {
  sources: [],
  sourceContents: {},
  codes: [],
  tags: [],
  sourceFolder: {},
  folders: []
}

self.onmessage = (e: MessageEvent<QueryWorkerRequest>) => {
  const msg = e.data
  Object.assign(data, msg.data)
  let reply: QueryWorkerResponse
  try {
    const results = executeQuery(
      msg.query,
      data.sources,
      data.sourceContents,
      data.codes,
      data.tags,
      data.sourceFolder,
      data.folders
    )
    reply = { id: msg.id, results }
  } catch (err) {
    reply = { id: msg.id, error: err instanceof Error ? err.message : String(err) }
  }
  self.postMessage(reply)
}
