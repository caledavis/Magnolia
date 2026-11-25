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

export function useColumnWindow(widths: number[], minColumns = 80) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [view, setView] = useState({ offset: 0, width: 2000 })
  const enabled = widths.length >= minColumns

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
  }, [enabled, view, starts, widths.length])
}
