/**
 * For a clickable element that isn't a <button> (a chip's ×, a header that
 * folds a section, a table cell that opens what it counts): props that put
 * it in the Tab order and make Enter and Space click it, so the keyboard
 * does exactly what the mouse does, through the element's own onClick.
 *
 *   <span onClick={remove} {...keyActivate({ label: t('common.remove') })}>×</span>
 *   <td onClick={open} {...keyActivate({ role: null })}>12</td>
 *
 * `role` defaults to "button"; pass null to keep the element's own (a table
 * cell or row stays one). `label` names it for screen readers when what it
 * shows doesn't (an icon). `expanded` for a section's header, `pressed` or
 * `selected` or `checked` for one of a set of choices. A focused one shows a ring
 * (global.css, [data-key-activate]).
 */
import type { KeyboardEvent } from 'react'

export function keyActivate(opts: {
  role?: string | null
  label?: string
  expanded?: boolean
  pressed?: boolean
  selected?: boolean
  checked?: boolean
} = {}): Record<string, unknown> {
  const props: Record<string, unknown> = {
    tabIndex: 0,
    'data-key-activate': '',
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget) return
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      e.currentTarget.click()
    }
  }
  if (opts.role !== null) props.role = opts.role ?? 'button'
  if (opts.label !== undefined) props['aria-label'] = opts.label
  if (opts.expanded !== undefined) props['aria-expanded'] = opts.expanded
  if (opts.pressed !== undefined) props['aria-pressed'] = opts.pressed
  if (opts.selected !== undefined) props['aria-selected'] = opts.selected
  if (opts.checked !== undefined) props['aria-checked'] = opts.checked
  return props
}

/**
 * For an area that takes drops (an analysis tool's "drag codes here"):
 * focusable and named, so the keyboard's paste (utils/keyboard-access.ts:
 * Cmd/Ctrl+C on a code, Cmd/Ctrl+V here) can reach it even while it's
 * empty. A focused one shows a ring (global.css, [data-drop-zone]).
 */
export function dropZone(label: string): Record<string, unknown> {
  return { tabIndex: 0, role: 'group', 'aria-label': label, 'data-drop-zone': '' }
}
