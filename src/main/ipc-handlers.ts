import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import { readFile, writeFile, stat, unlink } from 'fs/promises'
import { existsSync, mkdirSync } from 'fs'
import { basename, dirname, join } from 'path'
import { readQdpx } from './qdpx/reader'
import { writeQdpx, EmptyProjectGuardError, createEmptyProjectFile } from './qdpx/writer'
import { readCheckoutMarker, writeCheckoutMarker, readEditorInfo } from './qdpx/checkout-marker'
import { serializeCodebook } from './qdpx/codebook-serializer'
import { deserializeCodebook } from './qdpx/codebook-deserializer'
import {
  setActiveProjectPath,
  noteActiveProjectPath,
  getActiveProjectPath,
  isBinaryHandle,
  resolveHandle,
  readArchiveByName,
  getOverlayByHandle,
  markPersisted,
  putOverlay
} from './binary-store'
import { getLastImportDir, setLastImportDir } from './import-dirs'
import type { Project, Code } from '../renderer/models/types'

/**
 * Read a media binary for a viewer. The renderer holds an opaque
 * `magnolia-bin://` handle (resolved from the open .qdpx or the in-memory
 * import overlay) — no OS-temp round-trip. A legacy real filesystem path is
 * still accepted and self-healed from the archive if it was reaped, so old
 * in-flight references keep working. Throws ENOENT only when the bytes are
 * genuinely unrecoverable, preserving callers' "file not available" UI.
 */
async function readMediaFile(filePath: string): Promise<Buffer> {
  if (isBinaryHandle(filePath)) {
    const bytes = await resolveHandle(filePath)
    if (bytes) return bytes
    const err: any = new Error(`binary not available: ${filePath}`)
    err.code = 'ENOENT'
    throw err
  }
  try {
    return await readFile(filePath)
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e
    const recovered = await readArchiveByName(basename(filePath))
    if (recovered) return recovered
    throw e
  }
}

/** Paper sizes offered in Preferences, mapped to Electron printToPDF
 *  `pageSize` strings. */
type ExportPaperSize = 'A4' | 'A3' | 'A5' | 'Letter' | 'Legal' | 'Tabloid'
const VALID_PAPER_SIZES = new Set<ExportPaperSize>(['A4', 'A3', 'A5', 'Letter', 'Legal', 'Tabloid'])

/** Read the user's chosen export paper size from the persisted
 *  preferences file. Read at export time (rather than passed from the
 *  renderer) so every export call site honours it without change.
 *  Falls back to A4 — the Preferences default — on any miss. */
async function readExportPaperSize(): Promise<ExportPaperSize> {
  try {
    const prefsPath = join(app.getPath('userData'), 'magnolia-preferences.json')
    if (existsSync(prefsPath)) {
      const prefs = JSON.parse(await readFile(prefsPath, 'utf-8'))
      if (typeof prefs?.paperSize === 'string' && VALID_PAPER_SIZES.has(prefs.paperSize as ExportPaperSize)) {
        return prefs.paperSize as ExportPaperSize
      }
    }
  } catch { /* ignore — fall back to default */ }
  return 'A4'
}

export function registerIpcHandlers(): void {
  ipcMain.handle('get-file-size', async (_event, filePath: string) => {
    try {
      const s = await stat(filePath)
      return s.size
    } catch {
      return null
    }
  })

  ipcMain.handle('read-pdf-file', async (_event, filePath: string, archivePath?: string) => {
    // Return raw PDF bytes as a Uint8Array. Electron's structured clone
    // sends this as-is without base64 overhead, which is much faster than
    // passing a base64 string through contextBridge. archivePath is the open
    // project (passed by the renderer so resolution survives a main reload).
    noteActiveProjectPath(archivePath)
    const buffer = await readMediaFile(filePath)
    return new Uint8Array(buffer)
  })

  // Record which .qdpx the renderer currently has open, so the media read
  // handlers can serve binaries straight from it (and so switching projects
  // discards the previous one's not-yet-saved import overlay).
  ipcMain.handle('set-active-project-path', (_event, filePath: string | null) => {
    setActiveProjectPath(filePath)
  })

  ipcMain.handle('open-project', async (event) => {
    const result = await dialog.showOpenDialog({
      title: 'Open QDPX Project',
      filters: [{ name: 'QDPX Projects', extensions: ['qdpx'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    const data = await readQdpx(filePath, (stage, current, total) => {
      event.sender.send('project-load-progress', { stage, current, total })
    })
    // Make this the live archive immediately so viewers can resolve
    // magnolia-bin:// handles before the renderer's own path effect fires.
    setActiveProjectPath(filePath)
    const checkoutInfo = await readCheckoutMarker(filePath)
    return { ...data, filePath, checkoutInfo }
  })

  // Show the file picker and return the chosen path without doing any
  // load work. Lets the renderer separate "user picks a file" from
  // "loading begins" — important because the loading overlay used to
  // appear before the picker, making it look like Magnolia stalled
  // before the picker even opened.
  ipcMain.handle('pick-project-file', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open QDPX Project',
      filters: [{ name: 'QDPX Projects', extensions: ['qdpx'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(
    'save-project',
    async (
      _event,
      data: {
        project: Project
        sourceContents: Record<string, string>
        filePath?: string
      }
    ) => {
      let filePath = data.filePath
      if (!filePath) {
        const result = await dialog.showSaveDialog({
          title: 'Save QDPX Project',
          defaultPath: `${data.project.name}.qdpx`,
          filters: [{ name: 'QDPX Projects', extensions: ['qdpx'] }]
        })
        if (result.canceled || !result.filePath) return null
        filePath = result.filePath
      }
      try {
        await writeQdpx(filePath, data.project, data.sourceContents, {
          resolveOverlay: getOverlayByHandle,
          markPersisted
        })
      } catch (e) {
        if (e instanceof EmptyProjectGuardError) {
          console.warn('[save-project guard]', e.message)
          return { guardBlocked: true, message: e.message }
        }
        throw e
      }
      // The archive is now the live source path and holds every binary. Use
      // note (not set) so we DON'T clear the import overlay: writeQdpx just
      // recorded token→guid mappings for the binaries it embedded, and a
      // freshly-imported binary's still-overlay handle must keep resolving
      // (from this archive) until the renderer promotes it to an archive handle.
      noteActiveProjectPath(filePath)
      return filePath
    }
  )

  ipcMain.handle('create-new-project-file', async () => {
    const result = await dialog.showSaveDialog({
      title: 'Create New Project',
      defaultPath: 'Untitled.qdpx',
      filters: [{ name: 'QDPX Projects', extensions: ['qdpx'] }]
    })
    if (result.canceled || !result.filePath) return null
    const filePath = result.filePath
    try {
      const projectName = await createEmptyProjectFile(filePath)
      return { filePath, projectName }
    } catch (err) {
      dialog.showErrorBox('Failed to create project', String(err))
      return null
    }
  })

  ipcMain.handle('save-project-as', async (_event, data: { project: Project; sourceContents: Record<string, string>; currentFilePath?: string }) => {
    const result = await dialog.showSaveDialog({
      title: 'Save QDPX Project As',
      defaultPath: `${data.project.name}.qdpx`,
      filters: [{ name: 'QDPX Projects', extensions: ['qdpx'] }]
    })
    if (result.canceled || !result.filePath) return null
    try {
      // Carry imported binaries forward from the project that's currently
      // open (a different path than the Save As target), and embed any
      // not-yet-saved imports from the overlay, so nothing is dropped when
      // the project moves to a new file.
      await writeQdpx(result.filePath, data.project, data.sourceContents, {
        carryForwardFrom: data.currentFilePath,
        resolveOverlay: getOverlayByHandle,
        markPersisted
      })
    } catch (e) {
      if (e instanceof EmptyProjectGuardError) {
        console.warn('[save-project-as guard]', e.message)
        return { guardBlocked: true, message: e.message }
      }
      throw e
    }
    // The new file is now the live archive holding every binary. Note (not
    // set) so the just-recorded token→guid mappings for embedded imports
    // survive until the renderer promotes those handles to archive handles.
    noteActiveProjectPath(result.filePath)
    return result.filePath
  })

  // "Create a Copy" from the checkout-conflict dialog: an unattended
  // duplicate (no Save dialog) so a user who's blocked by someone else's
  // checkout can start working immediately, then merge the two copies back
  // together later via the Merge tool. Named "YYMMDD<name> <original
  // filename>.qdpx" — the date and who made it are what actually matters
  // once there are two copies of a project floating around waiting to be
  // merged, unlike a bare "<name> copy.qdpx" which says nothing about
  // either. Collisions (e.g. two copies made the same day) get " (2)",
  // " (3)", etc. Unlike save-project-as, this passes dropLock: true —
  // writeQdpx otherwise carries the source file's checkout lock
  // (magnolia-lock.json) and project id forward by design (so a normal
  // Save/Save As while checked out doesn't erase your own lock), which
  // here would just relabel someone ELSE's lock onto the new file. The
  // copy starts unlocked.
  ipcMain.handle('create-project-copy', async (_event, data: { project: Project; sourceContents: Record<string, string>; currentFilePath: string; userName?: string }) => {
    const dir = dirname(data.currentFilePath)
    const base = basename(data.currentFilePath, '.qdpx')
    const now = new Date()
    const datePrefix =
      String(now.getFullYear() % 100).padStart(2, '0') +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0')
    // Strip characters that are illegal (or awkward) in a filename on any
    // of the three platforms Magnolia ships for.
    const safeName = (data.userName ?? '').trim().replace(/[\\/:*?"<>|]/g, '')
    const prefix = safeName ? `${datePrefix}${safeName}` : datePrefix
    let candidate = join(dir, `${prefix} ${base}.qdpx`)
    let n = 2
    while (existsSync(candidate)) {
      candidate = join(dir, `${prefix} ${base} (${n}).qdpx`)
      n++
    }
    try {
      await writeQdpx(candidate, data.project, data.sourceContents, {
        carryForwardFrom: data.currentFilePath,
        resolveOverlay: getOverlayByHandle,
        markPersisted,
        dropLock: true
      })
    } catch (e) {
      if (e instanceof EmptyProjectGuardError) {
        console.warn('[create-project-copy guard]', e.message)
        return { guardBlocked: true, message: e.message }
      }
      throw e
    }
    noteActiveProjectPath(candidate)
    return candidate
  })

  ipcMain.handle('open-project-path', async (event, filePath: string) => {
    const data = await readQdpx(filePath, (stage, current, total) => {
      event.sender.send('project-load-progress', { stage, current, total })
    })
    setActiveProjectPath(filePath)
    const checkoutInfo = await readCheckoutMarker(filePath)
    return { ...data, filePath, checkoutInfo }
  })

  ipcMain.handle('read-checkout-marker', async (_event, filePath: string) => {
    return readCheckoutMarker(filePath)
  })

  ipcMain.handle('check-out-project', async (_event, filePath: string, userName: string) => {
    return writeCheckoutMarker(filePath, { userName })
  })

  ipcMain.handle('check-in-project', async (_event, filePath: string) => {
    return writeCheckoutMarker(filePath, null)
  })

  // Merge: load a SECOND .qdpx's full contents for comparison against the
  // currently-open project, without disturbing it. Deliberately does NOT
  // call setActiveProjectPath/noteActiveProjectPath — readQdpx itself is a
  // pure function of filePath (confirmed by reading it: it never touches
  // binary-store.ts's module-level activeProjectPath), so this is safe to
  // call while a different project is live. This means any magnolia-bin://
  // handles inside the returned data can't be resolved to actual bytes via
  // the normal read-pdf-file/read-audio-file/etc. IPCs (those always read
  // from the single active archive) — fine for the merge feature, which
  // only diffs structured/text data, not binary preview.
  ipcMain.handle('read-qdpx-for-compare', async (_event, filePath: string) => {
    const data = await readQdpx(filePath)
    const editorInfo = await readEditorInfo(filePath)
    return { ...data, filePath, editorInfo }
  })

  // Supported document extensions — add new formats here
  const SUPPORTED_EXTENSIONS = ['txt', 'md', 'markdown', 'pdf', 'docx', 'rtf', 'odt', 'doc', 'csv', 'xlsx', 'wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'tif', 'tiff', 'heic', 'heif', 'mp4', 'mov', 'avi']
  const BINARY_EXTENSIONS = new Set(['pdf', 'docx', 'rtf', 'odt', 'doc', 'xlsx', 'wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'tif', 'tiff', 'heic', 'heif', 'mp4', 'mov', 'avi'])
  const AUDIO_EXTENSIONS = new Set(['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac'])
  const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp'])
  // TIFF + HEIC are accepted but decoded to PNG on import — Chromium
  // can't render them natively, so we normalise at the boundary and
  // the rest of the app just sees a PNG.
  const DECODED_IMAGE_EXTENSIONS = new Set(['tif', 'tiff', 'heic', 'heif'])
  const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi'])
  const IMAGE_MIME: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp'
  }
  const VIDEO_MIME: Record<string, string> = {
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo'
  }

  async function readDocumentFile(fp: string): Promise<{ name: string; content: string; extension: string; formatting?: any }> {
    const ext = fp.split('.').pop()?.toLowerCase() || ''
    const name = basename(fp)

    if (BINARY_EXTENSIONS.has(ext)) {
      const buffer = await readFile(fp)
      if (ext === 'pdf') {
        const { extractPdfText } = await import('./pdf-extract')
        const result = await extractPdfText(buffer)
        return { name, content: result.text, extension: 'pdf', formatting: { pdfBase64: result.pdfBase64, pdfPageOffsets: result.pageOffsets } }
      }
      if (ext === 'docx') {
        const { convertDocxToPdf } = await import('./docx-convert')
        const result = await convertDocxToPdf(buffer)
        return { name, content: result.text, extension: 'pdf', formatting: { pdfBase64: result.pdfBase64, pdfPageOffsets: result.pageOffsets } }
      }
      if (ext === 'rtf') {
        const { convertRtfToPdf } = await import('./rtf-convert')
        const result = await convertRtfToPdf(buffer)
        return { name, content: result.text, extension: 'pdf', formatting: { pdfBase64: result.pdfBase64, pdfPageOffsets: result.pageOffsets } }
      }
      if (ext === 'odt') {
        const { convertOdtToPdf } = await import('./odt-convert')
        const result = await convertOdtToPdf(buffer)
        return { name, content: result.text, extension: 'pdf', formatting: { pdfBase64: result.pdfBase64, pdfPageOffsets: result.pageOffsets } }
      }
      if (ext === 'doc') {
        // Legacy Word binary format — no viable pure-JS parser. Tell
        // the user to resave as .docx rather than silently failing.
        throw new Error('Legacy Microsoft Word .doc files aren\'t supported. Please open the file in Word and save it as .docx.')
      }
      if (ext === 'xlsx') {
        // Convert to CSV at the boundary so the existing survey-import
        // pipeline (which expects CSV text) handles it unchanged. The
        // renderer keeps the .xlsx extension so it knows to route the
        // file through queueSurveyImport.
        const { convertXlsxToCsv } = await import('./xlsx-convert')
        const csv = convertXlsxToCsv(buffer)
        return { name, content: csv, extension: 'xlsx' }
      }
      if (IMAGE_EXTENSIONS.has(ext) || DECODED_IMAGE_EXTENSIONS.has(ext)) {
        // Hold the image bytes in the in-memory import overlay and hand the
        // renderer a magnolia-bin:// handle — no OS-temp file. The next save
        // embeds the bytes into the .qdpx; the viewer fetches them via the
        // handle either way. For TIFF / HEIC we decode to PNG first so the
        // rest of the pipeline only ever sees natively-renderable formats.
        let finalBuffer = buffer
        let finalExt = ext
        let finalMime = IMAGE_MIME[ext] || 'application/octet-stream'
        if (DECODED_IMAGE_EXTENSIONS.has(ext)) {
          const { convertTiffToPng, convertHeicToPng } = await import('./image-convert')
          const converted = ext === 'tif' || ext === 'tiff'
            ? convertTiffToPng(buffer)
            : await convertHeicToPng(buffer)
          finalBuffer = converted.buffer
          finalExt = converted.ext
          finalMime = converted.mimeType
        }
        return {
          name,
          content: '',
          extension: finalExt,
          formatting: {
            imageFilePath: putOverlay(finalBuffer, finalExt),
            mimeType: finalMime,
            imageExt: finalExt
          }
        }
      }
      if (VIDEO_EXTENSIONS.has(ext)) {
        let duration = 0
        try {
          const { extractVideoMetadata } = await import('./video-extract')
          const meta = await extractVideoMetadata(fp, ext)
          duration = meta.duration
        } catch (err) {
          console.error('Video metadata extraction failed, using defaults:', err)
        }
        return {
          name,
          content: '',
          extension: ext,
          formatting: {
            videoFilePath: putOverlay(buffer, ext),
            mimeType: VIDEO_MIME[ext] || 'video/mp4',
            duration,
            videoExt: ext
          }
        }
      }
      if (AUDIO_EXTENSIONS.has(ext)) {
        const AUDIO_MIME: Record<string, string> = { wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac' }
        let duration = 0, channels = 1, sampleRate = 44100
        try {
          const { extractAudioMetadata } = await import('./audio-extract')
          const metadata = await extractAudioMetadata(fp, ext)
          duration = metadata.duration
          channels = metadata.channels
          sampleRate = metadata.sampleRate
        } catch (err) {
          console.error('Audio metadata extraction failed, using defaults:', err)
        }
        return {
          name,
          content: '',
          extension: ext,
          formatting: {
            audioFilePath: putOverlay(buffer, ext),
            mimeType: AUDIO_MIME[ext.toLowerCase()] || 'audio/wav',
            duration,
            channels,
            sampleRate
          }
        }
      }
    }

    return { name, content: await readFile(fp, 'utf-8'), extension: ext }
  }

  /**
   * Read a batch of document paths, isolating per-file errors so one
   * bad file (unsupported format, corrupt bytes) doesn't blow up the
   * whole import. The renderer surfaces any `.error` entries via a
   * user-facing alert.
   */
  async function readDocumentBatch(
    paths: string[]
  ): Promise<Array<{ name: string; content: string; extension: string; formatting?: any } | { name: string; error: string }>> {
    return Promise.all(
      paths.map(async (fp) => {
        const name = basename(fp)
        try {
          return await readDocumentFile(fp)
        } catch (err: any) {
          return { name, error: err?.message || String(err) }
        }
      })
    )
  }

  ipcMain.handle('import-text-file', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import Document',
      defaultPath: await getLastImportDir(getActiveProjectPath()),
      filters: [{ name: 'Supported Documents', extensions: SUPPORTED_EXTENSIONS }],
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    void setLastImportDir(getActiveProjectPath(), dirname(result.filePaths[0]))
    return readDocumentBatch(result.filePaths)
  })

  ipcMain.handle('read-text-files', async (_event, filePaths: string[]) => {
    const acceptedExts = SUPPORTED_EXTENSIONS.map((e) => '.' + e)
    const validPaths = filePaths.filter((fp) => acceptedExts.some((ext) => fp.toLowerCase().endsWith(ext)))
    if (validPaths.length === 0) return null
    return readDocumentBatch(validPaths)
  })

  // Re-import the file for an existing document whose bytes are missing
  // from the .qdpx. Single-file picker filtered to the document's type;
  // returns the same { name, content, extension, formatting } shape as a
  // normal import so the renderer can re-attach it to the existing source
  // (preserving its guid + codes). Returns null if the user cancels.
  ipcMain.handle('reimport-document', async (_event, sourceType: string) => {
    const extsFor = (t: string): string[] => {
      if (t === 'pdf') return ['pdf', 'docx', 'rtf', 'odt']
      if (t === 'image') return [...IMAGE_EXTENSIONS, ...DECODED_IMAGE_EXTENSIONS]
      // Audio and video share container formats (e.g. Atlas references media
      // as .m4a even for video), so accept any media file for either — the
      // user is re-attaching the same media regardless of how the source was
      // typed. Otherwise a video stored as .m4a (or vice-versa) gets greyed.
      if (t === 'audio' || t === 'video') return [...new Set([...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS])]
      return SUPPORTED_EXTENSIONS
    }
    const result = await dialog.showOpenDialog({
      title: 'Re-import Document',
      defaultPath: await getLastImportDir(getActiveProjectPath()),
      filters: [{ name: 'Supported Documents', extensions: extsFor(sourceType) }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    void setLastImportDir(getActiveProjectPath(), dirname(result.filePaths[0]))
    try {
      const doc = await readDocumentFile(result.filePaths[0])
      // Honor the SOURCE's media type, not the file extension. Atlas (and
      // others) reference a video's media as .m4a, which readDocumentFile
      // types as audio; re-attaching it onto a video source must still come
      // back as video (videoFilePath) so the player shows. The overlay
      // handle is the same bytes for either media kind.
      const f = (doc as any)?.formatting
      if (f) {
        const handle = f.videoFilePath || f.audioFilePath
        if (sourceType === 'video' && handle && !f.videoFilePath) {
          ;(doc as any).formatting = { videoFilePath: handle, mimeType: 'video/mp4', duration: f.duration ?? 0, videoExt: (doc as any).extension }
        } else if (sourceType === 'audio' && handle && !f.audioFilePath) {
          ;(doc as any).formatting = { audioFilePath: handle, mimeType: 'audio/mp4', duration: f.duration ?? 0, channels: f.channels ?? 1, sampleRate: f.sampleRate ?? 44100 }
        }
      }
      return doc
    } catch (err: any) {
      return { name: basename(result.filePaths[0]), error: err?.message || String(err) }
    }
  })

  // Read an audio file and return as ArrayBuffer for blob URL creation in
  // renderer. archivePath = the open project (passed so resolution survives
  // a main reload); self-heals from the open .qdpx if temp was reaped.
  ipcMain.handle('read-audio-file', async (_event, filePath: string, archivePath?: string) => {
    noteActiveProjectPath(archivePath)
    const buffer = await readMediaFile(filePath)
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  })

  // Read an image file and return as ArrayBuffer for blob URL creation in
  // renderer. archivePath = the open project (passed so resolution survives
  // a main reload); self-heals from the open .qdpx if temp was reaped.
  ipcMain.handle('read-image-file', async (_event, filePath: string, archivePath?: string) => {
    noteActiveProjectPath(archivePath)
    const buffer = await readMediaFile(filePath)
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  })

  // Read a video file and return as ArrayBuffer for blob URL creation in
  // renderer. archivePath = the open project (passed so resolution survives
  // a main reload); self-heals from the open .qdpx if temp was reaped.
  ipcMain.handle('read-video-file', async (_event, filePath: string, archivePath?: string) => {
    noteActiveProjectPath(archivePath)
    const buffer = await readMediaFile(filePath)
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  })

  ipcMain.handle('import-transcript', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import Transcript',
      defaultPath: await getLastImportDir(getActiveProjectPath()),
      filters: [
        { name: 'Text Files', extensions: ['txt', 'md', 'markdown', 'srt', 'vtt', 'html', 'htm'] }
      ],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const fp = result.filePaths[0]
    void setLastImportDir(getActiveProjectPath(), dirname(fp))
    const content = await readFile(fp, 'utf-8')
    return { name: basename(fp), content }
  })

  ipcMain.handle(
    'export-pdf',
    async (
      _event,
      html: string,
      defaultName: string,
      dialogTitle?: string,
      headerTemplate?: string,
      footerTemplate?: string
    ) => {
      const result = await dialog.showSaveDialog({
        title: dialogTitle || 'Export as PDF',
        defaultPath: `${defaultName}.pdf`,
        filters: [{ name: 'PDF Documents', extensions: ['pdf'] }]
      })
      if (result.canceled || !result.filePath) return null

      // Write the HTML to a temp file and loadFile it. A data: URL would
      // cap at ~2MB in Chromium, and exports with embedded base64
      // thumbnails (query results over PDF / image sources) easily go
      // past that, silently dropping the images from the output.
      const tempDir = join(app.getPath('temp'), 'magnolia-pdf-export')
      if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true })
      const tempHtmlPath = join(tempDir, `export-${Date.now()}.html`)
      await writeFile(tempHtmlPath, html, 'utf-8')

      const win = new BrowserWindow({
        show: false,
        width: 800,
        height: 600,
        webPreferences: { sandbox: true }
      })

      try {
        await win.loadFile(tempHtmlPath)
        // Brief delay to let any remaining image decodes settle.
        await new Promise((resolve) => setTimeout(resolve, 300))
        // When a header is supplied, bump the top margin so the
        // header HTML fits above the body content without overlap.
        // Same for footer at the bottom. Chromium's printToPDF
        // requires displayHeaderFooter=true to render either; we
        // also pass empty placeholders for the opposite slot so
        // Chromium's default URL/date/page-number headers don't show.
        const hasHeader = !!headerTemplate
        const hasFooter = !!footerTemplate
        const displayHeaderFooter = hasHeader || hasFooter
        const pdfBuffer = await win.webContents.printToPDF({
          pageSize: await readExportPaperSize(),
          printBackground: true,
          margins: {
            // When a header/footer template is supplied, the page
            // margin doubles as that template's vertical canvas — so
            // give it ~0.95" of room. This also keeps the brand mark
            // well clear of the unprintable strip on most printers.
            top: hasHeader ? 0.95 : 0.5,
            bottom: hasFooter ? 0.95 : 0.5,
            left: 0.5,
            right: 0.5
          },
          ...(displayHeaderFooter
            ? {
                displayHeaderFooter: true,
                headerTemplate: headerTemplate || '<span></span>',
                footerTemplate: footerTemplate || '<span></span>'
              }
            : {})
        })
        await writeFile(result.filePath, pdfBuffer)
        return result.filePath
      } finally {
        win.close()
        try { await unlink(tempHtmlPath) } catch { /* best effort */ }
      }
    }
  )

  ipcMain.handle('export-codebook', async (_event, codes: Code[]) => {
    const result = await dialog.showSaveDialog({
      title: 'Export Codebook',
      defaultPath: 'Codebook.qdc',
      filters: [{ name: 'REFI-QDA Codebook', extensions: ['qdc'] }]
    })
    if (result.canceled || !result.filePath) return null
    const xml = serializeCodebook(codes)
    await writeFile(result.filePath, xml, 'utf-8')
    return result.filePath
  })

  ipcMain.handle('import-codebook', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import Codebook',
      filters: [{ name: 'REFI-QDA Codebook', extensions: ['qdc'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const xml = await readFile(result.filePaths[0], 'utf-8')
    return deserializeCodebook(xml)
  })
}
