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
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { emit, emitTo } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import type { ByteSource, ImportedFile, ImportItem, ImportState, MagnoliaAPI, Project, Query, QueryGraphLayout, TextSource } from '../models/types'
import type { WindowSender } from '../models/window-messages'
import { base64ToBytes, extractPdfText } from './pdf-text'
import { t } from '../i18n'
import { withDocumentLanguage } from '../utils/document-language'
import { guardComposition } from '../utils/keys'
import { buildPdfTextMap, forgetDrawnText, setDrawnText } from '../utils/pdf-text-map'

const current = getCurrentWebviewWindow()
const MAIN = 'main'

const platform: MagnoliaAPI['platform'] = /Mac/i.test(navigator.userAgent)
  ? 'darwin'
  : /Windows/i.test(navigator.userAgent)
    ? 'win32'
    : 'linux'

/** Preferences that couldn't be saved (a full disk, a settings folder that
 *  can't be written): tell the user, at most once a minute, since every
 *  change saves and a failing disk fails them all. */
let preferencesFailureShownAt = 0
function reportPreferencesNotSaved(err: unknown): void {
  console.error('Preferences not saved:', err)
  if (Date.now() - preferencesFailureShownAt < 60_000) return
  preferencesFailureShownAt = Date.now()
  void invoke('show_message', { message: t('prefs.saveFailed', { detail: String(err) }), kind: 'warning' }).catch(() => {})
}

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

/** A project as the backend reads it, before its PDFs' text is filled in:
 *  sources the backend couldn't read text from are flagged. */
type LoadedProject = Project & { sourceContents: Record<string, string> }
type PendingPdfText = { _pendingPdfText?: boolean }
/** A PDF whose text came from its project file (its REFI-QDA representation). */
type FromFile = { _textFromFile?: boolean }
/** A whole-document coding's passage on a PDF whose text isn't read yet
 *  (magnolia-core reader.rs place_document_codings). */
type WholeDocument = TextSource['selections'][number] & { _wholeDocument?: boolean }

/** A file as the backend reads it for import: a PDF's text is still to be
 *  read here (from formatting.pdfBase64) when it's flagged. */
type RawImport = ImportedFile & PendingPdfText
const localProgress = new Set<ProgressCallback>()

/** Fill in text + page offsets for PDFs the backend flagged
 *  `_pendingPdfText` in a loaded project. `readBytes` fetches a source's
 *  PDF by its handle. */
async function completeProjectPdfText<T extends LoadedProject | null>(
  data: T,
  readBytes: (handle: string) => Promise<Uint8Array | null>,
  /** Report progress to the project-loading overlay. Off for a file read
   *  alongside the open project (merge, inter-coder agreement): nothing
   *  would close the overlay afterwards. */
  reportProgress = true
): Promise<T> {
  if (!data?.sources) return data
  // Only the open project's PDFs are drawn by the viewer.
  const forViewer = reportProgress
  if (forViewer) forgetDrawnText()
  const pending = (data.sources as (TextSource & PendingPdfText)[]).filter((s) => s._pendingPdfText)
  let done = 0
  for (const source of pending) {
    delete source._pendingPdfText
    const fd = source.formatData ?? {}
    const fromFileFlag = (source as FromFile)._textFromFile
    delete (source as FromFile)._textFromFile
    const handle = fd.pdfFilePath
    try {
      const bytes = fd.pdfBase64 ? base64ToBytes(fd.pdfBase64) : handle ? await readBytes(handle) : null
      if (bytes) {
        const { text: drawnText, pageOffsets: drawnPageOffsets } = await extractPdfText(bytes)
        // The PDF's text is the one its file carries, where its passages
        // are (magnolia-core reader.rs); pdf.js's reading is what's drawn.
        const fromFile = fromFileFlag === true
        const text = fromFile ? data.sourceContents[source.guid] : drawnText
        if (!fromFile) data.sourceContents[source.guid] = text
        const map = buildPdfTextMap(text, drawnText)
        if (forViewer) setDrawnText(source.guid, map, drawnPageOffsets)
        // Page offsets are positions in the PDF's text: kept if the file
        // has them, else where each drawn page starts.
        if (!fd.pdfPageOffsets?.length) {
          source.formatData = { ...fd, pdfPageOffsets: drawnPageOffsets.map((o) => map.toDoc(o, 'start')) }
        }
        // A coding of the whole PDF (from another program) covers all of
        // its text, now that there is some.
        source.selections = source.selections.map((sel) => {
          if (!(sel as WholeDocument)._wholeDocument) return sel
          const { _wholeDocument: _flag, ...rest } = sel as WholeDocument
          void _flag
          return { ...rest, startPosition: 0, endPosition: Array.from(text).length }
        })
      }
    } catch (err) {
      // Still viewable; just no searchable text.
      console.error(`Failed to extract text from PDF ${source.guid}:`, err)
    }
    done++
    if (reportProgress) for (const cb of localProgress) cb({ stage: t('pdfText.reading'), current: done, total: pending.length })
  }
  return data
}

/** Same for an imported document: `formatting.pdfBase64` → content. */
async function completeImportedPdf(doc: RawImport): Promise<ImportedFile> {
  if (!doc._pendingPdfText || doc.error !== undefined) return doc
  delete doc._pendingPdfText
  const formatting = doc.formatting
  try {
    // An imported PDF's bytes come with it; without them it can't be read.
    if (!formatting?.pdfBase64) throw new Error('The imported PDF has no bytes')
    const { text, pageOffsets } = await extractPdfText(base64ToBytes(formatting.pdfBase64))
    doc.content = text
    formatting.pdfPageOffsets = pageOffsets
    return doc
  } catch (err) {
    // pdf.js's messages are technical; say what's wrong in plain words.
    console.error(`Could not read the PDF ${doc.name}:`, err)
    const password = err instanceof Error && err.name === 'PasswordException'
    return { name: doc.name, error: t(password ? 'importProgress.pdfPassword' : 'importProgress.pdfDamaged') }
  }
}


async function readMedia(handle: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>('read_media', { handle, archivePath: activeProjectPath })
}

// Audio and video are streamed (src-tauri/src/media.rs): the players load a
// URL answered in byte ranges, and the waveform reads only what it needs —
// never the whole recording at once. On Linux the players can't load the
// magnolia-media: scheme, so the backend serves the same over loopback HTTP
// and puts its address in every window.
declare global {
  interface Window { __MAGNOLIA_MEDIA_BASE__?: string; __MAGNOLIA_APPIMAGE__?: boolean }
}

function mediaUrl(handle: string, mimeType?: string): string {
  const query = new URLSearchParams()
  if (activeProjectPath) query.set('project', activeProjectPath)
  if (mimeType) query.set('type', mimeType)
  const q = query.toString()
  const base = window.__MAGNOLIA_MEDIA_BASE__
  const url = base ? `${base}/${encodeURIComponent(handle)}` : convertFileSrc(handle, 'magnolia-media')
  return url + (q ? `?${q}` : '')
}

async function openMedia(handle: string): Promise<ByteSource> {
  const archivePath = activeProjectPath
  const size = await invoke<number>('media_size', { handle, archivePath })
  return {
    size,
    read: async (start, end) =>
      new Uint8Array(await invoke<ArrayBuffer>('read_media_range', { handle, start, end, archivePath }))
  }
}

async function openedProject<T extends LoadedProject | null>(data: T): Promise<T> {
  if (!data) return data
  return completeProjectPdfText(data, async (h) => new Uint8Array(await readMedia(h)))
}

// ── Importing documents ───────────────────────────────────────────────
// Files are read one at a time, reporting each one's stage: the backend
// reads it (and typesets Word, RTF and ODT files as PDFs), then a PDF's
// text is read here.

const importProgress = new Set<(s: ImportState) => void>()
const OFFICE = /\.(docx|rtf|odt)$/i

async function readImports(filePaths: string[]): Promise<ImportedFile[]> {
  const items: ImportItem[] = filePaths.map((p) => ({
    name: droppedFiles.get(p)?.name ?? p.split(/[\\/]/).pop() ?? p,
    stage: 'waiting'
  }))
  const report = (finished = false) => {
    const state = { items: items.map((it) => ({ ...it })), finished }
    for (const cb of importProgress) cb(state)
  }
  const out: ImportedFile[] = []
  for (const [i, p] of filePaths.entries()) {
    const item = items[i]
    item.stage = OFFICE.test(item.name) ? 'converting' : 'reading'
    report()
    let doc: RawImport
    try {
      const file = droppedFiles.get(p)
      if (file) {
        droppedFiles.delete(p)
        droppedAt.delete(p)
        doc = await readDroppedFile(file)
      } else {
        doc = (await invoke<RawImport[]>('read_text_files', { filePaths: [p] }))[0]
      }
      if (doc?._pendingPdfText) {
        item.stage = 'readingText'
        report()
      }
      doc = await completeImportedPdf(doc)
    } catch (err) {
      doc = { name: item.name, error: (err instanceof Error && err.message) || String(err) }
    }
    if (doc?.error) {
      item.stage = 'failed'
      item.error = doc.error
    } else {
      item.stage = 'done'
    }
    out.push(doc)
  }
  report(true)
  return out
}

// ── OS file drops ─────────────────────────────────────────────────────
// The webview gives dropped files' bytes but not their paths, so
// getPathForFile returns a token, and readDroppedFile reads the file from
// disk if the backend can find it there, otherwise uploads its bytes.

const DROP_PREFIX = 'magnolia-drop://'
const droppedFiles = new Map<string, File>()
/** When each token was made: a drop's files are read straight away (and
 *  forgotten as they are), so one still here long after was dropped on
 *  something that never imported it — forgotten then, rather than held
 *  (a dropped video can be gigabytes) until the window closes. */
const droppedAt = new Map<string, number>()
const DROP_KEPT_MS = 10 * 60_000
function forgetStaleDrops(now: number): void {
  for (const [token, at] of droppedAt) {
    if (now - at < DROP_KEPT_MS) continue
    droppedAt.delete(token)
    droppedFiles.delete(token)
  }
}
let nextDropId = 1

async function readDroppedFile(file: File): Promise<RawImport> {
  // Read it from disk where the backend can find it (macOS and Linux): far
  // quicker than reading a large video into the page and sending it over IPC.
  const path = await invoke<string | null>('dropped_file_path', { name: file.name, size: file.size })
    .catch(() => null)
  if (path) return (await invoke<RawImport[]>('read_text_files', { filePaths: [path] }))[0]
  let bytes: ArrayBuffer
  try {
    bytes = await file.arrayBuffer()
  } catch {
    // WebKit can't read a dropped folder as bytes.
    return { name: file.name, error: t('native.import.folder') }
  }
  return invoke('read_dropped_file', new Uint8Array(bytes), {
    headers: { 'x-file-name': encodeURIComponent(file.name) }
  })
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
  // On Linux and Windows the first click's drag hands the mouse to the
  // window manager, which keeps the release, so the page never sees a
  // dblclick: toggle on the second press instead, as Tauri's own drag
  // regions do.
  if (e.detail === 2 && platform !== 'darwin' && firstClickInDragRegion && inRegion) {
    e.preventDefault()
    void current.toggleMaximize()
    return
  }
  if (e.detail > 1 || !inRegion) return
  void current.startDragging()
})
window.addEventListener('dblclick', (e) => {
  if (platform === 'darwin' && firstClickInDragRegion && inDragRegion(e.target)) void current.toggleMaximize()
})

// Keep the window's own background the colour of the page's, so a
// transparent macOS title bar (the pop-out windows have one) matches the
// page beneath it. Re-run whenever the theme changes.
function syncWindowBackground(): void {
  requestAnimationFrame(() => {
    const m = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g)
    if (!m || m.length < 3) return
    const [r, g, b] = m.map(Number)
    void current.setBackgroundColor([r, g, b, 255]).catch(() => { /* not supported here */ })
    // GTK draws the menu bar and the file dialogs in the system's light or
    // dark style; match them to Magnolia's theme instead, so Magnolia Dark
    // on a light desktop doesn't get a white menu bar above it.
    if (platform === 'linux') {
      const dark = 0.2126 * r + 0.7152 * g + 0.0722 * b < 128
      void current.setTheme(dark ? 'dark' : 'light').catch(() => { /* not supported here */ })
    }
  })
}
if (document.body) syncWindowBackground()
else window.addEventListener('DOMContentLoaded', syncWindowBackground, { once: true })
new MutationObserver(syncWindowBackground).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

// Electron mirrored the page <title> into the window title (used by the
// View menu's window list); do the same. The observer sees every change
// to <head>, so only a new title is passed on. The " — Edited" marker is
// left out: on macOS a title change resets the traffic lights, which then
// visibly jump back into place, and editing or saving shouldn't do that.
let syncedTitle = ''
function syncTitle(): void {
  const title = document.title.replace(' — Edited', '')
  if (!title || title === syncedTitle) return
  syncedTitle = title
  void current.setTitle(title).then(() => invoke('window_title_changed'))
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
  if (window.__suppressRaiseChildWindows) return
  void invoke('raise_other_windows')
})

// ── The API ───────────────────────────────────────────────────────────

const toMain = (event: string, payload?: unknown): void => {
  void emitTo(MAIN, event, payload)
}

// ── Which project a window is for ─────────────────────────────────────
// The Codebook, Logbook, Memos and memo edit windows stay open when the
// main window opens another project, and what they then sent landed in
// that one (a memo from the old project added to the new). So the main
// window stamps the data it sends them with its project's file, each of
// these windows sends it back at the top level of every message (the
// windows themselves do, in components/to-main-window.ts; the senders
// below do the same), and the main window refuses a message for another
// project (app/window-project.ts). A message without it is taken to be
// for the open project.

/** The data's project, from the main window (left as it is elsewhere, and
 *  while the project has no file yet). */
function stampProject<T extends object>(data: T): T & { projectPath?: string } {
  return current.label === MAIN && activeProjectPath ? { ...data, projectPath: activeProjectPath } : data
}

/** In one of those windows: the project of the data it last got. */
let windowProjectPath: string | undefined
function noteData<T>(data: T): T {
  if (data && typeof data === 'object') windowProjectPath = (data as { projectPath?: string }).projectPath
  return data
}

/** A message from one of those windows to the main window, with its project. */
const toMainFrom = (event: string, body: object): void => toMain(event, { ...body, projectPath: windowProjectPath })

/** Such a message, received in the main window: the message, and its project. */
function onFrom<T extends object>(event: string, callback: (body: T, from: WindowSender) => void): () => void {
  return on<T & { projectPath?: string }>(event, (p) => callback(p, { projectPath: p.projectPath }))
}

const api: MagnoliaAPI = {
  platform,
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
  missingFiles: (paths) => invoke('missing_files', { paths }),
  pickProjectFiles: () => invoke('pick_project_files'),
  openProjectPath: async (filePath) => openedProject(await invoke('open_project_path', { filePath })),
  readCheckoutMarker: (filePath) => invoke('read_checkout_marker', { filePath }),
  checkOutProject: (filePath, userName, steal) => invoke('check_out_project', { filePath, userName, steal }),
  checkInProject: (filePath, userName) => invoke('check_in_project', { filePath, userName }),
  readQdpxForCompare: async (filePath) => {
    const data = await invoke<Awaited<ReturnType<MagnoliaAPI['readQdpxForCompare']>>>('read_qdpx_for_compare', { filePath })
    // The comparison file isn't the active archive: read its PDFs from it.
    return completeProjectPdfText(data, async (handle) => {
      const buf = await invoke<ArrayBuffer>('read_compare_binary', { comparisonFilePath: filePath, handle })
      return buf.byteLength ? new Uint8Array(buf) : null
    }, false)
  },
  importMergeBinary: (comparisonFilePath, handle) => invoke('import_merge_binary', { comparisonFilePath, handle }),
  readCompareBinary: async (comparisonFilePath, handle) => {
    const buf = await invoke<ArrayBuffer>('read_compare_binary', { comparisonFilePath, handle })
    return buf.byteLength ? new Uint8Array(buf) : null
  },
  saveProject: (data) => invoke('save_project', { data }),
  saveProjectAs: (data) => invoke('save_project_as', { data }),
  showMessage: (message, kind) => invoke('show_message', { message, kind: kind ?? null }),
  diagnosticsInfo: (filePath) => invoke('diagnostics_info', { filePath }),
  askConfirm: (message, okLabel) =>
    invoke<boolean>('ask_confirm', { message, okLabel: okLabel ?? t('common.ok'), cancelLabel: t('common.cancel') }),
  confirmLosingChanges: (name, why) =>
    invoke<boolean>('confirm_losing_changes', { name, error: why.error ?? null, lockedBy: why.lockedBy ?? null, closing: !!why.closing }),
  createProjectCopy: (data) => invoke('create_project_copy', { data }),
  createNewProjectFile: () => invoke('create_new_project_file'),
  importTextFile: async () => {
    const paths = await invoke<string[] | null>('pick_import_files')
    return paths?.length ? readImports(paths) : null
  },
  readTextFiles: readImports,
  zoteroGet: (path) => invoke('zotero_get', { path }),
  zoteroFilePath: (library, key) => invoke('zotero_file_path', { library, key }),
  onImportProgress: (callback) => {
    importProgress.add(callback)
    return () => { importProgress.delete(callback) }
  },
  getPathForFile: (file) => {
    const token = `${DROP_PREFIX}${nextDropId++}/${file.name}`
    forgetStaleDrops(Date.now())
    droppedFiles.set(token, file)
    droppedAt.set(token, Date.now())
    return token
  },
  reimportDocument: async (sourceType) => {
    const doc = await invoke<RawImport | null>('reimport_document', { sourceType })
    return doc && completeImportedPdf(doc)
  },
  openLicence: () => invoke('open_licence'),
  openAcknowledgements: () => invoke('open_acknowledgements'),
  readAudioFile: readMedia,
  readImageFile: readMedia,
  readVideoFile: readMedia,
  mediaUrl,
  openMedia,
  importTranscript: () => invoke('import_transcript'),
  // Every PDF export: in the interface's language and direction.
  exportPdf: (html, defaultName, dialogTitle, headerTemplate, footerTemplate, script) =>
    invoke('export_pdf', { html: withDocumentLanguage(html), defaultName, dialogTitle, headerTemplate, footerTemplate, script: script ?? null }),
  exportCodebook: (codes) => invoke('export_codebook', { codes }),
  importCodebook: () => invoke('import_codebook'),
  showNewQueryDialog: () => {},

  // Query builder (runs in a main-window tab; round-trips main → main).
  onQueryFromBuilder: (callback) =>
    on<{ query: Query; editSavedQueryGuid?: string; graphLayout?: QueryGraphLayout }>('qb-query-result', (p) =>
      callback(p.query, p.editSavedQueryGuid, p.graphLayout)
    ),
  sendQueryToMain: (query, editSavedQueryGuid, graphLayout) => {
    toMain('menu-action', 'run-query-from-builder')
    toMain('qb-query-result', { query, editSavedQueryGuid, graphLayout })
  },
  sendPreviewToMain: (query, graphLayout) => toMain('qb-preview-result', { query, graphLayout }),
  onPreviewFromBuilder: (callback) =>
    on<{ query: Query; graphLayout?: QueryGraphLayout }>('qb-preview-result', (p) => callback(p.query, p.graphLayout)),
  sendSaveQueryToMain: (query, name, graphLayout, savedGuid) => toMain('qb-save-query-result', { query, name, graphLayout, savedGuid }),
  onSaveQueryFromBuilder: (callback) =>
    on<{ query: Query; name: string; graphLayout?: QueryGraphLayout; savedGuid?: string }>('qb-save-query-result', (p) =>
      callback(p.query, p.name, p.graphLayout, p.savedGuid)),
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
  broadcastLanguage: (language) => void emit('language-changed', { language, from: current.label }),
  onLanguageChanged: (callback) =>
    on<{ language: string; from: string }>('language-changed', (p) => {
      if (p.from !== current.label) callback(p.language)
    }),
  setNativeLanguage: (language, preference, numberLocale) => void invoke('set_native_language', { language, preference, numberLocale }),
  systemLocale: () => invoke('system_locale'),

  // Codebook window
  openCodebookWindow: (data) => void invoke('open_child_window', { kind: 'codebook', data: stampProject(data) }),
  getCodebookData: async () => noteData(await invoke('get_window_data')),
  onCodebookData: (callback) => on<Parameters<typeof callback>[0]>('codebook-init-data', (data) => callback(noteData(data))),
  sendCodebookUpdate: (action, ...args) => toMainFrom('codebook-update', { action, args }),
  onCodebookUpdate: (callback) => onFrom('codebook-update', callback),

  // Welcome window
  sendWelcomeAction: (action) => void invoke('welcome_action', { action }),
  getRecentProjects: () => invoke('get_recent_projects'),
  onOpenRecentProject: (callback) => onQueued<string>('open-recent-project', callback),
  onNewProjectAtPath: (callback) => onQueued<{ filePath: string; projectName: string }>('new-project-at-path', callback),
  onFlushAndClose: (callback) => on('flush-and-close', () => callback()),
  notifyFlushComplete: () => void invoke('flush_complete'),
  cancelFlush: () => void invoke('flush_cancelled'),
  sendFlushHeartbeat: () => void invoke('flush_heartbeat'),
  trackRecentProject: (name, filePath) => void invoke('track_recent_project', { name, filePath }),
  onRecentProjectsChanged: (callback) => on('recent-projects-changed', () => callback()),

  // Memo edit windows
  openMemoEditWindow: (data) => void invoke('open_child_window', { kind: 'memo-edit', data: stampProject(data) }),
  getMemoEditData: async () => noteData(await invoke('get_window_data')),
  onMemoEditData: (callback) => on<Parameters<typeof callback>[0]>('memo-edit-init-data', (data) => callback(noteData(data))),
  sendMemoUpdate: (memo) => toMainFrom('memo-update', memo),
  onMemoUpdate: (callback) => onFrom('memo-update', callback),
  sendMemoDelete: (guid) => toMainFrom('memo-delete', { guid }),
  // { guid, projectPath }; a bare guid from before.
  onMemoDelete: (callback) =>
    on<string | { guid: string; projectPath?: string }>('memo-delete', (p) =>
      typeof p === 'string' ? callback(p, {}) : callback(p.guid, { projectPath: p.projectPath })),

  // Logbook window
  openLogbookWindow: (data) => void invoke('open_child_window', { kind: 'logbook', data: stampProject(data) }),
  getLogbookData: async () => noteData(await invoke('get_window_data')),
  onLogbookData: (callback) => on<Parameters<typeof callback>[0]>('logbook-init-data', (data) => callback(noteData(data))),
  sendLogbookUpdate: (action, ...args) => toMainFrom('logbook-update', { action, args }),
  onLogbookUpdate: (callback) => onFrom('logbook-update', callback),

  // Memos window (every memo in the project)
  openMemosWindow: (data) => void invoke('open_child_window', { kind: 'memos', data: stampProject(data) }),
  updateMemosWindow: (data) => void invoke('update_memos_window', { data: stampProject(data) }),
  getMemosWindowData: async () => noteData(await invoke('get_window_data')),
  onMemosWindowData: (callback) => on<Parameters<typeof callback>[0]>('memos-init-data', (data) => callback(noteData(data))),
  sendMemosWindowAction: (action, ...args) => toMainFrom('memos-window-action', { action, args }),
  focusMainWindow: () => void invoke('focus_main_window'),
  onMemosWindowAction: (callback) => onFrom('memos-window-action', callback),

  // Analysis actions (main → main)
  sendAnalysisAction: (action, ...args) => toMain('analysis-action', { action, args }),
  onAnalysisAction: (callback) => on('analysis-action', callback),

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
  getUpdateView: () => invoke('update_window_state'),
  onUpdateView: (callback) => on('update-window:state', callback),
  installUpdate: () => void invoke('update_install'),
  skipUpdateVersion: (version) => void invoke('update_skip', { version }),
  dismissUpdate: () => void invoke('update_dismiss'),
  fitUpdateWindow: (delta) => void invoke('update_window_fit', { delta }),
  getAppVersion: () => invoke('get_app_version'),
  checkForUpdates: () => void invoke('check_for_updates'),
  onUpdateStatus: (callback) => on('update:status', callback),
  getUpdateBadge: () => invoke('get_update_badge'),
  onUpdateBadge: (callback) => on('update:badge', callback),

  // Inter-coder Agreement results window (pop-out)
  openIntercoderResultsWindow: (data) => void invoke('open_child_window', { kind: 'intercoder-results', data }),
  updateIntercoderResultsWindow: (data) => void invoke('update_intercoder_results_window', { data }),
  closeIntercoderResultsWindow: () => void invoke('close_child_window', { kind: 'intercoder-results' }),
  getIntercoderResultsData: () => invoke('get_window_data'),
  onIntercoderResultsData: (callback) => on('intercoder-results-init-data', callback),
  sendIntercoderResultsAction: (action, ...args) => toMain('intercoder-results-action', { action, payload: args[0] }),
  onIntercoderResultsAction: (callback) => on('intercoder-results-action', callback),
  onIntercoderResultsClosed: (callback) => on('intercoder-results-window-closed', () => callback()),

  // Query results window (pop-out)
  openQueryResultsWindow: (data) => void invoke('open_child_window', { kind: 'query-results', data }),
  wasQueryResultsPoppedOut: () => invoke('query_results_popped_out'),
  updateQueryResultsWindow: (data) => void invoke('update_query_results_window', { data }),
  getQueryResultsData: () => invoke('get_window_data'),
  onQueryResultsData: (callback) => on('query-results-init-data', callback),
  sendQueryResultsAction: (action, ...args) => toMain('query-results-action', { action, payload: args[0] }),
  onQueryResultsAction: (callback) => on('query-results-action', callback),
  jumpToQueryResult: (target) => {
    toMain('query-results-jump', target)
    void invoke('focus_main_window')
  },
  onJumpToQueryResult: (callback) => on('query-results-jump', callback),
  onQueryResultsClosed: (callback) => on('query-results-window-closed', () => callback()),

  updatePanelVisibility: (visibility) => void invoke('update_panel_visibility', { visibility }),

  // Preferences. A change that couldn't be written to disk still applies
  // this session, but would be gone at the next launch: say so.
  loadPreferences: () => invoke('load_preferences'),
  savePreferences: (prefs) => invoke<void>('save_preferences', { prefs }).catch(reportPreferencesNotSaved),
  sendPreferencesUpdate: (prefs) => void invoke('preferences_update', { prefs }).catch(reportPreferencesNotSaved),
  onPreferencesUpdate: (callback) => on('preferences-update', callback),
  mcpSetEnabled: (enabled) => invoke('mcp_set_enabled', { enabled }),
  mcpReply: (callId, content, isError) => invoke('mcp_reply', { callId, content, isError }),
  onMcpCall: (callback) => on('mcp-call', callback),
  mcpConnectorSettings: () => invoke('mcp_connector_settings'),
  mcpAddToClaudeDesktop: () => invoke('mcp_add_to_claude_desktop'),
  mcpClaudeDesktopFound: () => invoke('mcp_claude_desktop_found')
}

// Synchronous at startup so CSS / components can branch on it.
;window.api = api

// In a web view, window.close() only closes windows a page opened itself,
// so in a pop-out (memo editor, Query Results, …) it did nothing. Close the
// real window instead. The main window keeps the browser's (a no-op): it
// closes through the flush-on-close handshake (see windows.rs).
if (current.label !== MAIN) {
  window.close = () => { void current.close() }
}

// A web view makes no new window for window.open or a target="_blank"
// link, so web links (the Help tab's Manual and Donate, Preferences'
// Sponsor link…) did nothing. Hand them to the default browser instead.
const isExternalUrl = (url: string): boolean => /^(https?:|mailto:)/i.test(url)
const openExternal = (url: string): void => { void invoke('open_external', { url }) }
const nativeWindowOpen = window.open.bind(window)
window.open = ((url?: string | URL, target?: string, features?: string) => {
  const href = url == null ? '' : String(url)
  if (isExternalUrl(href)) {
    openExternal(href)
    return null
  }
  return nativeWindowOpen(url, target, features)
}) as typeof window.open
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0) return
  const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!a || !isExternalUrl(a.href)) return
  e.preventDefault()
  openExternal(a.href)
})

// Stamp the host platform on <html> in every window (every entry loads
// this file first), so CSS can branch on it: the main window's toolbar
// clears the macOS traffic lights, and on macOS the panes in a window's
// bottom corners, pop-outs included, follow its rounded corners.
document.documentElement.setAttribute('data-platform', platform)
// …and whether the window is full screen, where macOS hides the traffic
// lights and squares the window's corners, so neither needs room. Entering
// or leaving full screen resizes the window.
if (platform === 'darwin') {
  const markFullscreen = () => {
    void current.isFullscreen().then((full) => {
      document.documentElement.toggleAttribute('data-fullscreen', full)
    }).catch(() => { /* window gone */ })
  }
  markFullscreen()
  void current.onResized(markFullscreen)
}
// Enter and Escape belong to an input method while it's composing (see
// utils/keys), in every window.
guardComposition()
