// Reopened: still the newer Magnolia's file, without the refused edit.

async function spec(t) {
  const project = (await t.module('stores/project-store')).useProjectStore
  const codes = (await t.module('stores/code-store')).useCodeStore
  t.check('it still opens read-only', project.getState().newerFormat === 'Magnolia 9.0.0')
  t.check('the edit wasn’t saved', !codes.getState().flatCodes().some((c) => c.name === 'Not to be saved'))
  t.check('the sample’s codes are all there', codes.getState().flatCodes().length > 0)
}
