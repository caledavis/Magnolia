// Must load first: installs window.api for everything below.
import './platform/tauri-api'
import { initLanguage } from './i18n'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { WelcomeScreen } from './components/Welcome/WelcomeScreen'
import { applyStoredAppearance, installAppearanceListeners } from './utils/apply-theme'
import './styles/global.css'

// Pick up the user's saved appearance (theme + text size) so the welcome
// screen matches the look they last selected, rather than always
// rendering in the default palette.
applyStoredAppearance()
installAppearanceListeners()

// The first frame is already in the user's language (see i18n/index.ts).
await initLanguage()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WelcomeScreen />
  </React.StrictMode>
)
