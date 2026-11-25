/**
 * Keyboard and screen-reader access to Magnolia's right-click menus, for
 * every window (each entry file imports this once).
 *
 * Every menu is a `.context-menu` of `.context-menu-item`s (and
 * `.context-menu-separator`s). Rather than each of them handling keys, this
 * recognises any such menu when it appears and makes it one:
 *  - it's announced as a menu, its items as menu items;
 *  - focus moves to its first item, and comes back to where it was when the
 *    menu closes;
 *  - ↑ ↓ Home End move between items, Enter or Space chooses one, Escape
 *    or Tab closes it (as a click outside it does, which is how every menu
 *    already closes);
 *  - an item the mouse is over is the focused one, so mouse and keyboard
 *    never disagree about which is current.
 * Shift+F10 (or the context-menu key) opens the menu of what has focus, as
 * a right-click on it would.
 */

const MENU = '.context-menu'
const ITEM = '.context-menu-item'

function items(menu: Element): HTMLElement[] {
  return [...menu.querySelectorAll<HTMLElement>(ITEM)].filter(
    (el) => el.offsetParent !== null && el.getAttribute('aria-disabled') !== 'true'
  )
}

/** Where focus was when each open menu appeared. */
const openers = new WeakMap<Element, HTMLElement | null>()

function enhance(menu: HTMLElement): void {
  if (!menu.hasAttribute('role')) menu.setAttribute('role', 'menu')
  for (const item of menu.querySelectorAll<HTMLElement>(ITEM)) {
    if (!item.hasAttribute('role')) item.setAttribute('role', 'menuitem')
    if (!item.hasAttribute('tabindex')) item.tabIndex = -1
  }
  for (const sep of menu.querySelectorAll<HTMLElement>('.context-menu-separator')) {
    if (!sep.hasAttribute('role')) sep.setAttribute('role', 'separator')
  }
  if (openers.has(menu)) return
  const active = document.activeElement as HTMLElement | null
  openers.set(menu, active && !menu.contains(active) ? active : null)
  // Once it's laid out (it may be positioned after its first render).
  requestAnimationFrame(() => {
    if (!menu.isConnected || menu.contains(document.activeElement)) return
    items(menu)[0]?.focus({ preventScroll: true })
  })
}

function close(menu: Element): void {
  // Every menu closes on a press outside it.
  const outside = document.body
  for (const type of ['mousedown', 'mouseup', 'click'] as const) {
    outside.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
  }
  restoreFocus(menu)
}

function restoreFocus(menu: Element): void {
  const opener = openers.get(menu)
  openers.delete(menu)
  if (opener?.isConnected && (document.activeElement === document.body || document.activeElement === null || menu.contains(document.activeElement))) {
    opener.focus({ preventScroll: true })
  }
}

function onKeyDown(e: KeyboardEvent): void {
  // Open the focused thing's menu, as a right-click would.
  if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
    const target = document.activeElement as HTMLElement | null
    if (!target || target === document.body || target.closest(MENU)) return
    e.preventDefault()
    const r = target.getBoundingClientRect()
    target.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: r.left + Math.min(24, r.width / 2),
      clientY: r.top + r.height / 2
    }))
    return
  }
  const menu = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(MENU)
  if (!menu) return
  const list = items(menu)
  const at = list.indexOf(document.activeElement as HTMLElement)
  const move = (i: number) => {
    e.preventDefault()
    e.stopPropagation()
    list[(i + list.length) % list.length]?.focus({ preventScroll: false })
  }
  switch (e.key) {
    case 'ArrowDown': return move(at + 1)
    case 'ArrowUp': return move(at < 0 ? list.length - 1 : at - 1)
    case 'Home': return move(0)
    case 'End': return move(list.length - 1)
    case 'Enter':
    case ' ':
      if (at >= 0) {
        e.preventDefault()
        e.stopPropagation()
        list[at].click()
        // An item that keeps the menu open (a submenu) keeps focus in it.
        requestAnimationFrame(() => { if (!menu.isConnected) restoreFocus(menu) })
      }
      return
    case 'Escape':
    case 'Tab':
      e.preventDefault()
      e.stopPropagation()
      close(menu)
  }
}

function onMouseOver(e: MouseEvent): void {
  const item = (e.target as Element | null)?.closest?.<HTMLElement>(ITEM)
  if (item && item.closest(MENU) && document.activeElement !== item) item.focus({ preventScroll: true })
}

function scan(root: ParentNode): void {
  if (root instanceof HTMLElement && root.matches(MENU)) enhance(root)
  for (const menu of root.querySelectorAll<HTMLElement>(MENU)) enhance(menu)
  // Items added to a menu already open (a submenu, a filtered list).
  if (root instanceof HTMLElement && root.closest(MENU)) enhance(root.closest<HTMLElement>(MENU)!)
}

function install(): void {
  if ((window as { __keyboardAccess?: boolean }).__keyboardAccess) return
  ;(window as { __keyboardAccess?: boolean }).__keyboardAccess = true
  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('mouseover', onMouseOver, true)
  new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) if (node instanceof HTMLElement) scan(node)
      for (const node of r.removedNodes) {
        if (!(node instanceof HTMLElement)) continue
        const menus = node.matches(MENU) ? [node] : [...node.querySelectorAll(MENU)]
        for (const menu of menus) if (openers.has(menu)) requestAnimationFrame(() => restoreFocus(menu))
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true })
}

install()
