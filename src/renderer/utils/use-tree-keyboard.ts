/**
 * Keyboard access to a list or tree of rows (documents, codes, memos…),
 * as the WAI-ARIA tree pattern has it.
 *
 * The container takes the props this returns (the keys), and is a tree
 * (role="tree", named `label`) while it has rows: an empty one isn't;
 * each row is a `role="treeitem"` with `aria-level` (1 for the top), and
 * `aria-expanded` if it has children, whose fold/unfold control is marked
 * `data-tree-toggle`. Rows keep their own mouse handlers: the keys act
 * through them, so a key does exactly what the matching click does.
 *
 *  ↑ ↓ Home End   move between rows
 *  →              unfold, or go to the first child
 *  ←              fold, or go to the parent
 *  Space          select (a click; Shift and ⌘/Ctrl extend it, as clicks do)
 *  Enter          open (a double-click; a click for a row marked
 *                 data-tree-enter="click", such as a folder)
 *  Shift+F10      the row's menu (utils/keyboard-access.ts)
 *
 * One row is in the Tab order at a time: the focused one, else the first
 * selected one, else the first.
 */
import { useCallback, useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from 'react'

const ROW = '[role="treeitem"]'

function rowsOf(tree: HTMLElement): HTMLElement[] {
  return [...tree.querySelectorAll<HTMLElement>(ROW)].filter((r) => r.offsetParent !== null)
}

export function useTreeKeyboard(label: string): {
  ref: RefObject<HTMLDivElement>
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void
} {
  const ref = useRef<HTMLDivElement>(null)

  // Keep exactly one row in the Tab order, after every render.
  useLayoutEffect(() => {
    const tree = ref.current
    if (!tree) return
    const rows = rowsOf(tree)
    if (rows.length === 0) {
      tree.removeAttribute('role')
      tree.removeAttribute('aria-label')
      return
    }
    tree.setAttribute('role', 'tree')
    tree.setAttribute('aria-label', label)
    const focused = rows.find((r) => r === document.activeElement)
    const current = focused ?? rows.find((r) => r.tabIndex === 0) ?? rows.find((r) => r.getAttribute('aria-selected') === 'true') ?? rows[0]
    for (const r of tree.querySelectorAll<HTMLElement>(ROW)) r.tabIndex = r === current ? 0 : -1
  })

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLElement>) => {
    const tree = ref.current
    const row = (e.target as HTMLElement).closest<HTMLElement>(ROW)
    // Keys typed into a field inside a row (renaming) are the field's.
    if (!tree || !row || e.target !== row) return
    const rows = rowsOf(tree)
    const at = rows.indexOf(row)
    const go = (r: HTMLElement | undefined) => {
      if (!r) return
      e.preventDefault()
      for (const x of rows) x.tabIndex = -1
      r.tabIndex = 0
      r.focus()
      r.scrollIntoView({ block: 'nearest' })
    }
    const level = Number(row.getAttribute('aria-level') || 1)
    const expanded = row.getAttribute('aria-expanded')
    const toggle = () => (row.querySelector<HTMLElement>('[data-tree-toggle]') ?? row).click()
    const pointer = (type: string) =>
      row.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, detail: type === 'dblclick' ? 2 : 1,
        shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey
      }))
    switch (e.key) {
      case 'ArrowDown': return go(rows[at + 1])
      case 'ArrowUp': return go(rows[at - 1])
      case 'Home': return go(rows[0])
      case 'End': return go(rows[rows.length - 1])
      case 'ArrowRight':
        if (expanded === 'false') { e.preventDefault(); toggle() }
        else if (expanded === 'true') go(rows[at + 1])
        return
      case 'ArrowLeft':
        if (expanded === 'true') { e.preventDefault(); toggle(); return }
        for (let i = at - 1; i >= 0; i--) {
          if (Number(rows[i].getAttribute('aria-level') || 1) < level) return go(rows[i])
        }
        return
      case ' ':
        e.preventDefault()
        pointer('click')
        return
      case 'Enter':
        e.preventDefault()
        pointer(row.dataset.treeEnter === 'click' ? 'click' : 'dblclick')
    }
  }, [])

  return { ref, onKeyDown }
}
