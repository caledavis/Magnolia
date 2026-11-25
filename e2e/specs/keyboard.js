// Magnolia can be used without a mouse: the documents and codes lists are
// trees the arrow keys move through, Enter opens, Space selects, and
// Shift+F10 opens the right-click menu, which the arrow keys, Enter and
// Escape work. Focus comes back where it was when a menu closes.

async function spec(t) {
  const docs = (await t.module('stores/document-store')).useDocumentStore
  const key = (k, opts = {}) => {
    const target = document.activeElement
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }))
  }
  const tree = (label) => document.querySelector(`[role="tree"][aria-label="${label}"]`)
  const focused = () => document.activeElement

  // ── Documents ──
  const docTree = tree('Documents')
  t.check('the documents list is a tree', !!docTree)
  const rows = [...docTree.querySelectorAll('[role="treeitem"]')]
  t.check('one row is in the Tab order', rows.filter((r) => r.tabIndex === 0).length === 1)
  rows.find((r) => r.tabIndex === 0).focus()
  // Down to a document row, then open it with Enter.
  let guard = 0
  while (!focused().dataset.documentGuid && guard++ < 30) key('ArrowDown')
  const guid = focused().dataset.documentGuid
  t.check('↓ reaches a document', !!guid)
  key('Enter')
  t.check('Enter opens it', !!(await t.until(() => docs.getState().viewedDocumentGuid === guid, 5000)))
  const before = focused()
  key('ArrowUp')
  t.check('↑ moves to the row above', focused() !== before && focused().getAttribute('role') === 'treeitem')

  // ── Codes ──
  const codeTree = tree('Codes')
  t.check('the codes list is a tree', !!codeTree)
  const first = codeTree.querySelector('[role="treeitem"][tabindex="0"]')
  first.focus()
  key(' ')
  t.check('Space selects the code', !!(await t.until(() => first.getAttribute('aria-selected') === 'true', 3000)))
  const parent = [...codeTree.querySelectorAll('[role="treeitem"][aria-expanded]')][0]
  if (parent) {
    parent.focus()
    const was = parent.getAttribute('aria-expanded')
    key(was === 'true' ? 'ArrowLeft' : 'ArrowRight')
    t.check('← → fold and unfold a code', !!(await t.until(() => parent.getAttribute('aria-expanded') !== was, 3000)))
    key(was === 'true' ? 'ArrowRight' : 'ArrowLeft')
  }

  // ── Its menu ──
  first.focus()
  key('F10', { shiftKey: true })
  const menu = await t.until(() => document.querySelector('.context-menu[role="menu"]'), 3000)
  t.check('Shift+F10 opens the code’s menu, as a menu', !!menu)
  if (menu) {
    t.check('focus is on its first item', !!(await t.until(() => focused()?.getAttribute('role') === 'menuitem', 3000)))
    const firstItem = focused()
    key('ArrowDown')
    t.check('↓ moves to the next item', focused() !== firstItem && focused()?.getAttribute('role') === 'menuitem')
    key('Escape')
    t.check('Escape closes it', !!(await t.until(() => !document.querySelector('.context-menu'), 3000)))
    t.check('and focus is back on the code', !!(await t.until(() => focused() === first, 3000)))
  }

  // ── The other panes ──
  for (const label of ['Tags', 'Saved Memos', 'Saved Quotes', 'Queries', 'Saved Analyses']) {
    const pane = tree(label)
    // An empty pane isn't a tree (it has no rows).
    if (!pane) { t.log(`${label}: empty`); continue }
    const rows = [...pane.querySelectorAll('[role="treeitem"]')].filter((r) => r.offsetParent !== null)
    t.check(`the ${label} pane is a tree, one row in the Tab order`, rows.length === 0 || rows.filter((r) => r.tabIndex === 0).length === 1, `${rows.length} rows`)
  }

  // ── Document tabs ──
  const sources = docs.getState().sources
  docs.getState().viewDocument(sources[0].guid)
  docs.getState().viewDocument(sources[1].guid)
  await t.sleep(500)
  const tablist = document.querySelector('[role="tablist"][aria-label="Open documents"]')
  t.check('the open documents are a tab list', !!tablist)
  const active = tablist?.querySelector('[role="tab"][aria-selected="true"]')
  t.check('the open one is the tab in the Tab order', !!active && active.tabIndex === 0)
  if (active) {
    active.focus()
    const was = docs.getState().viewedDocumentGuid
    key('ArrowLeft')
    t.check('← opens the tab before it', !!(await t.until(() => docs.getState().viewedDocumentGuid !== was, 3000)))
    t.check('and takes the focus', !!(await t.until(() => focused()?.getAttribute('aria-selected') === 'true', 3000)))
  }

  // ── An analysis table ──
  const tabs = (await t.module('stores/analysis-tabs-store')).useAnalysisTabsStore
  const tabIds = await t.module('utils/tab-ids')
  const codes = (await t.module('stores/code-store')).useCodeStore
  const id = tabIds.makeAnalysisTabId('codes-in-documents', 'keys')
  tabs.getState().add(id, { toolType: 'codes-in-documents', title: 'Codes in Documents', config: { codeGuids: codes.getState().flatCodes().map((c) => c.guid) }, poppedOut: false })
  docs.getState().openToolTab(id)
  const grid = await t.until(() => [...document.querySelectorAll('[role="grid"]')].find((g) => t.visible(g)), 15000)
  t.check('Codes in Documents is a grid', !!grid)
  if (grid) {
    const cells = grid.querySelectorAll('[data-grid-cell]')
    t.check('one of its cells is in the Tab order', [...cells].filter((c) => c.tabIndex === 0).length === 1, `${cells.length} cells`)
    const start = [...cells].find((c) => c.tabIndex === 0)
    start.focus()
    key('ArrowRight')
    t.check('→ moves to the next cell', focused() !== start && focused()?.hasAttribute('data-grid-cell'))
    key('ArrowDown')
    t.check('↓ moves down a row', focused()?.hasAttribute('data-grid-cell') && focused().closest('tr') !== start.closest('tr'))
  }
}
