/**
 * PDF text extraction for imported and loaded PDFs.
 *
 * Magnolia's character offsets for a PDF are defined by each page's text as
 * utils/pdf-page-text.ts reads and joins it (pdf.js's text content, or the
 * text layer Magnolia attaches to the PDFs it typesets). This runs in the
 * renderer, with the same code the viewer uses, so stored codings always
 * line up with what the viewer shows.
 */
import { joinPageText, pageTextContent } from '../utils/pdf-page-text'

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
      const { text: pageText } = joinPageText(await pageTextContent(doc, page))
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
