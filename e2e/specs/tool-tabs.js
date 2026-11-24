// An analysis tab left open behind a document keeps up with the project:
// coding done meanwhile is in its numbers when it's shown again.

async function spec(t) {
  const docs = (await t.module('stores/document-store')).useDocumentStore
  const codes = (await t.module('stores/code-store')).useCodeStore
  const tabs = (await t.module('stores/analysis-tabs-store')).useAnalysisTabsStore
  const tabIds = await t.module('utils/tab-ids')
  const belonging = codes.getState().flatCodes().find((c) => c.name === 'Belonging').guid
  const dee = docs.getState().sources.find((s) => s.name === 'Interview - Dee.txt')

  const tabId = tabIds.makeAnalysisTabId('codes-in-documents', 'e2e-tabs')
  tabs.getState().add(tabId, { toolType: 'codes-in-documents', title: 'Codes in Documents', config: { codeGuids: [belonging] }, poppedOut: false })
  docs.getState().openToolTab(tabId)
  // Dee's column: the cell in Belonging's row under her name (in the
  // last heading row; the one above groups the survey's respondents).
  const deeCell = () => {
    const table = [...document.querySelectorAll('table')].find(t.visible)
    if (!table) return null
    const headRows = table.querySelectorAll('thead tr')
    const head = headRows.length ? [...headRows[headRows.length - 1].children] : []
    const col = head.findIndex((th) => th.textContent.includes('Dee'))
    const row = [...table.querySelectorAll('tbody tr')].find((tr) => tr.firstElementChild?.textContent.includes('Belonging'))
    return col >= 0 && row ? Number(row.children[col]?.textContent.trim()) : null
  }
  const before = await t.until(() => deeCell(), 10000)
  t.check('Codes in Documents shows Dee’s Belonging count', before !== null, String(before))

  // Behind a document, code another passage of Dee's.
  docs.getState().viewDocument(dee.guid)
  await t.sleep(800)
  const text = docs.getState().sourceContents[dee.guid]
  const phrase = 'Yes, with two children'
  const start = Array.from(text.slice(0, text.indexOf(phrase))).length
  const sel = docs.getState().addSelection(dee.guid, start, start + phrase.length, phrase)
  docs.getState().addCodingToSelection(dee.guid, sel, belonging)
  await t.sleep(500)

  docs.getState().viewDocument(tabId)
  const after = await t.until(() => (deeCell() === before + 1 ? deeCell() : null), 10000)
  t.check('back on the tab, the count includes the new coding', after === before + 1, `${before} → ${deeCell()}`)
}
