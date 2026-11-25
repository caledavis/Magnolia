async function spec(t) {
  const docs = (await t.module('stores/document-store')).useDocumentStore
  const codes = (await t.module('stores/code-store')).useCodeStore
  const tabs = (await t.module('stores/analysis-tabs-store')).useAnalysisTabsStore
  const tabIds = await t.module('utils/tab-ids')
  let last = performance.now(), longest = 0
  setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last - 20); last = now }, 20)
  await t.sleep(500); longest = 0
  const start = performance.now()
  const id = tabIds.makeAnalysisTabId('codes-in-documents', 'perf')
  tabs.getState().add(id, { toolType: 'codes-in-documents', title: 'CiD', config: { codeGuids: codes.getState().flatCodes().map((c) => c.guid), groupBy: [] }, poppedOut: false })
  docs.getState().openToolTab(id)
  const ok = await t.until(() => [...document.querySelectorAll('[role="grid"]')].some((g) => t.visible(g)), 120000, 20)
  await t.sleep(200)
  const cells = document.querySelectorAll('[role="grid"] td').length
  t.log(`open expanded: ${Math.round(performance.now() - start)} ms, longest freeze ${Math.round(longest)} ms, ${cells} cells${ok ? '' : ' (DID NOT FINISH)'}`)
  // Switch away and back (a re-render with it mounted).
  await t.sleep(500); longest = 0
  const s2 = performance.now()
  docs.getState().viewDocument(docs.getState().sources[0].guid)
  await t.sleep(300)
  docs.getState().openToolTab(id)
  await t.sleep(1500)
  t.log(`switch away and back: longest freeze ${Math.round(longest)} ms`)
  t.check('ran', true)
}
