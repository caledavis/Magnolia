/**
 * Export a document as a PDF, with or without its coded segments: text-based sources
 * (text, Markdown, notes, transcripts) as highlighted text, PDFs and
 * images as page images with the coded areas drawn on, and surveys as
 * each respondent's open-ended answers. Codes are labelled in the right
 * margin beside each segment (see coded-html.ts).
 */
import type { Code, PlainTextSelection, SurveyFormatData, TextSource } from '../../models/types'
import { useCodeStore } from '../../stores/code-store'
import { t, formatDateTime } from '../../i18n'
import { buildPdfDocument, escHtml, exportPdfWithHeader } from '../pdf-export'
import { formatTimestamp } from '../timestamp-parser'
import { buildCellText } from '../survey/cell-text'
import { base64ToBytes } from '../../platform/pdf-text'
import { sourceTypeFromFilename } from '../format-registry'
import {
  CODED_PDF_CSS,
  DEFAULT_CODE_COLOUR,
  codedTextHtml,
  colourWithAlpha,
  legendHtml,
  pageFigureHtml,
  type CodeRef,
  type PageLabel,
  type TextSegment
} from './coded-html'

/** Longest side, in pixels, of a page image embedded in the PDF. */
const MAX_IMAGE_SIDE = 1800
/** pdf.js render scale for PDF pages (72 dpi × 2). */
const PDF_SCALE = 2
const JPEG_QUALITY = 0.85

function codeLookup(): Map<string, CodeRef> {
  const map = new Map<string, CodeRef>()
  const walk = (codes: Code[]) => {
    for (const c of codes) {
      map.set(c.guid, { guid: c.guid, name: c.name, color: c.color || DEFAULT_CODE_COLOUR })
      walk(c.children)
    }
  }
  walk(useCodeStore.getState().codes)
  return map
}

function codesOf(sel: PlainTextSelection, lookup: Map<string, CodeRef>): CodeRef[] {
  const out: CodeRef[] = []
  for (const coding of sel.codings) {
    const code = lookup.get(coding.codeGuid)
    if (code && !out.some((c) => c.guid === code.guid)) out.push(code)
  }
  return out
}

function textSegments(selections: PlainTextSelection[], lookup: Map<string, CodeRef>): TextSegment[] {
  return selections
    .filter((s) => !s.pdfRegion && !s.surveyCell)
    .map((s) => ({ start: s.startPosition, end: s.endPosition, codes: codesOf(s, lookup) }))
    .filter((s) => s.codes.length > 0)
}

// ── Page images ────────────────────────────────────────────────────

interface Rect { x: number; y: number; w: number; h: number }

/** Fill text highlights and outline coded regions on a rendered page. */
function drawCoding(
  ctx: CanvasRenderingContext2D,
  highlights: { rect: Rect; color: string }[],
  regions: { rect: Rect; colors: string[] }[],
  lineWidth: number
) {
  ctx.save()
  ctx.globalCompositeOperation = 'multiply'
  for (const { rect, color } of highlights) {
    ctx.fillStyle = colourWithAlpha(color, 0.35)
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h)
  }
  ctx.restore()
  for (const { rect, colors } of regions) {
    ctx.fillStyle = colourWithAlpha(colors[0], 0.1)
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h)
    // One outline per code, each just inside the last.
    colors.forEach((color, i) => {
      const inset = lineWidth * (i + 0.5)
      ctx.strokeStyle = color
      ctx.lineWidth = lineWidth
      ctx.strokeRect(rect.x + inset, rect.y + inset, Math.max(0, rect.w - 2 * inset), Math.max(0, rect.h - 2 * inset))
    })
  }
}

function regionKey(r: Rect): string {
  return [r.x, r.y, r.w, r.h].map((v) => Math.round(v)).join(':')
}

/** Group region selections with identical rectangles, merging their codes. */
function regionGroups(
  selections: { rect: Rect; codes: CodeRef[] }[]
): { rect: Rect; codes: CodeRef[] }[] {
  const groups = new Map<string, { rect: Rect; codes: CodeRef[] }>()
  for (const s of selections) {
    const key = regionKey(s.rect)
    const g = groups.get(key) ?? { rect: s.rect, codes: [] }
    for (const c of s.codes) if (!g.codes.some((x) => x.guid === c.guid)) g.codes.push(c)
    groups.set(key, g)
  }
  return [...groups.values()]
}

async function loadPdfBytes(source: TextSource): Promise<Uint8Array> {
  const fd = source.formatData
  if (fd?.pdfFilePath) return window.api.readPdfFile(fd.pdfFilePath)
  if (fd?.pdfBase64) return base64ToBytes(fd.pdfBase64)
  throw new Error(t('codedPdf.noPdfData'))
}

async function pdfBody(source: TextSource, lookup: Map<string, CodeRef>, wide: boolean): Promise<string> {
  const pdfjsLib = await import('pdfjs-dist')
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href
  const doc = await pdfjsLib.getDocument({
    data: await loadPdfBytes(source),
    standardFontDataUrl: new URL('pdfjs-dist/standard_fonts/', import.meta.url).href,
    cMapUrl: new URL('pdfjs-dist/cmaps/', import.meta.url).href,
    cMapPacked: true
  }).promise

  const textSels = source.selections
    .filter((s) => !s.pdfRegion)
    .map((s) => ({ sel: s, codes: codesOf(s, lookup) }))
    .filter((s) => s.codes.length > 0 && s.sel.endPosition > s.sel.startPosition)
  const figures: string[] = []
  const canvas = document.createElement('canvas')
  try {
    // Page text offsets: the stored ones the viewer uses, else as
    // pdf-text.ts counts them (each page's text, then one separator).
    const storedOffsets: number[] = source.formatData?.pdfPageOffsets ?? []
    let pageOffset = 0
    for (let p = 1; p <= doc.numPages; p++) {
      if (storedOffsets.length > 0) pageOffset = storedOffsets[p - 1] ?? pageOffset
      const page = await doc.getPage(p)
      const base = page.getViewport({ scale: 1 })
      const scale = Math.min(PDF_SCALE, MAX_IMAGE_SIDE / Math.max(base.width, base.height))
      const viewport = page.getViewport({ scale })
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: ctx, viewport }).promise

      // Each text item's codepoint span on this page, and its rectangle.
      const textContent = await page.getTextContent()
      const items: { start: number; end: number; rect: Rect }[] = []
      let pageCp = 0
      let lastY: number | null = null
      for (const raw of textContent.items) {
        if (!('str' in raw)) continue
        const it = raw as any
        if (lastY !== null && Math.abs(it.transform[5] - lastY) > 2) pageCp += 1
        const len = [...(it.str || '')].length
        if (len > 0) {
          const tx = pdfjsLib.Util.transform(viewport.transform, it.transform)
          const fontHeight = Math.hypot(tx[2], tx[3])
          items.push({
            start: pageOffset + pageCp,
            end: pageOffset + pageCp + len,
            rect: { x: tx[4], y: tx[5] - fontHeight, w: it.width * scale, h: fontHeight * 1.2 }
          })
        }
        pageCp += len
        lastY = it.transform[5]
        if (it.hasEOL) { pageCp += 1; lastY = null }
      }
      const pageStart = pageOffset
      const pageEnd = pageOffset + pageCp
      pageOffset = pageEnd + 1

      const highlights: { rect: Rect; color: string }[] = []
      const labels: PageLabel[] = []
      for (const { sel, codes } of textSels) {
        if (sel.endPosition <= pageStart || sel.startPosition >= pageEnd) continue
        let firstTop: number | null = null
        for (const item of items) {
          if (sel.endPosition <= item.start || sel.startPosition >= item.end) continue
          // Proportion partial items by codepoint, as the viewer does.
          const len = item.end - item.start
          const from = Math.max(0, sel.startPosition - item.start) / len
          const to = Math.min(len, sel.endPosition - item.start) / len
          const rect = { x: item.rect.x + from * item.rect.w, y: item.rect.y, w: (to - from) * item.rect.w, h: item.rect.h }
          for (const c of codes) highlights.push({ rect, color: c.color })
          if (firstTop === null || rect.y < firstTop) firstTop = rect.y
        }
        // Label where the segment starts.
        if (firstTop !== null && sel.startPosition >= pageStart) {
          labels.push({ y: firstTop / canvas.height, codes })
        }
      }
      const regions = regionGroups(
        source.selections
          .filter((s) => s.pdfRegion?.page === p)
          .map((s) => {
            const r = s.pdfRegion!
            return { rect: { x: r.x * scale, y: r.y * scale, w: r.width * scale, h: r.height * scale }, codes: codesOf(s, lookup) }
          })
          .filter((s) => s.codes.length > 0)
      )
      for (const g of regions) labels.push({ y: g.rect.y / canvas.height, codes: g.codes })
      drawCoding(ctx, highlights, regions.map((g) => ({ rect: g.rect, colors: g.codes.map((c) => c.color) })), Math.max(2, 1.5 * scale))

      figures.push(pageFigureHtml(
        canvas.toDataURL('image/jpeg', JPEG_QUALITY),
        canvas.height / canvas.width,
        labels,
        t('codedPdf.page', { page: p }),
        p > 1,
        wide
      ))
      page.cleanup()
    }
  } finally {
    void doc.destroy()
  }
  return figures.join('\n')
}

async function imageBody(source: TextSource, lookup: Map<string, CodeRef>, wide: boolean): Promise<string> {
  const path = source.formatData?.imageFilePath as string | undefined
  if (!path) throw new Error(t('codedPdf.noImageData'))
  const buffer = await window.api.readImageFile(path)
  const bitmap = await createImageBitmap(new Blob([buffer], { type: source.formatData?.mimeType || 'image/png' }))
  const k = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * k)
  canvas.height = Math.round(bitmap.height * k)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()

  const regions = regionGroups(
    source.selections
      .filter((s) => s.pdfRegion)
      .map((s) => {
        const r = s.pdfRegion!
        return { rect: { x: r.x * k, y: r.y * k, w: r.width * k, h: r.height * k }, codes: codesOf(s, lookup) }
      })
      .filter((s) => s.codes.length > 0)
  )
  drawCoding(ctx, [], regions.map((g) => ({ rect: g.rect, colors: g.codes.map((c) => c.color) })), Math.max(2, Math.max(canvas.width, canvas.height) / 400))
  const labels = regions.map((g) => ({ y: g.rect.y / canvas.height, codes: g.codes }))
  const mime = source.formatData?.mimeType === 'image/png' ? 'image/png' : 'image/jpeg'
  return pageFigureHtml(canvas.toDataURL(mime, JPEG_QUALITY), canvas.height / canvas.width, labels, '', false, wide)
}

// ── Surveys ────────────────────────────────────────────────────────

function surveyBody(source: TextSource, lookup: Map<string, CodeRef>): string {
  const survey = (source.formatData as SurveyFormatData | undefined)?.survey
  if (!survey) throw new Error(t('survey.notLoaded'))
  const openQuestions = survey.questions
    .map((q, i) => ({ q, number: i + 1 }))
    .filter(({ q }) => q.type === 'open-ended')
  const parts: string[] = []
  for (const r of survey.respondents) {
    const answers: string[] = []
    for (const { q, number } of openQuestions) {
      const text = buildCellText(r.answers[q.id])
      if (!text) continue
      const segments = source.selections
        .filter((s) => s.surveyCell?.respondentId === r.id && s.surveyCell.questionId === q.id)
        .map((s) => ({ start: s.startPosition, end: s.endPosition, codes: codesOf(s, lookup) }))
      answers.push(
        `<div class="q">${escHtml(t('survey.questionShort', { number }))} · ${escHtml(q.text)}</div>` +
        codedTextHtml(text, segments)
      )
    }
    if (answers.length === 0) continue
    parts.push(`<div class="resp">${escHtml(r.displayName)}</div>${answers.join('')}`)
  }
  return parts.join('\n')
}

// ── Export ─────────────────────────────────────────────────────────

/** Codes used by the document in codebook order, with segment counts. */
function legendEntries(selections: PlainTextSelection[], lookup: Map<string, CodeRef>) {
  const counts = new Map<string, number>()
  for (const sel of selections) {
    for (const c of codesOf(sel, lookup)) counts.set(c.guid, (counts.get(c.guid) ?? 0) + 1)
  }
  return [...lookup.values()].filter((c) => counts.has(c.guid)).map((code) => ({ code, count: counts.get(code.guid)! }))
}

/**
 * Build the export's HTML. Without codes, nothing is highlighted or
 * labelled, there's no list of codes, and the text and pages take the
 * margin's room.
 */
export async function buildDocumentPdfHtml(source: TextSource, content: string, withCodes = true): Promise<string> {
  const lookup = withCodes ? codeLookup() : new Map<string, CodeRef>()
  const type = source.sourceType ?? sourceTypeFromFilename(source.name)
  const isPdf = !!(source.formatData?.pdfBase64 || source.formatData?.pdfFilePath)

  let body: string
  if (type === 'survey') {
    body = surveyBody(source, lookup)
  } else if (isPdf) {
    body = await pdfBody(source, lookup, !withCodes)
  } else if (type === 'image') {
    body = await imageBody(source, lookup, !withCodes)
  } else {
    const lineTimes = (type === 'audio' || type === 'video')
      ? source.formatData?.lineTimes as Record<string, number> | undefined
      : undefined
    const prefixes = lineTimes && Object.keys(lineTimes).length > 0
      ? new Map(Object.entries(lineTimes).map(([k, v]) => [parseInt(k, 10), formatTimestamp(v)]))
      : undefined
    body = codedTextHtml(content, textSegments(source.selections, lookup), prefixes)
  }

  const title = source.name.replace(/\.[^.]+$/, '')
  if (!withCodes) {
    return buildPdfDocument({ title, body: `<div class="no-codes">${body}</div>`, extraCss: CODED_PDF_CSS })
  }
  const coded = source.selections.filter((s) => codesOf(s, lookup).length > 0)
  return buildPdfDocument({
    title,
    subtitle: escHtml(t('codedPdf.subtitle', { count: coded.length, date: formatDateTime(new Date()) })),
    body: legendHtml(t('codedPdf.codes'), legendEntries(coded, lookup)) + body,
    extraCss: CODED_PDF_CSS
  })
}

/** Ask where to save, then write the PDF. Returns the saved path. */
export async function exportDocumentPdf(source: TextSource, content: string, withCodes: boolean): Promise<string | null> {
  try {
    const html = await buildDocumentPdfHtml(source, content, withCodes)
    const title = source.name.replace(/\.[^.]+$/, '')
    const name = withCodes ? t('codedPdf.fileName', { name: title }) : title
    const fileName = name.replace(/[\\/:*?"<>|]/g, '').trim() || title
    return await exportPdfWithHeader(html, fileName, withCodes ? t('codedPdf.dialogTitle') : undefined)
  } catch (e) {
    console.error('PDF export failed:', e)
    window.alert(t('codedPdf.failed', { detail: e instanceof Error ? e.message : String(e) }))
    return null
  }
}
