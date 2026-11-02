import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { UpdateView } from '../../models/types'
import { Markdown } from '../Markdown'
import appIcon from '../../../../src-tauri/icons/128x128@2x.png'

/**
 * The Sparkle-style software update window. The backend (updater.rs) opens
 * it and decides what it shows: the prompt with release notes and the
 * three standard choices when an update is available,
 *   - Skip This Version → automatic checks stay quiet until a newer
 *                         version is published
 *   - Remind Me Later   → close; the next check offers it again
 *   - Install Update    → download it (progress, Cancel), then
 *                         "Ready to Install" with Install and Relaunch
 * and otherwise a small status panel (checking, downloading, ready,
 * installing, up to date, error). Closing the window is Remind Me Later on
 * the prompt, Cancel mid-check or download, and install-on-quit once
 * downloaded.
 */
export function UpdateWindow(): JSX.Element | null {
  const [view, setView] = useState<UpdateView | null>(null)

  useEffect(() => {
    const off = window.api.onUpdateView(setView)
    window.api.getUpdateView().then((v) => v && setView((cur) => cur ?? v))
    return off
  }, [])

  // Return / Escape act on the default and cancel buttons, as in a native panel.
  const defaultRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' && defaultRef.current && !e.isComposing) {
        e.preventDefault()
        defaultRef.current.click()
      } else if (e.key === 'Escape' && cancelRef.current) {
        e.preventDefault()
        cancelRef.current.click()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!view) return null
  if (view.state === 'available') {
    return <Prompt view={view} defaultRef={defaultRef} cancelRef={cancelRef} />
  }
  return <Status view={view} defaultRef={defaultRef} cancelRef={cancelRef} />
}

type ButtonRefs = {
  defaultRef: React.RefObject<HTMLButtonElement>
  cancelRef: React.RefObject<HTMLButtonElement>
}

function Prompt({
  view,
  defaultRef,
  cancelRef
}: { view: Extract<UpdateView, { state: 'available' }> } & ButtonRefs): JSX.Element {
  const released = formatDay(view.releaseDate)
  return (
    <div className="update-window update-prompt">
      <img className="update-icon" src={appIcon} alt="" draggable={false} />
      <div className="update-body">
        <h1>A new version of Magnolia is available!</h1>
        <p className="update-info">
          Magnolia {view.version} is now available—you have {view.currentVersion}. Would you like to download it
          now?
        </p>
        <div className="update-notes-label">
          <span>Release Notes:</span>
          {released && <span className="update-released">Released {released}</span>}
        </div>
        <div className="update-notes" tabIndex={-1}>
          {view.releaseNotes.trim() ? (
            <Markdown text={view.releaseNotes} />
          ) : (
            <p className="update-notes-empty">No release notes were provided for this version.</p>
          )}
        </div>
      </div>
      <div className="update-buttons">
        <button className="update-skip" onClick={() => window.api.skipUpdateVersion(view.version)}>
          Skip This Version
        </button>
        <span className="update-spacer" />
        <button ref={cancelRef} onClick={() => window.api.dismissUpdate()}>
          Remind Me Later
        </button>
        <button ref={defaultRef} className="update-default" onClick={() => window.api.installUpdate()}>
          Install Update
        </button>
      </div>
    </div>
  )
}

function Status({ view, defaultRef, cancelRef }: { view: Exclude<UpdateView, { state: 'available' }> } & ButtonRefs) {
  let title: string
  let detail: React.ReactNode = null
  let progress: number | null | undefined // undefined: no bar; null: indeterminate
  let button: 'cancel' | 'ok' | 'install' | null = null

  // Fit the window to the panel, whatever the text (long errors, other
  // platforms' fonts).
  const panelRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = panelRef.current
    if (!el) return
    // Compare with the viewport rather than send a height: how the window
    // size maps to the viewport (title bar or not) differs by platform.
    // One correction at a time: measure again only once the window has
    // resized (or a resize evidently isn't coming), else a stale viewport
    // gets the same delta applied twice.
    let waiting: ReturnType<typeof setTimeout> | null = null
    const fit = (): void => {
      // Coming from the prompt, the window shrinks to the panel's width
      // first; measuring before then would size it for the wrong layout.
      if (waiting || Math.abs(window.innerWidth - STATUS_WIDTH) > 2) return
      const delta = Math.ceil(el.getBoundingClientRect().height) - window.innerHeight
      if (delta === 0) return
      window.api.fitUpdateWindow(delta)
      waiting = setTimeout(settled, 400)
    }
    const settled = (): void => {
      if (waiting) clearTimeout(waiting)
      waiting = null
      fit()
    }
    const ro = new ResizeObserver(fit) // also fires once on observe
    ro.observe(el)
    window.addEventListener('resize', settled)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', settled)
      if (waiting) clearTimeout(waiting)
    }
  }, [])

  switch (view.state) {
    case 'checking':
      title = 'Checking for updates…'
      progress = null
      button = 'cancel'
      break
    case 'downloading':
      title = `Downloading Magnolia ${view.version}…`
      progress = view.total ? view.received / view.total : null
      detail = view.total
        ? `${formatBytes(view.received)} of ${formatBytes(view.total)}`
        : view.received
          ? formatBytes(view.received)
          : ' '
      button = 'cancel'
      break
    case 'ready':
      title = 'Ready to Install'
      progress = 1
      detail = `Magnolia ${view.version} has been downloaded. If you close this window, it installs when you quit Magnolia.`
      button = 'install'
      break
    case 'installing':
      title = 'Installing update…'
      detail = 'Magnolia will relaunch when it’s done.'
      progress = null
      break
    case 'up-to-date':
      title = 'You’re up to date!'
      detail = `Magnolia ${view.version} is currently the newest version available.`
      button = 'ok'
      break
    case 'error':
      title = view.title
      detail = view.message
      button = 'ok'
      break
  }

  return (
    <div className="update-window update-status" ref={panelRef}>
      <img className="update-icon" src={appIcon} alt="" draggable={false} />
      <div className="update-body">
        <h1>{title}</h1>
        {progress !== undefined && <ProgressBar value={progress} />}
        {detail && <p className="update-info">{detail}</p>}
      </div>
      <div className="update-buttons">
        <span className="update-spacer" />
        {button === 'cancel' && (
          <button ref={cancelRef} onClick={() => window.api.dismissUpdate()}>
            Cancel
          </button>
        )}
        {button === 'ok' && (
          <button
            ref={(el) => {
              ;(defaultRef as React.MutableRefObject<HTMLButtonElement | null>).current = el
              ;(cancelRef as React.MutableRefObject<HTMLButtonElement | null>).current = el
            }}
            className="update-default"
            onClick={() => window.api.dismissUpdate()}
          >
            OK
          </button>
        )}
        {button === 'install' && (
          <button ref={defaultRef} className="update-default" onClick={() => window.api.installUpdate()}>
            Install and Relaunch
          </button>
        )}
      </div>
    </div>
  )
}

/** The status panel's width in points (windows.rs UPDATE_STATUS_WIDTH). */
const STATUS_WIDTH = 440

function ProgressBar({ value }: { value: number | null }): JSX.Element {
  return (
    <div
      className={`update-progress${value === null ? ' indeterminate' : ''}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : Math.round(value * 100)}
    >
      <div className="update-progress-fill" style={value === null ? undefined : { width: `${value * 100}%` }} />
    </div>
  )
}

/** "2 November 2026" from YYYY-MM-DD, without a timezone shifting the day. */
function formatDay(day: string | null): string | null {
  const m = day && /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return null
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
}

function formatBytes(n: number): string {
  if (n < 1e6) return `${Math.max(1, Math.round(n / 1e3))} KB`
  return `${(n / 1e6).toFixed(1)} MB`
}
