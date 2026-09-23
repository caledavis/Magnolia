import JSZip from 'jszip'
import { readFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import { deserializeProject } from './xml-deserializer'
import type { RawPdfSelection, RawPictureSelection, RawVideoSelection, RawNote, RawNoteAnchor } from './xml-deserializer'
import { refiToSurvey, type RefiVariable, type RefiCase } from './survey-refi'
import { graphToMap, type RefiGraph, type RefiLink, type GraphEntity } from './graph-refi'
import { reconstructLineTimes, reconstructTranscriptSelections, reconcileMediaTranscripts, lineStartOffsetsWithEnd, deriveLineTimeRange, transcriptTwinGuidFor, type RefiTranscript } from './transcript-refi'
import type { Project, PlainTextSelection, Memo } from '../../renderer/models/types'
import { extractPdfTextWithPositions } from '../pdf-extract'
import { archiveHandle, archiveHandleForFile } from '../binary-store'
import { decodeMaybeWindows1252 } from './text-encoding'
import { detectSourcesDir } from './zip-sources-dir'

/**
 * Read a text file from the archive, tolerating non-UTF-8 transcripts.
 * Other tools (Atlas.ti) write transcript .txt files in Windows-1252, which a
 * strict UTF-8 read turns into U+FFFD replacement chars — see
 * decodeMaybeWindows1252.
 */
async function readZipText(file: JSZip.JSZipObject): Promise<string> {
  return decodeMaybeWindows1252(await file.async('nodebuffer'))
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp'
}

const VIDEO_MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo'
}

const AUDIO_MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac'
}

/** Convert a raw <VideoSelection> (milliseconds per REFI-QDA) into a
 *  Magnolia time-range PlainTextSelection. */
function convertVideoSelection(raw: RawVideoSelection): PlainTextSelection {
  return {
    guid: raw.guid,
    name: raw.name,
    startPosition: 0,
    endPosition: 0,
    timeRange: { startTime: raw.begin / 1000, endTime: raw.end / 1000 },
    creatingUser: raw.creatingUser,
    creationDateTime: raw.creationDateTime,
    modifyingUser: raw.modifyingUser,
    modifiedDateTime: raw.modifiedDateTime,
    codings: raw.codings
  }
}

/** Convert a raw <PictureSelection> into a region-based PlainTextSelection.
 *  REFI-QDA defines coordinates as pixels with top-left origin (no quirks
 *  yet — add a `getPictureSelectionQuirks(origin)` helper here if a real-
 *  world tool ships a different convention). */
function convertPictureSelection(raw: RawPictureSelection): PlainTextSelection {
  const x = Math.min(raw.firstX, raw.secondX)
  const y = Math.min(raw.firstY, raw.secondY)
  const width = Math.abs(raw.secondX - raw.firstX)
  const height = Math.abs(raw.secondY - raw.firstY)
  return {
    guid: raw.guid,
    name: raw.name,
    startPosition: 0,
    endPosition: 0,
    pdfRegion: { page: 1, x, y, width, height },
    creatingUser: raw.creatingUser,
    creationDateTime: raw.creationDateTime,
    modifyingUser: raw.modifyingUser,
    modifiedDateTime: raw.modifiedDateTime,
    codings: raw.codings
  }
}

/**
 * Return the unit scale an exporting tool uses for <PDFSelection>
 * coordinates, expressed as a multiplier that converts the stored value
 * into PDF user-space points (72 DPI).
 *
 * Tool-specific overrides go here. The REFI-QDA spec says selections are
 * in points with a top-left origin, but MAXQDA (and a handful of other
 * Windows-first tools) store them in 96-DPI screen pixels instead — a
 * 72/96 = 0.75 factor. Detection by "does it fit in the page bounds?" is
 * unreliable because most selections fit at any reasonable scale, so we
 * dispatch on the `origin` attribute first and fall back to heuristic
 * detection only when the origin is unknown.
 */
/**
 * Per-origin quirks for reading <PDFSelection> coordinates. The REFI-QDA
 * spec says rectangles are in PDF user-space points with a top-left
 * origin, but real-world exporters differ:
 *
 *   - MAXQDA writes raw points but uses a PDF-native bottom-LEFT origin
 *     (Y increases upward), plus it 0-indexes the `page` attribute.
 *
 * We verified this empirically against a known-coded "[JUSTICE]" region
 * in a MAXQDA-exported QDPX: only the bottom-origin + 1-based page shift
 * lands the box on the text "are brought to justice."
 */
interface PdfSelectionQuirks {
  pageBase: number        // added to raw `page` attribute (0 for 1-based, 1 for 0-based)
  unitScale: number       // multiply x/y/w/h to convert into PDF user-space points
  yFlip: boolean          // true = stored coords use PDF-native bottom-origin
}

function getPdfSelectionQuirks(origin: string): PdfSelectionQuirks {
  const o = origin.toLowerCase()
  if (o.startsWith('maxqda')) return { pageBase: 1, unitScale: 1, yFlip: true }
  // Atlas.ti writes <PDFSelection> in PDF-native bottom-left origin with
  // 0-based page numbers (page="0" is the first page), so flip Y and add 1
  // to match Magnolia's top-origin, 1-based page model. Only affects
  // region-only PDF codings — text codings ride the char-offset
  // <PlainTextSelection> instead.
  if (o.startsWith('atlas')) return { pageBase: 1, unitScale: 1, yFlip: true }
  // Add more known tools here as they come up.
  return { pageBase: 0, unitScale: 1, yFlip: false }
}

/**
 * Convert a raw <PDFSelection> rectangle into a Magnolia PlainTextSelection
 * that carries its original page/x/y/width/height in `pdfRegion`. The
 * viewer renders region-based selections directly on the PDF canvas rather
 * than trying to map them into the extracted text stream, which preserves
 * the exact position of the original coding.
 *
 * Coordinates are normalized to top-left origin — `firstX/Y` and
 * `secondX/Y` from the XML may describe any two opposite corners — and
 * scaled from the exporting tool's unit system into PDF user-space points.
 */
/**
 * Compute the top-origin rectangle (in PDF points) for a raw PDFSelection,
 * respecting the exporting tool's unit scale and Y-origin convention.
 */
function resolveRawRect(
  raw: RawPdfSelection,
  quirks: PdfSelectionQuirks,
  pageSizes: { width: number; height: number }[],
  page: number
): { x: number; y: number; width: number; height: number } {
  const x = Math.min(raw.firstX, raw.secondX) * quirks.unitScale
  const width = Math.abs(raw.secondX - raw.firstX) * quirks.unitScale
  const height = Math.abs(raw.secondY - raw.firstY) * quirks.unitScale
  let y: number
  if (quirks.yFlip) {
    const pageSize = pageSizes[page]
    y = pageSize
      ? pageSize.height - Math.max(raw.firstY, raw.secondY) * quirks.unitScale
      : Math.min(raw.firstY, raw.secondY) * quirks.unitScale
  } else {
    y = Math.min(raw.firstY, raw.secondY) * quirks.unitScale
  }
  return { x, y, width, height }
}

/**
 * Convert a standalone <PDFSelection> into a region-based box selection.
 *
 * A <PDFSelection> is a geometric rectangle on the page — that's a *box*
 * coding, and Magnolia keeps it as one. (We used to "upgrade" rectangles
 * that happened to overlap text into char-offset text selections for
 * hover/search, but that mis-imported a genuine box drawn over text or an
 * image as a thin text bracket — the bug this fixes.) Text codings come in
 * through the <PlainTextSelection> path instead and never reach here: a
 * tool that exports a text coding as both a PlainTextSelection and a
 * duplicate-guid PDFSelection has the PDFSelection filtered out by the
 * caller's existing-guid check, so only true box codings are converted.
 */
function convertPdfSelection(
  raw: RawPdfSelection,
  quirks: PdfSelectionQuirks,
  pageSizes: { width: number; height: number }[]
): PlainTextSelection {
  const page = raw.page + quirks.pageBase
  const rect = resolveRawRect(raw, quirks, pageSizes, page)
  return {
    guid: raw.guid,
    name: raw.name,
    startPosition: 0,
    endPosition: 0,
    pdfRegion: { page, ...rect },
    creatingUser: raw.creatingUser,
    creationDateTime: raw.creationDateTime,
    modifyingUser: raw.modifyingUser,
    modifiedDateTime: raw.modifiedDateTime,
    codings: raw.codings
  }
}

/** Progress reporter: (stage, current, total). `total` may be 0 for indeterminate stages. */
export type QdpxProgress = (stage: string, current: number, total: number) => void

/** Extract one binary's raw bytes from an arbitrary .qdpx on disk, by the
 *  in-archive filename encoded in a `magnolia-bin://archive/<name>` handle
 *  (see binary-store.ts's archiveFileNameFromHandle). Unlike
 *  binary-store's own resolveHandle — which only ever reads from whichever
 *  single .qdpx is "active" in the open project — this reads from ANY
 *  .qdpx path, so Merge can pull a pdf/audio/video/image source's bytes
 *  out of the comparison file to bring the document into the active one. */
export async function readArchiveFile(filePath: string, internalName: string): Promise<Buffer | null> {
  const zip = await JSZip.loadAsync(await readFile(filePath))
  const sourcesDir = detectSourcesDir(zip)
  const entry = zip.file(`${sourcesDir}/${internalName}`)
  return entry ? entry.async('nodebuffer') : null
}

export async function readQdpx(
  filePath: string,
  onProgress?: QdpxProgress
): Promise<Project & { sourceContents: Record<string, string> }> {
  onProgress?.('Reading file', 0, 0)
  const buffer = await readFile(filePath)

  onProgress?.('Unpacking archive', 0, 0)
  const zip = await JSZip.loadAsync(buffer)

  // NVivo exports this folder as "Sources" rather than Magnolia's
  // lowercase "sources" — resolve the real casing once so every
  // `${sourcesDir}/...` lookup below finds NVivo's files too.
  const sourcesDir = detectSourcesDir(zip)

  // Find the .qde XML at the root of the zip. Magnolia's writer used
  // to hardcode "project.qde", but the REFI-QDA spec doesn't pin the
  // filename — Atlas.ti and others name it after the project (e.g.
  // "DemoQDPX.qde"). Accept any *.qde in the zip root, falling back to
  // "project.qde" for files written by older Magnolia versions.
  let qdeFile = zip.file('project.qde')
  if (!qdeFile) {
    const qdeName = Object.keys(zip.files).find(
      (n) => /^[^/]+\.qde$/i.test(n) && !zip.files[n].dir
    )
    if (qdeName) qdeFile = zip.file(qdeName)
  }
  if (!qdeFile) {
    throw new Error('Invalid QDPX file: missing project.qde')
  }
  onProgress?.('Parsing project', 0, 0)
  const xml = await qdeFile.async('string')
  const project = deserializeProject(xml)

  // Capture each binary source's referenced in-archive filename (from its
  // `internal://…` path) BEFORE the per-source loop clears plainTextPath.
  // Other tools (Atlas.ti) store the binary under a name that differs from
  // the source guid, so both the runtime handle and the missing-binary
  // detection below must use this reference, not `<guid>.<ext>`.
  const binaryRefByGuid = new Map<string, string>()
  // Captured here (before the source loop clears paths / the transcript pass
  // deletes _refiTranscript) for the video/audio transcript reconciliation
  // below: a media source's raw media `path`, the internal text file its
  // <Transcript> references, and each text source's own internal text file.
  const mediaPathByGuid = new Map<string, string>()
  const transcriptFileByGuid = new Map<string, string>()
  const textFileByGuid = new Map<string, string>()
  for (const s of project.sources as any[]) {
    if (['pdf', 'image', 'audio', 'video'].includes(s.sourceType)) {
      const m = (s.plainTextPath || '').match(/internal:\/\/(.+)/)
      if (m) binaryRefByGuid.set(s.guid, m[1])
    }
    if (s.sourceType === 'audio' || s.sourceType === 'video') {
      if (s.plainTextPath) mediaPathByGuid.set(s.guid, s.plainTextPath)
      const tp = (s._refiTranscript?.plainTextPath || '').match(/internal:\/\/(.+)/)
      if (tp) transcriptFileByGuid.set(s.guid, tp[1])
    } else if (!s.sourceType || s.sourceType === 'text') {
      const tp = (s.plainTextPath || '').match(/internal:\/\/(.+)/)
      if (tp) textFileByGuid.set(s.guid, tp[1])
    }
  }

  // Load source contents from the sources/ folder. The per-source work
  // is dominated by JSZip decompression of binaries (PDF / audio /
  // video / image) and the temp-file writeFile that follows. Sources
  // don't share mutable state — each task writes to its own
  // sourceContents[guid] key and mutates its own source object — so
  // we run the extraction in parallel via Promise.all. For typical
  // projects this is the dominant load-time cost; parallelising
  // collapses N sources' work into roughly the slowest single one.
  const sourceContents: Record<string, string> = {}
  const totalSources = project.sources.length
  let sourcesDone = 0
  await Promise.all(project.sources.map(async (source) => {
    // Audio sources: the binary lives in sources/<guid>.<ext> and is
    // restored via the magnolia-sources.json side table later. Here we
    // just load any transcript text from sources/<guid>.txt and clear
    // the plainTextPath (which currently points at the audio binary,
    // not the transcript) so the plain-text fall-through doesn't try
    // to read the binary as a string.
    if ((source as any).sourceType === 'audio') {
      // Foreign imports (e.g. an <AudioSource>, or a MAXQDA <VideoSource>
      // carrying an .m4a) arrive with the binary referenced by plainTextPath
      // and NO magnolia-sources.json side table to wire it up. Advertise the
      // archive handle here so the audio actually plays; for native Magnolia
      // files the side table later overwrites this formatData with the richer
      // recorded metadata (duration, channels, lineTimes).
      const match = (source.plainTextPath || '').match(/internal:\/\/(.+)/)
      if (match) {
        const internalName = match[1]
        if (zip.file(`${sourcesDir}/${internalName}`)) {
          const ext = (internalName.split('.').pop() || 'm4a').toLowerCase()
          // A <VideoSource> reclassified as audio still carries its
          // time-range codings on _rawVideoSelections — convert them so they
          // survive the import.
          const rawVideoSelections: RawVideoSelection[] =
            (source as any)._rawVideoSelections || []
          if (rawVideoSelections.length > 0) {
            source.selections = rawVideoSelections.map(convertVideoSelection)
          }
          ;(source as any).formatData = {
            audioFilePath: archiveHandleForFile(internalName),
            mimeType: AUDIO_MIME_BY_EXT[ext] || 'audio/mpeg',
            audioExt: ext,
            duration: 0
          }
        }
      }
      delete (source as any)._rawVideoSelections
      const transcriptFile = zip.file(`${sourcesDir}/${source.guid}.txt`)
      sourceContents[source.guid] = transcriptFile
        ? await readZipText(transcriptFile)
        : ''
      source.plainTextPath = undefined
      sourcesDone++
      onProgress?.('Loading documents', sourcesDone, totalSources)
      return
    }

    // PDFs from other QDA tools: write the PDF binary to a temp file, then
    // extract its text with per-item positions so we can convert any
    // rectangle-based <PDFSelection> codings into Magnolia's character-
    // offset model. The temp-file path is stored in formatData; the viewer
    // loads the bytes on demand via IPC.
    if ((source as any).sourceType === 'pdf' && source.plainTextPath) {
      const match = source.plainTextPath.match(/internal:\/\/(.+)/)
      if (match) {
        const pdfFile = zip.file(`${sourcesDir}/${match[1]}`)
        if (pdfFile) {
          // Bytes are read only to extract searchable text + positions; the
          // viewer fetches the PDF itself through the magnolia-bin:// handle
          // straight from the .qdpx — no temp file is written.
          const pdfBuf = await pdfFile.async('nodebuffer')

          let extractedText = ''
          let pageOffsets: number[] = []
          let pageSizes: { width: number; height: number }[] = []
          try {
            const extracted = await extractPdfTextWithPositions(pdfBuf)
            extractedText = extracted.text
            pageOffsets = extracted.pageOffsets
            pageSizes = extracted.pageSizes
          } catch (err) {
            // Text extraction failed — document still viewable, just no
            // searchable text.
            console.error(`Failed to extract text from PDF ${source.guid}:`, err)
          }

          // Convert raw <PDFSelection> rectangles into region-based box
          // selections.
          //
          // Atlas.ti (and others) export a TEXT coding twice: as a
          // <PDFSelection> page rectangle AND as a char-offset
          // <PlainTextSelection> inside the <Representation> (same selection
          // guid). The char-offset form is already in source.selections from
          // the deserializer and is reliable, so we drop the duplicate
          // PDFSelection (existing-guid check) — otherwise we'd clobber a
          // correct text coding with a mis-placed box (the bug that made
          // Atlas.ti PDF codings vanish). What remains are genuine BOX
          // codings (a rectangle with no char-offset twin), which stay boxes.
          const rawSelections: RawPdfSelection[] = (source as any)._rawPdfSelections || []
          if (rawSelections.length > 0) {
            const quirks = getPdfSelectionQuirks(project.origin || '')
            const existingGuids = new Set(source.selections.map((s) => s.guid))
            const converted = rawSelections
              .filter((raw) => !existingGuids.has(raw.guid))
              .map((raw) => convertPdfSelection(raw, quirks, pageSizes))
            source.selections = [...source.selections, ...converted]
          }

          ;(source as any).formatData = {
            pdfFilePath: archiveHandleForFile(match[1]),
            pdfPageOffsets: pageOffsets,
            // Page sizes (1-indexed) — kept so a re-save can flip box
            // selections back into the bottom-left, 0-based-page convention
            // other tools expect. Recomputed each load; not persisted.
            pdfPageSizes: pageSizes
          }
          sourceContents[source.guid] = extractedText
        }
      }
      // Clear plainTextPath and the transient raw selections.
      source.plainTextPath = undefined
      delete (source as any)._rawPdfSelections
      if (sourceContents[source.guid] === undefined) sourceContents[source.guid] = ''
      sourcesDone++
      onProgress?.('Loading documents', sourcesDone, totalSources)
      return
    }

    // Video sources (<VideoSource>): the viewer fetches the binary through
    // the magnolia-bin:// handle straight from the .qdpx (no temp file). We
    // still convert any <VideoSelection> time-range codings here.
    if ((source as any).sourceType === 'video' && source.plainTextPath) {
      const match = source.plainTextPath.match(/internal:\/\/(.+)/)
      if (match) {
        const internalName = match[1]
        const vidFile = zip.file(`${sourcesDir}/${internalName}`)
        if (vidFile) {
          const ext = (internalName.split('.').pop() || 'mp4').toLowerCase()

          const rawVideoSelections: RawVideoSelection[] =
            (source as any)._rawVideoSelections || []
          if (rawVideoSelections.length > 0) {
            source.selections = rawVideoSelections.map(convertVideoSelection)
          }

          ;(source as any).formatData = {
            videoFilePath: archiveHandleForFile(internalName),
            mimeType: VIDEO_MIME_BY_EXT[ext] || 'video/mp4',
            duration: 0,
            videoExt: ext
          }
        }
      }
      source.plainTextPath = undefined
      delete (source as any)._rawVideoSelections
      // Load the transcript text. The writer stores it alongside the video
      // binary as sources/${guid}.txt — without this load, every save/open
      // cycle would erase whatever the user typed in the transcript.
      if (sourceContents[source.guid] === undefined) {
        const transcriptFile = zip.file(`${sourcesDir}/${source.guid}.txt`)
        if (transcriptFile) {
          sourceContents[source.guid] = await readZipText(transcriptFile)
        } else {
          sourceContents[source.guid] = ''
        }
      }
      sourcesDone++
      onProgress?.('Loading documents', sourcesDone, totalSources)
      return
    }

    // Image sources (<PictureSource>): the viewer fetches the binary through
    // the magnolia-bin:// handle straight from the .qdpx (no temp file). We
    // still convert any rectangle <PictureSelection> codings into Magnolia's
    // region-based selections (page=1, pixel coords).
    if ((source as any).sourceType === 'image' && source.plainTextPath) {
      const match = source.plainTextPath.match(/internal:\/\/(.+)/)
      if (match) {
        const internalName = match[1]
        const imgFile = zip.file(`${sourcesDir}/${internalName}`)
        if (imgFile) {
          const ext = (internalName.split('.').pop() || 'png').toLowerCase()

          const rawPictureSelections: RawPictureSelection[] =
            (source as any)._rawPictureSelections || []
          if (rawPictureSelections.length > 0) {
            source.selections = rawPictureSelections.map(convertPictureSelection)
          }

          ;(source as any).formatData = {
            imageFilePath: archiveHandleForFile(internalName),
            mimeType: IMAGE_MIME_BY_EXT[ext] || 'application/octet-stream',
            imageExt: ext
          }
        }
      }
      source.plainTextPath = undefined
      delete (source as any)._rawPictureSelections
      sourceContents[source.guid] = ''
      sourcesDone++
      onProgress?.('Loading documents', sourcesDone, totalSources)
      return
    }

    if (source.plainTextPath) {
      // Extract filename from internal://guid.txt
      const match = source.plainTextPath.match(/internal:\/\/(.+)/)
      if (match) {
        const filename = match[1]
        const file = zip.file(`${sourcesDir}/${filename}`)
        if (file) {
          sourceContents[source.guid] = await readZipText(file)
        }
      }
    } else if (source.plainTextContent) {
      sourceContents[source.guid] = source.plainTextContent
    }
    sourcesDone++
    onProgress?.('Loading documents', sourcesDone, totalSources)
  }))

  // Load saved queries (app-specific JSON, not part of REFI-QDA XML)
  const queriesFile = zip.file('magnolia-queries.json')
  if (queriesFile) {
    try {
      const queriesJson = await queriesFile.async('string')
      project.savedQueries = JSON.parse(queriesJson)
    } catch {
      // Ignore malformed queries file
    }
  }

  // Load logbook entries (app-specific JSON, not part of REFI-QDA XML)
  const logbookFile = zip.file('magnolia-logbook.json')
  if (logbookFile) {
    try {
      const logbookJson = await logbookFile.async('string')
      project.logbookEntries = JSON.parse(logbookJson)
    } catch {
      // Ignore malformed logbook file
    }
  }

  // Load tag categories and extension data (app-specific JSON)
  const tagsExtFile = zip.file('magnolia-tags.json')
  if (tagsExtFile) {
    try {
      const tagsExtJson = await tagsExtFile.async('string')
      const ext = JSON.parse(tagsExtJson)
      if (ext.categories) {
        project.tagCategories = ext.categories
      }
      if (ext.tagMeta) {
        for (const meta of ext.tagMeta) {
          const set = project.sets.find((s) => s.guid === meta.guid)
          if (set) {
            set.categoryGuid = meta.categoryGuid
            set.value = meta.value
            if (meta.memberSurveyRespondents) set.memberSurveyRespondents = meta.memberSurveyRespondents
            if (meta.memberSurveyQuestions) set.memberSurveyQuestions = meta.memberSurveyQuestions
          }
        }
      }
    } catch {
      // Ignore malformed tags extension file
    }
  }

  // Load memos. Magnolia's own files carry full-fidelity memos in
  // magnolia-memos.json (anchors + every memo type). Files from other tools
  // (Atlas.ti) instead carry REFI-QDA project-level <Note>s, parsed into
  // _refiNotes — build project memos from those (loading each note body from
  // its plainTextPath) when there's no side table, so foreign memos appear.
  const memosFile = zip.file('magnolia-memos.json')
  if (memosFile) {
    try {
      const memosJson = await memosFile.async('string')
      project.memos = JSON.parse(memosJson)
    } catch {
      // Ignore malformed memos file
    }
  } else if ((project as any)._refiNotes) {
    const anchors = ((project as any)._refiNoteAnchors || {}) as Record<string, RawNoteAnchor>
    // Notes minted to back a map's free-text boxes (the representedGUID of a
    // shape="Note" vertex) aren't real memos — they round-trip as part of
    // the map (via the side-table, or graphToMap for foreign files). Skip
    // them here so they don't surface as phantom project memos.
    const freeTextNoteGuids = new Set<string>()
    for (const g of ((project as any)._refiGraphs as RefiGraph[] | undefined) ?? []) {
      for (const v of g.vertices) {
        if (v.shape === 'Note' && v.representedGuid) freeTextNoteGuids.add(v.representedGuid)
      }
    }
    const built: Memo[] = []
    for (const n of (project as any)._refiNotes as RawNote[]) {
      if (freeTextNoteGuids.has(n.guid)) continue
      let content = ''
      const match = (n.plainTextPath || '').match(/internal:\/\/(.+)/)
      if (match) {
        const noteFile = zip.file(`${sourcesDir}/${match[1]}`)
        if (noteFile) content = await readZipText(noteFile)
      }
      const base: Memo = {
        guid: n.guid,
        type: 'project',
        title: n.name,
        content,
        createdDateTime: n.creationDateTime || n.modifiedDateTime || '',
        modifiedDateTime: n.modifiedDateTime
      }
      // Anchor the memo from its <NoteRef>: a span => content memo on that
      // source; a bare source ref => document memo.
      const a = anchors[n.guid]
      if (a && a.startPosition !== undefined) {
        built.push({ ...base, type: 'content', sourceGuid: a.sourceGuid, startPosition: a.startPosition, endPosition: a.endPosition })
      } else if (a) {
        built.push({ ...base, type: 'document', sourceGuids: [a.sourceGuid] })
      } else {
        built.push(base)
      }
    }
    if (built.length > 0) project.memos = built
  }

  // Load quotes (app-specific JSON)
  const quotesFile = zip.file('magnolia-quotes.json')
  if (quotesFile) {
    try {
      const quotesJson = await quotesFile.async('string')
      project.quotes = JSON.parse(quotesJson)
    } catch {
      // Ignore malformed quotes file
    }
  }

  // Load document folders + per-source folder mapping (Magnolia-specific).
  // Older .qdpx files written before folder persistence won't have this
  // file — they just load with no folders, same as before.
  const foldersFile = zip.file('magnolia-folders.json')
  if (foldersFile) {
    try {
      const ext = JSON.parse(await foldersFile.async('string'))
      if (Array.isArray(ext.folders)) project.folders = ext.folders
      if (ext.sourceFolder && typeof ext.sourceFolder === 'object') {
        project.sourceFolder = ext.sourceFolder
      }
    } catch {
      // Ignore malformed folders file
    }
  }

  // Load saved analyses (app-specific JSON)
  const analysesFile = zip.file('magnolia-analyses.json')
  if (analysesFile) {
    try {
      const analysesJson = await analysesFile.async('string')
      project.savedAnalyses = JSON.parse(analysesJson)
    } catch {
      // Ignore malformed analyses file
    }
  }

  // Reconstruct relationship maps from REFI-QDA <Graphs> for files that
  // arrive without (or whose round-trip dropped) magnolia-analyses.json.
  // Magnolia's own files carry full-fidelity maps in that side-table, so
  // we only adopt a <Graph> when no saved analysis already has its guid —
  // otherwise the rich side-table map wins and the lossy graphToMap()
  // fallback is skipped. Mirrors the memo Notes / survey Cases pattern.
  const refiGraphs = (project as any)._refiGraphs as RefiGraph[] | undefined
  if (refiGraphs && refiGraphs.length > 0) {
    const existing = new Set((project.savedAnalyses ?? []).map((a) => a.guid))
    // Resolve a vertex's representedGUID to the project entity it shows so
    // imported vertices come back as proper code/document/tag/memo cards
    // rather than bare free-text. Codes are a tree → flatten first.
    const codeByGuid = new Map<string, { name: string; color?: string }>()
    const walkCodes = (codes: typeof project.codes): void => {
      for (const c of codes) {
        codeByGuid.set(c.guid, { name: c.name, color: c.color })
        walkCodes(c.children)
      }
    }
    walkCodes(project.codes)
    const sourceByGuid = new Map((project.sources as any[]).map((s) => [s.guid, s]))
    const setByGuid = new Map((project.sets ?? []).map((s) => [s.guid, s]))
    const memoByGuid = new Map((project.memos ?? []).map((m) => [m.guid, m]))
    const resolveEntity = (guid: string): GraphEntity | null => {
      const c = codeByGuid.get(guid)
      if (c) return { kind: 'code', label: c.name, codeColor: c.color }
      const s = sourceByGuid.get(guid)
      if (s) return { kind: 'document', label: s.name, sourceType: s.sourceType }
      const t = setByGuid.get(guid)
      if (t) return { kind: 'tag', label: t.name }
      const m = memoByGuid.get(guid)
      if (m) return { kind: 'memo', label: m.title }
      return null
    }
    const linkMap = new Map(
      (((project as any)._refiLinks as RefiLink[] | undefined) ?? []).map((l) => [l.guid, l])
    )
    const rebuilt = refiGraphs
      .filter((g) => !existing.has(g.guid))
      .map((g) => graphToMap(g, { resolveEntity, links: linkMap }))
    if (rebuilt.length > 0) {
      project.savedAnalyses = [...(project.savedAnalyses ?? []), ...rebuilt]
    }
  }

  // Load Document Viewer tab state (app-specific JSON)
  const tabsFile = zip.file('magnolia-tabs.json')
  if (tabsFile) {
    try {
      const tabsJson = await tabsFile.async('string')
      ;(project as any).tabState = JSON.parse(tabsJson)
    } catch {
      // Ignore malformed tabs file
    }
  }

  // Load code hotkey assignments (app-specific JSON)
  const codesExtFile = zip.file('magnolia-codes.json')
  if (codesExtFile) {
    try {
      const codesExtJson = await codesExtFile.async('string')
      const ext = JSON.parse(codesExtJson)
      if (ext.hotkeys) {
        const applyHotkeys = (codes: typeof project.codes) => {
          for (const c of codes) {
            const hk = ext.hotkeys.find((h: any) => h.guid === c.guid)
            if (hk) c.hotkey = hk.hotkey
            applyHotkeys(c.children)
          }
        }
        applyHotkeys(project.codes)
      }
    } catch {
      // Ignore malformed codes extension file
    }
  }

  // Restore source metadata (sourceType, formatData for PDF/markdown, etc.)
  const sourcesExtFile = zip.file('magnolia-sources.json')
  if (sourcesExtFile) {
    try {
      const ext = JSON.parse(await sourcesExtFile.async('string'))
      if (ext.sourceMeta) {
        // Same parallelism rationale as pass 1 — each meta entry maps
        // to a distinct source object, no shared mutable state, so
        // concurrent JSZip extraction + writeFile is safe.
        await Promise.all((ext.sourceMeta as any[]).map(async (meta) => {
          const source = project.sources.find((s: any) => s.guid === meta.guid)
          if (!source) return
          if (meta.sourceType) (source as any).sourceType = meta.sourceType

          // Reattach region-based selection data written as a side table.
          if (meta.pdfRegionSelections) {
            const regionByGuid = new Map<string, any>(
              (meta.pdfRegionSelections as any[]).map((r) => [r.guid, r.region])
            )
            for (const sel of source.selections) {
              const region = regionByGuid.get(sel.guid)
              if (region) {
                ;(sel as any).pdfRegion = region
                // The side-table region is authoritative. Clear any char
                // range convertPdfSelection may have inferred from the
                // <PDFSelection> rectangle (whose coords are in another
                // tool's convention) so a region coding stays a 0–0 box.
                sel.startPosition = 0
                sel.endPosition = 0
              }
            }
          }
          // Restore survey-cell selections from the side table. The
          // survey TextSource doesn't emit them in the XML (their
          // offsets are cell-relative, meaningless to other tools), so
          // the whole selection — offsets, codings, and the
          // (respondentId, questionId) cell identity — lives here.
          if (meta.surveyCellSelections) {
            source.selections.push(...(meta.surveyCellSelections as PlainTextSelection[]))
          }
          // Reattach video-transcript codings' text anchors. Video codings
          // are character-precise (startPosition/endPosition = codepoint
          // offsets), like audio/text. New files store startChar/endChar;
          // legacy files stored startLine/endLine (whole-line codings) — map
          // those to the line's character range so they keep rendering.
          if (meta.videoSelectionAnchors) {
            const anchorByGuid = new Map<string, any>(
              (meta.videoSelectionAnchors as any[]).map((a) => [a.guid, a])
            )
            const lineOffsets = lineStartOffsetsWithEnd(sourceContents[source.guid] ?? '')
            for (const sel of source.selections) {
              const anchor = anchorByGuid.get(sel.guid)
              if (anchor) {
                if (anchor.startChar != null) {
                  sel.startPosition = anchor.startChar
                  sel.endPosition = anchor.endChar ?? anchor.startChar
                } else {
                  const sLine = anchor.startLine ?? 0
                  const eLine = anchor.endLine ?? sLine
                  sel.startPosition = lineOffsets[sLine] ?? 0
                  sel.endPosition = Math.max((lineOffsets[eLine + 1] ?? lineOffsets[lineOffsets.length - 1] ?? 0) - 1, sel.startPosition)
                }
                ;(sel as any).manuallyAnchored = anchor.manuallyAnchored
              }
            }
          }
          if (meta.formatData) {
            // Binary sources are served to the viewers through a
            // magnolia-bin:// handle that resolves straight from this .qdpx
            // — no temp file is written. We only confirm the bytes are
            // present in the archive before advertising the handle.
            if (meta.formatData.hasPdfBinary) {
              const pdfFile = zip.file(`${sourcesDir}/${meta.guid}.pdf`)
              if (pdfFile) {
                ;(source as any).formatData = {
                  pdfFilePath: archiveHandle(meta.guid, 'pdf'),
                  pdfPageOffsets: meta.formatData.pdfPageOffsets
                }
              }
            } else if (meta.formatData.hasAudioBinary) {
              // Newer exports save the file with its real extension
              // (m4a / mp3 / wav / etc.); older ones used the literal
              // "audio" extension — try the recorded ext first and fall
              // back to ".audio" for those projects.
              const audioExt = (meta.formatData.audioExt as string | undefined) || 'audio'
              let audioFile = zip.file(`${sourcesDir}/${meta.guid}.${audioExt}`)
              let resolvedExt = audioExt
              if (!audioFile && audioExt !== 'audio') {
                audioFile = zip.file(`${sourcesDir}/${meta.guid}.audio`)
                resolvedExt = 'audio'
              }
              if (audioFile) {
                ;(source as any).formatData = {
                  audioFilePath: archiveHandle(meta.guid, resolvedExt),
                  audioExt: resolvedExt,
                  mimeType: meta.formatData.mimeType,
                  duration: meta.formatData.duration,
                  channels: meta.formatData.channels,
                  sampleRate: meta.formatData.sampleRate,
                  lineTimes: meta.formatData.lineTimes
                }
              }
            } else if (meta.formatData.hasVideoBinary) {
              const ext = meta.formatData.videoExt || 'mp4'
              const vidFile = zip.file(`${sourcesDir}/${meta.guid}.${ext}`)
              const existing = (source as any).formatData || {}
              if (vidFile) {
                ;(source as any).formatData = {
                  ...existing,
                  videoFilePath: archiveHandle(meta.guid, ext),
                  mimeType: meta.formatData.mimeType || existing.mimeType,
                  duration: meta.formatData.duration ?? existing.duration ?? 0,
                  width: meta.formatData.width,
                  height: meta.formatData.height,
                  videoExt: ext,
                  lineTimes: meta.formatData.lineTimes
                }
              } else {
                ;(source as any).formatData = {
                  ...existing,
                  duration: meta.formatData.duration ?? existing.duration ?? 0,
                  width: meta.formatData.width,
                  height: meta.formatData.height,
                  lineTimes: meta.formatData.lineTimes
                }
              }
            } else if (meta.formatData.hasImageBinary) {
              const ext = meta.formatData.imageExt || 'png'
              const imgFile = zip.file(`${sourcesDir}/${meta.guid}.${ext}`)
              if (imgFile) {
                ;(source as any).formatData = {
                  imageFilePath: archiveHandle(meta.guid, ext),
                  mimeType: meta.formatData.mimeType,
                  imageExt: ext
                }
              }
            } else {
              ;(source as any).formatData = meta.formatData
            }
          }
        }))
      }
    } catch {
      // Ignore malformed sources extension file
    }
  }

  // ── Transcript reconciliation ──
  // Magnolia's own files carry per-line timings in magnolia-sources.json
  // (restored above as formatData.lineTimes) and the transcript text at
  // sources/<guid>.txt. Files from other tools instead carry a REFI-QDA
  // <Transcript> (parsed onto _refiTranscript): its text may live at a
  // differently-named path, and its time-sync is in <SyncPoint>s, not
  // lineTimes. For those, load the transcript text from the Transcript's
  // path if we don't already have it, and rebuild lineTimes from the
  // SyncPoints — so a transcript that round-tripped through another tool
  // comes back time-synced. The side-table always wins when present.
  for (const source of project.sources as any[]) {
    const transcript = source._refiTranscript as RefiTranscript | undefined
    if (!transcript) continue
    if (!sourceContents[source.guid]) {
      const m = (transcript.plainTextPath || '').match(/internal:\/\/(.+)/)
      if (m && m[1] !== `${source.guid}.txt`) {
        const f = zip.file(`${sourcesDir}/${m[1]}`)
        if (f) sourceContents[source.guid] = await readZipText(f)
      }
    }
    const existing = source.formatData?.lineTimes
    if ((!existing || Object.keys(existing).length === 0) && transcript.syncPoints.length > 0) {
      const rebuilt = reconstructLineTimes(sourceContents[source.guid] ?? '', transcript.syncPoints)
      if (Object.keys(rebuilt).length > 0) {
        source.formatData = { ...(source.formatData || {}), lineTimes: rebuilt }
      }
    }
    // Rebuild char-offset transcript codings from <TranscriptSelection>s.
    // This is the only place audio codings are restored — they're stored
    // nowhere else — so it both loads Magnolia's own files and imports
    // codings authored in another tool. Skip any whose guid we already have.
    if (transcript.selections.length > 0) {
      // A video coding round-trips as a <VideoSelection> (already converted
      // into source.selections, keeping its guid) plus a twin
      // <TranscriptSelection> whose guid is transcriptTwinGuidFor(videoGuid).
      // Treat both forms as "already have it" so the twin doesn't re-add a
      // duplicate coding. (Older files wrote the twin with the SAME guid; the
      // plain s.guid entry still covers those.)
      const have = new Set<string>()
      for (const s of (source.selections ?? []) as any[]) {
        have.add(s.guid)
        have.add(transcriptTwinGuidFor(s.guid))
      }
      const rebuilt = reconstructTranscriptSelections(transcript)
        .filter((s) => !have.has(s.guid))
        .map((s) => ({
          guid: s.guid,
          name: s.name,
          startPosition: s.startPosition,
          endPosition: s.endPosition,
          creatingUser: s.creatingUser,
          creationDateTime: s.creationDateTime,
          codings: s.codings
        }))
      if (rebuilt.length > 0) source.selections = [...(source.selections ?? []), ...rebuilt]
    }
    delete source._refiTranscript
  }

  // ── Media-transcript reconciliation (foreign files, e.g. Atlas) ──
  // Atlas splits ONE coded video/audio into up to three sources: the media
  // <VideoSource>/<AudioSource>, a standalone transcript <TextSource> that
  // carries the codings, and a second media source whose <Transcript> child
  // re-references the same transcript text. Imported naively that's two or
  // three duplicate, unlinked documents. Collapse them: fold the standalone
  // transcript (text + codings) into the media source, and merge media
  // sources that share one media file into a single document. Magnolia's own
  // files have a single media source with its <Transcript> inline, so this is
  // a no-op for them.
  project.sources = reconcileMediaTranscripts(project.sources as any[], sourceContents, {
    mediaPathByGuid,
    transcriptFileByGuid,
    textFileByGuid
  }) as typeof project.sources

  // ── Re-derive video coding timeRanges from line times ──
  // A video transcript coding is character-precise text + a line-granular
  // timeRange. The timeRange is NOT stored in the XML (it's redundant with the
  // SyncPoints, and emitting a <VideoSelection> twin breaks the Atlas
  // round-trip — see serializeVideoSelection). So reconstruct it here from the
  // coding's char span and the source's line times, mirroring the renderer's
  // deriveVideoTimeRange. Only fills codings that have a char span but no
  // timeRange yet, so any time already present (e.g. a pure-timeline
  // VideoSelection) is left untouched.
  for (const source of project.sources as any[]) {
    if (source.sourceType !== 'video') continue
    const lineTimes = source.formatData?.lineTimes
    if (!lineTimes || Object.keys(lineTimes).length === 0) continue
    const text = sourceContents[source.guid] ?? ''
    for (const sel of (source.selections ?? []) as any[]) {
      if (sel.timeRange) continue
      if (typeof sel.startPosition !== 'number' || typeof sel.endPosition !== 'number') continue
      if (!(sel.endPosition > sel.startPosition)) continue
      if (sel.pdfRegion || sel.surveyCell) continue
      const tr = deriveLineTimeRange(text, sel.startPosition, sel.endPosition, lineTimes)
      if (tr) sel.timeRange = tr
    }
  }

  // ── Survey REFI reconciliation ──
  // The standards-native survey representation is <Variables>/<Cases>
  // plus one per-respondent open-ended <TextSource> (carrying the
  // promoted cell codings). Those respondent docs are referenced by a
  // <Case>'s <SourceRef>; the main survey source never is. Two paths:
  //
  //   (a) A side-table survey was already restored above (Magnolia↔
  //       Magnolia): keep the high-fidelity survey + its cell codings,
  //       and just drop the respondent docs so they don't surface as
  //       junk standalone documents.
  //   (b) No side-table (file came back from / originated in Atlas.ti /
  //       MAXQDA): reconstruct the survey from Variables/Cases/docs —
  //       closed answers from variables, open-ended answers + codings
  //       from the documents — synthesize a survey source for it, and
  //       drop the now-consumed respondent docs.
  const refiVariables = (project as any)._refiVariables as RefiVariable[] | undefined
  const refiCases = (project as any)._refiCases as RefiCase[] | undefined
  if (refiCases && refiCases.length > 0) {
    const caseDocGuids = new Set<string>()
    for (const c of refiCases) for (const g of c.sourceRefGuids) caseDocGuids.add(g)

    // Index the respondent docs by guid (text + coded spans).
    const docByGuid = new Map<string, { text: string; selections: any[] }>()
    for (const s of project.sources as any[]) {
      if (!caseDocGuids.has(s.guid)) continue
      docByGuid.set(s.guid, {
        text: s.plainTextContent ?? '',
        selections: (s.selections ?? []).map((sel: any) => ({
          guid: sel.guid,
          startPosition: sel.startPosition ?? 0,
          endPosition: sel.endPosition ?? 0,
          codings: sel.codings ?? []
        }))
      })
    }

    // respondent-doc guid → {surveyGuid, respondentId} for turning a
    // tag Set's <MemberSource> back into a respondent tag (foreign path).
    const docTagTarget = new Map<string, { sourceGuid: string; id: string }>()

    const hasSideTableSurvey = (project.sources as any[]).some((s) => s.formatData?.survey)
    if (!hasSideTableSurvey && refiVariables && refiVariables.length > 0) {
      const { survey, cellSelections, docToRespondent } = refiToSurvey(
        refiVariables,
        refiCases,
        docByGuid,
        project.name ? `${project.name} (survey)` : 'Imported Survey'
      )
      const surveyGuid = randomUUID().toUpperCase()
      ;(project.sources as any[]).push({
        guid: surveyGuid,
        name: survey.name,
        sourceType: 'survey',
        selections: cellSelections,
        formatData: { survey, rawCsv: '' }
      })
      for (const [docGuid, respId] of Object.entries(docToRespondent)) {
        docTagTarget.set(docGuid, { sourceGuid: surveyGuid, id: respId })
      }
    }

    // Reconcile tags: a Set member pointing at a respondent doc is a
    // respondent tag. The doc is about to be dropped, so strip it from
    // memberSourceGuids (else the tag keeps a phantom document member);
    // when reconstructing a foreign survey, convert it into a
    // memberSurveyRespondents entry. For Magnolia↔Magnolia the side-table
    // already restored memberSurveyRespondents, so this is pure cleanup.
    for (const set of ((project.sets ?? []) as any[])) {
      const docRefs = (set.memberSourceGuids ?? []).filter((g: string) => caseDocGuids.has(g))
      if (docRefs.length === 0) continue
      set.memberSourceGuids = set.memberSourceGuids.filter((g: string) => !caseDocGuids.has(g))
      for (const docGuid of docRefs) {
        const target = docTagTarget.get(docGuid)
        if (!target) continue
        const members = (set.memberSurveyRespondents ?? (set.memberSurveyRespondents = []))
        if (!members.some((m: any) => m.sourceGuid === target.sourceGuid && m.id === target.id)) {
          members.push(target)
        }
      }
    }

    // Drop the consumed respondent docs from both the source list and
    // the loaded contents map.
    project.sources = (project.sources as any[]).filter((s) => !caseDocGuids.has(s.guid))
    for (const g of caseDocGuids) delete sourceContents[g]
  }

  // Detect documents whose binary content is missing from the archive.
  // A pdf/image/audio/video source should have a non-text `${sourcesDir}/<guid>.*`
  // entry; if none exists, the bytes were never saved (or an older Magnolia
  // dropped them), so the viewer would be blank. We surface these so the
  // renderer can prompt the user to re-import — the only way to recover
  // bytes that simply aren't in the file.
  const BINARY_TYPES = new Set(['pdf', 'image', 'audio', 'video'])
  const zipNames = Object.keys(zip.files)
  const isFile = (name: string): boolean => !!zip.files[name] && !zip.files[name].dir
  const missingBinaries = (project.sources as any[])
    .filter((s) => {
      if (!BINARY_TYPES.has(s.sourceType)) return false
      // The binary is present if the archive holds the file the source
      // references (its `internal://…` path — used by Atlas.ti etc. where
      // the filename differs from the guid) OR any non-text `<guid>.*`
      // entry (Magnolia's own naming).
      const ref = binaryRefByGuid.get(s.guid)
      if (ref && isFile(`${sourcesDir}/${ref}`)) return false
      const prefix = `${sourcesDir}/${s.guid}.`
      const hasGuidNamed = zipNames.some(
        (n) => n.startsWith(prefix) && !zip.files[n].dir && !n.toLowerCase().endsWith('.txt')
      )
      return !hasGuidNamed
    })
    .map((s) => ({ guid: s.guid, name: s.name, sourceType: s.sourceType }))

  // Drop the transient REFI fields so they don't leak into renderer state.
  const { _refiVariables, _refiCases, _refiNotes, _refiNoteAnchors, _refiGraphs, _refiLinks, ...cleanProject } = project as any
  void _refiVariables
  void _refiCases
  void _refiNotes
  void _refiNoteAnchors
  void _refiGraphs
  void _refiLinks
  return { ...cleanProject, sourceContents, missingBinaries }
}
