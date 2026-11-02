// Must load first: installs window.api for everything below.
import './platform/tauri-api'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { UpdateWindow } from './components/Update/UpdateWindow'
import './components/Update/update-window.css'

// The update window imitates a native system panel, so it takes its look
// from the OS (light/dark, system font) rather than Magnolia's theme and
// interface scale.
document.documentElement.dataset.platform = (window.api as unknown as { platform: string }).platform

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <UpdateWindow />
  </React.StrictMode>
)
