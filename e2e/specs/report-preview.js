// The Reports tab shows the report as it will be exported beside its
// builder (GitHub #38): it updates as the report changes, its text can be
// selected and copied, and it can be hidden and shown again.

async function spec(t) {
  await new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = location.origin + '/@fs__E2E_ROOT__/node_modules/axe-core/axe.min.js'; s.onload = resolve; s.onerror = reject; document.head.appendChild(s) })
  const docs = (await t.module('stores/document-store')).useDocumentStore
  const tabs = (await t.module('stores/analysis-tabs-store')).useAnalysisTabsStore
  const tabIds = await t.module('utils/tab-ids')
  const id = tabIds.makeAnalysisTabId('reports', 'preview')
  tabs.getState().add(id, { toolType: 'reports', title: 'Report', config: { items: [{ id: 's', kind: 'section', title: 'Findings' }, { id: 'a', kind: 'text', content: 'hola' }] }, poppedOut: false })
  docs.getState().openToolTab(id)
  await t.call('automation_set_size', { width: 1400, height: 900 })
  const pane = await t.until(() => [...document.querySelectorAll('[role="region"][aria-label="Preview"]')].find(t.visible), 8000)
  t.check('the Reports tab has a preview', !!pane)
  const page = () => pane.querySelector('.rp-body')
  const text = () => page()?.textContent ?? ''
  t.check('it shows the report', !!(await t.until(() => /Findings/.test(text()) && /hola/.test(text()), 8000)), text().slice(0, 120))

  // Edit the text block: the preview follows.
  const editor = [...document.querySelectorAll('.ProseMirror')].find((e) => t.visible(e) && /hola/.test(e.textContent))
  if (editor) {
    editor.focus()
    const r = document.createRange(); r.selectNodeContents(editor); r.collapse(false)
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r)
    document.execCommand('insertText', false, ', mundo')
  }
  { const b = pane.parentElement.firstElementChild.getBoundingClientRect(); const l = [...document.querySelectorAll('span')].find((x) => x.textContent === 'Drag to add:' || /drag/i.test(x.textContent))?.parentElement.getBoundingClientRect(); t.check('its bar lines up with the builder\'s', b.top === l?.top && b.height === l?.height, `preview ${b.top}/${b.height}, builder ${l?.top}/${l?.height}`) }
  t.check('and follows changes to it', !!(await t.until(() => /hola, mundo/.test(text()), 8000)))

  // Its text can be selected (to copy into a word processor).
  const para = [...page().querySelectorAll('*')].find((e) => e.children.length === 0 && /hola, mundo/.test(e.textContent))
  const range = document.createRange(); range.selectNodeContents(para)
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range)
  t.check('its text can be selected', /hola, mundo/.test(sel.toString()), sel.toString())
  sel.removeAllRanges()

  const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }, resultTypes: ['violations'] })
  t.check('the tab passes axe', r.violations.length === 0, r.violations.map((v) => v.id + ' x' + v.nodes.length + ': ' + v.nodes.slice(0, 4).map((n) => n.html.slice(0, 140) + ' [' + ((n.any[0]||{}).data ? JSON.stringify((n.any[0]||{}).data).slice(0,120) : '') + ']').join(' / ')).join(' || '))

  const button = [...document.querySelectorAll('button')].find((b) => t.visible(b) && b.textContent.trim() === 'Hide Preview')
  button.click()
  t.check('Hide Preview hides it', !!(await t.until(() => !document.querySelector('[role="region"][aria-label="Preview"]'), 3000)))
  ;[...document.querySelectorAll('button')].find((b) => t.visible(b) && b.textContent.trim() === 'Show Preview').click()
  t.check('Show Preview brings it back', !!(await t.until(() => document.querySelector('[role="region"][aria-label="Preview"]'), 3000)))
}
