// AI Assistance, with an AI app on this computer (Claude Desktop, through
// Magnolia's connector: the connector itself is tested in
// src-tauri/src/mcp.rs) making its requests: View → AI Assistance opens
// the pane, which asks before the app can read anything; the pane lists
// what the app read; its proposals wait in the AI Assistance Viewer,
// change nothing until approved, and when approved are made by an AI
// coder, noted in the Logbook, and taken back by one Undo.

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

  // View → AI Assistance.
  const viewTab = [...document.querySelectorAll('[role="tab"]')].find((b) => b.textContent.trim() === 'View')
  viewTab?.click()
  const button = await t.until(() => [...document.querySelectorAll('button')].find((b) => t.visible(b) && b.textContent.trim() === 'AI Assistance'), 5000)
  button?.click()
  const pane = await t.until(() => [...document.querySelectorAll('[role="region"][aria-label="AI Assistance"]')].find(t.visible), 5000)
  t.check('View → AI Assistance opens the pane', !!pane)

  // Not allowed yet: the app is refused, and the pane asks.
  const refused = ask('list_documents')
  t.check('an app is refused until the project allows it', refused?.isError && /hasn't yet let AI apps use this project/.test(refused.content), refused?.content)
  t.check('and the pane asks', !!(await t.until(() => /Claude Desktop wants to use this project/.test(pane.textContent), 3000)), pane.textContent.slice(0, 200))
  t.check('nothing was read', ai.getState().sessions.length === 0)
  ;[...pane.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Allow')?.click()
  await t.sleep(50)
  t.check('allowing is kept with the project', ai.getState().projectAi().appsAllowed === true)

  // The app reads, then proposes a new code, a coding with it, and a renaming.
  const docsList = ask('list_documents').content
  const dRef = docsList.split('\n').find((l) => l.includes(`| ${doc.name} |`)).split(' |')[0]
  const cRef = ask('list_codes').content.split('\n').find((l) => l.includes(` ${firstCode.name}`))?.trim().split(' ')[0]
  const read = ask('read_document', { document: dRef })
  t.check('the app reads a document', !read.isError && read.content.includes(quote))
  ask('propose_new_code', { name: 'Test AI code', description: 'When a participant says so.', reason: 'Recurs.' })
  const coding = ask('propose_coding', { document: dRef, quote, code: 'N1', reason: 'It says so.' })
  t.check('a proposal tells the app it waits for the user', /AI Assistance Viewer/.test(coding.content), coding.content)
  ask('propose_code_change', { code: cRef ?? 'C1', name: 'Renamed by AI', reason: 'Clearer.' })

  await t.sleep(100)
  t.check('the pane lists what it read', /Listed the project/.test(pane.textContent) && pane.textContent.includes(`Read ${doc.name}`), pane.textContent.slice(0, 400))
  t.check('nothing has changed yet', !codes.getState().flatCodes().some((c) => c.name === 'Test AI code') && codes.getState().findCode(firstCode.guid).name === firstCode.name)
  t.check('three changes wait for review', ai.getState().proposals.filter((p) => p.status === 'pending').length === 3)

  let r = await window.axe.run(pane, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }, resultTypes: ['violations'] })
  t.check('the pane passes axe', r.violations.length === 0, r.violations.map((v) => v.id + ': ' + v.nodes.slice(0, 2).map((n) => n.html.slice(0, 100)).join(' / ')).join(' || '))

  // Review them.
  ;[...pane.querySelectorAll('button')].find((b) => /review/.test(b.textContent))?.click()
  const review = await t.until(() => [...document.querySelectorAll('h2')].find((h) => t.visible(h) && h.textContent === 'AI Assistance')?.closest('div[style*="flex-direction: column"]'), 5000)
  t.check('the AI Assistance Viewer opens', !!review)
  const cards = () => [...review.querySelectorAll('section > ul > li')]
  t.check('it shows each change, with its passage in context', cards().length === 3 && cards().some((c) => c.querySelector('mark')?.textContent === quote), cards().map((c) => c.textContent.slice(0, 60)).join(' | '))
  r = await window.axe.run(review, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }, resultTypes: ['violations'] })
  t.check('the Viewer passes axe', r.violations.length === 0, r.violations.map((v) => v.id + ': ' + v.nodes.slice(0, 2).map((n) => n.html.slice(0, 100)).join(' / ')).join(' || '))

  // Deny the renaming.
  await t.sleep(700)
  undo.getState().clearHistory()
  const renameCard = cards().find((c) => /Renamed by AI/.test(c.textContent))
  ;[...renameCard.querySelectorAll('button')].find((b) => b.textContent === 'Deny')?.click()
  await t.sleep(100)
  t.check('a denied change isn\'t made', codes.getState().findCode(firstCode.guid).name === firstCode.name && ai.getState().proposals.some((p) => p.change.type === 'editCode' && p.status === 'denied'))

  // Approve the coding: its new code comes with it.
  const codingCard = cards().find((c) => c.querySelector('mark'))
  t.check('the coding says it needs the new code', /also approves the new code/.test(codingCard.textContent))
  ;[...codingCard.querySelectorAll('button')].find((b) => b.textContent === 'Approve')?.click()
  await t.sleep(100)
  const made = codes.getState().flatCodes().find((c) => c.name === 'Test AI code')
  t.check('approving the coding makes the code too', !!made && made.description === 'When a participant says so.')
  const sel = docs.getState().sources.find((s) => s.guid === doc.guid).selections.find((s) => s.codings.some((c) => c.codeGuid === made?.guid))
  const coder = project.getState().users.find((u) => u.guid === sel?.codings[0].creatingUser)
  t.check('and the coding, by an AI coder', !!sel && coder?.name === 'AI (Claude Desktop)', coder?.name)
  t.check('on exactly the quoted passage', !!sel && Array.from(text).slice(sel.startPosition, sel.endPosition).join('') === quote)
  t.check('the Logbook notes it', /AI Assistance: 2 changes approved/.test(logbook.getState().entries[0]?.title ?? '') && /Claude Desktop/.test(logbook.getState().entries[0]?.content ?? ''))
  t.check('the Viewer says so', /2 changes made/.test(review.textContent))

  // One Undo takes the code and the coding back.
  await t.sleep(900)
  t.check('as one Undo step', undo.getState().undoStack.length === 1, String(undo.getState().undoStack.length))
  undo.getState().undo()
  t.check('Undo takes them back', !codes.getState().flatCodes().some((c) => c.name === 'Test AI code') && !docs.getState().sources.find((s) => s.guid === doc.guid).selections.some((s) => s.guid === sel?.guid))
  t.check('and puts them back to be reviewed', ai.getState().proposals.filter((p) => p.status === 'pending').length === 2)
  undo.getState().redo()
  t.check('Redo makes them again, approved', codes.getState().flatCodes().some((c) => c.name === 'Test AI code') && ai.getState().proposals.filter((p) => p.status === 'approved').length === 2)

  // Preferences → AI Assistance.
  docs.getState().openToolTab((await t.module('utils/tab-ids')).PREFERENCES_TAB_ID)
  const category = await t.until(() => [...document.querySelectorAll('div')].find((d) => t.visible(d) && d.children.length === 0 && d.textContent === 'AI Assistance'), 5000)
  category?.click()
  const service = await t.until(() => [...document.querySelectorAll('input[type="checkbox"]')].find((c) => t.visible(c) && /AI apps on this computer/.test(c.parentElement?.textContent ?? '')), 5000)
  t.check('Preferences has an AI Assistance section', !!service)
  const prefsPane = service?.closest('div[style*="max-width"]')
  r = await window.axe.run(prefsPane ?? document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }, resultTypes: ['violations'] })
  t.check('which passes axe', r.violations.length === 0, r.violations.map((v) => v.id + ': ' + v.nodes.slice(0, 2).map((n) => n.html.slice(0, 100)).join(' / ')).join(' || '))
}
