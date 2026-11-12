/**
 * A PDF page's text as Magnolia reads it, shared by text extraction
 * (platform/pdf-text.ts), the PDF viewer's text layer and the coded-PDF
 * export, so all three agree on every character offset.
 *
 * PDFs Magnolia typesets from Word, RTF and ODT files carry their exact
 * text and its positions as an attachment (`magnolia-text-layer.json`,
 * written by the core's convert/typeset.rs). That text is used instead of
 * pdf.js's reading of the drawn glyphs, which for scripts that join or
 * reorder letters (Arabic, Hebrew, Devanagari…) comes out scrambled. Other
 * PDFs are read with pdf.js as before.
 */
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api'

export const TEXT_LAYER_NAME = 'magnolia-text-layer.json'

interface LayerItem {
  s: string
  x: number
  y: number
  w: number
  h: number
  d?: 'rtl'
  e?: 1
}

interface TextLayerData {
  version: number
  pages: { items: LayerItem[] }[]
}

export interface PageTextContent extends TextContent {
  /** Text from the PDF's own text layer: lines end only where it says. */
  embedded?: boolean
}

const FONT = 'magnolia-text-layer'
const layers = new WeakMap<PDFDocumentProxy, Promise<TextLayerData | null>>()

/** The text layer attached to `doc`, if Magnolia typeset it. */
export function embeddedTextLayer(doc: PDFDocumentProxy): Promise<TextLayerData | null> {
  let layer = layers.get(doc)
  if (!layer) {
    layer = (async () => {
      try {
        const attachments = await doc.getAttachments()
        const file = attachments?.[TEXT_LAYER_NAME]
        if (!file?.content) return null
        const data = JSON.parse(new TextDecoder().decode(file.content))
        return data?.version === 1 && Array.isArray(data.pages) ? (data as TextLayerData) : null
      } catch {
        return null
      }
    })()
    layers.set(doc, layer)
  }
  return layer
}

/** A page's text items: the embedded layer's, else pdf.js's. */
export async function pageTextContent(doc: PDFDocumentProxy, page: PDFPageProxy): Promise<PageTextContent> {
  const layer = await embeddedTextLayer(doc)
  if (!layer) return page.getTextContent()
  const items = layer.pages[page.pageNumber - 1]?.items ?? []
  return {
    embedded: true,
    lang: null,
    styles: { [FONT]: { fontFamily: 'sans-serif', ascent: 0.8, descent: -0.2, vertical: false } },
    items: items.map((it): TextItem => ({
      str: it.s,
      dir: it.d ?? 'ltr',
      transform: [it.h, 0, 0, it.h, it.x, it.y],
      width: it.w,
      height: it.h,
      fontName: FONT,
      hasEOL: !!it.e
    }))
  }
}

export interface PlacedTextItem {
  item: TextItem
  /** Codepoint offset of the item's text within the page's text. */
  start: number
  /** Its length in codepoints. */
  length: number
}

/**
 * A page's text, joined as Magnolia stores it: a line break after an item
 * that ends a line and (for pdf.js text) where the baseline jumps more than
 * 2pt; and every item with text, with its codepoint offset in that text.
 */
export function joinPageText(content: PageTextContent): { text: string; items: PlacedTextItem[] } {
  const parts: string[] = []
  const items: PlacedTextItem[] = []
  let cp = 0
  let lastY: number | null = null
  for (const raw of content.items) {
    if (!('str' in raw)) continue
    const item = raw as TextItem
    if (!content.embedded && lastY !== null && Math.abs(item.transform[5] - lastY) > 2) {
      parts.push('\n')
      cp += 1
    }
    const length = [...(item.str || '')].length
    if (length > 0) items.push({ item, start: cp, length })
    parts.push(item.str)
    cp += length
    lastY = item.transform[5]
    if (item.hasEOL) {
      parts.push('\n')
      cp += 1
      lastY = null
    }
  }
  return { text: parts.join(''), items }
}
