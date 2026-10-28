import { resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const appVersion: string = JSON.parse(readFileSync(resolve('package.json'), 'utf-8')).version

// The renderer: one page per window. Tauri serves out/renderer in builds
// and this dev server (port fixed in src-tauri/tauri.conf.json) in dev.
export default defineConfig({
  root: resolve('src/renderer'),
  base: './',
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(appVersion)
  },
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: resolve('out/renderer'),
    emptyOutDir: true,
    // macOS 13's WKWebView is Safari 16; WebView2 and WebKitGTK are newer.
    target: ['safari16', 'chrome105'],
    rollupOptions: {
      input: {
        index: resolve('src/renderer/index.html'),
        codebook: resolve('src/renderer/codebook.html'),
        logbook: resolve('src/renderer/logbook.html'),
        welcome: resolve('src/renderer/welcome.html'),
        'memo-edit': resolve('src/renderer/memo-edit.html'),
        'query-results': resolve('src/renderer/query-results.html')
      }
    }
  },
  plugins: [react()]
})
