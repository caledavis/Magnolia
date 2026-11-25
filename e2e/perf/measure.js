// Times the app on the large project (node e2e/run.mjs --perf): how long
// each thing takes, and the longest the window stopped responding meanwhile
// (a heartbeat that should tick every 20 ms; its longest gap is the longest
// freeze a user would feel). Fails on a freeze over FREEZE_LIMIT_MS.

const FREEZE_LIMIT_MS = 2000

async function spec(t) {
  const docs = (await t.module('stores/document-store')).useDocumentStore
  const codes = (await t.module('stores/code-store')).useCodeStore
  const queries = (await t.module('stores/query-store')).useQueryStore
  const project = (await t.module('stores/project-store')).useProjectStore
  const tabs = (await t.module('stores/analysis-tabs-store')).useAnalysisTabsStore
  const tabIds = await t.module('utils/tab-ids')

  t.log(`opened: ${Math.round(performance.now())} ms after the window started loading (${docs.getState().sources.length} documents)`)

  let last = performance.now()
  let longest = 0
  setInterval(() => {
    const now = performance.now()
    longest = Math.max(longest, now - last - 20)
    last = now
  }, 20)
  const results = []
  async function measure(label, run) {
    await t.sleep(300)
    longest = 0
    const start = performance.now()
    const ok = await run()
    const took = Math.round(performance.now() - start)
    // Let the heartbeat record a block that has just ended: the check that
    // ended run() can come before it.
    await t.sleep(60)
    const freeze = Math.round(longest)
    results.push({ label, took, freeze })
    t.log(`${label}: ${took} ms, longest freeze ${freeze} ms${ok === false ? ' (DID NOT FINISH)' : ''}`)
    t.check(`${label}: no freeze over ${FREEZE_LIMIT_MS} ms`, ok !== false && freeze <= FREEZE_LIMIT_MS, `${took} ms, longest freeze ${freeze} ms`)
  }
  const query = async (q) => {
    queries.getState().setComplexQuery(q)
    return !!(await t.until(() => { const s = queries.getState(); return s.isActive && !s.isLoading }, 120000, 20))
  }

  await measure('save', async () => {
    project.getState().markDirty()
    return !!(await t.until(() => !project.getState().isDirty, 120000, 20))
  })
  const money = codes.getState().flatCodes().find((c) => c.name === 'Money')
  await measure('query: a code and its subcodes', () => query({ documentFilter: {}, codeCondition: { type: 'code', codeGuid: money.guid, includeSubcodes: true } }))
  t.log(`  (${queries.getState().results.length} results)`)
  await measure('query: text search', () => query({ documentFilter: {}, codeCondition: { type: 'text', searchText: 'rent', caseSensitive: false, wholeWord: true } }))
  t.log(`  (${queries.getState().results.length} results)`)
  await measure('query: sentences with a word', () => query({ documentFilter: {}, codeCondition: { type: 'text', searchText: 'debt', caseSensitive: false, wholeWord: true, sentences: true } }))
  await measure('query: two codes overlapping', () => query({ documentFilter: {}, codeCondition: { type: 'overlap', condition1: { type: 'code', codeGuid: money.guid, includeSubcodes: true }, condition2: { type: 'code', codeGuid: codes.getState().flatCodes().find((c) => c.name === 'Wellbeing').guid, includeSubcodes: true } } }))
  queries.getState().clearQuery()

  const top = codes.getState().codes.map((c) => c.guid)
  const all = codes.getState().flatCodes().map((c) => c.guid)
  let n = 0
  const openTool = (toolType, config) => async () => {
    const tabId = tabIds.makeAnalysisTabId(toolType, 'perf-' + n++)
    tabs.getState().add(tabId, { toolType, title: toolType, config, poppedOut: false })
    docs.getState().openToolTab(tabId)
    // Done when the tool shows its table, chart or list.
    return !!(await t.until(() => [...document.querySelectorAll('table, svg')].some((e) => t.visible(e) && e.closest('[data-tab-content], body') && e.getBoundingClientRect().height > 60), 120000, 20))
  }
  await measure('open Codes in Documents (all codes)', openTool('codes-in-documents', { codeGuids: all }))
  await measure('open Code Frequencies (all codes)', openTool('code-frequencies', { codeGuids: all }))
  await measure('open Code Co-Occurrences (5 × 5)', openTool('code-cooccurrences', { rowCodeGuids: top, colCodeGuids: top }))
  await measure('open Code Orders (top-level codes)', openTool('code-orders', { codeGuids: top }))
  await measure('open Word Frequencies', openTool('word-frequencies', {}))
  await measure('open Word Combinations', openTool('word-combinations', {}))
  await measure('open Framework Matrix (20 documents × all codes)', openTool('framework-matrix', {
    codeGuids: all, summaries: {}, collapsed: [],
    rows: docs.getState().sources.slice(0, 20).map((s) => ({ kind: 'doc', sourceGuid: s.guid }))
  }))

  const transcript = docs.getState().sources.find((s) => s.name === 'Focus group transcript.txt')
  await measure('open the long transcript', async () => {
    docs.getState().viewDocument(transcript.guid)
    return !!(await t.until(() => document.body.innerText.includes('Facilitator:'), 120000, 20))
  })
  const survey = docs.getState().sources.find((s) => s.sourceType === 'survey')
  await measure('open the survey (1,000 respondents)', async () => {
    docs.getState().viewDocument(survey.guid)
    await t.sleep(200)
    return !!(await t.until(() => document.body.innerText.includes('What is hardest?'), 120000, 20))
  })

  t.log('SUMMARY ' + JSON.stringify(results))
}
