/**
 * Drawing an area (on a picture or a PDF page) from the keyboard.
 *
 * Enter puts an area in the middle of the page most in view; the arrows
 * move it, with Shift they change its size (→ ↓ larger, ← ↑ smaller), with
 * Alt by smaller steps. It is the viewer's pending area, exactly as one
 * drawn with the mouse, so a code's shortcut, Shift+F10, a new code or
 * pasting a code codes it and Escape clears it (the viewers already do
 * all of that). To put it on another page: Escape, scroll there, Enter.
 *
 * Pages are the viewer's `[data-pdf-page]` elements; an area is in their
 * units (top-left origin), as a mouse-drawn one is.
 */
import type { PdfRegionSelection } from '../models/types'
import { roundRegionToWholePixels } from './region-rounding'

interface Page { el: HTMLElement; page: number; width: number; height: number }

function pages(container: HTMLElement): Page[] {
  return [...container.querySelectorAll<HTMLElement>('[data-pdf-page]')].map((el) => {
    const scale = parseFloat(el.dataset.pdfScale || '1') || 1
    const r = el.getBoundingClientRect()
    return { el, page: parseInt(el.dataset.pdfPage || '1', 10), width: r.width / scale, height: r.height / scale }
  })
}

/** The page showing most within the container. */
function pageInView(container: HTMLElement): Page | undefined {
  const box = container.getBoundingClientRect()
  let best: Page | undefined
  let bestShown = -1
  for (const p of pages(container)) {
    const r = p.el.getBoundingClientRect()
    const shown = Math.max(0, Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top)) *
      Math.max(0, Math.min(r.right, box.right) - Math.max(r.left, box.left))
    if (shown > bestShown) { best = p; bestShown = shown }
  }
  return best
}

const pct = (v: number, of: number) => Math.round((v / of) * 100)

/** Where an area is, in words (for a screen reader). */
export function describeArea(region: PdfRegionSelection, container: HTMLElement, t: (k: string, o: Record<string, unknown>) => string): string {
  const p = pages(container).find((x) => x.page === region.page)
  if (!p) return ''
  return t('viewer.areaAt', {
    page: region.page,
    left: pct(region.x, p.width), top: pct(region.y, p.height),
    width: pct(region.width, p.width), height: pct(region.height, p.height)
  })
}

/** The area after `e`, or undefined if `e` isn't an area key. */
export function areaKey(
  e: { key: string; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean },
  container: HTMLElement,
  region: PdfRegionSelection | null
): PdfRegionSelection | undefined {
  if (e.metaKey || e.ctrlKey) return undefined
  if (e.key === 'Enter' && !region) {
    const p = pageInView(container)
    if (!p) return undefined
    const w = p.width * 0.3
    const h = p.height * 0.3
    return { page: p.page, ...roundRegionToWholePixels((p.width - w) / 2, (p.height - h) / 2, w, h) }
  }
  if (!region || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return undefined
  const p = pages(container).find((x) => x.page === region.page)
  if (!p) return undefined
  const horizontal = e.key === 'ArrowLeft' || e.key === 'ArrowRight'
  const sign = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1
  const step = (horizontal ? p.width : p.height) * (e.altKey ? 0.005 : 0.02) * sign
  let { x, y, width, height } = region
  if (e.shiftKey) {
    if (horizontal) width = Math.max(5, Math.min(p.width - x, width + step))
    else height = Math.max(5, Math.min(p.height - y, height + step))
  } else if (horizontal) {
    x = Math.max(0, Math.min(p.width - width, x + step))
  } else {
    y = Math.max(0, Math.min(p.height - height, y + step))
  }
  const rounded = roundRegionToWholePixels(x, y, width, height)
  // A step smaller than a pixel still moves it by one.
  if (rounded.x === region.x && rounded.y === region.y && rounded.width === region.width && rounded.height === region.height) {
    const one = sign
    if (e.shiftKey) {
      if (horizontal) rounded.width = Math.max(5, Math.min(Math.floor(p.width - x), region.width + one))
      else rounded.height = Math.max(5, Math.min(Math.floor(p.height - y), region.height + one))
    } else if (horizontal) rounded.x = Math.max(0, Math.min(Math.floor(p.width - width), region.x + one))
    else rounded.y = Math.max(0, Math.min(Math.floor(p.height - height), region.y + one))
  }
  return { page: region.page, ...rounded }
}

/** Bring the area into view in the container. */
export function revealArea(region: PdfRegionSelection, container: HTMLElement): void {
  const p = pages(container).find((x) => x.page === region.page)
  if (!p) return
  const scale = parseFloat(p.el.dataset.pdfScale || '1') || 1
  const pr = p.el.getBoundingClientRect()
  const box = container.getBoundingClientRect()
  const top = pr.top + region.y * scale
  const bottom = top + region.height * scale
  const left = pr.left + region.x * scale
  const right = left + region.width * scale
  if (top < box.top) container.scrollTop -= box.top - top + 16
  else if (bottom > box.bottom) container.scrollTop += bottom - box.bottom + 16
  if (left < box.left) container.scrollLeft -= box.left - left + 16
  else if (right > box.right) container.scrollLeft += right - box.right + 16
}
