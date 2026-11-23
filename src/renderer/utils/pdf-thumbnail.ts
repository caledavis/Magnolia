/**
 * pdf-thumbnail — render a cropped PNG thumbnail of a PDF page region.
 *
 * Used by QueryResultViewer and QuotesPane to visualize box selections
 * (PlainTextSelection.pdfRegion / Quote.pdfRegion) that have no text
 * content to display.
 *
 * Caching strategy:
 *  - PDFDocumentProxy objects are cached by filePath so we don't reload
 *    the same PDF for every region we render.
 *  - Rendered data-URL thumbnails are cached by a composite key of
 *    (filePath, page, x, y, w, h, scale) — re-requests return the cached
 *    URL without doing any work.
 *  - In-flight requests are deduped: multiple components asking for the
 *    same thumbnail share a single Promise.
 *
 * Rendering runs in the renderer process (pdfjs is already loaded there),
 * off the main paint path thanks to the async pipeline.
 */
import { loadPdfjs, pdfParams } from './pdfjs'

interface ThumbnailOptions {
  /** Path on disk. Provide one of filePath or pdfBase64. */
  filePath?: string
  /** Base64-encoded PDF bytes. Used for freshly-imported PDFs whose
   *  formatData carries pdfBase64 instead of pdfFilePath. */
  pdfBase64?: string
  /** Stable identifier for caching when using pdfBase64 (typically the
   *  source GUID). Ignored in filePath mode — the path is the key. */
  docKey?: string
  page: number        // 1-based
  x: number           // top-origin PDF user-space points
  y: number
  width: number
  height: number
  /** Render scale (higher = sharper, larger data URL). Default 2. */
  scale?: number
}

const docCache = new Map<string, Promise<any>>()
const thumbCache = new Map<string, string>()
const inFlight = new Map<string, Promise<string>>()

function resolveDocKey(opts: ThumbnailOptions): string {
  if (opts.filePath) return `path:${opts.filePath}`
  if (opts.docKey) return `b64:${opts.docKey}`
  throw new Error('renderPdfRegionThumbnail: must provide filePath or { pdfBase64, docKey }')
}

async function loadPdfDoc(opts: ThumbnailOptions): Promise<any> {
  const key = resolveDocKey(opts)
  let promise = docCache.get(key)
  if (!promise) {
    promise = (async () => {
      const pdfjsLib = await loadPdfjs()
      let bytes: Uint8Array
      if (opts.filePath) {
        bytes = await window.api.readPdfFile(opts.filePath)
      } else if (opts.pdfBase64) {
        const binary = atob(opts.pdfBase64)
        bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      } else {
        throw new Error('renderPdfRegionThumbnail: no PDF source provided')
      }
      return await pdfjsLib.getDocument(pdfParams(bytes)).promise
    })()
    docCache.set(key, promise)
  }
  return promise
}

function cacheKey(opts: ThumbnailOptions): string {
  const s = opts.scale ?? 2
  const doc = resolveDocKey(opts)
  return `${doc}::${opts.page}::${opts.x}::${opts.y}::${opts.width}::${opts.height}::${s}`
}

/**
 * Render a cropped PNG thumbnail and return a data: URL suitable for an
 * <img src>. Resolves from cache if available.
 */
export async function renderPdfRegionThumbnail(opts: ThumbnailOptions): Promise<string> {
  const key = cacheKey(opts)
  const cached = thumbCache.get(key)
  if (cached) return cached
  const existing = inFlight.get(key)
  if (existing) return existing

  const scale = opts.scale ?? 2

  const promise = (async () => {
    const doc = await loadPdfDoc(opts)
    const page = await doc.getPage(opts.page)
    const viewport = page.getViewport({ scale })

    // Render the full page into a canvas, then crop to the region.
    // Rendering the whole page is simpler than trying to convince pdfjs
    // to render only a window — pdfjs always renders the whole page.
    const fullCanvas = document.createElement('canvas')
    fullCanvas.width = Math.ceil(viewport.width)
    fullCanvas.height = Math.ceil(viewport.height)
    const fullCtx = fullCanvas.getContext('2d')
    if (!fullCtx) throw new Error('Failed to create canvas 2D context')
    await page.render({ canvasContext: fullCtx, viewport }).promise

    const srcX = Math.max(0, Math.round(opts.x * scale))
    const srcY = Math.max(0, Math.round(opts.y * scale))
    const srcW = Math.min(fullCanvas.width - srcX, Math.round(opts.width * scale))
    const srcH = Math.min(fullCanvas.height - srcY, Math.round(opts.height * scale))

    const cropCanvas = document.createElement('canvas')
    cropCanvas.width = srcW
    cropCanvas.height = srcH
    const cropCtx = cropCanvas.getContext('2d')
    if (!cropCtx) throw new Error('Failed to create crop canvas 2D context')
    cropCtx.drawImage(fullCanvas, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH)

    const dataUrl = cropCanvas.toDataURL('image/png')
    thumbCache.set(key, dataUrl)
    return dataUrl
  })()

  inFlight.set(key, promise)
  try {
    const result = await promise
    return result
  } finally {
    inFlight.delete(key)
  }
}

/**
 * Render every page of a PDF to a PNG data URL, in page order. Used by the
 * Reports tool to embed a source PDF unchanged (each page is rasterised at
 * `scale`, then the report scales the image to fit the page). Reuses the
 * same cached PDFDocumentProxy as the region thumbnailer.
 */
export async function renderPdfPagesToImages(
  opts: { filePath?: string; pdfBase64?: string; docKey?: string; scale?: number }
): Promise<string[]> {
  const scale = opts.scale ?? 2
  const doc = await loadPdfDoc(opts as ThumbnailOptions)
  const out: string[] = []
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum)
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Failed to create canvas 2D context')
    // White backing so transparent PDFs don't render black in the PNG.
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: ctx, viewport }).promise
    out.push(canvas.toDataURL('image/png'))
  }
  return out
}

/** Clear all caches — call when a project is closed or a PDF is unloaded. */
export function clearPdfThumbnailCaches(): void {
  docCache.clear()
  thumbCache.clear()
  inFlight.clear()
}
