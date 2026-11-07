// Must load first: installs window.api for everything below.
import './platform/tauri-api'
import { initLanguage } from './i18n'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { CodebookWindow } from './components/Codebook/CodebookWindow'
import './styles/global.css'
import { applyStoredAppearance, installAppearanceListeners } from './utils/apply-theme'
import { usePreferencesStore } from './stores/preferences-store'

// Prevent default drag/drop navigation
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => e.preventDefault())

// Apply the stored theme on first paint, then listen for live changes.
applyStoredAppearance()
installAppearanceListeners()
// Load preferences so the code colour presets follow the theme.
usePreferencesStore.getState().load()

// The first frame is already in the user's language (see i18n/index.ts).
await initLanguage()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CodebookWindow />
  </React.StrictMode>
)
