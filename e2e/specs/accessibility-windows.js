// The pop-out windows (Codebook, Memos, Logbook, Query Results) pass
// axe-core's automatic accessibility checks (WCAG 2.1 A and AA) in each
// of the three themes, as the main window does (accessibility.js). Each
// runs axe itself and leaves its result in localStorage, which the
// windows share, for this spec to report.

async function spec(t) {
  const docs = (await t.module('stores/document-store')).useDocumentStore
  const queries = (await t.module('stores/query-store')).useQueryStore
  const codes = (await t.module('stores/code-store')).useCodeStore
  const logbook = (await t.module('stores/logbook-store')).useLogbookStore
  const press = (title) => {
    const b = [...document.querySelectorAll('button')].find((el) => t.visible(el) && (el.title === title || el.getAttribute('aria-label') === title))
    if (b) t.press(b)
    return !!b
  }

  // Open each window.
  // As the ribbon's Codebook and Memos buttons do.
  const other = await t.module('app/other-windows')
  other.sendCodebookData()
  window.api.openMemosWindow(other.memosWindowData())
  window.api.openLogbookWindow({ entries: logbook.getState().entries, theme: document.documentElement.getAttribute('data-theme') || '' })
  const money = codes.getState().flatCodes().find((c) => c.name === 'Money')
  queries.getState().setComplexQuery({ documentFilter: {}, codeCondition: { type: 'code', codeGuid: money.guid, includeSubcodes: true } })
  await t.until(() => { const s = queries.getState(); return s.isActive && !s.isLoading }, 10000)
  await t.sleep(500)
  t.check('Query Results pops out', press('Open query results in a separate window'))
  await t.sleep(4000)

  const labels = ['codebook', 'memos', 'logbook', 'query-results']
  for (const label of labels) localStorage.removeItem('e2e-axe:' + label)
  const script = (label) => `(async () => {
    const done = (r) => localStorage.setItem('e2e-axe:${label}', JSON.stringify(r))
    try {
      await new Promise((ok, no) => { const s = document.createElement('script'); s.src = location.origin + '/@fs__E2E_ROOT__/node_modules/axe-core/axe.min.js'; s.onload = ok; s.onerror = no; document.head.appendChild(s) })
      const still = document.createElement('style')
      still.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }'
      document.head.appendChild(still)
      const found = []
      for (const theme of ['magnolia', 'magnolia-dark', 'high-contrast']) {
        document.documentElement.setAttribute('data-theme', theme)
        await new Promise((r) => setTimeout(r, 600))
        const res = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] })
        for (const v of res.violations) for (const n of v.nodes.slice(0, 3)) {
          const d = (n.any[0] || {}).data || {}
          found.push(theme + ' ' + v.id + ': ' + n.html.slice(0, 120) + (d.contrastRatio ? ' (' + d.fgColor + ' on ' + d.bgColor + ', ' + d.contrastRatio + ')' : '') + ' ×' + v.nodes.length)
        }
      }
      done({ ok: true, found })
    } catch (e) { done({ ok: false, error: String(e) }) }
  })()`
  for (const label of labels) {
    try { await t.call('automation_eval', { label, script: script(label) }) } catch (e) { t.log(`${label}: ${e}`) }
  }
  for (const label of labels) {
    const raw = await t.until(() => localStorage.getItem('e2e-axe:' + label), 60000, 200)
    const r = raw ? JSON.parse(raw) : null
    if (r?.found) for (const f of r.found) t.log(`  ${label}: ${f}`)
    t.check(`the ${label} window passes axe in every theme`, !!r && r.ok && r.found.length === 0, r ? (r.error || `${r.found.length} findings: ${r.found.join(' | ').slice(0, 1200)}`) : 'no result')
  }
}
