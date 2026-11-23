/**
 * Preserve zustand store state across Vite HMR boundaries.
 *
 * Problem: when Vite hot-reloads a store module, the `create(...)` call at
 * module scope runs again and produces a new singleton with its default
 * (empty) initial state. Any components that still hold references to the
 * old hook observe the wipe. If the project auto-save then fires while
 * filePath is still set, the now-empty stores get written over the user's
 * project file on disk.
 *
 * Fix: stash only the DATA fields (no methods) in a window-level cache on
 * module dispose, and rehydrate after the new module creates its store.
 * Methods are always taken fresh from the new module so HMR still picks
 * up code changes to store actions.
 */

interface ZustandLike<S> {
  getState: () => S
  setState: (partial: Partial<S>, replace?: boolean) => void
}

/** Strip methods from state so HMR code changes to actions aren't clobbered
 *  when rehydrating the new store with cached state. */
function captureData<T extends object>(state: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(state)) {
    const val = (state as Record<string, unknown>)[key]
    if (typeof val !== 'function') out[key] = val
  }
  return out as Partial<T>
}

/** Call once per store, right after `create(...)`. The store's data-only
 *  snapshot is cached on the global `window` object so a subsequent HMR
 *  re-evaluation of this module can rehydrate it into the fresh store
 *  instance without losing user state. */
export function makeHmrSafe<S extends object>(key: string, store: ZustandLike<S>): void {
  if (typeof window === 'undefined') return
  const w = window as unknown as { __MAGNOLIA_STORE_CACHE__?: Record<string, unknown> }
  w.__MAGNOLIA_STORE_CACHE__ = w.__MAGNOLIA_STORE_CACHE__ || {}
  const cached = w.__MAGNOLIA_STORE_CACHE__[key] as Partial<S> | undefined
  if (cached) {
    // Merge data into the fresh store — methods from the new creator win.
    store.setState(cached, false)
  }
  const hot = (import.meta as any).hot
  if (hot) {
    hot.dispose(() => {
      w.__MAGNOLIA_STORE_CACHE__![key] = captureData(store.getState())
    })
  }
}
