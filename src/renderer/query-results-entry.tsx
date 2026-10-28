// Must load first: installs window.api for everything below.
import './platform/tauri-api'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryResultsWindow } from './components/QueryResultViewer/QueryResultsWindow'
import './styles/global.css'
import { applyStoredAppearance, installAppearanceListeners } from './utils/apply-theme'

document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => e.preventDefault())

applyStoredAppearance()
installAppearanceListeners()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryResultsWindow />
  </React.StrictMode>
)
