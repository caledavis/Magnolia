// The Query Results pane shows every result: one passage can give several
// (an overlap query gives each place it overlaps), and each is a row.

async function spec(t) {
  const docs = (await t.module('stores/document-store')).useDocumentStore
  const codes = (await t.module('stores/code-store')).useCodeStore
  const queries = (await t.module('stores/query-store')).useQueryStore
  const code = (name) => codes.getState().flatCodes().find((c) => c.name === name).guid

  // A Wellbeing passage across Ben's answer overlaps two separate Money
  // passages inside it.
  const ben = docs.getState().sources.find((s) => s.name === 'Interview - Ben.txt')
  const text = docs.getState().sourceContents[ben.guid]
  const at = (phrase) => Array.from(text.slice(0, text.indexOf(phrase))).length
  const whole = 'The debt worries me every day. I skip meals at the end of the month'
  const outer = docs.getState().addSelection(ben.guid, at(whole), at(whole) + whole.length, '')
  docs.getState().addCodingToSelection(ben.guid, outer, code('Belonging'))
  for (const part of ['worries me', 'skip meals']) {
    const sel = docs.getState().addSelection(ben.guid, at(part), at(part) + part.length, '')
    docs.getState().addCodingToSelection(ben.guid, sel, code('Rent'))
  }

  queries.getState().setComplexQuery({ documentFilter: { sourceGuids: [ben.guid] }, codeCondition: {
    type: 'overlap', condition1: { type: 'code', codeGuid: code('Belonging') }, condition2: { type: 'code', codeGuid: code('Rent') }
  } })
  await t.until(() => { const s = queries.getState(); return s.isActive && !s.isLoading })
  const results = queries.getState().results
  t.check('one passage overlapping two others gives two results', results.length === 2 && results[0].selectionGuid === results[1].selectionGuid,
    `${results.length} results`)
  await t.sleep(800)
  const header = [...document.querySelectorAll('.query-results-group-header')].find(t.visible)
  const rows = header ? [...header.parentElement.querySelectorAll('[draggable="true"]')].filter(t.visible) : []
  t.check('the pane shows a row for each', rows.length === results.length, `${rows.length} rows`)
}
