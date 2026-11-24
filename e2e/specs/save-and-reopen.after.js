// What save-and-reopen.js changed is in the project as it opens again.

async function spec(t) {
  const docs = (await t.module('stores/document-store')).useDocumentStore
  const codes = (await t.module('stores/code-store')).useCodeStore
  const tags = (await t.module('stores/tag-store')).useTagStore
  const memos = (await t.module('stores/memo-store')).useMemoStore
  const logbook = (await t.module('stores/logbook-store')).useLogbookStore
  const queries = (await t.module('stores/query-store')).useQueryStore

  await t.until(() => docs.getState().sources.length > 0, 20000)
  const source = (name) => docs.getState().sources.find((s) => s.name === name)
  const code = codes.getState().flatCodes().find((c) => c.name === 'Reopened')
  t.check('the new code is there', !!code)
  const ben = source('Interview - Ben.txt')
  const coded = ben?.selections.find((s) => s.codings.some((c) => c.codeGuid === code?.guid))
  const text = ben && docs.getState().sourceContents[ben.guid]
  t.check('its passage is coded where it was', !!coded && Array.from(text).slice(coded.startPosition, coded.endPosition).join('') === 'I study from home most days')
  const domestic = tags.getState().tags.find((x) => x.name === 'Domestic')
  t.check('Dee is tagged Domestic', domestic?.memberSourceGuids.includes(source('Interview - Dee.txt')?.guid))
  t.check('Chen is gone', !source('Interview - Chen.txt') && docs.getState().sources.length === 4)
  const known = new Set(docs.getState().sources.map((s) => s.guid))
  t.check('no tag lists a document that is gone', tags.getState().tags.every((x) => x.memberSourceGuids.every((g) => known.has(g))))
  t.check('the logbook entry is there', logbook.getState().entries.some((e) => e.guid === 'e2e-log'))
  t.check('the memo is there', memos.getState().memos.some((m) => m.title === 'Reopen memo'))
  t.check('the saved query is there', queries.getState().savedQueries.some((q) => q.name === 'Reopened query'))
}
