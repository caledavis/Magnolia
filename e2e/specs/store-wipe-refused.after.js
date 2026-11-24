async function spec(t) {
  const docs = (await t.module('stores/document-store')).useDocumentStore
  await t.until(() => docs.getState().sources.length > 0, 20000)
  t.check('the file still has every document', docs.getState().sources.length === 5)
}
