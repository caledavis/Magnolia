import { app } from 'electron'
import JSZip from 'jszip'
import { readFile, stat, open, rename, unlink } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { basename, join } from 'path'
import { randomUUID } from 'crypto'
import { serializeProject } from './xml-serializer'
import { buildTranscript } from './transcript-refi'
import { getPdfPageSizes } from '../pdf-extract'
import { detectSourcesDir } from './zip-sources-dir'
import { EDITOR_ENTRY } from './checkout-marker'
import type { Project } from '../../renderer/models/types'

/** Thrown when writeQdpx refuses to save because the incoming payload would
 *  wipe a non-empty project on disk. Caught at the IPC boundary so the
 *  renderer can surface a warning instead of a fatal error. */
export class EmptyProjectGuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmptyProjectGuardError'
  }
}

/** True when the project payload has no user-authored content at all.
 *  Used to decide whether a save is suspicious enough to refuse. */
function isProjectPayloadEmpty(project: Project): boolean {
  return (
    (!project.sources || project.sources.length === 0) &&
    (!project.codes || project.codes.length === 0) &&
    (!project.sets || project.sets.length === 0) &&
    (!project.savedQueries || project.savedQueries.length === 0) &&
    (!project.memos || project.memos.length === 0) &&
    (!project.quotes || project.quotes.length === 0) &&
    (!project.savedAnalyses || project.savedAnalyses.length === 0)
  )
}

/** Count <Source> elements in the project.qde XML inside an existing qdpx
 *  file. Returns 0 if the file is missing, unreadable, or holds no sources.
 *  Used by the load-prevention guard below — we never compute this from the
 *  in-memory payload, only from what is currently on disk. */
async function existingSourceCountOnDisk(filePath: string): Promise<number> {
  try {
    const buf = await readFile(filePath)
    const zip = await JSZip.loadAsync(buf)
    // Tolerate either Magnolia's old project.qde name or the
    // <projectname>.qde naming the spec / Atlas.ti use.
    let qdeFile = zip.file('project.qde')
    if (!qdeFile) {
      const qdeName = Object.keys(zip.files).find(
        (n) => /^[^/]+\.qde$/i.test(n) && !zip.files[n].dir
      )
      if (qdeName) qdeFile = zip.file(qdeName)
    }
    if (!qdeFile) return 0
    const xml = await qdeFile.async('text')
    const matches = xml.match(/<(?:TextSource|PDFSource|AudioSource|VideoSource|PictureSource)\b/g)
    return matches ? matches.length : 0
  } catch {
    return 0
  }
}

/** Read the user's display name from the persisted preferences file, for
 *  stamping into magnolia-editor.json below. Read at save time (rather
 *  than passed in from the renderer) so every save call site honours the
 *  latest saved name without plumbing a new parameter through — same
 *  precedent as ipc-handlers.ts's readExportPaperSize(). Falls back to
 *  '' (unattributed) on any miss. */
function readEditorNameFromDisk(): string {
  try {
    const prefsPath = join(app.getPath('userData'), 'magnolia-preferences.json')
    if (existsSync(prefsPath)) {
      const prefs = JSON.parse(readFileSync(prefsPath, 'utf-8'))
      if (typeof prefs?.userName === 'string') return prefs.userName.trim()
    }
  } catch { /* ignore — fall back to unattributed */ }
  return ''
}

/** Build the .qde filename for a given project. The spec doesn't pin
 *  the name, but Atlas.ti / NVivo use "<projectName>.qde" — match that
 *  so round-trips through other tools find the file where they expect.
 *  Falls back to "project.qde" if the project name has no usable chars. */
function qdeFilenameFor(projectName: string | undefined): string {
  const cleaned = (projectName || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .trim()
  return cleaned ? `${cleaned}.qde` : 'project.qde'
}

/** Stable derivation of a PDF Representation's guid from the source
 *  guid. Mirrors xml-serializer.ts's representationGuidFor — kept in
 *  sync so the .txt filename and the <Representation guid="..."> match.
 *  Flipping the first hex character is deterministic + reversible. */
function representationGuidForSource(sourceGuid: string): string {
  if (!sourceGuid) return sourceGuid
  const first = sourceGuid[0]
  const flipped = (15 - parseInt(first, 16)).toString(16)
  return Number.isNaN(parseInt(first, 16)) ? sourceGuid : flipped + sourceGuid.slice(1)
}

/** Resolve the real audio file extension for a source. Tries (in order)
 *  the explicit audioExt, the source name's extension, and the
 *  audioFilePath's extension. Falls back to "audio" only when nothing
 *  identifies the format. The extension drives both the in-zip
 *  filename and the path attribute on <AudioSource>. */
function audioExtensionFor(s: any): string {
  const explicit = s.formatData?.audioExt as string | undefined
  if (explicit) return explicit.toLowerCase()
  const fromName = (s.name || '').toString().match(/\.([a-z0-9]+)$/i)?.[1]
  if (fromName && fromName.toLowerCase() !== 'audio') return fromName.toLowerCase()
  const fromPath = (s.formatData?.audioFilePath as string | undefined || '')
    .match(/\.([a-z0-9]+)$/i)?.[1]
  if (fromPath && fromPath.toLowerCase() !== 'audio') return fromPath.toLowerCase()
  return 'audio'
}

export async function writeQdpx(
  filePath: string,
  project: Project,
  sourceContents: Record<string, string>,
  opts?: {
    /** Archive to carry imported binaries forward from when their temp
     *  working copy has been reaped. Defaults to `filePath` (the file
     *  being overwritten). For Save As, pass the currently-open project
     *  path so binaries follow the project to its new location. */
    carryForwardFrom?: string
    /** Resolve a freshly-imported `magnolia-bin://overlay/...` binary held
     *  in the main-process import overlay to its bytes, so this save can
     *  embed it into the archive. */
    resolveOverlay?: (handle: string) => Buffer | null
    /** Called after an overlay binary is embedded as `sources/<guid>.<ext>`,
     *  so the store can free the in-memory buffer and remember token→guid. */
    markPersisted?: (handle: string, guid: string) => void
    /** Skip carrying the checkout lock (magnolia-lock.json) and stable
     *  project id (magnolia-project-id.json) forward from `carryForwardFrom`
     *  / `filePath`. Normal Save and Save As want the opposite — the lock
     *  must survive an edit-while-checked-out save — but "Create a Copy"
     *  from the checkout-conflict dialog wants a clean break: the new file
     *  should never look checked out (by anyone) just because the source
     *  file was. */
    dropLock?: boolean
  }
): Promise<void> {
  // Document-loss guard: never overwrite an on-disk project's sources with
  // a zero-source payload. Catches partial-empty wipes (e.g. document store
  // reset by HMR or a project-switch race) that the all-empty guard below
  // would miss. The XML on disk is the source of truth for "what would be
  // destroyed by this save" — we never trust the in-memory payload to
  // self-report its own staleness.
  if (!project.sources || project.sources.length === 0) {
    const onDiskCount = await existingSourceCountOnDisk(filePath)
    if (onDiskCount > 0) {
      throw new EmptyProjectGuardError(
        `Refusing to overwrite "${filePath}" — incoming payload has 0 sources but ` +
        `the file currently contains ${onDiskCount}. This usually means a bug reset ` +
        'the document store after the file was opened. Use Save As to a new path if ' +
        'you really want to save an empty project.'
      )
    }
  }

  // All-empty safety net: refuse to overwrite a non-empty file on disk with
  // an all-empty payload (no sources, codes, sets, queries, memos, quotes,
  // or analyses). Belt-and-suspenders behind the document-loss guard above.
  if (isProjectPayloadEmpty(project)) {
    try {
      const st = await stat(filePath)
      if (st.size > 2048) {
        throw new EmptyProjectGuardError(
          `Refusing to overwrite "${filePath}" (${st.size} bytes) with an empty project. ` +
          'Use Save As if you really want to save an empty project.'
        )
      }
    } catch (e: any) {
      if (e instanceof EmptyProjectGuardError) throw e
      if (e.code !== 'ENOENT') throw e
    }
  }

  // Content-loss guard: catch the case the count-based guards above miss —
  // a project that still HAS its sources but whose in-memory text content
  // map is completely empty. Every healthy load (and every newly-added doc)
  // registers a sourceContents entry per text-bearing source, even an empty
  // string; a totally empty map alongside real sources means the content was
  // never loaded — a failed/partial open or an HMR store reset — not a real
  // edit. Writing it would keep the source structure but drop every document
  // body. Image sources carry no text content, so they're excluded from the
  // check (an image-only project legitimately has an empty content map).
  const textBearingSources = (project.sources ?? []).filter(
    (s: any) => s.sourceType !== 'image'
  )
  if (textBearingSources.length > 0 && Object.keys(sourceContents).length === 0) {
    try {
      const st = await stat(filePath)
      if (st.size > 2048) {
        throw new EmptyProjectGuardError(
          `Refusing to overwrite "${filePath}" — the project has ${textBearingSources.length} ` +
          'document(s) but no text content is loaded for any of them. This usually means the ' +
          'project did not open fully; saving now would erase the document text. Reopen the ' +
          'project, and if the problem persists restore from a backup.'
        )
      }
    } catch (e: any) {
      if (e instanceof EmptyProjectGuardError) throw e
      if (e.code !== 'ENOENT') throw e
    }
  }

  // Update modification timestamp
  project.modifiedDateTime = new Date().toISOString()

  // Prepare sources: ensure each has a plainTextPath for the QDPX file
  const preparedProject = { ...project }
  preparedProject.sources = project.sources.map((source) => {
    const sourceCopy = { ...source }
    // Store content as external file in sources/ folder
    sourceCopy.plainTextPath = `internal://${source.guid}.txt`
    // Don't embed inline content when using file path
    delete sourceCopy.plainTextContent
    // Audio/video: attach the standards-native <Transcript> (text path +
    // per-line SyncPoints derived from formatData.lineTimes) so the synced
    // transcript round-trips to other tools. Computed here because the
    // transcript text — needed for SyncPoint character offsets — lives in
    // sourceContents, not the project model. The serializer reads this
    // transient; magnolia-sources.json still carries lineTimes for full
    // Magnolia↔Magnolia fidelity.
    const kind = (source as any).sourceType
    if (kind === 'audio' || kind === 'video') {
      // Pass the source's selections too: char-offset transcript codings
      // become <TranscriptSelection>s (video time-range codings are skipped
      // — they ride in <VideoSelection> instead). This is what makes audio
      // transcript codings persist at all and round-trip to other tools.
      const transcript = buildTranscript(
        source.guid,
        sourceContents[source.guid] ?? '',
        (source as any).formatData?.lineTimes,
        (source as any).selections ?? []
      )
      if (transcript) (sourceCopy as any)._refiTranscript = transcript
    }
    return sourceCopy
  })

  // PDF box-selection export needs each page's height to flip Magnolia's
  // top-left rectangles into the bottom-left, 0-based-page <PDFSelection>
  // convention other tools use. Reloaded PDFs already carry pdfPageSizes
  // (the reader stores it); freshly-imported ones don't, so derive it here
  // from the in-memory PDF bytes — only for sources that actually have a
  // region coding, so the extra parse is rare. Falls back silently to a
  // top-left selection when the bytes/sizes can't be obtained.
  await Promise.all(
    preparedProject.sources.map(async (source: any) => {
      if (source.sourceType !== 'pdf') return
      const fd = source.formatData
      if (!fd || fd.pdfPageSizes) return
      const hasRegion = (source.selections ?? []).some((sel: any) => sel.pdfRegion)
      if (!hasRegion) return
      let buf: Buffer | null = null
      if (fd.pdfBase64) buf = Buffer.from(fd.pdfBase64, 'base64')
      else if (typeof fd.pdfFilePath === 'string' && fd.pdfFilePath.startsWith('magnolia-bin://overlay/')) {
        buf = opts?.resolveOverlay?.(fd.pdfFilePath) ?? null
      }
      if (!buf) return
      try {
        source.formatData = { ...fd, pdfPageSizes: await getPdfPageSizes(buf) }
      } catch { /* leave sizes unset → serializer falls back to top-left */ }
    })
  )

  const xml = serializeProject(preparedProject)

  const zip = new JSZip()
  zip.file(qdeFilenameFor(project.name), xml)

  // Add source files
  const sourcesFolder = zip.folder('sources')!
  for (const source of project.sources) {
    // Image sources don't have textual content — their bytes go in as
    // ${guid}.${imageExt} below. Writing an empty .txt would clutter the zip.
    if ((source as any).sourceType === 'image') continue
    const content = sourceContents[source.guid]
    if (content === undefined) continue
    if ((source as any).sourceType === 'pdf') {
      // PDFs reference their extracted text via a <Representation>
      // child whose guid differs from the source guid. The .txt has
      // to live under the Representation's guid so the path the XML
      // points at actually resolves. representationGuidForSource
      // mirrors the deterministic flip used by xml-serializer.ts.
      sourcesFolder.file(`${representationGuidForSource(source.guid)}.txt`, content)
    } else {
      sourcesFolder.file(`${source.guid}.txt`, content)
    }
  }

  // Store saved queries as JSON (app-specific, not part of REFI-QDA XML)
  if (project.savedQueries && project.savedQueries.length > 0) {
    zip.file('magnolia-queries.json', JSON.stringify(project.savedQueries))
  }

  // Store logbook entries as JSON (app-specific, not part of REFI-QDA XML)
  if (project.logbookEntries && project.logbookEntries.length > 0) {
    zip.file('magnolia-logbook.json', JSON.stringify(project.logbookEntries))
  }

  // Store memos as JSON (Magnolia-specific, full fidelity) AND as a plain
  // text body per memo, referenced by the REFI-QDA <Note plainTextPath> the
  // serializer emits — so memos round-trip with other tools (Atlas.ti).
  if (project.memos && project.memos.length > 0) {
    zip.file('magnolia-memos.json', JSON.stringify(project.memos))
    for (const memo of project.memos) {
      sourcesFolder.file(`${memo.guid}.txt`, memo.content ?? '')
    }
  }

  // Store quotes as JSON (app-specific)
  if (project.quotes && project.quotes.length > 0) {
    zip.file('magnolia-quotes.json', JSON.stringify(project.quotes))
  }

  // Store saved analyses as JSON (app-specific)
  if (project.savedAnalyses && project.savedAnalyses.length > 0) {
    zip.file('magnolia-analyses.json', JSON.stringify(project.savedAnalyses))
  }

  // Store open Document Viewer tabs + per-tool counters (app-specific).
  // Skip the file entirely when there's nothing to record so tiny
  // projects stay tiny.
  const tabState = (project as any).tabState
  if (
    tabState &&
    ((tabState.openTabs && tabState.openTabs.length > 0) ||
      (tabState.perToolCounters && Object.keys(tabState.perToolCounters).length > 0))
  ) {
    zip.file('magnolia-tabs.json', JSON.stringify(tabState))
  }

  // Store document folders + the per-source folder mapping. REFI-QDA
  // has no folder concept, so this is purely Magnolia metadata. Skipped
  // entirely when there's nothing to record so we don't bloat the zip.
  if (
    (project.folders && project.folders.length > 0) ||
    (project.sourceFolder && Object.keys(project.sourceFolder).length > 0)
  ) {
    zip.file(
      'magnolia-folders.json',
      JSON.stringify({
        folders: project.folders ?? [],
        sourceFolder: project.sourceFolder ?? {}
      })
    )
  }

  // Store tag categories and tag extension data (categoryGuid/value on Sets)
  // These are Magnolia-specific extensions not in the REFI-QDA standard
  const tagExtensions: any = {}
  if (project.tagCategories && project.tagCategories.length > 0) {
    tagExtensions.categories = project.tagCategories
  }
  // tagMeta carries the Magnolia-only bits of a tag that REFI-QDA's
  // <Set> can't express: its category/value, and membership on survey
  // sub-entities (respondents / questions, which aren't sources so
  // can't ride in <MemberSource>). Survey- and document-level tags
  // still round-trip as standard Sets via memberSourceGuids.
  const tagMeta = project.sets
    .filter(
      (s) =>
        s.categoryGuid ||
        s.value ||
        s.memberSurveyRespondents?.length ||
        s.memberSurveyQuestions?.length
    )
    .map((s) => ({
      guid: s.guid,
      categoryGuid: s.categoryGuid,
      value: s.value,
      memberSurveyRespondents: s.memberSurveyRespondents,
      memberSurveyQuestions: s.memberSurveyQuestions
    }))
  if (tagMeta.length > 0) {
    tagExtensions.tagMeta = tagMeta
  }
  if (Object.keys(tagExtensions).length > 0) {
    zip.file('magnolia-tags.json', JSON.stringify(tagExtensions))
  }

  // Store code hotkey assignments (Magnolia-specific)
  const collectHotkeys = (codes: typeof project.codes): { guid: string; hotkey: number }[] => {
    const result: { guid: string; hotkey: number }[] = []
    for (const c of codes) {
      if (c.hotkey !== undefined) result.push({ guid: c.guid, hotkey: c.hotkey })
      result.push(...collectHotkeys(c.children))
    }
    return result
  }
  const hotkeys = collectHotkeys(project.codes)
  if (hotkeys.length > 0) {
    zip.file('magnolia-codes.json', JSON.stringify({ hotkeys }))
  }

  // --- Embed every imported binary (pdf / image / audio / video) --------
  // The .qdpx must be self-contained: each imported file's bytes have to
  // live inside the archive, not merely in OS temp (which gets reaped on
  // reboot / age-out, silently producing an incomplete project on the next
  // save — the bug this fixes). For each binary source we resolve its
  // bytes from, in priority order:
  //   1. base64 held in memory (freshly imported PDFs),
  //   2. the temp working copy we extracted on open/import,
  //   3. the copy still inside the .qdpx on disk — the last-resort source
  //      when temp has been reaped, so a re-save can never drop a binary
  //      the project already held.
  // writtenBinaries records which sources actually got their bytes
  // embedded, so the metadata pass and the completeness guard below stay
  // in sync with what's really in the archive.
  const writtenBinaries = new Set<string>()
  // Overlay binaries embedded by this save. Their in-memory buffers are
  // only released (markPersisted) once the archive is actually on disk —
  // see the end of this function. Releasing them here, mid-save, let an
  // overlapping save (e.g. autosave racing Merge's Save & Close) find the
  // buffer already gone and the bytes not yet in the on-disk .qdpx, so it
  // tripped the completeness guard; and if THIS save then failed (guard,
  // write error), the bytes were lost for good.
  const persistedOverlays: { handle: string; guid: string }[] = []

  // Best-effort handle on the archive we're about to overwrite (or, for
  // Save As, the project currently open). Loaded once; used only to carry
  // binaries forward when their temp copy has gone missing.
  let existingZip: JSZip | null = null
  let existingSourcesDir = 'sources'
  try {
    const existingBuf = await readFile(opts?.carryForwardFrom ?? filePath)
    existingZip = await JSZip.loadAsync(existingBuf)
    // The file being carried forward from may be an NVivo original (its
    // "Sources" folder, not Magnolia's lowercase "sources") on a project's
    // very first save after import — resolve the real casing so carried-
    // forward binaries aren't silently dropped. New saves always write
    // lowercase "sources" below, regardless of what's read here.
    existingSourcesDir = detectSourcesDir(existingZip)
  } catch { /* new project, or Save As to a path with no prior file */ }

  /** Pull a source's binary out of the on-disk archive. Tries the exact
   *  expected filename first, then any non-text `${existingSourcesDir}/${guid}.*`
   *  entry (the original extension may be unknown if formatData was lost). */
  const carryForwardBinary = async (
    guid: string,
    expectedName: string
  ): Promise<Buffer | null> => {
    if (!existingZip) return null
    let entry = existingZip.file(`${existingSourcesDir}/${expectedName}`)
    if (!entry) {
      const prefix = `${existingSourcesDir}/${guid}.`
      const altName = Object.keys(existingZip.files).find(
        (n) =>
          n.startsWith(prefix) &&
          !existingZip!.files[n].dir &&
          !n.toLowerCase().endsWith('.txt')
      )
      if (altName) entry = existingZip.file(altName)
    }
    return entry ? await entry.async('nodebuffer') : null
  }

  const readTempFile = async (p: string): Promise<Buffer | null> => {
    try {
      return await readFile(p)
    } catch {
      return null
    }
  }

  for (const s of project.sources as any[]) {
    const kind = s.sourceType
    if (kind !== 'pdf' && kind !== 'image' && kind !== 'audio' && kind !== 'video') continue
    const fd = s.formatData || {}

    // Extension the XML serializer will emit for this source's path — the
    // in-zip filename must match it exactly so the reader can resolve it.
    const ext =
      kind === 'pdf'
        ? 'pdf'
        : kind === 'image'
          ? (fd.imageExt as string) || 'png'
          : kind === 'audio'
            ? audioExtensionFor(s)
            : (fd.videoExt as string) || 'mp4'
    const internalName = `${s.guid}.${ext}`

    // The binary's source, in priority order: inline base64 (PDFs), the
    // in-memory import overlay (a magnolia-bin://overlay/... handle, fresh
    // imports), a legacy real temp path, or — for archive handles and as a
    // last resort — the copy still inside the on-disk .qdpx.
    const pathOrHandle =
      kind === 'pdf'
        ? fd.pdfFilePath
        : kind === 'image'
          ? fd.imageFilePath
          : kind === 'audio'
            ? fd.audioFilePath
            : fd.videoFilePath
    const ARCHIVE_PREFIX = 'magnolia-bin://archive/'
    const isOverlay = typeof pathOrHandle === 'string' && pathOrHandle.startsWith('magnolia-bin://overlay/')
    const isHandle = typeof pathOrHandle === 'string' && pathOrHandle.startsWith('magnolia-bin://')
    // An archive handle records the binary's real in-archive filename, which
    // for files from other tools (Atlas.ti) differs from `<guid>.<ext>`. Use
    // it as the carry-forward lookup name so we find the bytes; we still WRITE
    // them under `<guid>.<ext>` to match the path the serializer emits.
    const carryName =
      isHandle && !isOverlay && (pathOrHandle as string).startsWith(ARCHIVE_PREFIX)
        ? (pathOrHandle as string).slice(ARCHIVE_PREFIX.length)
        : internalName

    let buf: Buffer | null = null
    if (kind === 'pdf' && fd.pdfBase64) {
      buf = Buffer.from(fd.pdfBase64, 'base64')
    } else if (isOverlay) {
      buf = opts?.resolveOverlay?.(pathOrHandle as string) ?? null
    } else if (pathOrHandle && !isHandle) {
      buf = await readTempFile(pathOrHandle)
    }

    // Temp/overlay copy missing or it's an archive handle — recover from the
    // archive on disk so a re-save can't drop a binary it once held.
    if (!buf) buf = await carryForwardBinary(s.guid, carryName)

    if (buf) {
      sourcesFolder.file(internalName, buf)
      writtenBinaries.add(s.guid)
      if (isOverlay) persistedOverlays.push({ handle: pathOrHandle as string, guid: s.guid })
    }
  }

  // Source metadata (sourceType, formatData for PDF/markdown, etc.)
  const sourceMeta = project.sources
    .filter(
      (s: any) =>
        (s.sourceType && s.sourceType !== 'text') ||
        s.formatData ||
        s.selections?.some((sel: any) => sel.pdfRegion)
    )
    .map((s: any) => {
      const meta: any = { guid: s.guid }
      if (s.sourceType && s.sourceType !== 'text') meta.sourceType = s.sourceType

      // Region-based selections (for PDFs imported from other QDA tools).
      // Stored as a side table so the plain REFI-QDA XML stays valid.
      // Image regions are skipped — they go in the XML directly as proper
      // <PictureSelection> elements, so there's no need for a side table
      // (which would also go stale if the file round-trips through MAXQDA
      // / NVivo, who'd update the XML but never magnolia-sources.json).
      if (s.sourceType !== 'image') {
        const regionSelections = (s.selections || [])
          .filter((sel: any) => sel.pdfRegion)
          .map((sel: any) => ({ guid: sel.guid, region: sel.pdfRegion }))
        if (regionSelections.length > 0) {
          meta.pdfRegionSelections = regionSelections
        }
      }
      // Survey-cell selections (Magnolia-specific extension). Their
      // startPosition/endPosition are CELL-relative (offsets into one
      // answer cell, not the source's plain text), and the
      // (respondentId, questionId) pair that identifies the cell isn't
      // part of the standard schema — so these are NOT emitted on the
      // survey TextSource in the XML (other tools would render them at
      // the wrong place). We persist the WHOLE selection here instead
      // (guid, offsets, codings, surveyCell) and rebuild it on load.
      // Open-ended codings are additionally promoted to proper
      // source-relative spans on the per-respondent documents so they
      // survive a round-trip through Atlas.ti / MAXQDA.
      if (s.sourceType === 'survey') {
        const cellSelections = (s.selections || []).filter((sel: any) => sel.surveyCell)
        if (cellSelections.length > 0) {
          meta.surveyCellSelections = cellSelections.map((sel: any) => ({ ...sel }))
        }
      }
      // Binary payloads (pdf/image/audio/video) were resolved + embedded
      // by the pass above; here we only record side-table metadata and a
      // hasXBinary flag that reflects whether the bytes ACTUALLY made it
      // into the archive (writtenBinaries) — never an unconditional true,
      // which is what previously let a silently-dropped binary masquerade
      // as present. lineTimes / video anchors are Magnolia-specific extras
      // that ride in this JSON side-table rather than the REFI-QDA XML.
      const fd = s.formatData
      if (s.sourceType === 'pdf') {
        meta.formatData = {
          pdfPageOffsets: fd?.pdfPageOffsets,
          hasPdfBinary: writtenBinaries.has(s.guid)
        }
      } else if (s.sourceType === 'image') {
        meta.formatData = {
          hasImageBinary: writtenBinaries.has(s.guid),
          mimeType: fd?.mimeType,
          imageExt: fd?.imageExt
        }
      } else if (s.sourceType === 'audio') {
        meta.formatData = {
          hasAudioBinary: writtenBinaries.has(s.guid),
          audioExt: audioExtensionFor(s),
          mimeType: fd?.mimeType,
          duration: fd?.duration,
          channels: fd?.channels,
          sampleRate: fd?.sampleRate,
          lineTimes: fd?.lineTimes
        }
      } else if (s.sourceType === 'video') {
        meta.formatData = {
          hasVideoBinary: writtenBinaries.has(s.guid),
          mimeType: fd?.mimeType,
          videoExt: fd?.videoExt,
          duration: fd?.duration,
          width: fd?.width,
          height: fd?.height,
          lineTimes: fd?.lineTimes
        }
        // Per-selection transcript anchors + the manuallyAnchored flag.
        // REFI-QDA's <VideoSelection> carries only begin/end times, so
        // anchors live in a Magnolia-specific side table and are
        // re-attached on load.
        // Video codings are character-precise: persist their codepoint
        // offsets so the text highlight survives a round-trip. (timeRange,
        // if any, rides in the REFI <VideoSelection>.)
        const anchors = (s.selections || [])
          .filter((sel: any) => sel.codings?.length > 0)
          .map((sel: any) => ({
            guid: sel.guid,
            startChar: sel.startPosition ?? 0,
            endChar: sel.endPosition ?? 0,
            manuallyAnchored: !!sel.manuallyAnchored
          }))
        if (anchors.length > 0) meta.videoSelectionAnchors = anchors
      } else if (s.formatData) {
        meta.formatData = s.formatData
      }
      return meta
    })
  if (sourceMeta.length > 0) {
    zip.file('magnolia-sources.json', JSON.stringify({ sourceMeta }))
  }

  // Completeness guard: the .qdpx must embed every imported file. If a
  // source's formatData still claims a binary (base64 or a temp path) but
  // we couldn't write its bytes — not from memory, the temp cache, or the
  // copy inside the on-disk .qdpx — refuse to write a silently-incomplete
  // project rather than dropping the document's content. (Sources whose
  // formatData no longer references any binary are already-lost legacy
  // cases we can't recover here, so they don't block the save.)
  const droppedBinaries = (project.sources as any[])
    .filter((s) => {
      const fd = s.formatData
      if (!fd) return false
      const declaresBinary =
        (s.sourceType === 'pdf' && (fd.pdfBase64 || fd.pdfFilePath)) ||
        (s.sourceType === 'image' && fd.imageFilePath) ||
        (s.sourceType === 'audio' && fd.audioFilePath) ||
        (s.sourceType === 'video' && fd.videoFilePath)
      return declaresBinary && !writtenBinaries.has(s.guid)
    })
    .map((s) => s.name || s.guid)
  if (droppedBinaries.length > 0) {
    throw new EmptyProjectGuardError(
      `Refusing to save "${filePath}" — the binary content for ${droppedBinaries.length} ` +
        `imported document(s) could not be located (${droppedBinaries.join(', ')}). Their bytes ` +
        'were not in memory, the temp cache, or the existing project file, so saving now would ' +
        'write them out empty. Re-import the affected document(s) and try again.'
    )
  }

  // Carry forward the checkout-lock side-tables. This zip is built fresh
  // above and only ever gets entries we explicitly know about, so without
  // this a normal Save while checked out would silently erase
  // magnolia-lock.json (and the stable project id) the moment the user
  // saves an edit — defeating check-out/check-in entirely. Applies to both
  // regular Save (filePath is the file being overwritten) and Save As
  // (carryForwardFrom), so a project's lock/identity follows it to a new
  // path the same way its binaries already do. opts.dropLock opts out —
  // see its own comment.
  //
  // Deliberately does its OWN fresh read here instead of reusing
  // existingZip (loaded at the top of this function, for binary carry-
  // forward): writeQdpx can run long — embedding a multi-MB binary is
  // exactly the case where auto-checkout's own writeCheckoutMarker call,
  // fired off the same edit a moment earlier, is still racing this save.
  // If existingZip's snapshot was taken before that lock landed, carrying
  // IT forward would silently erase the lock the instant this save
  // finishes and overwrites the file — which is the actual bug that
  // caused a user's own successful checkout to vanish under their own
  // subsequent autosave. Re-reading right before use, as late as
  // possible, closes that window the same way writeCheckoutMarker's own
  // late re-check does.
  if (!opts?.dropLock) {
    try {
      const latestBuf = await readFile(opts?.carryForwardFrom ?? filePath)
      const latestZip = await JSZip.loadAsync(latestBuf)
      const lockFile = latestZip.file('magnolia-lock.json')
      if (lockFile) zip.file('magnolia-lock.json', await lockFile.async('nodebuffer'))
      const idFile = latestZip.file('magnolia-project-id.json')
      if (idFile) zip.file('magnolia-project-id.json', await idFile.async('nodebuffer'))
    } catch { /* new project, or Save As to a path with no prior file */ }
  }

  // Stamp who last saved this project and when — unlike the checkout
  // lock above, this is written fresh on EVERY save (not carried
  // forward), regardless of whether the user ever clicks Check Out, so
  // features like merge can always attribute a file's differences to a
  // person. Lives in the same kind of Magnolia-only zip entry as the
  // checkout marker — never in the .qde.
  zip.file(EDITOR_ENTRY, JSON.stringify({
    lastEditedBy: readEditorNameFromDisk(),
    lastEditedAt: new Date().toISOString()
  }))

  const buffer = await zip.generateAsync({ type: 'nodebuffer' })

  // Atomic write: stream the full archive to a sibling temp file, flush it
  // to disk, then rename it over the target. The rename is atomic on
  // macOS/Linux/Windows, so an interrupted write — a crash, the app being
  // quit mid-save, or a dev HMR teardown of the main process — can never
  // leave a half-written file in place of the user's project. Worst case is
  // a leftover `.tmp` beside the project; the original stays intact.
  //
  // This is the fix for the truncated-to-1 MB corruption: previously the
  // buffer was written straight onto `filePath`, so a write cut short part
  // way through destroyed the existing file and lost its central directory.
  const tmpPath = `${filePath}.${randomUUID()}.tmp`
  try {
    const handle = await open(tmpPath, 'w')
    try {
      await handle.writeFile(buffer)
      // fsync so the bytes are durably on disk before we swap the file in —
      // otherwise a power loss right after rename could surface an empty or
      // partial file under the project's name.
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmpPath, filePath)
  } catch (err) {
    // Best-effort cleanup; never mask the original failure.
    await unlink(tmpPath).catch(() => { /* temp may not exist */ })
    throw err
  }

  // The archive now durably holds every embedded overlay binary, so it's
  // safe to free the buffers — later reads resolve via token→guid.
  for (const { handle, guid } of persistedOverlays) opts?.markPersisted?.(handle, guid)
}

/** Materialize an empty .qdpx at filePath. Used by the welcome-screen
 *  "New" flow and the in-app File → New Project flow so the user picks
 *  the file location up-front instead of working in an unsaved limbo.
 *  Returns the project name derived from the file basename. */
export async function createEmptyProjectFile(filePath: string): Promise<string> {
  const projectName = basename(filePath).replace(/\.qdpx$/i, '')
  const userGuid = randomUUID()
  const emptyProject: Project = {
    name: projectName,
    origin: `Magnolia ${app.getVersion()}`,
    users: [{ guid: userGuid, name: 'User' }],
    creatingUserGUID: userGuid,
    creationDateTime: new Date().toISOString(),
    codes: [],
    sources: [],
    sets: [],
    notes: [],
    tagCategories: [],
    savedQueries: [],
    logbookEntries: [],
    memos: [],
    quotes: [],
    savedAnalyses: []
  }
  await writeQdpx(filePath, emptyProject, {})
  return projectName
}
