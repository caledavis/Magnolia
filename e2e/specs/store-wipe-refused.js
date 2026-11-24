// A fault that wipes the stores doesn't empty the file: the save is
// refused, and the user is told (store-wipe-refused.after.js reopens it).

async function spec(t) {
  const docs = (await t.module('stores/document-store')).useDocumentStore
  const project = (await t.module('stores/project-store')).useProjectStore
  docs.getState().clearAll()
  project.getState().markDirty()
  const banner = await t.until(() => /aren.t being saved/.test(document.body.innerText), 15000)
  t.check('the user is told the changes aren’t being saved', !!banner)
  t.check('the project is still unsaved', project.getState().isDirty)
}
