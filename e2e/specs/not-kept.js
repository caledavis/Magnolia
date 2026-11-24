// A project holding something Magnolia can't keep says so when it opens,
// and offers to save the work as a new file.

async function spec(t) {
  const banner = () => [...document.querySelectorAll('[role="alert"]')].find((e) => /can.t be kept in Magnolia/.test(e.innerText))
  const shown = await t.until(banner, 10000)
  t.check('the user is told what can’t be kept', !!shown && /1 link between two items/.test(shown.innerText), shown && shown.innerText)
  const buttons = shown ? [...shown.querySelectorAll('button')].map((b) => b.textContent) : []
  t.check('and offered Save As', buttons.includes('Save As…'), buttons.join(', '))
  t.press([...shown.querySelectorAll('button')].find((b) => b.textContent === 'OK'))
  t.check('the notice can be put away', !!(await t.until(() => !banner(), 5000)))
}
