/**
 * `window.api` — the renderer's bridge to the Rust backend.
 *
 * Implements the MagnoliaAPI interface (models/types.ts) the components were
 * written against, on top of Tauri: file I/O, dialogs, conversion and window
 * management are Rust commands (src-tauri/src/commands.rs); pushes from the
 * backend arrive as events targeted at this window; messages between windows
 * (codebook → main, etc.) are emitted straight to the target window.
 *
 * Import this module first in every entry point so `window.api` exists
 * before any component touches it.
 */
import { invoke } from '@tauri-apps/api/core'
import { emit, emitTo } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import type { MagnoliaAPI } from '../models/types'
import { base64ToBytes, extractPdfText } from './pdf-text'

const current = getCurrentWebviewWindow()
const MAIN = 'main'

const platform = /Mac/i.test(navigator.userAgent)
  ? 'darwin'
  : /Windows/i.test(navigator.userAgent)
    ? 'win32'
    : 'linux'

// The open project's .qdpx, forwarded with every binary read so resolution
// survives a backend that lost track of it (mirrors the Electron preload).
let activeProjectPath: string | null = null

/** Subscribe to an event targeted at this window. */
function on<T>(event: string, callback: (payload: T) => void): () => void {
  let unlisten: (() => void) | null = null
  let disposed = false
  void current.listen<T>(event, (e) => callback(e.payload)).then((u) => {
    if (disposed) u()
    else unlisten = u
  })
  return () => {
    disposed = true
    unlisten?.()
  }
}

/** Like `on`, for messages the backend may send before this window's
 *  renderer has subscribed (e.g. "open this project" to a just-created main
 *  window): it queues them, and we drain the queue on subscribe and whenever
 *  it signals more. */
function onQueued<T>(event: string, callback: (payload: T) => void): () => void {
  const drain = async (): Promise<void> => {
    const items = await invoke<T[]>('drain_queued_events', { event })
    for (const item of items) callback(item)
  }
  const unlisten = on<{ event: string }>('queued-event-available', (p) => {
    if (p.event === event) void drain()
  })
  void drain()
  return unlisten
}

// ── PDF text ──────────────────────────────────────────────────────────

type ProgressCallback = (p: { stage: string; current: number; total: number }) => void
const localProgress = new Set<ProgressCallback>()

/** Fill in text + page offsets for PDFs the backend flagged
 *  `_pendingPdfText` in a loaded project. `readBytes` fetches a source's
 *  PDF by its handle. */
async function completeProjectPdfText(
  data: any,
  readBytes: (handle: string) => Promise<Uint8Array | null>
): Promise<any> {
  if (!data?.sources) return data
  const pending = data.sources.filter((s: any) => s._pendingPdfText)
  let done = 0
  for (const source of pending) {
    delete source._pendingPdfText
    const fd = source.formatData ?? {}
    const handle = fd.pdfFilePath
    try {
      const bytes = fd.pdfBase64 ? base64ToBytes(fd.pdfBase64) : handle ? await readBytes(handle) : null
      if (bytes) {
        const { text, pageOffsets } = await extractPdfText(bytes)
        data.sourceContents[source.guid] = text
        if (!fd.pdfPageOffsets?.length) source.formatData = { ...fd, pdfPageOffsets: pageOffsets }
      }
    } catch (err) {
      // Still viewable; just no searchable text.
      console.error(`Failed to extract text from PDF ${source.guid}:`, err)
    }
    done++
    for (const cb of localProgress) cb({ stage: 'Reading PDF text', current: done, total: pending.length })
  }
  return data
}

/** Same for an imported document: `formatting.pdfBase64` → content. */
async function completeImportedPdf(doc: any): Promise<any> {
  if (!doc?._pendingPdfText) return doc
  delete doc._pendingPdfText
  try {
    const { text, pageOffsets } = await extractPdfText(base64ToBytes(doc.formatting.pdfBase64))
    doc.content = text
    doc.formatting.pdfPageOffsets = pageOffsets
    return doc
  } catch (err: any) {
    return { name: doc.name, error: err?.message || String(err) }
  }
}

async function completeImports(result: any): Promise<any> {
  if (Array.isArray(result)) return Promise.all(result.map(completeImportedPdf))
  return completeImportedPdf(result)
}

async function readMedia(handle: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>('read_media', { handle, archivePath: activeProjectPath })
}

async function openedProject(data: any): Promise<any> {
  if (!data) return data
  return completeProjectPdfText(data, async (h) => new Uint8Array(await readMedia(h)))
}

// ── OS file drops ─────────────────────────────────────────────────────
// The webview gives dropped files' bytes but not their paths, so
// getPathForFile returns a token and readTextFiles uploads the bytes.

const DROP_PREFIX = 'magnolia-drop://'
const droppedFiles = new Map<string, File>()
let nextDropId = 1

async function readDroppedFile(file: File): Promise<any> {
  let bytes: ArrayBuffer
  try {
    bytes = await file.arrayBuffer()
  } catch {
    // WebKit can't read a dropped folder as bytes.
    return { name: file.name, error: "Folders can't be imported. Drop the files inside it instead." }
  }
  const doc = await invoke('read_dropped_file', new Uint8Array(bytes), {
    headers: { 'x-file-name': encodeURIComponent(file.name) }
  })
  return completeImportedPdf(doc)
}

// ── Window chrome ─────────────────────────────────────────────────────

/** Emulate Electron's `-webkit-app-region` (WebKit ignores it): a mousedown
 *  in a drag region that isn't on an interactive element moves the window,
 *  and a double-click toggles maximise/zoom as a native title bar would. */
const DRAG_REGION = '.app-toolbar, [data-drag-region]'
const NO_DRAG = 'button, a, input, select, textarea, [contenteditable="true"], .app-toolbar-scroll-inner, [data-no-drag]'

function inDragRegion(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null
  if (!el || el.closest(NO_DRAG)) return false
  return !!el.closest(DRAG_REGION)
}

// A double-click counts only when its first click was in a drag region too:
// WebKit pairs two quick clicks wherever they land, so clicking a dialog
// button and then the toolbar would otherwise maximise the window.
let firstClickInDragRegion = false
window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  const inRegion = inDragRegion(e.target)
  if (e.detail <= 1) firstClickInDragRegion = inRegion
  if (e.detail > 1 || !inRegion) return
  void current.startDragging()
})
window.addEventListener('dblclick', (e) => {
  if (firstClickInDragRegion && inDragRegion(e.target)) void current.toggleMaximize()
})

// Electron mirrored the page <title> into the window title (used by the
// View menu's window list); do the same.
function syncTitle(): void {
  if (!document.title) return
  void current.setTitle(document.title).then(() => invoke('window_title_changed'))
}
new MutationObserver(syncTitle).observe(document.head ?? document.documentElement, {
  subtree: true,
  childList: true,
  characterData: true
})
window.addEventListener('DOMContentLoaded', syncTitle)

// When a drag starts in the main window, raise the other windows so their
// drop targets are reachable.
window.addEventListener('dragstart', () => {
  if (current.label !== MAIN) return
  if ((window as any).__suppressRaiseChildWindows) return
  void invoke('raise_other_windows')
})

// ── The API ───────────────────────────────────────────────────────────

const toMain = (event: string, payload?: unknown): void => {
  void emitTo(MAIN, event, payload)
}

const api: MagnoliaAPI = {
  getFileSize: (filePath) => invoke('get_file_size', { filePath }),
  readPdfFile: async (filePath) => new Uint8Array(await readMedia(filePath)),
  setActiveProjectPath: async (filePath) => {
    activeProjectPath = filePath || null
    await invoke('set_active_project_path', { filePath })
  },
  onProjectLoadProgress: (callback) => {
    localProgress.add(callback)
    const unlisten = on('project-load-progress', callback)
    return () => {
      localProgress.delete(callback)
      unlisten()
    }
  },
  openProject: async () => openedProject(await invoke('open_project')),
  pickProjectFile: () => invoke('pick_project_file'),
  openProjectPath: async (filePath) => openedProject(await invoke('open_project_path', { filePath })),
  readCheckoutMarker: (filePath) => invoke('read_checkout_marker', { filePath }),
  checkOutProject: (filePath, userName, steal) => invoke('check_out_project', { filePath, userName, steal }),
  checkInProject: (filePath, userName) => invoke('check_in_project', { filePath, userName }),
  readQdpxForCompare: async (filePath) => {
    const data = await invoke<any>('read_qdpx_for_compare', { filePath })
    // The comparison file isn't the active archive: read its PDFs from it.
    return completeProjectPdfText(data, async (handle) => {
      const buf = await invoke<ArrayBuffer>('read_compare_binary', { comparisonFilePath: filePath, handle })
      return buf.byteLength ? new Uint8Array(buf) : null
    })
  },
  importMergeBinary: (comparisonFilePath, handle) => invoke('import_merge_binary', { comparisonFilePath, handle }),
  readCompareBinary: async (comparisonFilePath, handle) => {
    const buf = await invoke<ArrayBuffer>('read_compare_binary', { comparisonFilePath, handle })
    return buf.byteLength ? new Uint8Array(buf) : null
  },
  saveProject: (data) => invoke('save_project', { data }),
  saveProjectAs: (data) => invoke('save_project_as', { data }),
  createProjectCopy: (data) => invoke('create_project_copy', { data }),
  createNewProjectFile: () => invoke('create_new_project_file'),
  importTextFile: async () => completeImports(await invoke('import_text_file')),
  readTextFiles: async (filePaths) => {
    const out: any[] = []
    for (const p of filePaths) {
      const file = droppedFiles.get(p)
      if (file) {
        droppedFiles.delete(p)
        out.push(await readDroppedFile(file))
      } else {
        out.push(...(await completeImports(await invoke<any[]>('read_text_files', { filePaths: [p] }))))
      }
    }
    return out
  },
  getPathForFile: (file) => {
    const token = `${DROP_PREFIX}${nextDropId++}/${file.name}`
    droppedFiles.set(token, file)
    return token
  },
  reimportDocument: async (sourceType) => completeImports(await invoke('reimport_document', { sourceType })),
  openLicence: () => invoke('open_licence'),
  openAcknowledgements: () => invoke('open_acknowledgements'),
  readAudioFile: readMedia,
  readImageFile: readMedia,
  readVideoFile: readMedia,
  importTranscript: () => invoke('import_transcript'),
  exportPdf: (html, defaultName, dialogTitle, headerTemplate, footerTemplate) =>
    invoke('export_pdf', { html, defaultName, dialogTitle, headerTemplate, footerTemplate }),
  exportCodebook: (codes) => invoke('export_codebook', { codes }),
  importCodebook: () => invoke('import_codebook'),
  showNewQueryDialog: () => {},

  // Query builder (runs in a main-window tab; round-trips main → main).
  onQueryFromBuilder: (callback) =>
    on<{ query: any; editSavedQueryGuid?: string; graphLayout?: any }>('qb-query-result', (p) =>
      callback(p.query, p.editSavedQueryGuid, p.graphLayout)
    ),
  sendQueryToMain: (query, editSavedQueryGuid, graphLayout) => {
    toMain('menu-action', 'run-query-from-builder')
    toMain('qb-query-result', { query, editSavedQueryGuid, graphLayout })
  },
  sendPreviewToMain: (query, graphLayout) => toMain('qb-preview-result', { query, graphLayout }),
  onPreviewFromBuilder: (callback) => on<any>('qb-preview-result', (p) => callback(p.query, p.graphLayout)),
  sendSaveQueryToMain: (query, name, graphLayout, savedGuid) => toMain('qb-save-query-result', { query, name, graphLayout, savedGuid }),
  onSaveQueryFromBuilder: (callback) =>
    on<any>('qb-save-query-result', (p) => callback(p.query, p.name, p.graphLayout, p.savedGuid)),
  onMenuAction: (callback) => on<string>('menu-action', callback),

  // Theme and interface scale broadcast to every other window.
  broadcastTheme: (theme) => void emit('theme-changed', { theme, from: current.label }),
  onThemeChanged: (callback) =>
    on<{ theme: string; from: string }>('theme-changed', (p) => {
      if (p.from !== current.label) callback(p.theme)
    }),
  setZoomFactor: (factor) => {
    // Read by the window-corner radius rules in global.css.
    document.documentElement.style.setProperty('--window-zoom', String(factor))
    void getCurrentWebview().setZoom(factor)
  },
  broadcastZoomFactor: (factor) => void emit('zoom-factor-changed', { factor, from: current.label }),
  onZoomFactorChanged: (callback) =>
    on<{ factor: number; from: string }>('zoom-factor-changed', (p) => {
      if (p.from !== current.label) callback(p.factor)
    }),

  // Codebook window
  openCodebookWindow: (data) => void invoke('open_child_window', { kind: 'codebook', data }),
  getCodebookData: () => invoke('get_window_data'),
  onCodebookData: (callback) => on('codebook-init-data', callback),
  sendCodebookUpdate: (action, ...args) => toMain('codebook-update', { action, args }),
  onCodebookUpdate: (callback) => on<any>('codebook-update', (p) => callback(p.action, ...p.args)),

  // Welcome window
  sendWelcomeAction: (action) => void invoke('welcome_action', { action }),
  getRecentProjects: () => invoke('get_recent_projects'),
  onOpenRecentProject: (callback) => onQueued<string>('open-recent-project', callback),
  onNewProjectAtPath: (callback) => onQueued<{ filePath: string; projectName: string }>('new-project-at-path', callback),
  onFlushAndClose: (callback) => on('flush-and-close', () => callback()),
  notifyFlushComplete: () => void invoke('flush_complete'),
  sendFlushHeartbeat: () => void invoke('flush_heartbeat'),
  trackRecentProject: (name, filePath) => void invoke('track_recent_project', { name, filePath }),
  onRecentProjectsChanged: (callback) => on('recent-projects-changed', () => callback()),

  // Memo edit windows
  openMemoEditWindow: (data) => void invoke('open_child_window', { kind: 'memo-edit', data }),
  getMemoEditData: () => invoke('get_window_data'),
  onMemoEditData: (callback) => on('memo-edit-init-data', callback),
  sendMemoUpdate: (memo) => toMain('memo-update', memo),
  onMemoUpdate: (callback) => on('memo-update', callback),
  sendMemoDelete: (guid) => toMain('memo-delete', guid),
  onMemoDelete: (callback) => on('memo-delete', callback),

  // Logbook window
  openLogbookWindow: (data) => void invoke('open_child_window', { kind: 'logbook', data }),
  getLogbookData: () => invoke('get_window_data'),
  onLogbookData: (callback) => on('logbook-init-data', callback),
  sendLogbookUpdate: (action, ...args) => toMain('logbook-update', { action, args }),
  onLogbookUpdate: (callback) => on<any>('logbook-update', (p) => callback(p.action, ...p.args)),

  // Analysis actions (main → main)
  sendAnalysisAction: (action, ...args) => toMain('analysis-action', { action, args }),
  onAnalysisAction: (callback) => on<any>('analysis-action', (p) => callback(p.action, ...p.args)),

  exportCsv: (content, defaultName) => invoke('export_csv', { content, defaultName }),
  exportSvg: (content, defaultName) => invoke('export_svg', { content, defaultName }),
  focusWindow: () => void invoke('raise_other_windows'),

  // Custom window controls (Windows/Linux frameless windows)
  minimizeWindow: () => void current.minimize(),
  toggleMaximizeWindow: () => void current.toggleMaximize(),
  closeWindow: () => void current.close(),
  isWindowMaximized: () => current.isMaximized(),
  onWindowMaximizedChanged: (callback) => {
    let unlisten: (() => void) | null = null
    let disposed = false
    void current
      .onResized(async () => callback(await current.isMaximized()))
      .then((u) => (disposed ? u() : (unlisten = u)))
    return () => {
      disposed = true
      unlisten?.()
    }
  },

  // Auto-update
  onUpdateAvailable: (callback) => on('update-available', callback),
  installUpdate: () => void invoke('update_install'),
  skipUpdateVersion: (version) => void invoke('update_skip', { version }),
  remindUpdateLater: () => void invoke('update_remind_later'),
  getAppVersion: () => invoke('get_app_version'),
  checkForUpdates: () => void invoke('check_for_updates'),
  onUpdateStatus: (callback) => on('update:status', callback as any),
  getUpdateBadge: () => invoke('get_update_badge'),
  onUpdateBadge: (callback) => on('update:badge', callback as any),

  // Query results window (pop-out)
  openQueryResultsWindow: (data) => void invoke('open_child_window', { kind: 'query-results', data }),
  updateQueryResultsWindow: (data) => void invoke('update_query_results_window', { data }),
  getQueryResultsData: () => invoke('get_window_data'),
  onQueryResultsData: (callback) => on('query-results-init-data', callback),
  sendQueryResultsAction: (action, payload) => toMain('query-results-action', { action, payload }),
  onQueryResultsAction: (callback) => on<any>('query-results-action', (p) => callback(p.action, p.payload)),
  jumpToQueryResult: (target) => {
    toMain('query-results-jump', target)
    void invoke('focus_main_window')
  },
  onJumpToQueryResult: (callback) => on('query-results-jump', callback),
  onQueryResultsClosed: (callback) => on('query-results-window-closed', () => callback()),

  updatePanelVisibility: (visibility) => void invoke('update_panel_visibility', { visibility }),

  // Preferences
  loadPreferences: () => invoke('load_preferences'),
  savePreferences: (prefs) => invoke('save_preferences', { prefs }),
  sendPreferencesUpdate: (prefs) => void invoke('preferences_update', { prefs }),
  onPreferencesUpdate: (callback) => on('preferences-update', callback)
}

// Synchronous at startup so CSS / components can branch on it.
;(api as any).platform = platform
;(window as any).api = api
