/**
 * pdf.js, set up the same way everywhere it opens a PDF.
 *
 * pdf.js needs two folders of its own beside the code: the standard fonts
 * (for PDFs that don't embed theirs) and the CMaps (for PDFs whose fonts use
 * a predefined, mostly Chinese/Japanese/Korean, encoding — without them it
 * can't read those fonts' text). vite.config.mts serves them at /pdfjs/ in
 * development and copies them there in builds.
 */
import type { DocumentInitParameters } from 'pdfjs-dist/types/src/display/api'

export async function loadPdfjs() {
  const pdfjsLib = await import('pdfjs-dist')
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href
  return pdfjsLib
}

/** Every page sits beside the pdfjs folder, so it resolves from the page. */
const assetUrl = (dir: string): string => new URL(`pdfjs/${dir}/`, document.baseURI).href

/** Parameters for opening `data`, which pdf.js takes over (pass a copy if
 *  the caller still needs it). */
export function pdfParams(data: Uint8Array): DocumentInitParameters {
  return {
    data,
    standardFontDataUrl: assetUrl('standard_fonts'),
    cMapUrl: assetUrl('cmaps'),
    cMapPacked: true
  }
}
