// The main window's side of what the other windows send it: each message,
// sent as that window sends it, does what it should.

async function spec(t) {
  const logbook = (await t.module('stores/logbook-store')).useLogbookStore
  const codes = (await t.module('stores/code-store')).useCodeStore
  const memos = (await t.module('stores/memo-store')).useMemoStore
  const queries = (await t.module('stores/query-store')).useQueryStore
  const docs = (await t.module('stores/document-store')).useDocumentStore
  const project = (await t.module('stores/project-store')).useProjectStore
  const api = window.api
  const settled = () => t.until(() => { const s = queries.getState(); return s.isActive && !s.isLoading }, 10000)

  // Logbook window.
  const entries = logbook.getState().entries.length
  api.sendLogbookUpdate('add-entry', { guid: 'e2e-entry', title: 'Day one', content: 'Started coding.', createdDateTime: new Date().toISOString() })
  t.check('logbook: an entry is added', await t.until(() => logbook.getState().entries.length === entries + 1))
  api.sendLogbookUpdate('update-entry', 'e2e-entry', 'Day one, edited', 'Started coding today.')
  t.check('logbook: an entry is edited', await t.until(() => logbook.getState().entries.find((e) => e.guid === 'e2e-entry')?.title === 'Day one, edited'))
  api.sendLogbookUpdate('remove-entry', 'e2e-entry')
  t.check('logbook: an entry is removed', await t.until(() => logbook.getState().entries.length === entries))

  // Codebook window.
  const money = codes.getState().flatCodes().find((c) => c.name === 'Money')
  const codeCount = codes.getState().flatCodes().length
  const before = new Set(codes.getState().flatCodes().map((c) => c.guid))
  api.sendCodebookUpdate('add-child-code', money.guid)
  const child = await t.until(() => codes.getState().flatCodes().find((c) => !before.has(c.guid)))
  t.check('Codebook: a child code is added under its parent',
    !!child && codes.getState().findCode(money.guid)?.children?.some((c) => c.guid === child.guid))
  api.sendCodebookUpdate('rename-code', child.guid, 'Fees')
  t.check('Codebook: a code is renamed', await t.until(() => codes.getState().findCode(child.guid)?.name === 'Fees'))
  api.sendCodebookUpdate('recolor-code', child.guid, '#123456')
  t.check('Codebook: a code is recoloured', await t.until(() => codes.getState().findCode(child.guid)?.color === '#123456'))
  api.sendCodebookUpdate('delete-code', child.guid)
  t.check('Codebook: a code is deleted', await t.until(() => codes.getState().flatCodes().length === codeCount))
  api.sendCodebookUpdate('show-in-all-documents', money.guid)
  t.check('Codebook: Show in all documents runs the code’s query', await settled() && queries.getState().currentQuery?.codeCondition?.codeGuid === money.guid)
  queries.getState().clearQuery()

  // Memo windows: a draft's first save creates it; edits and deletes.
  const memoCount = memos.getState().memos.length
  api.sendMemoUpdate({ guid: 'e2e-memo', type: 'project', title: 'A memo', content: 'x', createdDateTime: new Date().toISOString(), _isNew: true })
  t.check('memo window: a new memo is created (without its draft flag)',
    await t.until(() => memos.getState().memos.length === memoCount + 1) && !('_isNew' in memos.getState().findMemo('e2e-memo')))
  api.sendMemoUpdate({ ...memos.getState().findMemo('e2e-memo'), title: 'A memo, edited' })
  t.check('memo window: a memo is edited', await t.until(() => memos.getState().findMemo('e2e-memo')?.title === 'A memo, edited'))
  api.sendMemosWindowAction('delete', ['e2e-memo'])
  t.check('Memos window: a memo is deleted', await t.until(() => memos.getState().memos.length === memoCount))

  // Query Builder window.
  const query = { documentFilter: {}, codeCondition: { type: 'code', codeGuid: money.guid, includeSubcodes: true } }
  api.sendPreviewToMain(query)
  t.check('Query Builder: a preview runs', await settled() && queries.getState().results.length > 0)
  api.sendPreviewToMain(null)
  t.check('Query Builder: an empty preview clears', await t.until(() => !queries.getState().isActive))
  api.sendSaveQueryToMain(query, 'E2E query', undefined, 'e2e-query')
  t.check('Query Builder: a query is saved', await t.until(() => queries.getState().savedQueries.some((q) => q.guid === 'e2e-query' && q.name === 'E2E query')))
  api.sendQueryToMain({ ...query, codeCondition: { type: 'code', codeGuid: money.guid } }, 'e2e-query')
  await t.until(() => queries.getState().savedQueries.find((q) => q.guid === 'e2e-query')?.query.codeCondition.includeSubcodes === undefined)
  const edited = queries.getState().savedQueries.find((q) => q.guid === 'e2e-query')
  t.check('Query Builder: editing a saved query updates and runs it, keeping its name',
    edited?.query.codeCondition.includeSubcodes === undefined && edited?.name === 'E2E query', JSON.stringify(edited)?.slice(0, 300))

  // Query Results window.
  api.sendQueryResultsAction('rename-saved-query', { guid: 'e2e-query', name: 'E2E query, renamed' })
  t.check('Query Results: a saved query is renamed', await t.until(() => queries.getState().savedQueries.find((q) => q.guid === 'e2e-query')?.name === 'E2E query, renamed'),
    JSON.stringify(queries.getState().savedQueries.map((q) => [q.guid, q.name])))
  // Messages sent back to back all land: a change in between used to make
  // the Query Results listener subscribe again, and lose what came then.
  api.sendQueryToMain(query, 'e2e-query')
  api.sendQueryResultsAction('rename-saved-query', { guid: 'e2e-query', name: 'E2E query, renamed twice' })
  t.check('Query Results: a message straight after a change still lands',
    await t.until(() => { const q = queries.getState().savedQueries.find((x) => x.guid === 'e2e-query'); return q?.name === 'E2E query, renamed twice' && q.query.codeCondition.includeSubcodes === true }))
  api.sendQueryResultsAction('run-saved-query', { guid: 'e2e-query' })
  t.check('Query Results: a saved query runs', !!(await settled()))
  api.sendQueryResultsAction('save-query')
  const dialog = await t.until(() => [...document.querySelectorAll('.modal')].find(t.visible))
  t.check('Query Results: Save opens the Save Query dialog', !!dialog)
  const cancel = dialog && [...dialog.querySelectorAll('button')].find((b) => /cancel/i.test(b.textContent))
  if (cancel) t.press(cancel)
  api.sendQueryResultsAction('delete-saved-query', { guid: 'e2e-query' })
  t.check('Query Results: a saved query is deleted', await t.until(() => !queries.getState().savedQueries.some((q) => q.guid === 'e2e-query')))
  api.sendQueryResultsAction('clear-query')
  t.check('Query Results: the query is cleared', await t.until(() => !queries.getState().isActive))

  // A popped-out Query Results window is sent each change.
  const sent = []
  const realUpdate = api.updateQueryResultsWindow
  api.updateQueryResultsWindow = (d) => { sent.push(d); realUpdate(d) }
  api.sendAnalysisAction('run-code-query', money.guid)
  await settled()
  const popOut = await t.until(() => [...document.querySelectorAll('[title="Open query results in a separate window"]')].find(t.visible))
  t.check('Query Results: the pane can pop out', !!popOut)
  if (popOut) {
    t.press(popOut)
    await t.sleep(1500)
    const before = sent.length
    const wellbeing = codes.getState().flatCodes().find((c) => c.name === 'Wellbeing')
    api.sendAnalysisAction('run-code-query', wellbeing.guid)
    await settled()
    await t.sleep(800)
    const last = sent[sent.length - 1]
    t.check('Query Results: the popped-out window gets the new results',
      sent.length > before && last?.currentQuery?.codeCondition?.codeGuid === wellbeing.guid && last.results.length === queries.getState().results.length)
    api.closeQueryResultsWindow?.()
  }
  api.updateQueryResultsWindow = realUpdate

  // Cmd/Ctrl+F with a document open opens Find.
  const ana = docs.getState().sources.find((s) => s.name === 'Interview - Ana.txt')
  docs.getState().viewDocument(ana.guid)
  await t.sleep(800)
  const mac = /Mac/i.test(navigator.userAgent)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', metaKey: mac, ctrlKey: !mac, bubbles: true }))
  const find = await t.until(() => [...document.querySelectorAll('.modal')].find((m) => t.visible(m) && m.textContent.includes(ana.name)))
  t.check('Cmd/Ctrl+F opens Find for the open document', !!find)

  // Every change above was a real edit: the project saves.
  t.check('the project saves after these changes', !!(await t.until(() => !project.getState().isDirty, 15000)))
}
