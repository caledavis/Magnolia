/**
 * Apply the user's saved appearance settings (theme + interface scale) to
 * the current document/window. Called from each renderer entry point so
 * popped-out windows render in the right look on first paint, before
 * the main window's broadcast (if any) arrives.
 *
 * First-install defaults follow the OS's appearance preferences:
 *   - prefers-contrast: more  →  "high-contrast"
 *   - prefers-color-scheme: dark  →  "magnolia-dark"
 *   - otherwise  →  "magnolia"
 * These only apply when no theme has been saved yet; any saved value
 * wins.
 */
export async function applyStoredAppearance(): Promise<void> {
  let theme = 'magnolia'
  let hadSavedTheme = false
  let interfaceScale = 1
  let colourful = true
  try {
    const prefs = await window.api.loadPreferences()
    if (prefs && typeof prefs === 'object') {
      if ('theme' in prefs && typeof (prefs as { theme: unknown }).theme === 'string') {
        theme = (prefs as { theme: string }).theme
        hadSavedTheme = true
      }
      if ('interfaceScale' in prefs && typeof (prefs as { interfaceScale: unknown }).interfaceScale === 'number') {
        interfaceScale = (prefs as { interfaceScale: number }).interfaceScale
      }
      colourful = (prefs as { colourfulInterface?: unknown }).colourfulInterface !== false
    }
  } catch {
    /* fall through to defaults */
  }

  try {
    window.api.setZoomFactor(interfaceScale)
  } catch {
    /* zoom API unavailable — leave window at its default scale */
  }

  // First-launch OS preference hints — only consulted when nothing's
  // been saved. Increased-contrast trumps dark-mode because users who
  // explicitly opted into high-contrast at the OS level need it more.
  if (!hadSavedTheme) {
    try {
      if (window.matchMedia && window.matchMedia('(prefers-contrast: more)').matches) {
        theme = 'high-contrast'
      } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        theme = 'magnolia-dark'
      }
    } catch { /* matchMedia unavailable — keep default */ }
  }

  document.documentElement.setAttribute('data-theme', theme)
  document.documentElement.toggleAttribute('data-colourful', colourful)
}

/** Backwards-compatible alias for callers that only know about themes. */
export const applyStoredTheme = applyStoredAppearance

/** Install live listeners so theme broadcasts from any other window
 *  (e.g. Preferences) update this window without a reload. Also
 *  installs the global context-menu clamp observer (idempotent) so
 *  every renderer keeps menus on-screen regardless of which component
 *  rendered them. Call once per renderer entry point. */
export function installAppearanceListeners(): void {
  window.api.onThemeChanged((theme) => {
    document.documentElement.setAttribute('data-theme', theme)
  })
  window.api.onZoomFactorChanged((factor) => {
    window.api.setZoomFactor(factor)
  })
  // Lazy-imported to avoid pulling DOM-observer code into entries that
  // never paint a context menu. Once any entry runs the listeners
  // setup, the observer is live for the rest of the session.
  import('./install-context-menu-clamp').then((m) => m.installContextMenuClamp())
}
