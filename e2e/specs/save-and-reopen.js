// Edits are saved, and are there when the project is opened again
// (save-and-reopen.after.js).

async function spec(t) {
  const docs = (await t.module('stores/document-store')).useDocumentStore
  const codes = (await t.module('stores/code-store')).useCodeStore
  const tags = (await t.module('stores/tag-store')).useTagStore
  const memos = (await t.module('stores/memo-store')).useMemoStore
  const logbook = (await t.module('stores/logbook-store')).useLogbookStore
  const queries = (await t.module('stores/query-store')).useQueryStore
  const project = (await t.module('stores/project-store')).useProjectStore

  const source = (name) => docs.getState().sources.find((s) => s.name === name)
  // A new code on a passage of Ben's.
  const guid = codes.getState().addCode('Reopened', '#123456')
  const ben = source('Interview - Ben.txt')
  const text = docs.getState().sourceContents[ben.guid]
  const phrase = 'I study from home most days'
  const start = Array.from(text.slice(0, text.indexOf(phrase))).length
  const sel = docs.getState().addSelection(ben.guid, start, start + phrase.length, phrase)
  docs.getState().addCodingToSelection(ben.guid, sel, guid)
  // Dee tagged Domestic; Chen removed (and so taken off its tag).
  const domestic = tags.getState().tags.find((x) => x.name === 'Domestic')
  tags.getState().assignTagToDocument(domestic.guid, source('Interview - Dee.txt').guid)
  docs.getState().removeSource(source('Interview - Chen.txt').guid)
  // A logbook entry, a memo and a saved query.
  logbook.getState().setEntries([{ guid: 'e2e-log', title: 'Reopen check', content: 'Written before closing.', createdDateTime: new Date().toISOString() }, ...logbook.getState().entries])
  memos.getState().addMemo('project', 'Reopen memo', { content: 'Still here?' })
  queries.getState().setComplexQuery({ documentFilter: {}, codeCondition: { type: 'code', codeGuid: guid } })
  queries.getState().saveCurrentQuery('Reopened query')
  project.getState().markDirty()

  t.check('the edits are saved', !!(await t.until(() => !project.getState().isDirty, 20000)))
}
