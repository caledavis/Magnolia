// Does switching documents cost more with analysis tabs open?
async function spec(t) {
  const docs = (await t.module('stores/document-store')).useDocumentStore
  const codes = (await t.module('stores/code-store')).useCodeStore
  const tabs = (await t.module('stores/analysis-tabs-store')).useAnalysisTabsStore
  const tabIds = await t.module('utils/tab-ids')
  const transcript = docs.getState().sources.find((s) => s.name === 'Focus group transcript.txt')
  const other = docs.getState().sources.find((s) => s.name === 'Interview 001.txt')
  let last = performance.now(), longest = 0
  setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last - 20); last = now }, 20)
  async function measure(label, run, done) {
    await t.sleep(800); longest = 0
    const start = performance.now()
    run()
    const ok = await t.until(done, 120000, 20)
    await t.sleep(300)
    t.log(`${label}: ${Math.round(performance.now() - start)} ms, longest freeze ${Math.round(longest)} ms`)
    t.check(label, !!ok)
  }
  const shows = (s) => () => document.body.innerText.includes(s)
  await measure('open the transcript, no tabs', () => docs.getState().viewDocument(transcript.guid), shows('Facilitator:'))
  await measure('switch to a short interview, no tabs', () => docs.getState().viewDocument(other.guid), shows('Interviewer:'))
  await measure('back to the transcript, no tabs', () => docs.getState().viewDocument(transcript.guid), shows('Facilitator:'))
  const all = codes.getState().flatCodes().map((c) => c.guid)
  let n = 0
  for (const [tool, config] of [['codes-in-documents', { codeGuids: all }], ['code-frequencies', { codeGuids: all }], ['word-frequencies', {}]]) {
    const id = tabIds.makeAnalysisTabId(tool, 'x' + n++)
    tabs.getState().add(id, { toolType: tool, title: tool, config, poppedOut: false })
    docs.getState().openToolTab(id)
    await t.sleep(8000)
  }
  await measure('switch to a short interview, 3 tool tabs open', () => docs.getState().viewDocument(other.guid), shows('Interviewer:'))
  await measure('back to the transcript, 3 tool tabs open', () => docs.getState().viewDocument(transcript.guid), shows('Facilitator:'))
}
