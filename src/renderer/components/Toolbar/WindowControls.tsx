import { useEffect, useState } from 'react'

/**
 * Minimise / maximise / close buttons for the frameless main window on
 * Windows and Linux (the main window is created with `frame: false`, so
 * there are no native controls there). macOS keeps its native traffic
 * lights, so this renders nothing on that platform.
 *
 * The toolbar carries `-webkit-app-region: drag` so the window can be moved;
 * these buttons opt back out with `no-drag` so they stay clickable.
 */
export function WindowControls(): JSX.Element | null {
  const platform = ((window as any).api?.platform as string) ?? ''
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (platform === 'darwin') return
    window.api.isWindowMaximized().then(setMaximized).catch(() => {})
    return window.api.onWindowMaximizedChanged(setMaximized)
  }, [platform])

  // macOS uses the native traffic lights — no custom controls needed.
  if (platform === 'darwin') return null

  return (
    <div
      className="win-controls"
      style={{ display: 'flex', alignItems: 'stretch', height: '100%', WebkitAppRegion: 'no-drag' }}
    >
      <style>{`
        .win-controls button {
          width: 44px; border: none; background: transparent; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          color: var(--text-secondary); transition: background 0.12s, color 0.12s;
        }
        .win-controls button:hover { background: var(--bg-tertiary); color: var(--text-primary); }
        .win-controls button.win-close:hover { background: #e81123; color: #fff; }
        .win-controls svg { width: 10px; height: 10px; display: block; }
      `}</style>

      <button onClick={() => window.api.minimizeWindow()} aria-label="Minimise" title="Minimise">
        <svg viewBox="0 0 10 10"><path d="M0 5 H10" stroke="currentColor" strokeWidth="1" /></svg>
      </button>

      <button
        onClick={() => window.api.toggleMaximizeWindow()}
        aria-label={maximized ? 'Restore' : 'Maximise'}
        title={maximized ? 'Restore' : 'Maximise'}
      >
        {maximized ? (
          <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="0.5" y="2.5" width="6" height="6" />
            <path d="M2.5 2.5 V0.5 H9.5 V7.5 H6.5" />
          </svg>
        ) : (
          <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="0.5" y="0.5" width="9" height="9" />
          </svg>
        )}
      </button>

      <button className="win-close" onClick={() => window.api.closeWindow()} aria-label="Close" title="Close">
        <svg viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1">
          <path d="M0 0 L10 10 M10 0 L0 10" />
        </svg>
      </button>
    </div>
  )
}
