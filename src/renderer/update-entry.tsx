// Must load first: installs window.api for everything below.
import './platform/tauri-api'
import { initLanguage } from './i18n'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { UpdateWindow } from './components/Update/UpdateWindow'
import './components/Update/update-window.css'

// The update window imitates a native system panel, so it takes its look
// from the OS (light/dark, system font) rather than Magnolia's theme and
// interface scale.
document.documentElement.dataset.platform = (window.api as unknown as { platform: string }).platform

// The first frame is already in the user's language (see i18n/index.ts).
await initLanguage()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <UpdateWindow />
  </React.StrictMode>
)
