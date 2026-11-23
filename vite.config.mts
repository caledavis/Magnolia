import { join, resolve, sep } from 'path'
import { cpSync, createReadStream, readFileSync, statSync } from 'fs'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const appVersion: string = JSON.parse(readFileSync(resolve('package.json'), 'utf-8')).version

/** pdf.js's standard fonts and CMaps (see src/renderer/utils/pdfjs.ts), at
 *  /pdfjs/<dir>/ beside the pages: served from node_modules in development,
 *  copied into the build. */
function pdfjsAssets(): Plugin {
  const dirs = ['standard_fonts', 'cmaps']
  const from = resolve('node_modules/pdfjs-dist')
  return {
    name: 'magnolia-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/pdfjs\/(standard_fonts|cmaps)\/([^?#]+)/.exec(req.url ?? '')
        if (!m) return next()
        const dir = join(from, m[1])
        const file = join(dir, decodeURIComponent(m[2]))
        if (!file.startsWith(dir + sep) || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
          res.statusCode = 404
          return res.end()
        }
        res.setHeader('Content-Type', 'application/octet-stream')
        createReadStream(file).pipe(res)
      })
    },
    writeBundle(options) {
      for (const dir of dirs) cpSync(join(from, dir), join(options.dir!, 'pdfjs', dir), { recursive: true })
    }
  }
}

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
        memos: resolve('src/renderer/memos.html'),
        welcome: resolve('src/renderer/welcome.html'),
        'memo-edit': resolve('src/renderer/memo-edit.html'),
        'query-results': resolve('src/renderer/query-results.html'),
        'intercoder-results': resolve('src/renderer/intercoder-results.html'),
        update: resolve('src/renderer/update.html')
      }
    }
  },
  plugins: [react(), pdfjsAssets()]
})
