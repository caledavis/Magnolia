// Every kind of Query Builder box passes axe (its controls are named).

async function spec(t) {
  await new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = location.origin + '/@fs__E2E_ROOT__/node_modules/axe-core/axe.min.js'; s.onload = resolve; s.onerror = reject; document.head.appendChild(s) })
  const docs = (await t.module('stores/document-store')).useDocumentStore
  const tabs = (await t.module('stores/analysis-tabs-store')).useAnalysisTabsStore
  const tabIds = await t.module('utils/tab-ids')
  const mod = navigator.platform.startsWith('Mac') ? { metaKey: true } : { ctrlKey: true }
  const key = (k, o = {}) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }))
  const id = tabIds.makeAnalysisTabId('query-builder', 'qb2')
  tabs.getState().add(id, { toolType: 'query-builder', title: 'QB', config: {}, poppedOut: false })
  docs.getState().openToolTab(id)
  const canvas = await t.until(() => [...document.querySelectorAll('[data-drop-zone][aria-label="Query"]')].find(t.visible), 8000)
  const root = canvas.parentElement
  const palette = [...root.querySelectorAll('button')].filter((b) => t.visible(b) && !canvas.contains(b) && b.getBoundingClientRect().bottom <= canvas.getBoundingClientRect().top)
  for (const b of palette) { b.click(); await t.sleep(80) }
  // A code with subcodes (Money), for its checkbox.
  const money = [...document.querySelectorAll('[role="tree"][aria-label="Codes"] [role="treeitem"]')].find((r) => /Money/.test(r.textContent))
  money.focus(); key('c', mod); canvas.focus(); key('v', mod)
  await t.sleep(600)
  t.log('boxes: ' + [...canvas.querySelectorAll('[data-query-node]')].map((b) => b.getAttribute('aria-label')).join(' | '))
  const r = await window.axe.run(root, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }, resultTypes: ['violations'] })
  t.check('every Query Builder box passes axe', r.violations.length === 0, r.violations.map((v) => v.id + ': ' + v.nodes.slice(0, 3).map((n) => n.html.slice(0, 100)).join(' / ')).join(' || '))
}
