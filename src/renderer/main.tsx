// Must load first: installs window.api for everything below.
import './platform/tauri-api'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/global.css'
import { applyStoredAppearance, installAppearanceListeners } from './utils/apply-theme'
// Initialize undo system (subscriptions activate on import)
import './stores/undo-store'

// Prevent the webview from opening dropped files in the window.
// Individual components (e.g. DocumentBrowser) selectively handle drops.
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => e.preventDefault())

// Apply the user's saved theme before React mounts so the very first
// frame paints in the right colors. Then listen for live theme changes
// pushed from other windows (e.g. Preferences) so the main window keeps
// up too — historically the main window was the only initiator of theme
// changes, so it never had to listen.
applyStoredAppearance()
installAppearanceListeners()

// Stamp the host platform on <html> so CSS can branch on it. The main
// window keeps the macOS traffic lights (titleBarStyle: 'hiddenInset')
// and needs an indent in `.app-toolbar` to clear them; Windows / Linux
// have no traffic lights and want no indent. data-platform is the
// scope hook in global.css.
document.documentElement.setAttribute(
  'data-platform',
  ((window as any).api?.platform as string) || ''
)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
