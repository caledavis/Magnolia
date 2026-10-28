// Must load first: installs window.api for everything below.
import './platform/tauri-api'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { LogbookWindow } from './components/Logbook/LogbookWindow'
import './styles/global.css'
import { applyStoredAppearance, installAppearanceListeners } from './utils/apply-theme'

// Prevent default drag/drop navigation
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => e.preventDefault())

// Apply the stored theme on first paint, then listen for live changes.
applyStoredAppearance()
installAppearanceListeners()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LogbookWindow />
  </React.StrictMode>
)
