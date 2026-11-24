// Runs in Magnolia's main window, ahead of each spec (see run.mjs). It
// reports to the runner through the automation_log command, one line per
// event: "CHECK ok|FAIL <label>", "ERROR <message>", "DONE".
// Specs define `async function spec(t)`; `t` is the toolkit below.
;(function () {
  if (window.top !== window || window.__e2e) return
  window.__e2e = true
  const call = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args)
  const log = (m) => call('automation_log', { message: String(m) })

  // Anything the page reports as wrong fails the run.
  const origError = console.error
  console.error = (...a) => {
    log('ERROR console.error: ' + a.map((x) => (x && x.stack) || String(x)).join(' ').slice(0, 400))
    origError(...a)
  }
  const origWarn = console.warn
  console.warn = (...a) => {
    const s = a.map(String).join(' ')
    if (/React|Maximum update depth|act\(/i.test(s)) log('ERROR console.warn: ' + s.slice(0, 400))
    origWarn(...a)
  }
  addEventListener('error', (e) => log('ERROR ' + e.message))
  addEventListener('unhandledrejection', (e) => log('ERROR unhandled rejection: ' + ((e.reason && e.reason.message) || e.reason)))

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const t = {
    log,
    call,
    sleep,
    /** Record a check; a failed one fails the run. */
    check(label, ok, detail) {
      log('CHECK ' + (ok ? 'ok   ' : 'FAIL ') + label + (detail ? ' — ' + detail : ''))
      return !!ok
    },
    /** A module of the app (as the dev server serves it), e.g. t.module('stores/query-store'). */
    module: (path) => import(location.origin + '/' + path + '.ts'),
    visible: (el) => !!el && el.offsetParent !== null,
    /** Click as a user does: press, release, click. */
    press(el) {
      for (const type of ['mousedown', 'mouseup']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    },
    dblclick(el) {
      t.press(el)
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    },
    /** Wait until `test()` is truthy (polling), or give up after `ms`. */
    async until(test, ms = 10000, step = 100) {
      const start = Date.now()
      while (Date.now() - start < ms) {
        const v = await test()
        if (v) return v
        await sleep(step)
      }
      return null
    }
  }

  ;(async () => {
    await new Promise((r) => (document.readyState === 'complete' ? r() : addEventListener('load', r)))
    try {
      // The project opens, and settles, before the spec starts.
      const project = (await t.module('stores/project-store')).useProjectStore
      if (!(await t.until(() => project.getState().filePath, 30000))) throw new Error('the project never opened')
      await sleep(2000)
      // eslint-disable-next-line no-undef
      await spec(t)
    } catch (e) {
      log('ERROR spec threw: ' + ((e && e.stack) || e))
    }
    log('DONE')
    await call('automation_quit')
  })()
})()
