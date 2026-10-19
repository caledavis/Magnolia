/**
 * PDF text extraction using pdfjs-dist.
 * Runs in the main process (Node.js) — no canvas needed for text-only extraction.
 */

// pdfjs-dist loads Node built-ins (fs for fonts/CMaps, module for
// createRequire) via process.getBuiltinModule, which only arrived in
// Node 20.16 / 22.3. Electron 28 ships Node 18, so shim it with require.
if (typeof (process as any).getBuiltinModule !== 'function') {
  ;(process as any).getBuiltinModule = (name: string) => require(name)
}

// pdfjs-dist v5 expects DOM globals even for text-only work.
// Provide minimal stubs so it loads in Node without errors.
if (typeof globalThis.DOMMatrix === 'undefined') {
  ;(globalThis as any).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    constructor(init?: any) {
      if (Array.isArray(init) && init.length >= 6) {
        ;[this.a, this.b, this.c, this.d, this.e, this.f] = init
      }
    }
    isIdentity = true
    is2D = true
    inverse() { return new DOMMatrix() }
    multiply() { return new DOMMatrix() }
    translate() { return new DOMMatrix() }
    scale() { return new DOMMatrix() }
    rotate() { return new DOMMatrix() }
    transformPoint(p: any) { return p }
    toString() { return `matrix(${this.a},${this.b},${this.c},${this.d},${this.e},${this.f})` }
  }
}

if (typeof globalThis.ImageData === 'undefined') {
  ;(globalThis as any).ImageData = class ImageData {
    width: number; height: number; data: Uint8ClampedArray
    constructor(sw: number, sh: number) {
      this.width = sw; this.height = sh
      this.data = new Uint8ClampedArray(sw * sh * 4)
    }
  }
}

/** Resolve the pdfjs-dist standard_fonts directory as a plain filesystem
 *  path terminated with a separator. Under Node, pdfjs reads these with
 *  fs.readFile(baseUrl + filename), so a file:// URL string fails with
 *  "Unable to load font data". Silences "Ensure that the
 *  standardFontDataUrl API parameter is provided" warnings too. */
function getStandardFontDataUrl(): string {
  try {
    const { createRequire } = require('module')
    const { join, dirname, sep } = require('path')
    const req = createRequire(__filename)
    const pkg = req.resolve('pdfjs-dist/package.json')
    return join(dirname(pkg), 'standard_fonts') + sep
  } catch {
    return ''
  }
}

/** Same as getStandardFontDataUrl but for the CMap directory, which pdfjs
 *  needs for CJK and other non-Latin character sets. */
function getCmapUrl(): string {
  try {
    const { createRequire } = require('module')
    const { join, dirname, sep } = require('path')
    const req = createRequire(__filename)
    const pkg = req.resolve('pdfjs-dist/package.json')
    return join(dirname(pkg), 'cmaps') + sep
  } catch {
    return ''
  }
}

if (typeof globalThis.Path2D === 'undefined') {
  ;(globalThis as any).Path2D = class Path2D {
    moveTo() {}; lineTo() {}; bezierCurveTo() {}; quadraticCurveTo() {}
    arc() {}; arcTo() {}; ellipse() {}; rect() {}; closePath() {}
    addPath() {}
  }
}

export interface PdfExtractResult {
  text: string
  pageOffsets: number[]  // codepoint offset where each page's text starts
  pdfBase64: string
}

/** A single text item with its bounding box and character range. */
export interface PdfTextItem {
  page: number         // 1-based
  cpStart: number      // codepoint offset in the full document text
  cpEnd: number        // exclusive
  /** Bounding box in top-origin page user space (PDF points from top-left). */
  x: number
  y: number
  width: number
  height: number
}

export interface PdfExtractWithPositions {
  text: string
  pageOffsets: number[]
  pageSizes: { width: number; height: number }[]  // 1-indexed: [0] is a dummy
  items: PdfTextItem[]
}

/**
 * Extract PDF text along with per-item positional info. Used when importing
 * PDFs from another QDA tool where we must convert rectangle-based codings
 * (<PDFSelection>) into Magnolia's character-offset selections.
 */
export async function extractPdfTextWithPositions(buffer: Buffer): Promise<PdfExtractWithPositions> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(buffer)
  const doc = await pdfjsLib.getDocument({
    data,
    useSystemFonts: true,
    standardFontDataUrl: getStandardFontDataUrl(),
    cMapUrl: getCmapUrl(),
    cMapPacked: true
  }).promise

  const pages: string[] = []
  const pageOffsets: number[] = []
  const pageSizes: { width: number; height: number }[] = [{ width: 0, height: 0 }]
  const items: PdfTextItem[] = []
  let totalCpOffset = 0

  for (let i = 1; i <= doc.numPages; i++) {
    pageOffsets.push(totalCpOffset)
    const page = await doc.getPage(i)
    const viewport = page.getViewport({ scale: 1 })
    pageSizes.push({ width: viewport.width, height: viewport.height })
    const textContent = await page.getTextContent()

    let pageCpOffset = 0
    const lines: string[] = []
    let lastY: number | null = null

    for (const rawItem of textContent.items) {
      if (!('str' in rawItem)) continue
      const textItem = rawItem as any

      // Mirror the line-break logic from extractPdfText so character offsets
      // line up with what the viewer would produce.
      if (lastY !== null && Math.abs(textItem.transform[5] - lastY) > 2) {
        lines.push('\n')
        pageCpOffset += 1
      }

      // Text item bounding box.
      // transform = [a, b, c, d, e, f] — (e, f) is the origin (bottom-left)
      // of the text box in PDF user space (bottom-origin). width/height are
      // provided in pre-transform units, so multiply by scale = transform[0]
      // for the final width. height is the font size (approx).
      const transform = textItem.transform
      const itemX = transform[4]
      const itemYBottom = transform[5]
      const itemWidth = textItem.width ?? 0
      const itemHeight = textItem.height ?? transform[0] ?? 0

      // Flip Y from bottom-origin (pdf) to top-origin (MAXQDA-style GUI):
      // topY = pageHeight - bottomY - itemHeight
      const topY = viewport.height - itemYBottom - itemHeight

      const str: string = textItem.str
      const cpLen = [...str].length
      if (cpLen > 0) {
        items.push({
          page: i,
          cpStart: totalCpOffset + pageCpOffset,
          cpEnd: totalCpOffset + pageCpOffset + cpLen,
          x: itemX,
          y: topY,
          width: itemWidth,
          height: itemHeight
        })
      }

      lines.push(str)
      pageCpOffset += cpLen
      lastY = itemYBottom

      if (textItem.hasEOL) {
        lines.push('\n')
        pageCpOffset += 1
        lastY = null
      }
    }

    const pageText = lines.join('')
    pages.push(pageText)
    totalCpOffset += [...pageText].length

    if (i < doc.numPages) {
      pages.push('\n')
      totalCpOffset += 1
    }
  }

  return {
    text: pages.join(''),
    pageOffsets,
    pageSizes,
    items
  }
}

export async function extractPdfText(buffer: Buffer): Promise<PdfExtractResult> {
  // Dynamic import to avoid issues with ESM/CJS in Electron main process
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')

  const data = new Uint8Array(buffer)
  const doc = await pdfjsLib.getDocument({
    data,
    useSystemFonts: true,
    standardFontDataUrl: getStandardFontDataUrl(),
    cMapUrl: getCmapUrl(),
    cMapPacked: true
  }).promise

  const pages: string[] = []
  const pageOffsets: number[] = []
  let totalCpOffset = 0

  for (let i = 1; i <= doc.numPages; i++) {
    pageOffsets.push(totalCpOffset)
    const page = await doc.getPage(i)
    const textContent = await page.getTextContent()

    const lines: string[] = []
    let lastY: number | null = null

    for (const item of textContent.items) {
      if (!('str' in item)) continue
      const textItem = item as any

      // Detect line breaks by checking if Y position changed
      if (lastY !== null && Math.abs(textItem.transform[5] - lastY) > 2) {
        lines.push('\n')
      }
      lines.push(textItem.str)
      lastY = textItem.transform[5]

      if (textItem.hasEOL) {
        lines.push('\n')
        lastY = null
      }
    }

    const pageText = lines.join('')
    pages.push(pageText)
    totalCpOffset += [...pageText].length

    // Add page separator
    if (i < doc.numPages) {
      pages.push('\n')
      totalCpOffset += 1
    }
  }

  return {
    text: pages.join(''),
    pageOffsets,
    pdfBase64: buffer.toString('base64')
  }
}

/**
 * Lightweight page-dimension extraction — loads each page's viewport only,
 * no text. Returns sizes 1-indexed to match extractPdfTextWithPositions
 * ([0] is a dummy, so [n] is page n). Used at save time to flip PDF box
 * selections from Magnolia's top-left origin into the bottom-left,
 * 0-based-page convention other QDA tools (Atlas.ti) expect.
 */
export async function getPdfPageSizes(buffer: Buffer): Promise<{ width: number; height: number }[]> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(buffer)
  const doc = await pdfjsLib.getDocument({
    data,
    useSystemFonts: true,
    standardFontDataUrl: getStandardFontDataUrl(),
    cMapUrl: getCmapUrl(),
    cMapPacked: true
  }).promise
  const pageSizes: { width: number; height: number }[] = [{ width: 0, height: 0 }]
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const viewport = page.getViewport({ scale: 1 })
    pageSizes.push({ width: viewport.width, height: viewport.height })
  }
  return pageSizes
}
