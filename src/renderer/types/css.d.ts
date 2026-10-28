/**
 * Augment csstype's Properties (which React.CSSProperties aliases) so
 * `-webkit-app-region` is allowed in inline styles. It documents which
 * areas of a custom-titlebar window drag the window (`'drag'`) and which
 * don't (`'no-drag'`). The webviews don't act on it themselves: window
 * dragging is driven by platform/tauri-api.ts from `.app-toolbar` /
 * `[data-drag-region]`. csstype doesn't ship it — it isn't in any spec.
 */
import 'csstype'

declare module 'csstype' {
  interface Properties {
    WebkitAppRegion?: 'drag' | 'no-drag'
  }
}

declare global {
  /** App version, injected at build time from package.json via the
   *  `define` in vite.config.ts. */
  const __APP_VERSION__: string
}

export {}
