import { useEffect } from 'react'

/** How close (CSS px) a panel's corner must sit to the panel area's corner
 *  to count as "in" it. Covers the Magnolia themes' inset with slack. */
const CORNER_SLOP = 8

/**
 * Marks the panels that sit in the main window's bottom-left and
 * bottom-right corners with data-window-corner="bl" / "br" (or "bl br"
 * for a panel spanning the full width), so CSS can round those corners
 * concentrically with the macOS window corner. Which panel that is
 * depends on the layout (query results hidden, side columns collapsed,
 * panes closed), so it's measured rather than assumed.
 *
 * The CSS divides the corner radius by --window-zoom (set on <html> by
 * setZoomFactor in platform/tauri-api.ts): the window corner radius is
 * fixed in screen points, but CSS px scale with the interface zoom.
 * WKWebView reports window.outerWidth as 0, so the zoom can't be measured
 * from the outer/inner width ratio.
 */
export function useWindowCornerPanels(): void {
  useEffect(() => {
    let frame = 0

    const update = (): void => {
      frame = 0
      const container = document.querySelector('.app-main-panels')
      if (!container) return
      const box = container.getBoundingClientRect()
      container.querySelectorAll<HTMLElement>('.panel').forEach((panel) => {
        const r = panel.getBoundingClientRect()
        const atBottom = r.width > 0 && box.bottom - r.bottom <= CORNER_SLOP
        const corners: string[] = []
        if (atBottom && r.left - box.left <= CORNER_SLOP) corners.push('bl')
        if (atBottom && box.right - r.right <= CORNER_SLOP) corners.push('br')
        const value = corners.join(' ')
        if (value) {
          if (panel.dataset.windowCorner !== value) panel.dataset.windowCorner = value
        } else if (panel.dataset.windowCorner !== undefined) {
          delete panel.dataset.windowCorner
        }
      })
    }
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(update)
    }

    // Panel sizes change on window resize and splitter drags; panels come
    // and go when panes are opened, closed or collapsed. DOM changes are
    // frequent (typing, lists), so re-observing is batched to one per frame.
    const resizeObserver = new ResizeObserver(schedule)
    let reobserveFrame = 0
    const observeAll = (): void => {
      reobserveFrame = 0
      resizeObserver.disconnect()
      const container = document.querySelector('.app-main-panels')
      if (container) resizeObserver.observe(container)
      document.querySelectorAll('.app-main-panels .panel').forEach((p) => resizeObserver.observe(p))
      schedule()
    }
    const mutationObserver = new MutationObserver(() => {
      if (!reobserveFrame) reobserveFrame = requestAnimationFrame(observeAll)
    })
    mutationObserver.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', schedule)
    observeAll()

    return () => {
      if (frame) cancelAnimationFrame(frame)
      if (reobserveFrame) cancelAnimationFrame(reobserveFrame)
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      window.removeEventListener('resize', schedule)
    }
  }, [])
}
