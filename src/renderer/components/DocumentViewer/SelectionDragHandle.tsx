/**
 * SelectionDragHandle — a grab handle on the end of the pending selection (or the
 * corner of the pending box) that the reader drags onto a code in the Code
 * Browser to code the selection. See utils/selection-drag.ts.
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
import { Icon, faHand } from '../Icon'
import { startSelectionDrag } from '../../utils/selection-drag'

const SIZE = 18

/** Where the handle's centre goes, in client coordinates, or null to hide it. */
export type HandleAnchor = (container: HTMLElement) => { x: number; y: number } | null

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
export const textSelectionAnchor: HandleAnchor = (container) => {
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
export const boxSelectionAnchor: HandleAnchor = (container) => {
  const box = container.querySelector('[data-pending-box]')
  if (!box) return null
  const r = box.getBoundingClientRect()
  return { x: r.right, y: r.bottom }
}

/** The drag image: the start of the selected text, or the label. */
function setDragPreview(e: React.DragEvent, text: string): void {
  const flat = text.replace(/\s+/g, ' ').trim()
  const ghost = document.createElement('div')
  ghost.style.cssText = 'position:absolute;top:-9999px;left:-9999px;max-width:280px;padding:4px 8px;background:var(--bg-secondary,#2a2a2a);border:1px solid var(--border-color,#555);border-radius:4px;font-size:11px;color:var(--text-primary,#eee);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
  ghost.textContent = flat.length > 60 ? `${flat.slice(0, 57)}…` : flat
  document.body.appendChild(ghost)
  e.dataTransfer.setDragImage(ghost, 10, 10)
  requestAnimationFrame(() => ghost.remove())
}

interface Props {
  /** The viewer the selection is in: the handle shows only while its
   *  anchor is inside this element's visible area. */
  containerRef: React.RefObject<HTMLElement | null>
  sourceGuid: string
  anchor: HandleAnchor
  /** Shown in the drag image in place of the selected text (for a box). */
  label?: string
}

export function SelectionDragHandle({ containerRef, sourceGuid, anchor, label }: Props): React.ReactElement {
  const handleRef = useRef<HTMLDivElement>(null)
  /** Held still from mousedown to drop: pressing a draggable element
   *  clears the text selection for a frame (install-drag-selection-keeper
   *  puts it back), which would otherwise hide the handle mid-drag. */
  const grabbingRef = useRef(false)
  /** The mouse is down somewhere else, perhaps making a new selection: the
   *  handle waits until it's released, when the selection is finished. */
  const selectingRef = useRef(false)

  useEffect(() => {
    let frame = 0
    const place = (): void => {
      frame = requestAnimationFrame(place)
      const el = handleRef.current
      const container = containerRef.current
      if (!el || !container || grabbingRef.current) return
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
      // A selection ending at the right edge keeps its handle inside the viewer.
      const x = Math.min(p.x, c.right - SIZE / 2 - 2)
      el.style.display = 'flex'
      el.style.left = `${x - SIZE / 2}px`
      el.style.top = `${p.y - SIZE / 2}px`
    }
    place()
    const press = (e: MouseEvent): void => {
      if (e.button === 0 && e.target !== handleRef.current && !handleRef.current?.contains(e.target as Node)) selectingRef.current = true
    }
    const release = (): void => {
      grabbingRef.current = false
      selectingRef.current = false
    }
    window.addEventListener('mousedown', press, true)
    window.addEventListener('mouseup', release, true)
    window.addEventListener('dragend', release, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('mousedown', press, true)
      window.removeEventListener('mouseup', release, true)
      window.removeEventListener('dragend', release, true)
    }
  }, [containerRef, anchor])

  // React events from a portal still bubble to the viewer, where a press
  // would start a new box or selection: keep them here.
  const stop = (e: React.SyntheticEvent): void => e.stopPropagation()

  return createPortal(
    <div
      ref={handleRef}
      draggable
      data-selection-handle
      title="Drag onto a code to code this selection"
      onMouseDown={(e) => { e.stopPropagation(); grabbingRef.current = true }}
      onMouseUp={stop}
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}
      onDragStart={(e) => {
        e.stopPropagation()
        const text = label ?? (window.getSelection()?.toString() || 'Selection')
        startSelectionDrag(e, sourceGuid, text)
        setDragPreview(e, text)
      }}
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
        cursor: 'grab',
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.3)',
        zIndex: 30
      }}
    >
      <Icon icon={faHand} size={12} />
    </div>,
    document.body
  )
}
