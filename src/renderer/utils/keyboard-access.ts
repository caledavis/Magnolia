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
 *
 * Dragging, from the keyboard: Cmd/Ctrl+C on something that can be dragged
 * (a code, a document, a tag, a query: whatever is selected with it) picks
 * it up; Cmd/Ctrl+V on where it could be dropped (a tool's drop area, a
 * document, a folder, a code, a text) puts it there; Escape puts it down.
 * Both run the drag's own handlers (dragstart on the item, then dragenter,
 * dragover and drop on the target, dragend on the item), so the result is
 * exactly a drag's. A screen reader hears what was picked up and whether
 * it was accepted. Copying text (a selection, a field) is left alone.
 */
import { i18n } from '../i18n'
import { isMac } from './platform'

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

// ── Dragging from the keyboard ──

let held: { source: HTMLElement; data: DataTransfer; name: string } | null = null
let liveRegion: HTMLElement | null = null

function announce(message: string): void {
  if (!liveRegion || !liveRegion.isConnected) {
    liveRegion = document.createElement('div')
    liveRegion.setAttribute('aria-live', 'assertive')
    liveRegion.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0'
    document.body.appendChild(liveRegion)
  }
  // Re-set so the same words are said again.
  liveRegion.textContent = ''
  requestAnimationFrame(() => { if (liveRegion) liveRegion.textContent = message })
}

/** Typing or text being copied: the keys are theirs. */
function inText(el: Element | null): boolean {
  if (!el) return false
  if (el.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return true
  const sel = window.getSelection()
  return !!sel && !sel.isCollapsed && sel.toString().trim() !== '' && !(el as HTMLElement).closest('.text-document')
}

function nameOf(el: HTMLElement): string {
  const label = el.getAttribute('aria-label') || el.innerText || el.textContent || ''
  return label.split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 60) ?? ''
}

function dragEvent(type: string, target: HTMLElement, data: DataTransfer): boolean {
  const r = target.getBoundingClientRect()
  // At the middle, where a row takes a drop into itself rather than
  // beside it.
  return target.dispatchEvent(new DragEvent(type, {
    bubbles: true, cancelable: true, dataTransfer: data,
    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2
  }))
}

/** Cmd/Ctrl+C: pick up what has focus, if it can be dragged. */
function pickUp(e: Event): boolean {
  const active = document.activeElement as HTMLElement | null
  if (!active || inText(active)) return false
  const source = active.closest<HTMLElement>('[draggable="true"]')
  if (!source) return false
  const data = new DataTransfer()
  dragEvent('dragstart', source, data)
  if (data.types.length === 0) return false
  e.preventDefault()
  held = { source, data, name: nameOf(source) }
  announce(i18n.t('keys.pickedUp', { name: held.name, paste: isMac ? '⌘V' : 'Ctrl+V' }))
  return true
}

/** Cmd/Ctrl+V: put it on what has focus. */
function putDown(e: Event): boolean {
  const target = document.activeElement as HTMLElement | null
  if (!held || !target || target === document.body || target.closest('input, textarea, select, [contenteditable="true"]')) return false
  e.preventDefault()
  const { source, data, name } = held
  dragEvent('dragenter', target, data)
  dragEvent('dragover', target, data)
  const accepted = !dragEvent('drop', target, data)
  if (source.isConnected) dragEvent('dragend', source, data)
  held = null
  announce(i18n.t(accepted ? 'keys.put' : 'keys.cantPut', { name }))
  return true
}

function onKeyDown(e: KeyboardEvent): void {
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c' && pickUp(e)) return
  if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'v' && putDown(e)) return
  if (e.key === 'Escape' && held && !document.activeElement?.closest(MENU)) {
    held = null
    announce(i18n.t('keys.cancelled'))
  }
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
  // The Edit menu's Copy and Paste (when it takes the keys first, as macOS
  // menus do while they're enabled) arrive as these instead.
  document.addEventListener('copy', (e) => { pickUp(e) }, true)
  document.addEventListener('paste', (e) => { putDown(e) }, true)
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
