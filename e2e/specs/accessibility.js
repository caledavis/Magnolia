// The main window's views pass axe-core's automatic accessibility checks
// (WCAG 2.1 A and AA) in each of the three themes: a text document, the
// survey, analysis tools, the Query Builder, and a document's and a code's
// right-click menus. axe finds what the markup shows (roles, names,
// contrast); it can't tell a clickable div should have been a button —
// specs/keyboard.js drives the app by keyboard for that.

async function spec(t) {
  await new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = location.origin + '/@fs__E2E_ROOT__/node_modules/axe-core/axe.min.js'
    s.onload = resolve
    s.onerror = () => reject(new Error('axe did not load'))
    document.head.appendChild(s)
  })
  // Judge everything settled, not part-way through a fade (contrast).
  const still = document.createElement('style')
  still.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }'
  document.head.appendChild(still)

  // A small window, as on the build machines: more panes overflow and scroll.
  await t.call('automation_set_size', { width: 1100, height: 720 })
  await t.sleep(800)
  const docs = (await t.module('stores/document-store')).useDocumentStore
  const tabs = (await t.module('stores/analysis-tabs-store')).useAnalysisTabsStore
  const codes = (await t.module('stores/code-store')).useCodeStore
  const tabIds = await t.module('utils/tab-ids')
  const allCodes = codes.getState().flatCodes().map((c) => c.guid)
  let n = 0
  const tool = (toolType, config) => () => {
    const id = tabIds.makeAnalysisTabId(toolType, 'axe' + n++)
    tabs.getState().add(id, { toolType, title: toolType, config, poppedOut: false })
    docs.getState().openToolTab(id)
  }
  const menuOn = (find) => () => {
    const el = find()
    const r = el.getBoundingClientRect()
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 20, clientY: r.top + 5 }))
  }
  const closeMenu = () => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  const views = [
    ['text document', () => docs.getState().viewDocument(docs.getState().sources.find((s) => (s.sourceType ?? 'text') === 'text').guid)],
    ['a document’s menu', menuOn(() => document.querySelector('[data-document-guid][role="treeitem"]')), closeMenu],
    ['a code’s menu', menuOn(() => document.querySelector('[role="tree"][aria-label="Codes"] [role="treeitem"]')), closeMenu],
    ['survey', () => docs.getState().viewDocument(docs.getState().sources.find((s) => s.sourceType === 'survey').guid)],
    ['Codes in Documents', tool('codes-in-documents', { codeGuids: allCodes })],
    ['Code Frequencies', tool('code-frequencies', { codeGuids: allCodes })],
    ['Code Co-Occurrences', tool('code-cooccurrences', { rowCodeGuids: allCodes, colCodeGuids: allCodes })],
    ['Word Frequencies', tool('word-frequencies', {})],
    ['Framework Matrix', tool('framework-matrix', { codeGuids: allCodes, summaries: {}, collapsed: [], rows: docs.getState().sources.slice(0, 2).map((s) => ({ kind: 'doc', sourceGuid: s.guid })) })],
    ['Query Builder', tool('query-builder', {})]
  ]

  const all = {}
  for (const theme of ['magnolia', 'magnolia-dark', 'high-contrast']) {
    document.documentElement.setAttribute('data-theme', theme)
    for (const [view, open, after] of views) {
      open()
      await t.sleep(1200)
      const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] })
      for (const v of r.violations) {
        const e = (all[v.id] = all[v.id] || { impact: v.impact, help: v.help, where: new Set(), count: 0, samples: [] })
        e.where.add(`${view} (${theme})`)
        e.count += v.nodes.length
        for (const node of v.nodes.slice(0, 2)) {
          if (e.samples.length < 6) e.samples.push(`[${theme}] ` + node.html.slice(0, 130) + (node.failureSummary ? ' — ' + node.failureSummary.replace(/\s+/g, ' ').slice(0, 170) : ''))
        }
      }
      if (after) { after(); await t.sleep(200) }
    }
  }
  const rules = Object.entries(all).sort((a, b) => b[1].count - a[1].count)
  for (const [id, e] of rules) {
    t.log(`RULE ${id} [${e.impact}] ×${e.count} — ${e.help}`)
    t.log('    in ' + [...e.where].slice(0, 8).join('; '))
    for (const s of e.samples) t.log('    ' + s)
  }
  t.check('no accessibility violations axe can find, in any theme', rules.length === 0, rules.map(([id, e]) => `${id} ×${e.count}: ${e.samples.slice(0, 3).join(' | ')}`).join(' || ').slice(0, 1500))
}
