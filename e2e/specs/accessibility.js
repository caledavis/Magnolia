// The main views pass axe-core's automatic accessibility checks (WCAG 2.1
// A and AA): a text document, the survey, an analysis tool and the Query
// Builder. axe finds what the markup shows (roles, names, contrast); it
// can't tell a clickable div should have been a button.

async function spec(t) {
  await new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = location.origin + '/@fs__E2E_ROOT__/node_modules/axe-core/axe.min.js'
    s.onload = resolve
    s.onerror = () => reject(new Error('axe did not load'))
    document.head.appendChild(s)
  })
  const docs = (await t.module('stores/document-store')).useDocumentStore
  const tabs = (await t.module('stores/analysis-tabs-store')).useAnalysisTabsStore
  const tabIds = await t.module('utils/tab-ids')
  const all = {}
  const scan = async (view) => {
    await t.sleep(1500)
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] })
    for (const v of r.violations) {
      const e = (all[v.id] = all[v.id] || { impact: v.impact, help: v.help, views: new Set(), count: 0, samples: [] })
      e.views.add(view)
      e.count += v.nodes.length
      for (const n of v.nodes.slice(0, 3)) if (e.samples.length < 4) e.samples.push(n.html.slice(0, 140))
    }
  }
  const text = docs.getState().sources.find((s) => (s.sourceType ?? 'text') === 'text')
  docs.getState().viewDocument(text.guid)
  await scan('text document')
  const survey = docs.getState().sources.find((s) => s.sourceType === 'survey')
  if (survey) { docs.getState().viewDocument(survey.guid); await scan('survey') }
  const id = tabIds.makeAnalysisTabId('code-frequencies', 'axe')
  tabs.getState().add(id, { toolType: 'code-frequencies', title: 'Code Frequencies', config: {}, poppedOut: false })
  docs.getState().openToolTab(id)
  await scan('Code Frequencies')
  const q = tabIds.makeAnalysisTabId('query-builder', 'axe')
  tabs.getState().add(q, { toolType: 'query-builder', title: 'Query', config: {}, poppedOut: false })
  docs.getState().openToolTab(q)
  await scan('Query Builder')
  const rules = Object.entries(all).sort((a, b) => b[1].count - a[1].count)
  for (const [id, e] of rules) {
    t.log(`RULE ${id} [${e.impact}] ×${e.count} in ${[...e.views].join(', ')} — ${e.help}`)
    for (const s of e.samples) t.log('    ' + s)
  }
  t.check('no accessibility violations axe can find', rules.length === 0, rules.map(([id, e]) => `${id} ×${e.count}`).join(', '))
}
