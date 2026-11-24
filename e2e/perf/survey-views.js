// Times each of the survey's views on the large project.
async function spec(t) {
  const docs = (await t.module('stores/document-store')).useDocumentStore
  const views = (await t.module('stores/survey-view-store')).useSurveyViewStore
  const survey = docs.getState().sources.find((s) => s.sourceType === 'survey')
  const data = survey.formatData.survey
  const open = data.questions.find((q) => q.type === 'open-ended')
  let last = performance.now(), longest = 0
  setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last - 20); last = now }, 20)
  async function measure(label, run, done) {
    await t.sleep(500); longest = 0
    const start = performance.now()
    run()
    const ok = await t.until(done, 120000, 20)
    await t.sleep(100)
    t.log(`${label}: ${Math.round(performance.now() - start)} ms, longest freeze ${Math.round(longest)} ms${ok ? '' : ' (DID NOT FINISH)'}`)
    t.check(label, !!ok)
  }
  await measure('summary view', () => { views.getState().setView(survey.guid, 'summary'); docs.getState().viewDocument(survey.guid) }, () => document.body.innerText.includes(data.respondents[999].displayName))
  await measure('one respondent', () => views.getState().setView(survey.guid, 'respondent', data.respondents[5].id), () => document.body.innerText.includes('What helps?'))
  await measure('an open-ended question (1,000 answers)', () => views.getState().setView(survey.guid, 'question', open.id), () => document.body.innerText.includes(data.respondents[999].displayName))
}
