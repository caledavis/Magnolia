// A project the user empties is saved (and opens again empty:
// empty-save-guard.after.js); one whose stores are wiped by a fault isn't
// (store-wipe-refused.js).

async function spec(t) {
  const docs = (await t.module('stores/document-store')).useDocumentStore
  const project = (await t.module('stores/project-store')).useProjectStore
  for (const s of [...docs.getState().sources]) docs.getState().removeSource(s.guid)
  t.check('the user removed every document', docs.getState().sources.length === 0)
  t.check('the emptied project saves', !!(await t.until(() => !project.getState().isDirty, 20000)))
}
