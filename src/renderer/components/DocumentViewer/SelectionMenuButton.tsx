/**
 * SelectionMenuButton — a chevron button on the end of the pending selection
 * (or the corner of the pending box). Clicking it opens the selection's
 * context menu, as right-clicking the selection would.
 *
 * It's drawn in document.body at a fixed position, so no viewer's overflow
 * clips it, and follows its anchor every frame: the anchor moves when the
 * viewer scrolls, a PDF zooms or the window resizes, and polling one
 * rectangle a frame is cheaper than listening for all of those. It hides
 * when the anchor is scrolled out of the viewer.
 */
import { useEffect, useRef } from 'react'
import type React from 'react'
import { createPortal } from 'react-dom'
import { Icon, faChevronDown } from '../Icon'
import { useTranslation } from 'react-i18next'

const SIZE = 18

/** Where the button's centre goes, in client coordinates, or null to hide it. */
export type MenuButtonAnchor = (container: HTMLElement) => { x: number; y: number } | null

/** The last character of a range, or its last box if that has no width
 *  (a range ending at a line break). */
function endRect(range: Range): DOMRect | null {
  const visible = (rects: DOMRectList): DOMRect[] => [...rects].filter((r) => r.width > 0 && r.height > 0)
  const { endContainer, endOffset } = range
  if (endContainer.nodeType === Node.TEXT_NODE && endOffset > 0) {
    const last = document.createRange()
    last.setStart(endContainer, endOffset - 1)
    last.setEnd(endContainer, endOffset)
    const rects = visible(last.getClientRects())
    if (rects.length > 0) return rects[rects.length - 1]
  }
  const rects = visible(range.getClientRects())
  return rects.length > 0 ? rects[rects.length - 1] : null
}

/** Where the selection's focus (the end the cursor finished at) sits: the
 *  x of its edge, and the middle of its line. */
function focusPoint(sel: Selection): { x: number; y: number } | null {
  const node = sel.focusNode
  const offset = sel.focusOffset
  if (!node || node.nodeType !== Node.TEXT_NODE) return null
  const char = document.createRange()
  const box = (): DOMRect | undefined =>
    [...char.getClientRects()].filter((r) => r.width > 0 && r.height > 0).pop()
  if (offset > 0) {
    char.setStart(node, offset - 1)
    char.setEnd(node, offset)
    const r = box()
    if (r) return { x: r.right, y: r.top + r.height / 2 }
  }
  if (offset < (node.textContent?.length ?? 0)) {
    char.setStart(node, offset)
    char.setEnd(node, offset + 1)
    const r = box()
    if (r) return { x: r.left, y: r.top + r.height / 2 }
  }
  return null
}

/** Centred on the end of the selection in `container`, where the cursor
 *  finished: on the edge of its last character, in the middle of the line. */
export const textSelectionAnchor: MenuButtonAnchor = (container) => {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(sel.rangeCount - 1)
  if (!container.contains(range.commonAncestorContainer)) return null
  const p = focusPoint(sel)
  if (p) return p
  const r = endRect(range)
  return r ? { x: r.right, y: r.top + r.height / 2 } : null
}

/** The bottom-right corner of the pending box drawn in `container`
 *  (PdfPageRenderer and ImagePageRenderer mark it data-pending-box). */
export const boxSelectionAnchor: MenuButtonAnchor = (container) => {
  const box = container.querySelector('[data-pending-box]')
  if (!box) return null
  const r = box.getBoundingClientRect()
  return { x: r.right, y: r.bottom }
}

/** The element a right-click on the selection would land on: the pending
 *  box, or the text the selection ends in. */
function menuTarget(container: HTMLElement): Element | null {
  const box = container.querySelector('[data-pending-box]')
  if (box) return box
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed) return null
  const node = sel.focusNode
  const el = node && (node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element)
  return el && container.contains(el) ? el : null
}

/** Failing that, whatever is just behind the button, where the selection ends. */
function elementBehind(button: HTMLElement, container: HTMLElement): Element | null {
  const r = button.getBoundingClientRect()
  const prev = button.style.display
  button.style.display = 'none'
  const el = document.elementFromPoint(r.left - 2, r.top + r.height / 2)
  button.style.display = prev
  return el && container.contains(el) ? el : null
}

/** Open the selection's context menu at the button by sending the viewer
 *  the right-click it already handles, so every viewer's menu (and what it
 *  finds under the selection) is unchanged. */
function openMenu(target: Element, button: HTMLElement): void {
  const r = button.getBoundingClientRect()
  target.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button: 2,
    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2
  }))
}

interface Props {
  /** The viewer the selection is in: the button shows only while its
   *  anchor is inside this element's visible area. */
  containerRef: React.RefObject<HTMLElement | null>
  anchor: MenuButtonAnchor
}

export function SelectionMenuButton({ containerRef, anchor }: Props): React.ReactElement {
  const { t } = useTranslation()
  const buttonRef = useRef<HTMLDivElement>(null)
  /** The mouse is down somewhere else, perhaps making a new selection: the
   *  button waits until it's released, when the selection is finished. */
  const selectingRef = useRef(false)

  useEffect(() => {
    let frame = 0
    const place = (): void => {
      frame = requestAnimationFrame(place)
      const el = buttonRef.current
      const container = containerRef.current
      if (!el || !container) return
      if (selectingRef.current) {
        el.style.display = 'none'
        return
      }
      const p = anchor(container)
      const c = container.getBoundingClientRect()
      if (!p || p.y < c.top || p.y > c.bottom || p.x < c.left) {
        el.style.display = 'none'
        return
      }
      // A selection ending at the right edge keeps its button inside the viewer.
      const x = Math.min(p.x, c.right - SIZE / 2 - 2)
      el.style.display = 'flex'
      el.style.left = `${x - SIZE / 2}px`
      el.style.top = `${p.y - SIZE / 2}px`
    }
    place()
    const press = (e: MouseEvent): void => {
      if (e.button === 0 && e.target !== buttonRef.current && !buttonRef.current?.contains(e.target as Node)) selectingRef.current = true
    }
    const release = (): void => { selectingRef.current = false }
    window.addEventListener('mousedown', press, true)
    window.addEventListener('mouseup', release, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('mousedown', press, true)
      window.removeEventListener('mouseup', release, true)
    }
  }, [containerRef, anchor])

  // React events from a portal still bubble to the viewer, where a press
  // would start a new box or selection: keep them here.
  const stop = (e: React.SyntheticEvent): void => e.stopPropagation()

  return createPortal(
    <div
      ref={buttonRef}
      data-selection-menu-button
      role="button"
      aria-haspopup="menu"
      aria-label={t('viewer.selectionMenu')}
      title={t('viewer.selectionMenu')}
      // preventDefault keeps the text selection: pressing would clear it.
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}
      onMouseUp={stop}
      onClick={(e) => {
        e.stopPropagation()
        const container = containerRef.current
        const button = buttonRef.current
        if (!container || !button) return
        const target = menuTarget(container) ?? elementBehind(button, container)
        if (target) openMenu(target, button)
      }}
      onDoubleClick={stop}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}
      style={{
        position: 'fixed',
        display: 'none',
        width: SIZE,
        height: SIZE,
        borderRadius: '50%',
        background: 'var(--accent)',
        color: '#fff',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.3)',
        zIndex: 30
      }}
    >
      <Icon icon={faChevronDown} size={12} />
    </div>,
    document.body
  )
}
