async function spec(t) {
  const docs = (await t.module('stores/document-store')).useDocumentStore
  const tags = (await t.module('stores/tag-store')).useTagStore
  const codes = (await t.module('stores/code-store')).useCodeStore
  await t.sleep(2000)
  t.check('it opens with no documents', docs.getState().sources.length === 0)
  t.check('its codes and tags are kept', codes.getState().flatCodes().length === 5 && tags.getState().tags.length === 4)
  t.check('no tag lists a removed document', tags.getState().tags.every((x) => x.memberSourceGuids.length === 0 && (x.memberSurveyRespondents ?? []).length === 0))
}
