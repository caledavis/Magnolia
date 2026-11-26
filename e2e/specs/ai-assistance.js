// AI Assistance, with an AI app on this computer (Claude Desktop, through
// Magnolia's connector: the connector itself is tested in
// src-tauri/src/mcp.rs) making its requests: the AI Assistance Viewer
// opens to ask before the app can read anything, and opens from View → AI
// Assistance; the app's proposals appear in it as they come, change
// nothing until approved, and when approved are made by an AI coder,
// noted in the Logbook, and taken back by one Undo.

async function spec(t) {
  await new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = location.origin + '/@fs__E2E_ROOT__/node_modules/axe-core/axe.min.js'; s.onload = resolve; s.onerror = reject; document.head.appendChild(s) })
  const prefs = (await t.module('stores/preferences-store')).usePreferencesStore
  const docs = (await t.module('stores/document-store')).useDocumentStore
  const codes = (await t.module('stores/code-store')).useCodeStore
  const project = (await t.module('stores/project-store')).useProjectStore
  const logbook = (await t.module('stores/logbook-store')).useLogbookStore
  const undo = (await t.module('stores/undo-store')).useUndoStore
  const ai = (await t.module('stores/ai-store')).useAiStore
  const apps = await t.module('utils/ai/apps')
  await t.call('automation_set_size', { width: 1500, height: 950 })

  const doc = docs.getState().sources.find((s) => (s.sourceType ?? 'text') === 'text')
  const text = docs.getState().sourceContents[doc.guid]
  const quote = text.split(/(?<=[.!?])\s+/).find((s) => s.length > 30 && s.length < 200).trim()
  const firstCode = codes.getState().flatCodes()[0]

  // Claude Desktop's requests, as the connector hands them on.
  const answers = {}
  window.api.mcpReply = async (callId, content, isError) => { answers[callId] = { content, isError } }
  let n = 0
  const ask = (name, input = {}) => {
    const callId = `c${++n}`
    apps.answerAppCall({ callId, session: 's1', client: 'claude-ai', name, input })
    return answers[callId]
  }

  prefs.setState({ aiAppsEnabled: true })
  // Start in Focused (the choice is remembered, and may be List).
  localStorage.setItem('magnolia-ai-review-view', 'focused')
  t.check('Claude Desktop is named so, in agent mode too', apps.appName('claude-ai') === 'Claude Desktop' && apps.appName('local-agent-mode-magnolia') === 'Claude Desktop')

  // Not allowed yet: the app is refused, and the Viewer opens to ask.
  const refused = ask('list_documents')
  t.check('an app is refused until the project allows it', refused?.isError && /hasn't yet let AI apps use this project/.test(refused.content), refused?.content)
  const findReview = () => [...document.querySelectorAll('h2')].find((h) => t.visible(h) && h.textContent === 'AI Assistance')?.closest('div[style*="flex-direction: column"]')
  let review = await t.until(findReview, 3000)
  t.check('the AI Assistance Viewer opens to ask', !!review && /Claude Desktop wants to use this project/.test(review.textContent), review?.textContent.slice(0, 200))
  t.check('nothing was read', ai.getState().sessions.length === 0)
  t.check('it says the user is responsible for their use of AI', /It is your responsibility to ensure/.test(review.textContent))
  { const box = [...review.querySelectorAll('[role="alert"]')][0]; const close = [...review.querySelectorAll('button')].find((b) => b.textContent === 'Close'); const scroller = box?.closest('div[style*="overflow-y: auto"]'); const bar = scroller ? scroller.offsetWidth - scroller.clientWidth : 0; t.check('the box lines up with the heading (allowing for a scrollbar beside it)', !!box && !!close && Math.abs(box.getBoundingClientRect().right + bar - close.getBoundingClientRect().right) < 2, `${box?.getBoundingClientRect().right} + ${bar} vs ${close?.getBoundingClientRect().right}`) }
  ;[...review.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Allow')?.click()
  await t.sleep(50)
  t.check('allowing is kept with the project', ai.getState().projectAi().appsAllowed === true)

  // Closed, it opens again from View → AI Assistance.
  docs.getState().closeTab((await t.module('utils/tab-ids')).AI_REVIEW_TAB_ID)
  await t.sleep(100)
  ;[...document.querySelectorAll('[role="tab"]')].find((b) => b.textContent.trim() === 'View')?.click()
  const button = await t.until(() => [...document.querySelectorAll('button')].find((b) => t.visible(b) && b.textContent.trim() === 'AI Assistance'), 5000)
  button?.click()
  review = await t.until(findReview, 3000)
  t.check('View → AI Assistance opens the Viewer', !!review)
  t.check('with nothing to review yet', /Nothing to review/.test(review?.textContent ?? ''))

  // The app reads, then proposes a new code, a coding with it, and a renaming.
  const docsList = ask('list_documents').content
  const dRef = docsList.split('\n').find((l) => l.includes(`| ${doc.name} |`)).split(' |')[0]
  const cRef = ask('list_codes').content.split('\n').find((l) => l.includes(` ${firstCode.name}`))?.trim().split(' ')[0]
  // A second connection (Claude Desktop starts the connector more than
  // once) uses the same references.
  const other = (name, input = {}) => { const callId = `o${++n}`; apps.answerAppCall({ callId, session: 's2', client: 'claude-ai', name, input }); return answers[callId] }
  const again = other('read_document', { document: dRef })
  t.check('references mean the same in another connection', !again.isError && again.content.includes(quote), again.content.slice(0, 120))
  t.check('and are numbered the same', other('list_documents').content.split('\n').find((l) => l.includes(`| ${doc.name} |`))?.startsWith(dRef + ' '))
  const read = ask('read_document', { document: dRef })
  t.check('the app reads a document', !read.isError && read.content.includes(quote))
  ask('propose_new_code', { name: 'Test AI code', description: 'When a participant says so.', reason: 'Recurs.' })
  const coding = ask('propose_coding', { document: dRef, quote, code: 'N1', reason: 'It says so.' })
  t.check('a proposal tells the app it waits for the user', /AI Assistance Viewer/.test(coding.content), coding.content)
  ask('propose_code_change', { code: cRef ?? 'C1', name: 'Renamed by AI', reason: 'Clearer.' })
  t.check('nothing has changed yet', !codes.getState().flatCodes().some((c) => c.name === 'Test AI code') && codes.getState().findCode(firstCode.guid).name === firstCode.name)

  // A list to move through: the current change in full, the others as lines.
  const list = () => review.querySelector('[role="listbox"]')
  const focused = () => list()?.querySelector('[aria-selected="true"]')
  const keyCodes = { e: 'KeyE', r: 'KeyR' }
  const key = async (k) => { list()?.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: keyCodes[k] ?? k, bubbles: true })); await t.sleep(500) }
  t.check('the Viewer lists each change as it comes', !!(await t.until(() => list()?.querySelectorAll('[data-proposal]').length === 3, 3000)), list()?.textContent.slice(0, 200))
  t.check('the first is shown in full: the new code', /Test AI code/.test(focused()?.textContent ?? '') && /New code/.test(focused()?.textContent ?? ''), focused()?.textContent.slice(0, 100))
  t.check('the list has the keyboard', document.activeElement === list())
  await key('ArrowDown')
  t.check('↓ moves to the coding, its passage in context', focused()?.querySelector('mark')?.textContent === quote, focused()?.textContent.slice(0, 120))
  t.check('it says where it is', /2 of 3/.test(focused()?.textContent ?? ''))
  // axe, in each theme.
  const axeThemes = async (el) => {
    const before = document.documentElement.getAttribute('data-theme')
    const found = []
    // The colours as they end up: no transitions while checking (a window
    // in the background may not run them).
    const still = document.createElement('style')
    still.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }'
    document.head.appendChild(still)
    for (const theme of ['magnolia', 'magnolia-dark', 'high-contrast']) {
      document.documentElement.setAttribute('data-theme', theme)
      await t.sleep(300)
      // Not the faint cards either side of the current one in Focused: a
      // preview, hidden from screen readers, each read in full when it's
      // current (WCAG's "incidental" text, which has no contrast minimum).
      const res = await window.axe.run({ include: [el], exclude: [['.ai-barrel [aria-hidden="true"]']] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }, resultTypes: ['violations'] })
      for (const v of res.violations) found.push(`[${theme}] ${v.id}: ` + v.nodes.slice(0, 2).map((n) => n.html.slice(0, 90) + ' — ' + (n.failureSummary ?? '').replace(/\s+/g, ' ').slice(0, 120)).join(' / '))
    }
    if (before) document.documentElement.setAttribute('data-theme', before); else document.documentElement.removeAttribute('data-theme')
    still.remove()
    return found
  }
  t.check('the coding shows its (proposed) code\'s colour', !!focused()?.querySelector('span[aria-hidden][style*="border-radius: 50%"]'))
  const v1 = await axeThemes(review)
  t.check('the Viewer passes axe in every theme, with changes to review', v1.length === 0, v1.join(' || ').slice(0, 1200))

  // The plain list, instead: a line each, with Reject and Approve.
  const radio = (name) => [...review.querySelectorAll('[role="radio"]')].find((b) => b.textContent.trim() === name)
  radio('List')?.click()
  await t.sleep(150)
  const lines = [...review.querySelectorAll('li[data-proposal]')]
  t.check('List shows each change as a line, to decide there', lines.length === 3 && lines.every((l) => l.querySelector('button[aria-label="Approve"]') && l.querySelector('button[aria-label="Reject"]')), String(lines.length))
  // Its keys work after a click (a click doesn't move the keyboard on
  // macOS): E rejects the clicked row.
  const listEl = review.querySelector('ul.ai-list')
  document.body.focus()
  const third = lines[2]
  third.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  await t.sleep(100)
  t.check('a click gives the list the keyboard, and selects the row', document.activeElement === listEl && third.hasAttribute('data-active'))
  const v1b = await axeThemes(review)
  t.check('and passes axe in every theme', v1b.length === 0, v1b.join(' || ').slice(0, 800))
  radio('Focused')?.click()
  await t.sleep(150)
  list()?.focus()

  // A new code under another reads as Parent/New code; rejected.
  await t.sleep(700)
  const stepsBefore = undo.getState().undoStack.length
  ask('propose_new_code', { name: 'Child test', parent: cRef ?? 'C1', reason: 'Narrower.' })
  await t.sleep(700)
  t.check('a proposal arriving isn\'t an Undo step', undo.getState().undoStack.length === stepsBefore, `${undo.getState().undoStack.length} (was ${stepsBefore})`)
  await t.until(() => list()?.querySelectorAll('[data-proposal]').length === 4, 3000)
  await key('End')
  t.check('a new code shows where it goes, as Parent/New code', (focused()?.textContent ?? '').includes(`${firstCode.name}/Child test`), focused()?.textContent.slice(0, 80))
  await key('e')

  // Reject the renaming (E), from the keyboard.
  await t.sleep(700)
  undo.getState().clearHistory()
  await key('End')
  t.check('the renaming is reached with End', /Renamed by AI/.test(focused()?.textContent ?? ''), focused()?.textContent.slice(0, 80))
  await key('e')
  t.check('a rejected change isn\'t made', codes.getState().findCode(firstCode.guid).name === firstCode.name && ai.getState().proposals.some((p) => p.change.type === 'editCode' && p.status === 'denied'))
  // Rejecting is an Undo step: Undo brings it back to review, Redo rejects it again.
  const renameStatus = () => ai.getState().proposals.find((p) => p.change.type === 'editCode')?.status
  await t.sleep(700)
  t.check('rejecting is an Undo step', undo.getState().undoStack.length === 1, String(undo.getState().undoStack.length))
  undo.getState().undo()
  t.check('Undo brings a rejected proposal back to review', renameStatus() === 'pending')
  undo.getState().redo()
  t.check('and Redo rejects it again', renameStatus() === 'denied')
  await t.sleep(700)
  undo.getState().clearHistory()

  // Approve the coding (R): its new code comes with it.
  await key('Home')
  await key('ArrowDown')
  t.check('the coding says it needs the new code', /also approves the new code/.test(focused()?.textContent ?? ''), focused()?.textContent.slice(0, 120))
  await key('r')
  await t.sleep(100)
  const made = codes.getState().flatCodes().find((c) => c.name === 'Test AI code')
  t.check('approving the coding makes the code too', !!made && made.description === 'When a participant says so.')
  const sel = docs.getState().sources.find((s) => s.guid === doc.guid).selections.find((s) => s.codings.some((c) => c.codeGuid === made?.guid))
  const coder = project.getState().users.find((u) => u.guid === sel?.codings[0].creatingUser)
  t.check('and the coding, by an AI coder', !!sel && coder?.name === 'AI (Claude Desktop)', coder?.name)
  t.check('on exactly the quoted passage', !!sel && Array.from(text).slice(sel.startPosition, sel.endPosition).join('') === quote)
  t.check('the Logbook notes it', /AI Assistance: 2 changes approved/.test(logbook.getState().entries[0]?.title ?? '') && /Claude Desktop/.test(logbook.getState().entries[0]?.content ?? ''))
  t.check('a screen reader is told, and nothing is added to the Viewer', !!(await t.until(() => [...document.querySelectorAll('[aria-live="assertive"]')].some((e) => /2 changes made/.test(e.textContent)), 2000)) && !/2 changes made/.test(review.textContent))

  // One Undo takes the code and the coding back.
  await t.sleep(900)
  t.check('as one Undo step', undo.getState().undoStack.length === 1, String(undo.getState().undoStack.length))
  undo.getState().undo()
  t.check('Undo takes them back', !codes.getState().flatCodes().some((c) => c.name === 'Test AI code') && !docs.getState().sources.find((s) => s.guid === doc.guid).selections.some((s) => s.guid === sel?.guid))
  t.check('and puts them back to be reviewed', ai.getState().proposals.filter((p) => p.status === 'pending').length === 2)
  undo.getState().redo()
  t.check('Redo makes them again, approved', codes.getState().flatCodes().some((c) => c.name === 'Test AI code') && ai.getState().proposals.filter((p) => p.status === 'approved').length === 2)

  // Decided changes, on each filter, in each theme.
  const filterBtn = (name) => [...review.querySelectorAll('[role="radio"]')].find((b) => b.textContent.startsWith(name))
  const v2 = []
  for (const name of ['Approved', 'Rejected']) {
    filterBtn(name)?.click()
    await t.sleep(150)
    v2.push(...(await axeThemes(review)).map((x) => `${name}: ${x}`))
  }
  t.check('and with decided ones', v2.length === 0, v2.join(' || ').slice(0, 1200))
  filterBtn('To Review')?.click()

  // Preferences → AI Assistance.
  docs.getState().openToolTab((await t.module('utils/tab-ids')).PREFERENCES_TAB_ID)
  const category = await t.until(() => [...document.querySelectorAll('div')].find((d) => t.visible(d) && d.children.length === 0 && d.textContent === 'AI Assistance'), 5000)
  category?.click()
  const service = await t.until(() => [...document.querySelectorAll('input[type="checkbox"]')].find((c) => t.visible(c) && /AI apps on this computer/.test(c.parentElement?.textContent ?? '')), 5000)
  t.check('Preferences has an AI Assistance section', !!service)
  const prefsPane = service?.closest('div[style*="max-width"]')
  const rp = await window.axe.run(prefsPane ?? document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }, resultTypes: ['violations'] })
  t.check('which passes axe', rp.violations.length === 0, rp.violations.map((v) => v.id + ': ' + v.nodes.slice(0, 2).map((n) => n.html.slice(0, 100)).join(' / ')).join(' || '))
}
