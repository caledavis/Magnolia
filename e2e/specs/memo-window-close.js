// A memo window with unsaved changes asks before it closes: Cancel keeps
// it open with the edit, Save & Close saves the edit into the project and
// closes, and a window with nothing unsaved closes at once. (It used to
// close without asking, and the main window closed memo windows without
// asking too, so a memo being written was lost.)

async function spec(t) {
  const memos = (await t.module('stores/memo-store')).useMemoStore
  const guid = memos.getState().addMemo('project', 'Close test')
  const memo = () => memos.getState().memos.find((m) => m.guid === guid)
  const label = 'memo-' + guid.replace(/[^A-Za-z0-9-]/g, '_')
  const theme = document.documentElement.getAttribute('data-theme') || ''

  let n = 0
  // Run `body` in the memo window; resolves to what it returns, or null if
  // the window is gone.
  const inMemo = async (body) => {
    const key = 'e2e-memo:' + n++
    localStorage.removeItem(key)
    try {
      await t.call('automation_eval', { label, script: `(async () => { let r; try { r = await (async () => { ${body} })() } catch (e) { r = 'ERR ' + e } localStorage.setItem('${key}', JSON.stringify(r ?? null)) })()` })
    } catch (e) {
      return { gone: String(e) }
    }
    const raw = await t.until(() => localStorage.getItem(key), 8000, 100)
    return raw ? JSON.parse(raw) : { noAnswer: true }
  }
  const press = (scope, text) => `{ const b = [...${scope}.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) return 'no button ${text}'; b.click(); }`
  const typeTitle = (v) => `{ const i = document.querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input', { bubbles: true })); }`

  // Windows open slowly on a virtual display (CI): wait for each step
  // rather than for a fixed time.
  const ready = (title) => t.until(async () => (await inMemo(`return document.querySelector('input')?.value`)) === title, 30000, 500)
  const gone = () => t.until(async () => (await inMemo(`return 'here'`))?.gone !== undefined, 15000, 500)
  const dialogShown = (shown) => t.until(async () => (await inMemo(`return !!document.querySelector('[role="alertdialog"]')`)) === shown, 10000, 250)

  window.api.openMemoEditWindow({ memo: memo(), isNew: false, theme })
  t.check('the memo window opens', await ready('Close test'))

  // 1. Unsaved edit, then close: it asks.
  await inMemo(`${typeTitle('Edited title')} return true`)
  await t.sleep(300)
  await inMemo(`${press('document', 'Cancel')} return true`)
  t.check('closing with an unsaved edit asks first', await dialogShown(true))

  // 2. Cancel in the question: the window stays, edit intact.
  await inMemo(`${press('document.querySelector(\'[role="alertdialog"]\')', 'Cancel')} return true`)
  await dialogShown(false)
  const after = await inMemo(`return { dialog: !!document.querySelector('[role="alertdialog"]'), title: document.querySelector('input')?.value }`)
  t.check('Cancel keeps the window open, with the edit', after && after.dialog === false && after.title === 'Edited title', JSON.stringify(after))

  // 3. Save & Close: the edit reaches the project, and the window goes.
  await inMemo(`${press('document', 'Save & Close')} return true`)
  await t.until(() => memo()?.title === 'Edited title', 8000)
  t.check('Save & Close saves the edit', memo()?.title === 'Edited title', memo()?.title)
  t.check('…and closes the window', await gone())

  // 4. No edits: closing doesn't ask.
  window.api.openMemoEditWindow({ memo: memo(), isNew: false, theme })
  await ready('Edited title')
  await inMemo(`${press('document', 'Cancel')} return true`)
  t.check('closing with nothing unsaved closes at once', await gone())
}
