// Every analysis tool: clicking a number shows what it counts. A cell's
// click shows exactly its number of results. A total adds up its rows (a
// passage two rows count is counted twice: the user's choice), so its click
// shows at most its number, and some.

async function spec(t) {
  const queries = await t.module('stores/query-store')
  const qs = queries.useQueryStore
  const docs = (await t.module('stores/document-store')).useDocumentStore
  const codes = (await t.module('stores/code-store')).useCodeStore
  const tags = (await t.module('stores/tag-store')).useTagStore
  const tabs = (await t.module('stores/analysis-tabs-store')).useAnalysisTabsStore
  const tabIds = await t.module('utils/tab-ids')
  const { emptyDocumentFilter } = await t.module('utils/document-graph')

  const code = (name) => codes.getState().flatCodes().find((c) => c.name === name).guid
  const allCodes = ['Money', 'Debt', 'Rent', 'Wellbeing', 'Belonging'].map(code)
  const tag = (name) => tags.getState().tags.find((x) => x.name === name)
  const survey = docs.getState().sources.find((s) => s.sourceType === 'survey')
  const surveyData = survey.formatData.survey
  const openQuestion = surveyData.questions.find((q) => q.type === 'open-ended')
  const category = tags.getState().categories.find((c) => c.name === 'Student type').guid
  const folder = docs.getState().folders.find((f) => f.name === 'Round 1').guid
  const saved = (name) => qs.getState().savedQueries.find((q) => q.name === name).guid
  const filteredByDomestic = { docFilter: { ...emptyDocumentFilter(), tagGuids: [tag('Domestic').guid] } }
  const groupedByType = { groupBy: [{ kind: 'category', categoryGuid: category }] }

  let n = 0
  async function open(toolType, config) {
    const tabId = tabIds.makeAnalysisTabId(toolType, 'e2e-' + n++)
    tabs.getState().add(tabId, { toolType, title: toolType, config, poppedOut: false })
    docs.getState().openToolTab(tabId)
    await t.sleep(2500)
    // The tool's panel: its heading's container.
    const headings = [...document.querySelectorAll('h2')].filter(t.visible)
    let root = headings[headings.length - 1]
    while (root && root.offsetHeight < 300) root = root.parentElement
    return root
  }

  /** Run a click, and the query it starts; the number of results, or -1 if none ran. */
  async function resultsOf(click) {
    qs.getState().clearQuery()
    await t.sleep(50)
    click()
    // As long as the query takes: a busy computer (and a debug build) can
    // take well over the usual second.
    const ran = await t.until(() => { const s = qs.getState(); return s.isActive && !s.isLoading }, 60000)
    return ran ? qs.getState().results.length : -1
  }

  /** Whether a table cell is a total: its row's or column's heading says so. */
  function isTotal(el) {
    const td = el.closest('td')
    if (!td) return false
    const tr = td.parentElement
    if (/^Total/.test(tr.firstElementChild?.textContent.trim() ?? '')) return true
    const table = td.closest('table')
    let col = 0
    for (const c of tr.children) { if (c === td) break; col += c.colSpan || 1 }
    const headRow = table?.querySelector('thead tr:last-child')
    let at = 0
    for (const th of headRow ? headRow.children : []) {
      const span = th.colSpan || 1
      if (col >= at && col < at + span) return /^Total/.test(th.textContent.trim())
      at += span
    }
    return false
  }

  /** Click every clickable number in a tool, one at a time (finding them
   *  afresh each time, as a click may redraw the table). */
  async function everyNumber(label, root) {
    const numbers = () => [...root.querySelectorAll('*')].filter((e) =>
      e.children.length === 0 && t.visible(e) && !e.closest('button') &&
      /^[0-9]+$/.test(e.textContent.trim()) && Number(e.textContent.trim()) > 0 &&
      (getComputedStyle(e).cursor === 'pointer' || getComputedStyle(e.parentElement).cursor === 'pointer'))
    // The table may still be filling in (its counts come from queries).
    await t.until(() => numbers().length > 0, 30000)
    const count = numbers().length
    let cells = 0, totals = 0
    const wrong = []
    for (let k = 0; k < count; k++) {
      const el = numbers()[k]
      if (!el) break
      const want = Number(el.textContent.trim())
      const total = isTotal(el)
      const target = getComputedStyle(el).cursor === 'pointer' ? el : el.parentElement
      const got = await resultsOf(() => t.press(target))
      const ok = total ? got > 0 && got <= want : got === want
      if (total) totals++; else cells++
      if (!ok) wrong.push(`${total ? 'total ' : ''}${want}→${got} [${el.closest('tr')?.firstElementChild?.textContent.trim().slice(0, 24) ?? ''}]`)
    }
    t.check(`${label}: every number shows what it counts`, count > 0 && wrong.length === 0,
      `${cells} cells, ${totals} totals${wrong.length ? '; wrong: ' + wrong.slice(0, 8).join(' | ') : ''}`)
  }

  const setups = { plain: {}, 'filtered by Domestic': filteredByDomestic, 'grouped by Student type': groupedByType }
  for (const [name, extra] of Object.entries(setups)) {
    await everyNumber(`Codes in Documents, ${name}`, await open('codes-in-documents', { codeGuids: allCodes, ...extra }))
  }
  for (const [name, extra] of Object.entries({ plain: {}, 'filtered by Domestic': filteredByDomestic })) {
    await everyNumber(`Code Co-Occurrences, ${name}`, await open('code-cooccurrences', { rowCodeGuids: allCodes, colCodeGuids: allCodes, ...extra }))
    await everyNumber(`Word Frequencies, ${name}`, await open('word-frequencies', { ...extra }))
  }
  await everyNumber('Results in Documents', await open('results-in-documents', { queryGuids: [saved('Money talk'), saved('Domestic wellbeing')] }))
  await everyNumber('Results in Documents, grouped by Student type', await open('results-in-documents', { queryGuids: [saved('Money talk')], ...groupedByType }))

  // Word Combinations: its phrases and associations are table rows.
  async function everyRow(label, root, selector) {
    const rows = () => [...root.querySelectorAll(selector)].filter(t.visible)
    const count = rows().length
    const wrong = []
    for (let k = 0; k < count; k++) {
      const row = rows()[k]
      const want = Number(row.children[1].textContent.trim())
      const got = await resultsOf(() => t.press(row.children[1]))
      if (got !== want) wrong.push(`${row.children[0].textContent.trim()} ${want}→${got}`)
    }
    t.check(`${label}: every row shows what it counts`, count > 0 && wrong.length === 0, `${count} rows${wrong.length ? '; wrong: ' + wrong.join(' | ') : ''}`)
  }
  await everyRow('Word Combinations, phrases', await open('word-combinations', {}), 'tr[title^="Search for"]')
  // Associations need a word that shares sentences with others more often
  // than chance; in a project this small, try a few.
  let associated = false
  for (const word of ['alone', 'rent', 'students', 'friends', 'feel']) {
    const root = await open('word-combinations', { view: 'associations', focusWord: word, minTogether: 1 })
    if (![...root.querySelectorAll('tr[title^="Find"]')].some(t.visible)) continue
    await everyRow(`Word Combinations, associations with "${word}"`, root, 'tr[title^="Find"]')
    associated = true
    break
  }
  t.check('Word Combinations: some word has associations to check', associated)

  // Framework Matrix: a cell's query runs when it's focused.
  const fm = await open('framework-matrix', {
    codeGuids: allCodes, summaries: {}, collapsed: [],
    rows: [
      ...docs.getState().sources.map((s) => ({ kind: 'doc', sourceGuid: s.guid })),
      { kind: 'tag', tagGuid: tag('Domestic').guid },
      { kind: 'category', categoryGuid: category },
      { kind: 'folder', folderGuid: folder },
      { kind: 'respondent', sourceGuid: survey.guid, respondentId: surveyData.respondents[1].id },
      { kind: 'question', sourceGuid: survey.guid, questionId: openQuestion.id }
    ]
  })
  const fmCells = () => [...fm.querySelectorAll('td')].filter((td) => t.visible(td) && td.querySelector('textarea'))
  const fmCount = fmCells().length
  const fmWrong = []
  let fmCoded = 0
  for (let k = 0; k < fmCount; k++) {
    const td = fmCells()[k]
    const shown = [...td.querySelectorAll('*')].find((e) => e.children.length === 0 && /^[0-9]+$/.test(e.textContent.trim()))
    const want = shown ? Number(shown.textContent.trim()) : 0
    if (want > 0) fmCoded++
    const got = await resultsOf(() => td.querySelector('textarea').focus())
    if (Math.max(got, 0) !== want) fmWrong.push(`${td.closest('tr')?.firstElementChild?.textContent.trim().slice(0, 20)} ${want}→${got}`)
    document.activeElement?.blur()
  }
  t.check('Framework Matrix: every cell shows what it counts', fmCount > 0 && fmCoded > 0 && fmWrong.length === 0,
    `${fmCount} cells (${fmCoded} coded)${fmWrong.length ? '; wrong: ' + fmWrong.slice(0, 8).join(' | ') : ''}`)

  // Code Frequencies shows percentages: each bar's click finds the code.
  const cf = await open('code-frequencies', { codeGuids: allCodes, ...groupedByType })
  const viz = [...cf.querySelectorAll('button')].find((b) => /chart|visual/i.test(b.textContent + (b.title || '')))
  if (viz) { t.press(viz); await t.sleep(800) }
  const bars = [...cf.querySelectorAll('rect')].filter((r) => r.style.cursor === 'pointer')
  let barsOk = 0
  for (const bar of bars.slice(0, 12)) {
    const got = await resultsOf(() => bar.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    if (got > 0) barsOk++
  }
  t.check('Code Frequencies: a grouped bar’s click finds the code there', bars.length > 0 && barsOk === Math.min(bars.length, 12), `${barsOk} of ${Math.min(bars.length, 12)} bars`)
}
