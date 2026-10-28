/**
 * useRememberedScroll — saves a document's scroll position as the reader
 * scrolls and returns to it whenever the document is shown again, including
 * after the project is reopened (see view-position-store.ts).
 *
 * `positionKey` names what is being scrolled: usually a source guid, or a
 * finer key when one document has several views (a survey's respondents).
 * Attach the returned handler as the scroll container's onScroll.
 *
 * Options:
 *  - `ready`: hold the restore back until the content has laid out (a
 *    PDF's pages, a transcript in coding mode). Going un-ready starts the
 *    visit over, so the position is restored again once it's ready.
 *  - `skipRestore`: leave the scroll alone because the viewer is about to
 *    jump somewhere specific (a quote, memo or query-result click).
 *  - `horizontal`: also remember the sideways position (zoomed-in images),
 *    under `${positionKey}|x`.
 *
 * Saving pauses until the restore has happened: viewers that reuse one
 * container for successive documents get a scroll event when the browser
 * clamps the old position to the new content, and that must not overwrite
 * the new document's saved position before it has been read.
 */
import { useCallback, useEffect, useRef, type RefObject, type UIEvent } from 'react'
import { getViewPosition, setViewPosition } from '../stores/view-position-store'

export function useRememberedScroll(
  positionKey: string | null | undefined,
  scrollRef: RefObject<HTMLElement | null>,
  {
    ready = true,
    skipRestore = false,
    horizontal = false
  }: { ready?: boolean; skipRestore?: boolean; horizontal?: boolean } = {}
): (e: UIEvent<HTMLElement>) => void {
  const restoredKeyRef = useRef<string | null>(null)
  const restorePendingRef = useRef(false)

  useEffect(() => {
    if (!positionKey || !ready) {
      restoredKeyRef.current = null
      restorePendingRef.current = false
      return
    }
    if (restoredKeyRef.current === positionKey) return
    restoredKeyRef.current = positionKey
    restorePendingRef.current = !skipRestore
    if (skipRestore) return
    const key = positionKey
    const fraction = getViewPosition(key) ?? 0
    const xFraction = horizontal ? getViewPosition(`${key}|x`) ?? 0 : 0
    requestAnimationFrame(() => {
      if (restoredKeyRef.current !== key) return
      restorePendingRef.current = false
      const el = scrollRef.current
      if (!el) return
      el.scrollTop = fraction * el.scrollHeight
      if (horizontal) el.scrollLeft = xFraction * el.scrollWidth
    })
  }, [positionKey, ready, skipRestore, horizontal, scrollRef])

  return useCallback((e: UIEvent<HTMLElement>) => {
    if (!positionKey || restorePendingRef.current || restoredKeyRef.current !== positionKey) return
    const el = e.currentTarget
    setViewPosition(positionKey, el.scrollTop, el.scrollHeight)
    if (horizontal) setViewPosition(`${positionKey}|x`, el.scrollLeft, el.scrollWidth)
  }, [positionKey, horizontal])
}
