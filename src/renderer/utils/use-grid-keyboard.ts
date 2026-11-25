/**
 * Keyboard access to a table of results (Codes in Documents, Code
 * Co-Occurrences, word lists…), as the WAI-ARIA grid pattern has it: the
 * table is one stop in the Tab order, the arrow keys move between its
 * cells, and Enter or Space does what clicking the cell does (through the
 * cell's own onClick).
 *
 * The table takes the props this returns; each cell that can be reached
 * takes `gridCell()` (others, such as empty corners, are passed over). A
 * row whose whole width is one target (a word in a list) can take it on
 * the <tr> instead of its cells.
 *
 *  ← → ↑ ↓        move (↑ ↓ keep the column)
 *  Home End       the row's first or last cell; with Ctrl/⌘ the table's
 *  Enter Space    click it
 */
import { useCallback, useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from 'react'

const CELL = '[data-grid-cell]'

/** Props for a cell (or a row) the keyboard can reach. */
export function gridCell(): { 'data-grid-cell': ''; tabIndex: -1 } {
  return { 'data-grid-cell': '', tabIndex: -1 }
}

export function useGridKeyboard(label: string): {
  ref: RefObject<HTMLTableElement>
  role: 'grid'
  'aria-label': string
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void
} {
  const ref = useRef<HTMLTableElement>(null)

  // One cell in the Tab order: the one that had it, else the first.
  useLayoutEffect(() => {
    const table = ref.current
    if (!table) return
    const current = table.querySelector<HTMLElement>(`${CELL}[tabindex="0"]`)
    if (current) return
    table.querySelector<HTMLElement>(CELL)?.setAttribute('tabindex', '0')
  })

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLElement>) => {
    const table = ref.current
    const cell = (e.target as HTMLElement).closest<HTMLElement>(CELL)
    if (!table || !cell || e.target !== cell) return
    const rows = [...table.querySelectorAll<HTMLTableRowElement>('tr')]
      .map((tr) => (tr.matches(CELL) ? [tr] : [...tr.querySelectorAll<HTMLElement>(CELL)].filter((c) => c.closest('tr') === tr)))
      .filter((cells) => cells.length > 0)
    const r = rows.findIndex((cells) => cells.includes(cell))
    if (r < 0) return
    const c = rows[r].indexOf(cell)
    const go = (target: HTMLElement | undefined) => {
      e.preventDefault()
      if (!target) return
      cell.tabIndex = -1
      target.tabIndex = 0
      target.focus()
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
    const at = (row: number, col: number) => {
      const cells = rows[row]
      return cells?.[Math.min(col, cells.length - 1)]
    }
    const rtl = getComputedStyle(table).direction === 'rtl'
    switch (e.key) {
      case 'ArrowRight': return go(rows[r][c + (rtl ? -1 : 1)])
      case 'ArrowLeft': return go(rows[r][c + (rtl ? 1 : -1)])
      case 'ArrowDown': return go(at(r + 1, c))
      case 'ArrowUp': return go(at(r - 1, c))
      case 'Home': return go(e.ctrlKey || e.metaKey ? rows[0][0] : rows[r][0])
      case 'End': {
        const last = e.ctrlKey || e.metaKey ? rows[rows.length - 1] : rows[r]
        return go(last[last.length - 1])
      }
      case 'Enter':
      case ' ':
        e.preventDefault()
        cell.click()
    }
  }, [])

  return { ref, role: 'grid', 'aria-label': label, onKeyDown }
}
