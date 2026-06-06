import { app, BrowserWindow, Menu, shell, ipcMain, dialog, screen, protocol, net } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { pathToFileURL } from 'url'
import { is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpcHandlers } from './ipc-handlers'
import { buildMenu, type WindowListEntry } from './menu'
import { readQdpx } from './qdpx/reader'
import { createEmptyProjectFile } from './qdpx/writer'
import { initAutoUpdater, checkForUpdatesManually } from './auto-updater'
import { openBundledLicenceFile } from './licence-files'

// Register custom protocol scheme BEFORE app.ready (required by Electron)
protocol.registerSchemesAsPrivileged([
  { scheme: 'magnolia-audio', privileges: { bypassCSP: true, supportFetchAPI: true, stream: true } }
])

// Recent projects persistence
const recentProjectsPath = join(app.getPath('userData'), 'recent-projects.json')

function loadRecentProjects(): { name: string; path: string }[] {
  try {
    if (existsSync(recentProjectsPath)) {
      return JSON.parse(readFileSync(recentProjectsPath, 'utf-8'))
    }
  } catch { /* ignore */ }
  return []
}

function saveRecentProject(name: string, filePath: string): void {
  const recents = loadRecentProjects().filter((r) => r.path !== filePath)
  recents.unshift({ name, path: filePath })
  // Keep at most 10
  const trimmed = recents.slice(0, 10)
  try {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(recentProjectsPath, JSON.stringify(trimmed))
  } catch { /* ignore */ }
}

/** Drop entries whose file no longer exists on disk and persist the
 *  pruned list. Returns the live entries. Used by the welcome screen so
 *  it never offers a project that would fail to open. */
function pruneRecentProjects(): { name: string; path: string }[] {
  const all = loadRecentProjects()
  const live = all.filter((r) => existsSync(r.path))
  if (live.length !== all.length) {
    try {
      writeFileSync(recentProjectsPath, JSON.stringify(live))
    } catch { /* ignore */ }
  }
  return live
}

let welcomeWindow: BrowserWindow | null = null
let mainWindow: BrowserWindow | null = null
let codebookWindow: BrowserWindow | null = null
let logbookWindow: BrowserWindow | null = null
let memoEditWindows: Map<string, BrowserWindow> = new Map() // memo guid -> window
let pendingMemoEditDataMap: Map<string, any> = new Map() // memo guid -> init data
let pendingCodebookData: any = null
let pendingLogbookData: any = null
let isQuitting = false
let currentPanelVisibility: Record<string, boolean> | undefined = undefined

/** A .qdpx path that arrived via Finder double-click ('open-file' event)
 *  or as a command-line argument before app.whenReady() fired. The
 *  startup branch in whenReady() consumes this and bypasses the welcome
 *  screen, going straight to the main window. */
let pendingProjectPath: string | null = null

/** True for paths that look like a .qdpx project file we can actually
 *  open. Filters Electron's own argv noise (e.g. dev-mode flags, the
 *  electron binary path). */
function looksLikeQdpx(p: string | undefined | null): boolean {
  return typeof p === 'string' && p.toLowerCase().endsWith('.qdpx') && existsSync(p)
}

/** Scan process.argv for a .qdpx path. macOS cold-starts via Finder may
 *  bypass argv (delivering the path through 'open-file' instead), but
 *  Windows always passes it as an argument and `electron .` in dev does
 *  too — so we always check both pathways. */
function qdpxFromArgv(argv: string[]): string | null {
  for (const a of argv.slice(1)) {
    if (looksLikeQdpx(a)) return a
  }
  return null
}

// Capture 'open-file' events as soon as possible — they fire during
// launch on macOS when the user double-clicks a .qdpx with Magnolia
// not yet running. event.preventDefault() tells Electron we're handling
// the path ourselves; without it macOS can complain about an
// unrecognised file type. The handler runs both pre- and post-ready;
// post-ready it routes the path into the running session.
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  if (!looksLikeQdpx(filePath)) return
  if (!app.isReady()) {
    pendingProjectPath = filePath
    return
  }
  // Already running. If the welcome screen is up, dismiss it and open
  // the main window on the path. If the main window already exists,
  // hand the path off to the renderer's "open recent" channel — that
  // hot-swaps the project without a full window cycle.
  if (welcomeWindow && !welcomeWindow.isDestroyed()) {
    welcomeWindow.close()
    welcomeWindow = null
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('open-recent-project', filePath)
    mainWindow.focus()
    return
  }
  pendingProjectPath = filePath
  createWindow()
  mainWindow?.webContents.once('did-finish-load', () => {
    if (pendingProjectPath) {
      mainWindow?.webContents.send('open-recent-project', pendingProjectPath)
      pendingProjectPath = null
    }
  })
})

// Cold-start argv check for Windows / Linux / dev-launch with a .qdpx
// path appended. On packaged macOS the 'open-file' event above takes
// over — argv typically only contains the binary path.
{
  const argvPath = qdpxFromArgv(process.argv)
  if (argvPath) pendingProjectPath = argvPath
}

// Flush-on-close watchdog. The renderer pings every HEARTBEAT_INTERVAL_MS
// while it is mid-save; armFlushWatchdog/resetFlushWatchdog re-arm a timer
// that only fires after HEARTBEAT_TIMEOUT_MS of silence — i.e. only if the
// renderer has actually gone unresponsive. A long save keeps extending the
// deadline indefinitely. A renderer crash trips the watchdog and we close
// the window so the user isn't stuck.
const HEARTBEAT_TIMEOUT_MS = 4000
let flushPending = false
let flushWatchdog: NodeJS.Timeout | null = null
function armFlushWatchdog(): void {
  if (flushWatchdog) clearTimeout(flushWatchdog)
  flushWatchdog = setTimeout(() => {
    flushWatchdog = null
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
  }, HEARTBEAT_TIMEOUT_MS)
}
function clearFlushWatchdog(): void {
  if (flushWatchdog) {
    clearTimeout(flushWatchdog)
    flushWatchdog = null
  }
}

function rebuildMenu(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const entries: WindowListEntry[] = []
  const titleOf = (win: BrowserWindow) => win.getTitle().replace(' — Magnolia', '') || 'Magnolia'
  entries.push({ label: titleOf(mainWindow), window: mainWindow })
  if (codebookWindow && !codebookWindow.isDestroyed()) {
    entries.push({ label: titleOf(codebookWindow), window: codebookWindow })
  }
  if (logbookWindow && !logbookWindow.isDestroyed()) {
    entries.push({ label: titleOf(logbookWindow), window: logbookWindow })
  }
  for (const [guid, win] of memoEditWindows) {
    if (!win.isDestroyed()) {
      entries.push({ label: titleOf(win), window: win })
    }
  }
  if (queryResultsWindow && !queryResultsWindow.isDestroyed()) {
    entries.push({ label: titleOf(queryResultsWindow), window: queryResultsWindow })
  }
  buildMenu(mainWindow, entries, currentPanelVisibility)
}

function showWelcome(): void {
  welcomeWindow = new BrowserWindow({
    width: 720,
    height: 520,
    resizable: false,
    maximizable: false,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  welcomeWindow.on('ready-to-show', () => {
    welcomeWindow?.show()
  })

  // Apply our custom menu while only the welcome window is open. Without
  // this Electron falls back to the default menu, which shows
  // "About magnolia" (lowercase, from package.json's npm name) and
  // doesn't include the Acknowledgements item. File-menu items routed via
  // mainWindow.webContents.send are no-ops here (no main window exists),
  // but the about / acknowledgements / quit / etc. roles work without IPC.
  if (welcomeWindow) buildMenu(welcomeWindow)

  welcomeWindow.on('closed', () => {
    welcomeWindow = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    welcomeWindow.loadURL(
      process.env['ELECTRON_RENDERER_URL'] + '/welcome.html'
    )
  } else {
    welcomeWindow.loadFile(
      join(__dirname, '../renderer/welcome.html')
    )
  }
}

function createWindow(): void {
  const primaryDisplay = screen.getPrimaryDisplay()
  const { height: screenHeight } = primaryDisplay.workAreaSize

  mainWindow = new BrowserWindow({
    width: 1400,
    height: screenHeight,
    minWidth: 900,
    minHeight: 600,
    show: false,
    icon,
    // Chromeless main window. On macOS we keep the traffic lights
    // (inset into the toolbar's left edge via 'hiddenInset'); on
    // Windows/Linux there are no traffic lights to keep, so
    // `frame: false` removes the chrome entirely. The renderer's
    // `.app-toolbar` strip carries -webkit-app-region: drag so the
    // user can still move the window, and indents its left side on
    // macOS so the wordmark sits clear of the traffic lights.
    //
    // Traffic-light position: x=20 leaves a sensible left margin
    // and y=20 vertically centres the 14 px light cluster inside
    // the renderer's 54 px toolbar (top of the cluster sits at
    // y=20, bottom at y=34, centre at y=27 — matches the toolbar's
    // mid-line). Without this the cluster defaults to the top edge
    // of the window and reads as floating above the wordmark.
    frame: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 20 },
    acceptFirstMouse: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // Keep the renderer's custom window controls (Windows/Linux, where there
  // is no native frame) in sync with the maximised state so the
  // maximise/restore icon is correct.
  const emitMaximized = (): void => {
    mainWindow?.webContents.send('window-maximized-changed', !!mainWindow?.isMaximized())
  }
  mainWindow.on('maximize', emitMaximized)
  mainWindow.on('unmaximize', emitMaximized)

  // Prevent the window from navigating away (e.g. on file drop)
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  buildMenu(mainWindow)

  // Wire auto-update to GitHub Releases. Safe in dev — electron-updater
  // no-ops when running unpackaged.
  initAutoUpdater(mainWindow)

  // Hidden flush-on-close: intercept the close, ask the renderer to write
  // any unsaved work to its current file, then complete the close once the
  // renderer acks. flushPending guards against re-entry — when we call
  // mainWindow.close() the second time, this handler runs again and must
  // fall through. The watchdog (reset by every heartbeat the renderer
  // sends while the save is in progress) only fires when the renderer has
  // actually gone silent for HEARTBEAT_TIMEOUT_MS — so a multi-minute save
  // on a large project will keep extending it indefinitely.
  flushPending = false
  clearFlushWatchdog()
  mainWindow.on('close', (e) => {
    if (flushPending) return
    if (!mainWindow || mainWindow.isDestroyed()) return
    e.preventDefault()
    flushPending = true
    mainWindow.webContents.send('flush-and-close')
    armFlushWatchdog()
  })

  mainWindow.on('closed', () => {
    // Close all child windows
    const childWindows: (BrowserWindow | null | undefined)[] = [
      codebookWindow,
      logbookWindow,
      queryResultsWindow,
      ...memoEditWindows.values()
    ]
    for (const win of childWindows) {
      if (win && !win.isDestroyed()) win.close()
    }
    codebookWindow = null
    logbookWindow = null
    queryResultsWindow = null
    memoEditWindows.clear()
    mainWindow = null

    if (!isQuitting) showWelcome()
  })
}

// IPC: when a drag starts in a window, raise all other windows above it
// so the user can see and reach drop targets without the source window covering them.
// Also focus the topmost child window to pull focus away from the source window.
ipcMain.on('update-panel-visibility', (_event, visibility: Record<string, boolean>) => {
  currentPanelVisibility = visibility
  rebuildMenu()
})

// Custom window controls. Windows/Linux render their own minimise /
// maximise / close buttons in the toolbar (the window is frameless there);
// macOS uses the native traffic lights. Each acts on the requesting window.
ipcMain.on('window-minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
ipcMain.on('window-maximize-toggle', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w) return
  if (w.isMaximized()) w.unmaximize()
  else w.maximize()
})
ipcMain.on('window-close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
ipcMain.handle('window-is-maximized', (e) => !!BrowserWindow.fromWebContents(e.sender)?.isMaximized())

ipcMain.on('raise-child-windows', (event) => {
  const sourceWin = BrowserWindow.fromWebContents(event.sender)
  if (!sourceWin || sourceWin.isDestroyed()) return
  const others: BrowserWindow[] = []
  const allWindows = BrowserWindow.getAllWindows()
  for (const win of allWindows) {
    if (win !== sourceWin && !win.isDestroyed() && win !== welcomeWindow) {
      others.push(win)
      win.moveTop()
    }
  }
  // Focus the last raised window (topmost) to pull focus from the source
  if (others.length > 0) {
    others[others.length - 1].focus()
  }
})

// IPC: broadcast theme changes to all child windows
ipcMain.on('theme-changed', (_event, theme: string) => {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    if (!win.isDestroyed() && win.webContents.id !== _event.sender.id) {
      win.webContents.send('theme-changed', theme)
    }
  }
})

// Query Builder IPCs — round-trip through main back to mainWindow.
// The builder runs in a main-window tab now, so the renderer that
// sends here is the same one that receives the broadcast. Wasteful
// but keeps the existing event-driven flow intact; collapsing these
// into direct store calls is a future cleanup.
ipcMain.on('qb-save-query', (_event, query, name, graphLayout, savedGuid) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('qb-save-query-result', query, name, graphLayout, savedGuid)
  }
})

ipcMain.on('qb-preview-query', (_event, query) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('qb-preview-result', query)
  }
})

ipcMain.on('qb-run-query', (_event, query, editSavedQueryGuid, graphLayout) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('menu-action', 'run-query-from-builder')
    mainWindow.webContents.send('qb-query-result', query, editSavedQueryGuid, graphLayout)
  }
})

// ---- Codebook Window ----

function openCodebookWindow(initData: any): void {
  pendingCodebookData = initData

  if (codebookWindow && !codebookWindow.isDestroyed()) {
    codebookWindow.focus()
    codebookWindow.webContents.send('codebook-init-data', initData)
    return
  }

  codebookWindow = new BrowserWindow({
    width: 650,
    height: 700,
    minWidth: 450,
    minHeight: 400,
    title: 'Codes',
    show: false,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  codebookWindow.on('ready-to-show', () => {
    codebookWindow?.show()
    rebuildMenu()
  })

  codebookWindow.on('closed', () => {
    codebookWindow = null
    rebuildMenu()
  })

  codebookWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  codebookWindow.setMenuBarVisibility(false)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    codebookWindow.loadURL(
      process.env['ELECTRON_RENDERER_URL'] + '/codebook.html'
    )
  } else {
    codebookWindow.loadFile(
      join(__dirname, '../renderer/codebook.html')
    )
  }
}

ipcMain.on('open-codebook-window', (_event, initData) => {
  openCodebookWindow(initData)
})

ipcMain.handle('get-codebook-data', () => {
  return pendingCodebookData
})

// Codebook window sends updates back to main window
ipcMain.on('codebook-update', (_event, action: string, ...args: any[]) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('codebook-update', action, ...args)
  }
})

// ---- Logbook Window ----

function openLogbookWindow(initData: any): void {
  pendingLogbookData = initData

  if (logbookWindow && !logbookWindow.isDestroyed()) {
    logbookWindow.focus()
    logbookWindow.webContents.send('logbook-init-data', initData)
    return
  }

  logbookWindow = new BrowserWindow({
    width: 650,
    height: 700,
    minWidth: 450,
    minHeight: 400,
    title: 'Logbook',
    show: false,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  logbookWindow.on('ready-to-show', () => {
    logbookWindow?.show()
    rebuildMenu()
  })

  logbookWindow.on('closed', () => {
    logbookWindow = null
    rebuildMenu()
  })

  logbookWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  logbookWindow.setMenuBarVisibility(false)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    logbookWindow.loadURL(
      process.env['ELECTRON_RENDERER_URL'] + '/logbook.html'
    )
  } else {
    logbookWindow.loadFile(
      join(__dirname, '../renderer/logbook.html')
    )
  }
}

ipcMain.on('open-logbook-window', (_event, initData) => {
  openLogbookWindow(initData)
})

ipcMain.handle('get-logbook-data', () => {
  return pendingLogbookData
})

// Logbook window sends updates back to main window
ipcMain.on('logbook-update', (_event, action: string, ...args: any[]) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('logbook-update', action, ...args)
  }
})

// ---- Preferences ----

const preferencesPath = join(app.getPath('userData'), 'magnolia-preferences.json')

function loadPreferencesFromDisk(): any {
  try {
    if (existsSync(preferencesPath)) return JSON.parse(readFileSync(preferencesPath, 'utf-8'))
  } catch { /* ignore */ }
  return null
}

function savePreferencesToDisk(prefs: any): void {
  try {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(preferencesPath, JSON.stringify(prefs, null, 2))
  } catch { /* ignore */ }
}

ipcMain.handle('load-preferences', () => loadPreferencesFromDisk())
ipcMain.handle('save-preferences', (_event, prefs: any) => { savePreferencesToDisk(prefs) })

// The Preferences pane lives in a main-window tab now (no popup
// window), so `preferences-update` from the renderer just persists
// to disk and echoes back to mainWindow so the preferences-store
// listener picks up the change and re-syncs derived state across
// the rest of the renderer.
ipcMain.on('preferences-update', (_event, prefs: any) => {
  savePreferencesToDisk(prefs)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('preferences-update', prefs)
  }
})

// ---- Memo Edit Windows (multiple) ----

function openMemoEditWindow(initData: any): void {
  const memoGuid: string = initData.memo.guid
  pendingMemoEditDataMap.set(memoGuid, initData)

  // If already open for this memo, focus it
  const existing = memoEditWindows.get(memoGuid)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    existing.webContents.send('memo-edit-init-data', initData)
    return
  }

  const win = new BrowserWindow({
    width: 550,
    height: 500,
    minWidth: 400,
    minHeight: 350,
    title: 'Memos',
    show: false,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  memoEditWindows.set(memoGuid, win)

  win.on('ready-to-show', () => {
    win.show()
    rebuildMenu()
  })

  win.on('closed', () => {
    memoEditWindows.delete(memoGuid)
    pendingMemoEditDataMap.delete(memoGuid)
    rebuildMenu()
  })

  win.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  win.setMenuBarVisibility(false)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(
      process.env['ELECTRON_RENDERER_URL'] + '/memo-edit.html'
    )
  } else {
    win.loadFile(
      join(__dirname, '../renderer/memo-edit.html')
    )
  }
}

ipcMain.on('open-memo-edit-window', (_event, initData) => {
  openMemoEditWindow(initData)
})

ipcMain.handle('get-memo-edit-data', (event) => {
  // Find which memo data belongs to the requesting window
  for (const [guid, win] of memoEditWindows) {
    if (!win.isDestroyed() && win.webContents.id === event.sender.id) {
      return pendingMemoEditDataMap.get(guid) ?? null
    }
  }
  return null
})

ipcMain.on('memo-update', (_event, memo: any) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('memo-update', memo)
  }
})

ipcMain.on('memo-delete', (_event, guid: string) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('memo-delete', guid)
  }
})

// ---- Query Results Window (Pop-Out) ----

let queryResultsWindow: BrowserWindow | null = null
let pendingQueryResultsData: any = null

function openQueryResultsWindow(initData: any): void {
  pendingQueryResultsData = initData

  // If already open, update it
  if (queryResultsWindow && !queryResultsWindow.isDestroyed()) {
    queryResultsWindow.focus()
    queryResultsWindow.webContents.send('query-results-init-data', initData)
    return
  }

  const win = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 500,
    minHeight: 300,
    title: 'Queries',
    show: false,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  queryResultsWindow = win

  win.on('ready-to-show', () => {
    win.show()
  })

  win.on('closed', () => {
    queryResultsWindow = null
    // Notify main window that query results window closed
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('query-results-window-closed')
    }
  })

  win.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  win.setMenuBarVisibility(false)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/query-results.html')
  } else {
    win.loadFile(join(__dirname, '../renderer/query-results.html'))
  }
}

ipcMain.on('open-query-results-window', (_event, initData) => {
  openQueryResultsWindow(initData)
})

ipcMain.on('update-query-results-window', (_event, data) => {
  pendingQueryResultsData = data
  if (queryResultsWindow && !queryResultsWindow.isDestroyed()) {
    queryResultsWindow.webContents.send('query-results-init-data', data)
  }
})

ipcMain.on('query-results-action', (_event, action: string, payload?: any) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('query-results-action', action, payload)
  }
})

ipcMain.on('query-results-jump', (_event, target: any) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus()
    mainWindow.webContents.send('query-results-jump', target)
  }
})

ipcMain.handle('get-query-results-data', () => {
  return pendingQueryResultsData
})

// ---- Analysis actions ----
// Inline analysis tools (run in main-window tabs) hand work back to
// the App via this IPC: save-analysis, run-query, open-memo, etc.
// The roundtrip through main is now redundant (sender and receiver
// are the same renderer) but kept for compatibility with the
// existing event flow; folding it into a direct store call is a
// future cleanup.
ipcMain.on('analysis-action', (_event, action: string, ...args: any[]) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('analysis-action', action, ...args)
  }
})

// CSV and SVG export handlers
ipcMain.handle('export-csv', async (_event, content: string, defaultName: string) => {
  const { dialog } = await import('electron')
  const result = await dialog.showSaveDialog({
    defaultPath: defaultName,
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  })
  if (result.canceled || !result.filePath) return null
  const { writeFile } = await import('fs/promises')
  await writeFile(result.filePath, content, 'utf-8')
  return result.filePath
})

ipcMain.handle('export-svg', async (_event, content: string, defaultName: string) => {
  const { dialog } = await import('electron')
  const result = await dialog.showSaveDialog({
    defaultPath: defaultName,
    filters: [{ name: 'SVG', extensions: ['svg'] }]
  })
  if (result.canceled || !result.filePath) return null
  const { writeFile } = await import('fs/promises')
  await writeFile(result.filePath, content, 'utf-8')
  return result.filePath
})


// ---- Welcome Window IPC ----

ipcMain.handle('get-recent-projects', () => {
  return pruneRecentProjects()
})

ipcMain.on('welcome-action', async (_event, action: string) => {
  if (action === 'quit') {
    if (welcomeWindow && !welcomeWindow.isDestroyed()) {
      welcomeWindow.close()
      welcomeWindow = null
    }
    app.quit()
    return
  }

  if (action === 'new-project') {
    // Prompt for the file location up-front so the user knows what their
    // project is named and where it lives on disk. Mirrors the Open flow:
    // cancelling the dialog leaves them on the welcome screen.
    const result = await dialog.showSaveDialog({
      title: 'Create New Project',
      defaultPath: 'Untitled.qdpx',
      filters: [{ name: 'QDPX Projects', extensions: ['qdpx'] }]
    })
    if (result.canceled || !result.filePath) return
    const filePath = result.filePath
    let projectName: string
    try {
      projectName = await createEmptyProjectFile(filePath)
    } catch (err) {
      dialog.showErrorBox('Failed to create project', String(err))
      return
    }
    saveRecentProject(projectName, filePath)
    if (welcomeWindow && !welcomeWindow.isDestroyed()) {
      welcomeWindow.close()
      welcomeWindow = null
    }
    createWindow()
    mainWindow?.webContents.once('did-finish-load', () => {
      mainWindow?.webContents.send('new-project-at-path', { filePath, projectName })
    })
    return
  }

  if (action === 'open-project') {
    // Show file dialog BEFORE creating the main window
    const result = await dialog.showOpenDialog({
      title: 'Open QDPX Project',
      filters: [{ name: 'QDPX Projects', extensions: ['qdpx'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return // stay on welcome screen
    const filePath = result.filePaths[0]
    try {
      const data = await readQdpx(filePath)
      if (welcomeWindow && !welcomeWindow.isDestroyed()) {
        welcomeWindow.close()
        welcomeWindow = null
      }
      createWindow()
      mainWindow?.webContents.once('did-finish-load', () => {
        mainWindow?.webContents.send('open-recent-project', filePath)
      })
    } catch (err) {
      dialog.showErrorBox('Failed to open project', String(err))
    }
    return
  }

  if (action === 'clear-recent') {
    try {
      writeFileSync(recentProjectsPath, JSON.stringify([]))
    } catch { /* ignore */ }
    return
  }

  if (action.startsWith('open-recent:')) {
    const filePath = action.slice('open-recent:'.length)
    // The welcome list was filtered when it was fetched, but the file may
    // have been moved or deleted in the interim. Re-check at click time
    // and prune the dead entry instead of silently opening a blank
    // main window for a project that doesn't exist on disk.
    if (!existsSync(filePath)) {
      const remaining = loadRecentProjects().filter((r) => r.path !== filePath)
      try { writeFileSync(recentProjectsPath, JSON.stringify(remaining)) } catch { /* ignore */ }
      if (welcomeWindow && !welcomeWindow.isDestroyed()) {
        welcomeWindow.webContents.send('recent-projects-changed')
      }
      dialog.showErrorBox(
        'Project not found',
        `"${filePath}" no longer exists. It has been removed from Recent Projects.`
      )
      return
    }
    if (welcomeWindow && !welcomeWindow.isDestroyed()) {
      welcomeWindow.close()
      welcomeWindow = null
    }
    createWindow()
    mainWindow?.webContents.once('did-finish-load', () => {
      mainWindow?.webContents.send('open-recent-project', filePath)
    })
    return
  }
})

// Track recent projects when saving
ipcMain.on('track-recent-project', (_event, name: string, filePath: string) => {
  saveRecentProject(name, filePath)
})

// Renderer ack for the flush-on-close handshake. The 'close' handler
// above prevents the initial close, dispatches 'flush-and-close', and
// awaits this signal — which re-issues the close. flushPending in the
// 'close' handler ensures that re-entry falls through to the real close.
ipcMain.on('flush-and-close-complete', (event) => {
  clearFlushWatchdog()
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) win.close()
})

// Heartbeat from the renderer while a flush-on-close save is in flight.
// Each ping pushes the watchdog deadline back, so a long save (e.g. a
// project with hundreds of MB of video) keeps the window open as long as
// progress is being made. Silence trips the watchdog → force-close.
ipcMain.on('flush-heartbeat', () => {
  if (flushPending) armFlushWatchdog()
})

// Licence-text bundled-file lookups for the renderer's Licence dialog.
// Same helper as the Help menu's "Acknowledgements" item — see
// licence-files.ts for the candidate-path logic.
ipcMain.handle('open-licence', () => { openBundledLicenceFile('LICENSE') })
ipcMain.handle('open-acknowledgements', () => { openBundledLicenceFile('THIRD-PARTY-LICENSES.txt') })

app.on('before-quit', () => {
  isQuitting = true
})

// Squirrel.Mac fires `before-quit-for-update` (NOT `before-quit`) when
// autoUpdater.quitAndInstall() runs. Without flagging isQuitting here, the
// main window's `closed` handler re-opens the Welcome screen instead of
// letting the app exit, so the macOS update never installs (the app keeps
// running on the old version). Treat it as a quit, same as `before-quit`.
app.on('before-quit-for-update', () => {
  isQuitting = true
})

app.whenReady().then(() => {
  // Customise the native About panel (Cmd-? on macOS, Help → About on
  // Linux). applicationName is forced to "Magnolia" so dev builds don't
  // show the lowercase npm name; credits list the libraries we want to
  // thank explicitly. License-compliance for every dependency lives in
  // the bundled THIRD-PARTY-LICENSES.txt file.
  app.setAboutPanelOptions({
    applicationName: 'Magnolia',
    applicationVersion: app.getVersion(),
    copyright: '© 2026 Cale Davis',
    credits: [
      'Free and open-source qualitative data analysis.',
      '',
      'https://github.com/caledavis/Magnolia',
      '',
      'Built with Electron, React, TipTap, and PDF.js. Icons by Lucide.'
    ].join('\n')
  })

  // Register magnolia-audio:// protocol to serve audio temp files to the renderer.
  // This avoids passing huge base64 strings through IPC or using file:// URLs
  // (which are blocked by fetch() in Chromium).
  protocol.handle('magnolia-audio', (request) => {
    // URL format: magnolia-audio://load/<filename>
    const url = new URL(request.url)
    const filename = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    const tempDir = join(app.getPath('temp'), 'magnolia-audio')
    const filePath = join(tempDir, filename)
    return net.fetch(pathToFileURL(filePath).toString())
  })

  // Show OS spell-check suggestions on right-click in any editable field.
  // Electron's built-in spellchecker flags misspellings (using the native
  // macOS checker / Hunspell on Windows/Linux); we just need to surface a
  // menu so the user can pick a correction or add the word to the dictionary.
  app.on('web-contents-created', (_evt, wc) => {
    wc.on('context-menu', (_e, params) => {
      if (!params.misspelledWord) return
      const template: Electron.MenuItemConstructorOptions[] = params.dictionarySuggestions.map((s) => ({
        label: s,
        click: () => wc.replaceMisspelling(s)
      }))
      if (template.length === 0) {
        template.push({ label: 'No suggestions', enabled: false })
      }
      template.push({ type: 'separator' })
      template.push({
        label: 'Add to Dictionary',
        click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord)
      })
      Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(wc) || undefined })
    })
  })

  registerIpcHandlers()

  // If the user launched Magnolia by double-clicking a .qdpx (or passed
  // one on the command line), skip the welcome screen and open the
  // project directly. Otherwise show the welcome screen as usual.
  if (pendingProjectPath) {
    const filePath = pendingProjectPath
    createWindow()
    mainWindow?.webContents.once('did-finish-load', () => {
      mainWindow?.webContents.send('open-recent-project', filePath)
      pendingProjectPath = null
    })
  } else {
    showWelcome()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      showWelcome()
    }
  })
})

app.on('window-all-closed', () => {
  // The flush-on-close handshake calls e.preventDefault() on the main
  // window's first 'close' event so the renderer can finish saving.
  // That preventDefault also cancels the in-flight quit triggered by
  // Cmd-Q / menu Quit, leaving the app running with no windows after
  // the flush completes. Re-trigger app.quit() here so the user's quit
  // intent actually takes effect once every window is gone.
  if (isQuitting) {
    app.quit()
    return
  }
  // Otherwise, the user just closed the main window (X button) and the
  // mainWindow 'closed' handler has already reopened the welcome screen.
  // On macOS, apps conventionally stay running with no windows.
})
