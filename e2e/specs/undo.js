// Undo with a query open: coding a passage is one Undo step (the query's
// results, which follow a moment later, aren't a step of their own), and
// undoing or redoing it brings the results up to date.

async function spec(t) {
  const docs = (await t.module('stores/document-store')).useDocumentStore
  const codes = (await t.module('stores/code-store')).useCodeStore
  const queries = (await t.module('stores/query-store')).useQueryStore
  const undo = (await t.module('stores/undo-store')).useUndoStore
  const settled = () => t.until(() => { const s = queries.getState(); return s.isActive && !s.isLoading }, 30000)

  const money = codes.getState().flatCodes().find((c) => c.name === 'Money')
  queries.getState().setComplexQuery({ documentFilter: {}, codeCondition: { type: 'code', codeGuid: money.guid, includeSubcodes: true } })
  await settled()
  await t.sleep(1000)
  undo.getState().clearHistory()
  const before = queries.getState().results.length

  const src = docs.getState().sources.find((s) => (s.sourceType ?? 'text') === 'text')
  const sel = docs.getState().addSelection(src.guid, 0, 12, 'undo test')
  docs.getState().addCodingToSelection(src.guid, sel, money.guid)
  await t.until(() => queries.getState().results.length === before + 1, 30000)
  await t.sleep(1500)
  t.check('coding with a query open is one Undo step', undo.getState().undoStack.length === 1, String(undo.getState().undoStack.length))

  const coded = () => docs.getState().sources.find((s) => s.guid === src.guid).selections.some((s) => s.guid === sel)
  undo.getState().undo()
  t.check('one Undo removes the coding', !coded())
  t.check('and the results follow', !!(await t.until(() => !queries.getState().isLoading && queries.getState().results.length === before, 10000)), `${queries.getState().results.length} (was ${before})`)

  undo.getState().redo()
  t.check('Redo brings the coding back', coded())
  t.check('and its result', !!(await t.until(() => !queries.getState().isLoading && queries.getState().results.length === before + 1, 10000)))
}
