// A project saved by a newer Magnolia opens read-only: the user is told,
// edits aren't saved (not by autosave, nor by a save the backend is asked
// for), and the file is left as it was (newer-format.after.js reopens it).

async function spec(t) {
  const project = (await t.module('stores/project-store')).useProjectStore
  const codes = (await t.module('stores/code-store')).useCodeStore
  const { collectProject } = await t.module('app/project-file')
  const docs = (await t.module('stores/document-store')).useDocumentStore

  t.check('the project knows a newer Magnolia saved it', project.getState().newerFormat === 'Magnolia 9.0.0', project.getState().newerFormat)
  const banner = () => [...document.querySelectorAll('[role="alertdialog"]')].find((e) => /Opened read-only/.test(e.innerText))
  const shown = await t.until(banner, 10000)
  t.check('the user is told it’s read-only, and why', !!shown && /Magnolia 9\.0\.0/.test(shown.innerText))
  t.check('it has a way to look for an update', !!shown && /Check for Updates/.test(shown.innerText))

  t.press([...shown.querySelectorAll('button')].find((b) => b.textContent === 'OK'))
  t.check('the notice can be put away', !!(await t.until(() => !banner(), 5000)))

  const pill = [...document.querySelectorAll('.app-toolbar button')].find((b) => b.textContent.trim() === 'Read-only')
  t.check('a Read-only pill stays in the toolbar', !!pill)

  codes.getState().addCode('Not to be saved', '#888888')
  t.check('an edit leaves the project unchanged on disk', !project.getState().isDirty)
  // Just closed: an edit doesn't bring the dialog straight back (an edit is
  // often a keystroke); it comes back at most once a minute.
  await t.sleep(500)
  t.check('an edit straight after closing it doesn’t reopen it', !banner())
  pill?.click()
  t.check('the pill brings the notice back', !!(await t.until(banner, 5000)))
  t.press([...banner().querySelectorAll('button')].find((b) => b.textContent === 'OK'))

  // Asked directly, the backend refuses too.
  const result = await window.api.saveProject({
    project: collectProject(),
    sourceContents: docs.getState().sourceContents,
    filePath: project.getState().filePath,
    userName: 'Tester'
  })
  t.check('a save over it is refused', !!result && result.guardBlocked === true && /Magnolia 9\.0\.0/.test(result.message), JSON.stringify(result))

  // Long enough for an autosave to have fired, had there been one.
  await t.sleep(4000)
}
