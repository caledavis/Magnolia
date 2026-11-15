/**
 * The size of each page of a PDF and of an image, for the analyses that
 * measure box selections by area (Code Frequencies). Sizes are read from
 * the files, in PDF points and image pixels — the units box selections are
 * stored in — and cached per document, so synchronous callers (the
 * analysis grids, reports) can look them up once loaded.
 */
import { useEffect, useMemo, useState } from 'react'
import { mediaPathField } from './binary-handles'

/** Page key ('p1', 'p2', …) → width and height. */
export type PageSizes = Record<string, { w: number; h: number }>

interface SizedSource {
  guid: string
  sourceType?: string
  formatData?: unknown
}

const cache = new Map<string, PageSizes | null>()
const pending = new Map<string, Promise<PageSizes | null>>()

const keyOf = (s: SizedSource): string | null => {
  const field = mediaPathField(s.sourceType)
  const handle = field ? (s.formatData as Record<string, unknown> | undefined)?.[field] : undefined
  return typeof handle === 'string' && (s.sourceType === 'pdf' || s.sourceType === 'image') ? `${s.guid}::${handle}` : null
}

async function readSizes(sourceType: string, handle: string): Promise<PageSizes | null> {
  try {
    if (sourceType === 'pdf') {
      const raw = await window.api.readPdfFile(handle)
      if (!raw) return null
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer)
      const pdfjsLib = await import('pdfjs-dist')
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href
      const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise
      try {
        const out: PageSizes = {}
        for (let n = 1; n <= doc.numPages; n++) {
          const vp = (await doc.getPage(n)).getViewport({ scale: 1 })
          out[`p${n}`] = { w: vp.width, h: vp.height }
        }
        return out
      } finally {
        void doc.destroy()
      }
    }
    const raw = await window.api.readImageFile(handle)
    if (!raw) return null
    const bmp = await createImageBitmap(new Blob([raw as BlobPart]))
    try {
      return { p1: { w: bmp.width, h: bmp.height } }
    } finally {
      bmp.close()
    }
  } catch {
    return null
  }
}

/** Load a document's page sizes (once). Resolves null when the file can't
 *  be read, or the document isn't a PDF or image. */
export function loadPageSizes(s: SizedSource): Promise<PageSizes | null> {
  const key = keyOf(s)
  if (!key) return Promise.resolve(null)
  if (cache.has(key)) return Promise.resolve(cache.get(key)!)
  let p = pending.get(key)
  if (!p) {
    const field = mediaPathField(s.sourceType)!
    p = readSizes(s.sourceType!, (s.formatData as Record<string, string>)[field]).then((sizes) => {
      cache.set(key, sizes)
      pending.delete(key)
      return sizes
    })
    pending.set(key, p)
  }
  return p
}

/** Every loaded document's page sizes, by source guid. */
export function cachedPageSizes(sources: SizedSource[]): Record<string, PageSizes> {
  const out: Record<string, PageSizes> = {}
  for (const s of sources) {
    const key = keyOf(s)
    const sizes = key ? cache.get(key) : undefined
    if (sizes) out[s.guid] = sizes
  }
  return out
}

/** Load the page sizes of every PDF and image with a box selection. */
export function loadAllPageSizes(sources: (SizedSource & { selections?: { pdfRegion?: unknown }[] })[]): Promise<unknown> {
  return Promise.all(sources.filter((s) => s.sourceType === 'image' || s.selections?.some((x) => !!x.pdfRegion)).map(loadPageSizes))
}

/** The page sizes of the given documents, re-rendering as they load. */
export function usePageSizes(sources: (SizedSource & { selections?: { pdfRegion?: unknown }[] })[]): Record<string, PageSizes> {
  const [loaded, setLoaded] = useState(0)
  useEffect(() => {
    let live = true
    void loadAllPageSizes(sources).then(() => { if (live) setLoaded((n) => n + 1) })
    return () => { live = false }
  }, [sources])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => cachedPageSizes(sources), [sources, loaded])
}
