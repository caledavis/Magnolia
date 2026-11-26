// A relationship map's free-text note from the keyboard: it takes the focus
// (named by its text), the arrows move it, Enter edits it, Escape gives the
// keyboard back to it, and its menu deletes it.

async function spec(t) {
  const docs = (await t.module('stores/document-store')).useDocumentStore
  const maps = (await t.module('stores/relationship-map-store')).useRelationshipMapStore
  const tabIds = await t.module('utils/tab-ids')
  const key = (k, o = {}) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }))
  const guid = maps.getState().createNewMap()
  maps.getState().setFreeTexts(guid, [{ id: 'ft1', kind: 'freetext', x: 100, y: 100, width: 200, height: 60, content: 'A note on money' }])
  docs.getState().openToolTab(tabIds.makeMapTabId(guid))
  const note = await t.until(() => [...document.querySelectorAll('[data-free-text]')].find(t.visible), 8000)
  t.check('the note can take the focus, and is named', !!note && note.tabIndex === 0 && note.getAttribute('aria-label') === 'A note on money', note?.getAttribute('aria-label'))
  note.focus()
  key('ArrowRight', { shiftKey: true })
  t.check('Shift+→ moves it', !!(await t.until(() => maps.getState().maps[guid].freeTexts[0].x === 150, 2000)), String(maps.getState().maps[guid].freeTexts[0].x))
  key('Enter')
  t.check('Enter edits it', !!(await t.until(() => document.activeElement?.closest('.ProseMirror'), 3000)))
  // As a person would: a moment after editing starts (the editor settles).
  await t.sleep(400)
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  t.check('Escape stops, and the keyboard is back on the note', !!(await t.until(() => document.activeElement?.hasAttribute('data-free-text'), 8000)), document.activeElement?.outerHTML.slice(0, 80))
  key('F10', { shiftKey: true })
  const menu = await t.until(() => document.querySelector('.context-menu[role="menu"]'), 3000)
  const items = menu ? [...menu.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent) : []
  t.check('its menu has no Add Memo, and Delete', !items.includes('Add Memo') && items.includes('Delete'), items.join(' | '))
  const del = menu && [...menu.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent === 'Delete')
  if (del) { del.focus(); key('Enter') }
  t.check('Delete from the menu deletes it', !!(await t.until(() => maps.getState().maps[guid].freeTexts.length === 0, 3000)))
}
