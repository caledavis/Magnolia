// A saved query in a report finds what the Query panel finds: the same run
// (runQueryLive), so "include subcodes" includes them (reports once found
// only the parent code's passages).

async function spec(t) {
  const qs = (await t.module('stores/query-store'))
  const codes = (await t.module('stores/code-store')).useCodeStore
  const rq = await t.module('components/Analysis/report-query')
  const money = codes.getState().flatCodes().find((c) => c.name === 'Money')
  const q = { documentFilter: {}, codeCondition: { type: 'code', codeGuid: money.guid, includeSubcodes: true } }
  qs.useQueryStore.setState((s) => ({ savedQueries: [...s.savedQueries, { guid: 'test-sub', name: 'Money and subcodes', query: q }] }))
  const live = qs.runQueryLive(q).results.length
  const html = rq.renderQueryItemHtml('test-sub', 'a')
  const inReport = (html.match(/class="q-result"/g) || []).length
  t.log(`Query panel: ${live} results; report: ${inReport}`)
  t.check('a report finds what the Query panel finds (subcodes included)', live === inReport && live > 0, `${live} vs ${inReport}`)
}
