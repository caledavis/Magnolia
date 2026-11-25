// A project holding something Magnolia can't keep says so when it opens
// (a dialog), and offers to save the work as a new file; closed, a pill in
// the toolbar's corner stays and reopens it.

async function spec(t) {
  const banner = () => [...document.querySelectorAll('[role="alertdialog"]')].find((e) => /can.t be kept in Magnolia/.test(e.innerText))
  const shown = await t.until(banner, 10000)
  t.check('the user is told what can’t be kept', !!shown && /1 link between two items/.test(shown.innerText), shown && shown.innerText)
  const buttons = shown ? [...shown.querySelectorAll('button')].map((b) => b.textContent) : []
  t.check('and offered Save As', buttons.includes('Save As…'), buttons.join(', '))
  t.press([...shown.querySelectorAll('button')].find((b) => b.textContent === 'OK'))
  t.check('the notice can be put away', !!(await t.until(() => !banner(), 5000)))
  const pill = [...document.querySelectorAll('.app-toolbar button')].find((b) => b.textContent.trim() === 'Not all kept')
  t.check('a pill stays in the toolbar', !!pill)
  pill?.click()
  t.check('and brings the notice back', !!(await t.until(banner, 5000)))
}
