import { contextBridge, ipcRenderer } from 'electron'
import type { ElectronAPI } from '../renderer/models/types'

const api: ElectronAPI = {
  getFileSize: (filePath: string) => ipcRenderer.invoke('get-file-size', filePath),
  readPdfFile: (filePath: string) => ipcRenderer.invoke('read-pdf-file', filePath),
  onProjectLoadProgress: (callback: (p: { stage: string; current: number; total: number }) => void) => {
    const handler = (_event: any, p: { stage: string; current: number; total: number }) => callback(p)
    ipcRenderer.on('project-load-progress', handler)
    return () => {
      ipcRenderer.removeListener('project-load-progress', handler)
    }
  },
  openProject: () => ipcRenderer.invoke('open-project'),
  pickProjectFile: () => ipcRenderer.invoke('pick-project-file'),
  openProjectPath: (filePath: string) => ipcRenderer.invoke('open-project-path', filePath),
  saveProject: (data) => ipcRenderer.invoke('save-project', data),
  saveProjectAs: (data) => ipcRenderer.invoke('save-project-as', data),
  createNewProjectFile: () => ipcRenderer.invoke('create-new-project-file'),
  importTextFile: () => ipcRenderer.invoke('import-text-file'),
  readTextFiles: (filePaths: string[]) => ipcRenderer.invoke('read-text-files', filePaths),
  openLicence: () => ipcRenderer.invoke('open-licence'),
  openAcknowledgements: () => ipcRenderer.invoke('open-acknowledgements'),
  readAudioFile: (filePath: string) => ipcRenderer.invoke('read-audio-file', filePath),
  readImageFile: (filePath: string) => ipcRenderer.invoke('read-image-file', filePath),
  readVideoFile: (filePath: string) => ipcRenderer.invoke('read-video-file', filePath),
  importTranscript: () => ipcRenderer.invoke('import-transcript'),
  exportPdf: (
    html: string,
    defaultName: string,
    dialogTitle?: string,
    headerTemplate?: string,
    footerTemplate?: string
  ) =>
    ipcRenderer.invoke('export-pdf', html, defaultName, dialogTitle, headerTemplate, footerTemplate),
  exportCodebook: (codes) => ipcRenderer.invoke('export-codebook', codes),
  importCodebook: () => ipcRenderer.invoke('import-codebook'),
  showNewQueryDialog: () => ipcRenderer.send('show-new-query-dialog'),
  onQueryFromBuilder: (callback) => {
    const handler = (_event: any, query: any, editSavedQueryGuid?: string, graphLayout?: any) => callback(query, editSavedQueryGuid, graphLayout)
    ipcRenderer.on('qb-query-result', handler)
    return () => {
      ipcRenderer.removeListener('qb-query-result', handler)
    }
  },
  // Query builder IPCs (live preview / save / run round-trip through
  // main → mainWindow back to the same renderer that hosts the inline
  // builder tab).
  sendQueryToMain: (query, editSavedQueryGuid, graphLayout) => ipcRenderer.send('qb-run-query', query, editSavedQueryGuid, graphLayout),
  sendPreviewToMain: (query) => ipcRenderer.send('qb-preview-query', query),
  sendSaveQueryToMain: (query, name, graphLayout, savedGuid) =>
    ipcRenderer.send('qb-save-query', query, name, graphLayout, savedGuid),
  onSaveQueryFromBuilder: (callback) => {
    const handler = (_event: any, query: any, name: string, graphLayout?: any, savedGuid?: string) =>
      callback(query, name, graphLayout, savedGuid)
    ipcRenderer.on('qb-save-query-result', handler)
    return () => {
      ipcRenderer.removeListener('qb-save-query-result', handler)
    }
  },
  onPreviewFromBuilder: (callback) => {
    const handler = (_event: any, query: any) => callback(query)
    ipcRenderer.on('qb-preview-result', handler)
    return () => {
      ipcRenderer.removeListener('qb-preview-result', handler)
    }
  },
  onMenuAction: (callback) => {
    const handler = (_event: any, action: string) => callback(action)
    ipcRenderer.on('menu-action', handler)
    return () => {
      ipcRenderer.removeListener('menu-action', handler)
    }
  },
  broadcastTheme: (theme: string) => ipcRenderer.send('theme-changed', theme),
  onThemeChanged: (callback: (theme: string) => void) => {
    const handler = (_event: any, theme: string) => callback(theme)
    ipcRenderer.on('theme-changed', handler)
    return () => {
      ipcRenderer.removeListener('theme-changed', handler)
    }
  },
  // Codebook window
  openCodebookWindow: (data) => ipcRenderer.send('open-codebook-window', data),
  getCodebookData: () => ipcRenderer.invoke('get-codebook-data'),
  onCodebookData: (callback) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on('codebook-init-data', handler)
    return () => { ipcRenderer.removeListener('codebook-init-data', handler) }
  },
  sendCodebookUpdate: (action, ...args) => ipcRenderer.send('codebook-update', action, ...args),
  onCodebookUpdate: (callback) => {
    const handler = (_event: any, action: string, ...args: any[]) => callback(action, ...args)
    ipcRenderer.on('codebook-update', handler)
    return () => { ipcRenderer.removeListener('codebook-update', handler) }
  },
  // Memo edit window
  openMemoEditWindow: (data) => ipcRenderer.send('open-memo-edit-window', data),
  getMemoEditData: () => ipcRenderer.invoke('get-memo-edit-data'),
  onMemoEditData: (callback) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on('memo-edit-init-data', handler)
    return () => { ipcRenderer.removeListener('memo-edit-init-data', handler) }
  },
  sendMemoUpdate: (memo) => ipcRenderer.send('memo-update', memo),
  onMemoUpdate: (callback) => {
    const handler = (_event: any, memo: any) => callback(memo)
    ipcRenderer.on('memo-update', handler)
    return () => { ipcRenderer.removeListener('memo-update', handler) }
  },
  sendMemoDelete: (guid) => ipcRenderer.send('memo-delete', guid),
  onMemoDelete: (callback) => {
    const handler = (_event: any, guid: any) => callback(guid)
    ipcRenderer.on('memo-delete', handler)
    return () => { ipcRenderer.removeListener('memo-delete', handler) }
  },
  // Welcome window
  sendWelcomeAction: (action) => ipcRenderer.send('welcome-action', action),
  getRecentProjects: () => ipcRenderer.invoke('get-recent-projects'),
  onOpenRecentProject: (callback) => {
    const handler = (_event: any, filePath: string) => callback(filePath)
    ipcRenderer.on('open-recent-project', handler)
    return () => { ipcRenderer.removeListener('open-recent-project', handler) }
  },
  onNewProjectAtPath: (callback) => {
    const handler = (_event: any, data: { filePath: string; projectName: string }) => callback(data)
    ipcRenderer.on('new-project-at-path', handler)
    return () => { ipcRenderer.removeListener('new-project-at-path', handler) }
  },
  onFlushAndClose: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('flush-and-close', handler)
    return () => { ipcRenderer.removeListener('flush-and-close', handler) }
  },
  notifyFlushComplete: () => ipcRenderer.send('flush-and-close-complete'),
  sendFlushHeartbeat: () => ipcRenderer.send('flush-heartbeat'),
  trackRecentProject: (name, filePath) => ipcRenderer.send('track-recent-project', name, filePath),
  onRecentProjectsChanged: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('recent-projects-changed', handler)
    return () => { ipcRenderer.removeListener('recent-projects-changed', handler) }
  },
  // Logbook window
  openLogbookWindow: (data) => ipcRenderer.send('open-logbook-window', data),
  getLogbookData: () => ipcRenderer.invoke('get-logbook-data'),
  onLogbookData: (callback) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on('logbook-init-data', handler)
    return () => { ipcRenderer.removeListener('logbook-init-data', handler) }
  },
  sendLogbookUpdate: (action, ...args) => ipcRenderer.send('logbook-update', action, ...args),
  onLogbookUpdate: (callback) => {
    const handler = (_event: any, action: string, ...args: any[]) => callback(action, ...args)
    ipcRenderer.on('logbook-update', handler)
    return () => { ipcRenderer.removeListener('logbook-update', handler) }
  },
  // Analysis actions — round-trip through main so inline analysis
  // tools can hand work (save-analysis, run-query, open-memo, etc.)
  // back to the main App.
  sendAnalysisAction: (action, ...args) => ipcRenderer.send('analysis-action', action, ...args),
  onAnalysisAction: (callback) => {
    const handler = (_event: any, action: string, ...args: any[]) => callback(action, ...args)
    ipcRenderer.on('analysis-action', handler)
    return () => { ipcRenderer.removeListener('analysis-action', handler) }
  },
  exportCsv: (content: string, defaultName: string) => ipcRenderer.invoke('export-csv', content, defaultName),
  exportSvg: (content: string, defaultName: string) => ipcRenderer.invoke('export-svg', content, defaultName),
  focusWindow: () => ipcRenderer.send('raise-child-windows'),
  // Custom window controls (Windows/Linux frameless main window)
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  toggleMaximizeWindow: () => ipcRenderer.send('window-maximize-toggle'),
  closeWindow: () => ipcRenderer.send('window-close'),
  isWindowMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  onWindowMaximizedChanged: (callback) => {
    const handler = (_event: any, isMax: boolean) => callback(isMax)
    ipcRenderer.on('window-maximized-changed', handler)
    return () => { ipcRenderer.removeListener('window-maximized-changed', handler) }
  },
  // Query results window (pop-out)
  openQueryResultsWindow: (data) => ipcRenderer.send('open-query-results-window', data),
  updateQueryResultsWindow: (data) => ipcRenderer.send('update-query-results-window', data),
  getQueryResultsData: () => ipcRenderer.invoke('get-query-results-data'),
  onQueryResultsData: (callback) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on('query-results-init-data', handler)
    return () => { ipcRenderer.removeListener('query-results-init-data', handler) }
  },
  sendQueryResultsAction: (action, payload) => ipcRenderer.send('query-results-action', action, payload),
  onQueryResultsAction: (callback) => {
    const handler = (_event: any, action: string, payload?: any) => callback(action, payload)
    ipcRenderer.on('query-results-action', handler)
    return () => { ipcRenderer.removeListener('query-results-action', handler) }
  },
  jumpToQueryResult: (target) => ipcRenderer.send('query-results-jump', target),
  onJumpToQueryResult: (callback) => {
    const handler = (_event: any, target: any) => callback(target)
    ipcRenderer.on('query-results-jump', handler)
    return () => { ipcRenderer.removeListener('query-results-jump', handler) }
  },
  onQueryResultsClosed: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('query-results-window-closed', handler)
    return () => { ipcRenderer.removeListener('query-results-window-closed', handler) }
  },
  // Panel visibility
  updatePanelVisibility: (visibility: Record<string, boolean>) => ipcRenderer.send('update-panel-visibility', visibility),
  // Preferences
  loadPreferences: () => ipcRenderer.invoke('load-preferences'),
  savePreferences: (prefs: any) => ipcRenderer.invoke('save-preferences', prefs),
  sendPreferencesUpdate: (prefs: any) => ipcRenderer.send('preferences-update', prefs),
  onPreferencesUpdate: (callback: (prefs: any) => void) => {
    const handler = (_event: any, prefs: any) => callback(prefs)
    ipcRenderer.on('preferences-update', handler)
    return () => { ipcRenderer.removeListener('preferences-update', handler) }
  },
}

// Expose the host platform alongside the API so the renderer can
// branch on it (e.g. add the macOS-only traffic-light indent to the
// app toolbar). Exposed as a property rather than a function to keep
// the value synchronous at startup.
;(api as any).platform = process.platform

contextBridge.exposeInMainWorld('api', api)

// When a drag starts in the MAIN window, tell main process to raise all
// child windows above it so the user can see drop targets.
// Only the main window needs this — child windows (query builder, analysis,
// codebook, etc.) should never raise other windows on internal drags.
window.addEventListener('dragstart', () => {
  const href = window.location.href
  // Main window loads index.html (prod) or the root dev URL (no sub-page)
  const isMainWindow =
    href.endsWith('/index.html') ||
    (href.includes('localhost') && !href.includes('.html'))
  if (!isMainWindow) return
  if ((window as any).__suppressRaiseChildWindows) return
  ipcRenderer.send('raise-child-windows')
})
