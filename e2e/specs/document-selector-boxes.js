// The Document Selector's boxes from the keyboard: every kind passes axe (its
// controls are named), documents pasted onto a Documents box are added, and
// each can be removed by its named button or from the box's menu.

async function spec(t) {
  await new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = location.origin + '/@fs__E2E_ROOT__/node_modules/axe-core/axe.min.js'; s.onload = resolve; s.onerror = reject; document.head.appendChild(s) })
  const docs = (await t.module('stores/document-store')).useDocumentStore
  const tabs = (await t.module('stores/analysis-tabs-store')).useAnalysisTabsStore
  const tabIds = await t.module('utils/tab-ids')
  const mod = navigator.platform.startsWith('Mac') ? { metaKey: true } : { ctrlKey: true }
  const key = (k, o = {}) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }))
  const id = tabIds.makeAnalysisTabId('query-builder', 'ds2')
  tabs.getState().add(id, { toolType: 'query-builder', title: 'QB', config: {}, poppedOut: false })
  docs.getState().openToolTab(id)
  await t.sleep(800)
  const head = [...document.querySelectorAll('[aria-expanded="false"]')].find((b) => t.visible(b) && /from these documents/i.test(b.textContent))
  head?.focus(); key('Enter')
  const canvas = await t.until(() => [...document.querySelectorAll('[data-drop-zone][aria-label="Document selection"]')].find(t.visible), 5000)
  const root = canvas.parentElement.parentElement
  const palette = [...root.querySelectorAll('button')].filter((b) => t.visible(b) && !canvas.contains(b) && b.getBoundingClientRect().bottom <= canvas.getBoundingClientRect().top)
  t.log('palette: ' + palette.map((b) => b.textContent.trim()).join(' | '))
  for (const b of palette) { b.click(); await t.sleep(100) }
  await t.sleep(500)
  const boxes = () => [...canvas.querySelectorAll('[data-selector-node]')]
  t.log('boxes: ' + boxes().map((b) => b.getAttribute('aria-label')).join(' | '))
  const r = await window.axe.run(root, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }, resultTypes: ['violations'] })
  t.check('every box kind passes axe (names on its controls)', r.violations.length === 0, r.violations.map((v) => v.id + ': ' + v.nodes.slice(0, 3).map((n) => n.html.slice(0, 100)).join(' / ')).join(' || '))
  // Documents: paste two onto the Documents box.
  const docsBox = boxes().find((b) => /^[0-9]+ docs?$/.test(b.getAttribute('aria-label')))
  const docRows = [...document.querySelectorAll('[data-document-guid][role="treeitem"]')].slice(0, 2)
  for (const row of docRows) { row.focus(); key('c', mod); docsBox.focus(); key('v', mod); await t.sleep(200) }
  const removeBtns = () => [...docsBox.querySelectorAll('button[aria-label^="Remove"]')]
  t.check('pasting documents onto the box adds them', !!(await t.until(() => removeBtns().length === 2, 3000)), docsBox.textContent.slice(0, 120))
  t.check('each has a named remove button', removeBtns().every((b) => b.getAttribute('aria-label').length > 7), removeBtns().map((b) => b.getAttribute('aria-label')).join(' | '))
  removeBtns()[0].focus(); key('Enter'); removeBtns()[0]?.click()
  t.check('the button removes it', !!(await t.until(() => removeBtns().length === 1, 2000)))
  docsBox.focus(); key('F10', { shiftKey: true })
  const menu = await t.until(() => document.querySelector('.context-menu[role="menu"]'), 3000)
  const item = menu && [...menu.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent.startsWith('Remove '))
  t.check('its menu lists its documents', !!item, menu ? [...menu.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent).join(' | ') : 'no menu')
  if (item) { item.focus(); key('Enter') }
  t.check('and removes one chosen there', !!(await t.until(() => removeBtns().length === 0, 2000)))
}
