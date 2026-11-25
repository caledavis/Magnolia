/**
 * Draw only the columns of a wide table that are in view (and a margin
 * either side), so a table of a thousand documents costs what a table of
 * thirty does. Columns outside the window are stood in for by one spacer
 * cell each side, `before` and `after` pixels wide, so the table scrolls
 * exactly as if every column were there.
 *
 * `widths` are the columns' fixed widths in pixels, in order. Below
 * `minColumns` every column is drawn (the window isn't worth it). Works
 * right-to-left too (WebKit counts scrollLeft negative from the start).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const MARGIN = 800 // px drawn beyond each edge of the view

/** How far a horizontally scrolling box is scrolled, and how wide it is
 *  (kept up to date while `enabled`). */
export function useScrollView(enabled: boolean) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [view, setView] = useState({ offset: 0, width: 2000 })

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    setView((v) => {
      const next = { offset: Math.abs(el.scrollLeft), width: el.clientWidth || v.width }
      return next.offset === v.offset && next.width === v.width ? v : next
    })
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => { frame = 0; measure() })
    }
    measure()
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [enabled, measure])

  return { ref, view, margin: MARGIN }
}

export function useColumnWindow(widths: number[], minColumns = 80) {
  const enabled = widths.length >= minColumns
  const { ref, view } = useScrollView(enabled)

  const starts = useMemo(() => {
    const s = new Array<number>(widths.length + 1)
    s[0] = 0
    for (let j = 0; j < widths.length; j++) s[j + 1] = s[j] + widths[j]
    return s
  }, [widths])

  return useMemo(() => {
    const n = widths.length
    if (!enabled) return { ref, start: 0, end: n, before: 0, after: 0 }
    const lo = view.offset - MARGIN
    const hi = view.offset + view.width + MARGIN
    let start = 0
    while (start < n && starts[start + 1] < lo) start++
    let end = start
    while (end < n && starts[end] < hi) end++
    return { ref, start, end, before: starts[start], after: starts[n] - starts[end] }
  }, [enabled, ref, view, starts, widths.length])
}

/** Which part of `target` (from its top, in px) is on screen in whatever
 *  scrolls it vertically, for drawing only the rows of a tall chart that
 *  are in view. Kept up to date on any scroll or resize while `enabled`. */
export function useVerticalView(target: React.RefObject<Element | null>, enabled: boolean) {
  const [view, setView] = useState({ top: 0, bottom: 4000 })
  useEffect(() => {
    if (!enabled) return
    let frame = 0
    const measure = () => {
      frame = 0
      const el = target.current
      if (!el) return
      let scroller: Element | null = el.parentElement
      // The first container that actually scrolls (one that may, but is
      // as tall as what's in it, doesn't).
      while (scroller && !(/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight + 1)) scroller = scroller.parentElement
      const box = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight }
      const r = el.getBoundingClientRect()
      const top = Math.max(0, box.top - r.top)
      const bottom = Math.max(top, box.bottom - r.top)
      setView((v) => (v.top === top && v.bottom === bottom ? v : { top, bottom }))
    }
    const later = () => { if (!frame) frame = requestAnimationFrame(measure) }
    measure()
    document.addEventListener('scroll', later, { capture: true, passive: true })
    window.addEventListener('resize', later)
    return () => {
      document.removeEventListener('scroll', later, { capture: true })
      window.removeEventListener('resize', later)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [target, enabled])
  return { view, margin: MARGIN }
}
