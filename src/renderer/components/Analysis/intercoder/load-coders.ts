/**
 * Loading the coders' projects for Inter-coder Agreement: the open
 * project straight from the stores, other .qdpx files through the merge
 * reader, and the page / image sizes the region measure needs.
 */
import { collectCurrentProject } from '../../../stores/merge-review-store'
import { useDocumentStore } from '../../../stores/document-store'
import { useProjectStore } from '../../../stores/project-store'
import { usePreferencesStore } from '../../../stores/preferences-store'
import { mediaPathField } from '../../../utils/binary-handles'
import { t } from '../../../i18n'
import { OPEN_PROJECT_ID, type CoderProject, type DocExtents, type MatchedDoc } from './intercoder-model'

const baseName = (p: string): string => p.split(/[/\\]/).pop() ?? p

/** The open project as a coder. Labelled with the user's name from
 *  Preferences when there is one. */
export function openProjectCoder(): CoderProject {
  const project = collectCurrentProject()
  const filePath = useProjectStore.getState().filePath
  const fileName = filePath ? baseName(filePath) : project.name
  const user = usePreferencesStore.getState().userName.trim()
  return {
    id: OPEN_PROJECT_ID,
    label: user || fileName.replace(/\.qdpx$/i, ''),
    fileName,
    filePath: null,
    codes: project.codes,
    sources: project.sources,
    sourceContents: useDocumentStore.getState().sourceContents
  }
}

/** Whether `path` is the open project's own file (then it's the open
 *  project, live, rather than its last saved copy). */
export function isOpenProjectPath(path: string): boolean {
  return useProjectStore.getState().filePath === path
}

/** A coder's project read from a .qdpx file, labelled with whoever last
 *  edited it, else the file name. */
export async function fileCoder(filePath: string): Promise<CoderProject> {
  const data = await window.api.readQdpxForCompare(filePath)
  const fileName = baseName(filePath)
  // Dropped files are staged in a temp folder, so a dropped file's name
  // is the last component either way.
  return {
    id: filePath,
    label: data.editorInfo?.lastEditedBy?.trim() || fileName.replace(/\.qdpx$/i, ''),
    fileName,
    filePath,
    codes: data.codes,
    sources: data.sources,
    sourceContents: data.sourceContents
  }
}

async function readBinary(p: CoderProject, handle: string, sourceType: string): Promise<Uint8Array | null> {
  if (p.filePath) return window.api.readCompareBinary(p.filePath, handle)
  const buf = sourceType === 'pdf' ? await window.api.readPdfFile(handle) : await window.api.readImageFile(handle)
  return buf ? (buf instanceof Uint8Array ? buf : new Uint8Array(buf)) : null
}

async function pdfPageAreas(bytes: Uint8Array): Promise<Record<string, number>> {
  const pdfjsLib = await import('pdfjs-dist')
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href
  // pdfjs takes ownership of the buffer; give it a copy.
  const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise
  try {
    const out: Record<string, number> = {}
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      const vp = page.getViewport({ scale: 1 })
      out[`p${n}`] = vp.width * vp.height
    }
    return out
  } finally {
    void doc.destroy()
  }
}

async function imageArea(bytes: Uint8Array): Promise<Record<string, number>> {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart]))
  try {
    return { p1: bmp.width * bmp.height }
  } finally {
    bmp.close()
  }
}

const regionCache = new Map<string, Promise<Record<string, number> | null>>()

/** Page areas for a PDF or image document, read from the first project
 *  that has its file. null when no file could be read — the model then
 *  estimates from the coded regions. Cached per project and handle. */
export function loadRegionExtents(projects: CoderProject[], doc: MatchedDoc): Promise<Record<string, number> | null> {
  const st = doc.sourceType
  const field = mediaPathField(st)
  if (!field || (st !== 'pdf' && st !== 'image')) return Promise.resolve(null)
  for (const p of projects) {
    const s = p.sources.find((x) => x.guid === doc.members[p.id])
    const handle = (s?.formatData as Record<string, unknown> | undefined)?.[field]
    if (typeof handle !== 'string') continue
    const key = `${p.filePath ?? OPEN_PROJECT_ID}::${handle}`
    let promise = regionCache.get(key)
    if (!promise) {
      promise = (async () => {
        try {
          const bytes = await readBinary(p, handle, st)
          if (!bytes || bytes.byteLength === 0) return null
          return st === 'pdf' ? await pdfPageAreas(bytes) : await imageArea(bytes)
        } catch {
          return null
        }
      })()
      regionCache.set(key, promise)
    }
    return promise
  }
  return Promise.resolve(null)
}

/** Whether any project has region codings in the document, so its page
 *  areas are worth loading. Images are always coded by region. */
export function needsRegionExtents(projects: CoderProject[], doc: MatchedDoc): boolean {
  if (doc.sourceType === 'image') return true
  if (doc.sourceType !== 'pdf') return false
  return projects.some((p) => p.sources.find((x) => x.guid === doc.members[p.id])?.selections.some((s) => !!s.pdfRegion))
}

export function mergeExtents(base: DocExtents, region: Record<string, number> | null): DocExtents {
  return region ? { ...base, region } : base
}

/** A readable message for a project that couldn't be loaded. */
export function loadErrorMessage(fileName: string, err: unknown): string {
  return t('intercoder.loadFailed', { name: fileName, error: err instanceof Error ? err.message : String(err) })
}
