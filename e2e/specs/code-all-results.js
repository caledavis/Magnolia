// "Code all results" codes each result where it is: a text match in a
// survey answer becomes a passage in that answer.

async function spec(t) {
  const queries = (await t.module('stores/query-store')).useQueryStore
  const docs = (await t.module('stores/document-store')).useDocumentStore
  const codes = (await t.module('stores/code-store')).useCodeStore
  const { buildCellText } = await t.module('utils/survey/cell-text')

  queries.getState().setComplexQuery({ documentFilter: {}, codeCondition: { type: 'text', searchText: 'rent', caseSensitive: false, wholeWord: true } })
  await t.until(() => { const s = queries.getState(); return s.isActive && !s.isLoading })
  const results = queries.getState().results
  t.check('the search finds "rent" in interviews and in survey answers',
    results.some((r) => r.surveyCell) && results.some((r) => !r.surveyCell), `${results.length} results`)

  const guid = codes.getState().addCode('Coded all', '#888888')
  window.api.sendQueryResultsAction('code-all-existing-code', { guid })
  const coded = await t.until(() => {
    const sels = docs.getState().sources.flatMap((s) => s.selections.filter((sel) => sel.codings.some((c) => c.codeGuid === guid)).map((sel) => ({ s, sel })))
    return sels.length === results.length ? sels : null
  })
  t.check('every result is coded', !!coded, `${results.length} results`)

  const misplaced = []
  for (const { s, sel } of coded || []) {
    let text
    if (s.sourceType === 'survey') {
      if (!sel.surveyCell) { misplaced.push(`${s.name}: not in an answer`); continue }
      const respondent = s.formatData.survey.respondents.find((r) => r.id === sel.surveyCell.respondentId)
      text = buildCellText(respondent?.answers[sel.surveyCell.questionId])
    } else {
      text = docs.getState().sourceContents[s.guid] ?? s.plainTextContent ?? ''
    }
    const found = Array.from(text).slice(sel.startPosition, sel.endPosition).join('')
    if (found.toLowerCase() !== 'rent') misplaced.push(`${s.name}: "${found}"`)
  }
  t.check('each coded passage is the matched word, in its answer for a survey', misplaced.length === 0, misplaced.join(' | '))

  // Closed answers aren't searched (they can't be coded).
  queries.getState().setComplexQuery({ documentFilter: {}, codeCondition: { type: 'text', searchText: 'domestic', caseSensitive: false, wholeWord: true } })
  await t.until(() => { const s = queries.getState(); return s.isActive && !s.isLoading })
  const survey = docs.getState().sources.find((s) => s.sourceType === 'survey').formatData.survey
  const closed = new Set(survey.questions.filter((q) => q.type !== 'open-ended').map((q) => q.id))
  const inClosed = queries.getState().results.filter((r) => r.surveyCell && closed.has(r.surveyCell.questionId))
  t.check('a search skips closed survey answers', inClosed.length === 0 && queries.getState().results.length > 0, `${queries.getState().results.length} results, ${inClosed.length} in closed answers`)
}
