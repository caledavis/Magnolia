/**
 * PDF text extraction for imported and loaded PDFs.
 *
 * Magnolia's character offsets for a PDF are defined by pdf.js's text
 * content, joined exactly as below. This runs in the renderer, with the same
 * pdf.js the viewer uses, so stored codings always line up with what the
 * viewer shows. (The Electron build ran the same algorithm in the main
 * process.)
 */

export interface PdfTextResult {
  text: string
  /** Codepoint offset where each page's text starts. */
  pageOffsets: number[]
}

async function loadPdfjs() {
  const pdfjsLib = await import('pdfjs-dist')
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href
  return pdfjsLib
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export async function extractPdfText(data: Uint8Array): Promise<PdfTextResult> {
  const pdfjsLib = await loadPdfjs()
  const doc = await pdfjsLib.getDocument({
    // pdf.js transfers (detaches) the buffer it's given; keep the caller's.
    data: data.slice(),
    standardFontDataUrl: new URL('pdfjs-dist/standard_fonts/', import.meta.url).href,
    cMapUrl: new URL('pdfjs-dist/cmaps/', import.meta.url).href,
    cMapPacked: true
  }).promise

  const pages: string[] = []
  const pageOffsets: number[] = []
  let totalCpOffset = 0
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      pageOffsets.push(totalCpOffset)
      const page = await doc.getPage(i)
      const textContent = await page.getTextContent()
      const lines: string[] = []
      let lastY: number | null = null
      for (const item of textContent.items) {
        if (!('str' in item)) continue
        const textItem = item as any
        // A change in Y position is a line break.
        if (lastY !== null && Math.abs(textItem.transform[5] - lastY) > 2) lines.push('\n')
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
      // Page separator
      if (i < doc.numPages) {
        pages.push('\n')
        totalCpOffset += 1
      }
    }
  } finally {
    void doc.destroy()
  }
  return { text: pages.join(''), pageOffsets }
}
