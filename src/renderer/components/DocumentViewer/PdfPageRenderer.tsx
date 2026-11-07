/**
 * PdfPageRenderer — renders a single PDF page with three layers:
 * 1. Canvas layer (visual rendering)
 * 2. Text layer (pdfjs-dist TextLayer — invisible, drives native selection)
 * 3. Highlight overlay layer (selection highlight + coding highlights)
 *
 * Native browser text selection works normally (click, drag, Cmd+A, copy).
 * We hide the per-span ::selection highlight and draw our own clean overlay
 * so there are no gaps between words.
 */
import { useRef, useEffect, useState, useCallback } from 'react'
import type { PlainTextSelection, Code, Memo } from '../../models/types'
import { Icon, MEMO_POINT_ICON } from '../Icon'

// SVG wave underline pattern for memos (matching CodedTextView)
const MEMO_WAVE = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='2.25'%3E%3Cpath d='M0 2.25 L3 0 L6 2.25 L9 0 L12 2.25' fill='none' stroke='%234a90d9' stroke-width='1'/%3E%3C/svg%3E")`
// Vertical variant — same zigzag rotated 90° for box-memo side borders.
const MEMO_WAVE_V = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='2.25' height='12'%3E%3Cpath d='M2.25 0 L0 3 L2.25 6 L0 9 L2.25 12' fill='none' stroke='%234a90d9' stroke-width='1'/%3E%3C/svg%3E")`

interface Props {
  pdfDocument: any  // PDFDocumentProxy
  pageNumber: number  // 1-based
  pageTextOffset: number  // codepoint offset where this page's text starts
  pageText: string  // the actual extracted text for this page (ground truth)
  scale: number
  selections: PlainTextSelection[]
  codeMap: Map<string, Code>
  contentMemos?: Memo[]
  quotes?: { guid: string; startCp: number; endCp: number }[]
  /** Persistent yellow highlight — used by the context menu's hover-over-
   *  "Remove Code" preview. Static, no animation. */
  externalHighlightRange?: { startCp: number; endCp: number } | null
  /** Brief pulse overlay for "jump to quote" clicks on a box region.
   *  Text-range quote clicks set lockedRange instead (native selection). */
  pulseRegion?: import('../../models/types').PdfRegionSelection | null
  /** Highlight overlay drawn when the user hovers a memo / quote icon
   *  whose underlying item has a pdfRegion on this page. */
  hoveredRegion?: import('../../models/types').PdfRegionSelection | null
  hoverHighlightRange?: { startCp: number; endCp: number } | null
  hoveredSelGuid?: string | null
  /** Live drag-preview rectangle (in PDF user-space points, top-origin). */
  boxDragPreview?: { page: number; startX: number; startY: number; currentX: number; currentY: number } | null
  /** Completed pending box selection awaiting coding. */
  pendingBoxRegion?: import('../../models/types').PdfRegionSelection | null
  /** Double-click on a point memo's circular icon overlay opens its editor. */
  onMemoDoubleClick?: (memoGuid: string) => void
  /** Click-and-drag a point memo's icon to reposition it. (page, x, y) are
   *  in PDF user-space coordinates of this page. */
  onMemoMove?: (memoGuid: string, page: number, x: number, y: number) => void
  onRendered?: () => void
}

export function PdfPageRenderer({
  pdfDocument, pageNumber, pageTextOffset, pageText, scale,
  selections, codeMap, contentMemos, quotes, externalHighlightRange, pulseRegion, hoveredRegion, hoverHighlightRange, hoveredSelGuid,
  boxDragPreview, pendingBoxRegion, onMemoDoubleClick, onMemoMove, onRendered
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const selOverlayRef = useRef<HTMLDivElement>(null)
  const [pageSize, setPageSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 })
  const [rendered, setRendered] = useState(false)
  // Active drag of a point-memo icon. While set, we track mousemove on
  // window and reposition by feeding the parent the new (x, y).
  const [memoDrag, setMemoDrag] = useState<{ guid: string; startClientX: number; startClientY: number; origX: number; origY: number } | null>(null)

  useEffect(() => {
    if (!memoDrag) return
    const onMove = (e: MouseEvent) => {
      const dx = (e.clientX - memoDrag.startClientX) / scale
      const dy = (e.clientY - memoDrag.startClientY) / scale
      onMemoMove?.(memoDrag.guid, pageNumber, memoDrag.origX + dx, memoDrag.origY + dy)
    }
    const onUp = () => setMemoDrag(null)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [memoDrag, scale, pageNumber, onMemoMove])

  // Draw selection highlight overlay from current browser selection.
  // Merges per-span rects into continuous line-wide rectangles so
  // there are no gaps between words.
  const updateSelectionOverlay = useCallback(() => {
    const selOv = selOverlayRef.current
    const container = canvasRef.current?.parentElement
    if (!selOv || !container) return
    selOv.innerHTML = ''

    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return

    const range = sel.getRangeAt(0)
    const textLayer = textLayerRef.current
    if (!textLayer || !range.intersectsNode(textLayer)) return

    const rects = range.getClientRects()
    const containerRect = container.getBoundingClientRect()

    // Collect valid rects relative to container
    interface Rect { left: number; top: number; right: number; bottom: number }
    const local: Rect[] = []
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i]
      if (r.width < 1 || r.height < 1) continue
      const left = r.left - containerRect.left
      const top = r.top - containerRect.top
      const right = left + r.width
      const bottom = top + r.height
      // Filter to rects within this page
      if (right < 0 || bottom < 0 || left > containerRect.width || top > containerRect.height) continue
      local.push({ left, top, right, bottom })
    }

    if (local.length === 0) return

    // Merge rects on the same line (similar vertical centre) into one wide rect
    const LINE_TOLERANCE = 4 // px — rects within this Y range are same line
    const merged: Rect[] = []
    // Sort by top then left
    local.sort((a, b) => a.top - b.top || a.left - b.left)

    let cur = { ...local[0] }
    for (let i = 1; i < local.length; i++) {
      const r = local[i]
      const curMidY = (cur.top + cur.bottom) / 2
      const rMidY = (r.top + r.bottom) / 2
      if (Math.abs(curMidY - rMidY) < LINE_TOLERANCE) {
        // Same line — extend
        cur.left = Math.min(cur.left, r.left)
        cur.right = Math.max(cur.right, r.right)
        cur.top = Math.min(cur.top, r.top)
        cur.bottom = Math.max(cur.bottom, r.bottom)
      } else {
        merged.push(cur)
        cur = { ...r }
      }
    }
    merged.push(cur)

    for (const m of merged) {
      const div = document.createElement('div')
      div.style.cssText = `
        position: absolute;
        left: ${m.left}px;
        top: ${m.top}px;
        width: ${m.right - m.left}px;
        height: ${m.bottom - m.top}px;
        background: rgba(60, 100, 240, 0.25);
        pointer-events: none;
        border-radius: 2px;
      `
      selOv.appendChild(div)
    }
  }, [])

  // Listen for selection changes to update the overlay in real-time
  useEffect(() => {
    if (!rendered) return
    const handler = () => updateSelectionOverlay()
    document.addEventListener('selectionchange', handler)
    return () => document.removeEventListener('selectionchange', handler)
  }, [rendered, updateSelectionOverlay])

  // Render page canvas and text layer
  useEffect(() => {
    if (!pdfDocument || !canvasRef.current || !textLayerRef.current) return
    let cancelled = false

    // Mark the page as not-yet-rendered for the duration of this pass.
    // Without this, a scale change leaves `rendered` at true, and the
    // overlay effect (which depends on `rendered` + `scale`) fires
    // immediately against the OLD text spans before the new render
    // finishes — text-code highlights then sit at the old positions
    // until something else triggers a re-render.
    setRendered(false)

    const renderPage = async () => {
      const page = await pdfDocument.getPage(pageNumber)
      if (cancelled) return

      const viewport = page.getViewport({ scale })
      const canvas = canvasRef.current!
      const ctx = canvas.getContext('2d')!

      // Set canvas dimensions (HiDPI aware)
      const dpr = window.devicePixelRatio || 1
      canvas.width = viewport.width * dpr
      canvas.height = viewport.height * dpr
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      ctx.scale(dpr, dpr)

      setPageSize({ width: viewport.width, height: viewport.height })

      // Render canvas
      await page.render({ canvasContext: ctx, viewport }).promise
      if (cancelled) return

      // Build text layer using pdfjs-dist's official TextLayer API
      const textContent = await page.getTextContent()
      if (cancelled) return

      const textLayerEl = textLayerRef.current!
      textLayerEl.innerHTML = ''
      // pdf.js v4's TextLayer applies per-span transforms via the CSS
      // custom property `--scale-factor` on the container. Without
      // this, the spans render at the unscaled (1.0) size — narrower
      // than the actual PDF text — so highlights computed from
      // span.getBoundingClientRect() come out too short. Set both the
      // standard variable and `--total-scale-factor` (used by some
      // pdf.js builds) to the current zoom level.
      textLayerEl.style.setProperty('--scale-factor', String(scale))
      textLayerEl.style.setProperty('--total-scale-factor', String(scale))

      const pdfjsLib = await import('pdfjs-dist')
      const textLayer = new pdfjsLib.TextLayer({
        textContentSource: textContent,
        container: textLayerEl,
        viewport,
      })

      await textLayer.render()
      if (cancelled) return

      // Assign data-cpoffset to each rendered span by walking the same
      // text-content items pdf.js used to render the layer and mirroring
      // pdf-extract.ts's line-break logic. Earlier we matched span text
      // against the extracted page text via substring search — fragile,
      // because pdf.js's TextLayer normalises whitespace / ligatures
      // differently than our extractor, and a single failed match would
      // truncate every downstream cpoffset (visible as a highlight that
      // covers only the prefix of a multi-span text item, e.g.
      // "Chemical Weapons: I" of "Chemical Weapons: Is it a Crime?").
      // Index-based assignment is exact: pdf.js renders one span per
      // non-empty `str` item in textContent, in order.
      const validItemCpStarts: number[] = []
      {
        let pageCp = 0
        let lastY: number | null = null
        for (const rawItem of textContent.items) {
          if (!('str' in rawItem)) continue
          const it = rawItem as any
          // Mirror pdf-extract.ts: a Y jump > 2pt produces an inserted
          // newline that consumes 1 codepoint in pageText.
          if (lastY !== null && Math.abs(it.transform[5] - lastY) > 2) pageCp += 1
          const cpLen = [...(it.str || '')].length
          if (cpLen > 0) validItemCpStarts.push(pageCp)
          pageCp += cpLen
          lastY = it.transform[5]
          if (it.hasEOL) { pageCp += 1; lastY = null }
        }
      }
      const spans = textLayerEl.querySelectorAll<HTMLSpanElement>('span:not(.markedContent)')
      let validIdx = 0
      for (const span of spans) {
        if (!span.textContent) continue
        if (validIdx >= validItemCpStarts.length) break
        span.dataset.cpoffset = String(pageTextOffset + validItemCpStarts[validIdx])
        validIdx++
      }

      setRendered(true)
      onRendered?.()
    }

    renderPage()
    return () => { cancelled = true }
  }, [pdfDocument, pageNumber, pageTextOffset, scale]) // eslint-disable-line react-hooks/exhaustive-deps

  // Render coding highlight overlays + memo/quote wave underlines.
  // Merges per-span rects into continuous line-wide rectangles.
  useEffect(() => {
    if (!rendered || !textLayerRef.current || !overlayRef.current) return
    const overlay = overlayRef.current
    overlay.innerHTML = ''

    // Build span data once for all overlay types
    const textSpans = textLayerRef.current.querySelectorAll<HTMLSpanElement>('[data-cpoffset]')
    interface SpanInfo { el: HTMLSpanElement; cpStart: number; cpEnd: number }
    const spanData: SpanInfo[] = []
    for (const span of textSpans) {
      const cpStart = parseInt(span.dataset.cpoffset!, 10)
      const cpEnd = cpStart + [...(span.textContent || '')].length
      spanData.push({ el: span, cpStart, cpEnd })
    }

    const containerRect = overlay.parentElement!.getBoundingClientRect()
    const LINE_TOLERANCE = 4

    // Helper: collect and merge rects for a codepoint range into line-wide rects
    interface Rect { left: number; top: number; right: number; bottom: number }
    function getMergedRects(cpStart: number, cpEnd: number): Rect[] {
      const rawRects: Rect[] = []
      for (const sd of spanData) {
        if (cpEnd <= sd.cpStart || cpStart >= sd.cpEnd) continue
        // Take the span's full visual rectangle (this matches the PDF's
        // rendered text exactly because pdf.js applies a scaleX so the
        // span's bounding box covers the same visual area as the PDF's
        // text item) and proportion it by codepoint offset within the
        // span. Earlier we used Range.getClientRects() over the text
        // node, but the browser fallback font's per-character widths
        // don't match the actual PDF font's, so a partial Range came
        // out narrower than it should — visible as a highlight that
        // ended mid-word. Proportional mapping is exact when the code
        // covers the whole span and a small approximation when it
        // covers only part of one (still much closer than the Range
        // approach for typical text).
        const r = sd.el.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) continue
        const spanCpLen = sd.cpEnd - sd.cpStart
        const localStartCp = Math.max(0, cpStart - sd.cpStart)
        const localEndCp = Math.min(spanCpLen, cpEnd - sd.cpStart)
        const startFrac = spanCpLen > 0 ? localStartCp / spanCpLen : 0
        const endFrac = spanCpLen > 0 ? localEndCp / spanCpLen : 1
        const left = r.left + startFrac * r.width
        const right = r.left + endFrac * r.width
        rawRects.push({
          left: left - containerRect.left,
          top: r.top - containerRect.top,
          right: right - containerRect.left,
          bottom: r.bottom - containerRect.top
        })
      }
      if (rawRects.length === 0) return []

      rawRects.sort((a, b) => a.top - b.top || a.left - b.left)
      const merged: Rect[] = []
      let cur = { ...rawRects[0] }
      for (let i = 1; i < rawRects.length; i++) {
        const r = rawRects[i]
        const curMidY = (cur.top + cur.bottom) / 2
        const rMidY = (r.top + r.bottom) / 2
        if (Math.abs(curMidY - rMidY) < LINE_TOLERANCE) {
          cur.left = Math.min(cur.left, r.left)
          cur.right = Math.max(cur.right, r.right)
          cur.top = Math.min(cur.top, r.top)
          cur.bottom = Math.max(cur.bottom, r.bottom)
        } else {
          merged.push(cur)
          cur = { ...r }
        }
      }
      merged.push(cur)
      return merged
    }

    // --- Region-based coding overlays ---
    // Selections with a `pdfRegion` are drawn directly in PDF user space at
    // the current render scale. Rendering matches the text-code approach:
    // a single 2-px bar at the bottom of the region. Single-color codings
    // get a solid bar; multi-color codings get a dashed bar where each dash
    // cycles through the code colors.
    interface RegionKey { key: string; left: number; top: number; width: number; height: number; colors: string[] }
    const regionGroups = new Map<string, RegionKey>()
    for (const sel of selections) {
      if (!sel.pdfRegion || sel.pdfRegion.page !== pageNumber) continue
      const left = sel.pdfRegion.x * scale
      const top = sel.pdfRegion.y * scale
      const width = sel.pdfRegion.width * scale
      const height = sel.pdfRegion.height * scale
      // Identical rectangles from different coding events merge so their
      // colors combine into one dashed bar.
      const key = `${Math.round(left)}:${Math.round(top)}:${Math.round(width)}:${Math.round(height)}`
      const group = regionGroups.get(key) || { key, left, top, width, height, colors: [] }
      for (const coding of sel.codings) {
        const code = codeMap.get(coding.codeGuid)
        if (!code) continue
        const color = code.color || '#888'
        if (!group.colors.includes(color)) group.colors.push(color)
      }
      regionGroups.set(key, group)
    }

    for (const group of regionGroups.values()) {
      if (group.colors.length === 0) continue
      const div = document.createElement('div')
      const BORDER_W = 2
      if (group.colors.length === 1) {
        // Single-color coding: solid border on all four sides.
        // We rely on the global `box-sizing: border-box` so `width` sets
        // the outer edge and the border sits inside. This matches both
        // the multi-colour branch below and the hover-highlight overlay,
        // so the coded box and its highlight align to the pixel.
        div.style.cssText = `
          position: absolute;
          left: ${group.left}px;
          top: ${group.top}px;
          width: ${group.width}px;
          height: ${group.height}px;
          pointer-events: none;
          border: ${BORDER_W}px solid ${group.colors[0]};
          border-radius: 2px;
        `
      } else {
        // Multi-color coding: dashed border cycling through code colors on
        // all four sides. We use individual edge gradients so each side
        // cycles the colors along its length.
        const segWidth = 4
        const stops = group.colors
          .map((c, i) => `${c} ${i * segWidth}px, ${c} ${(i + 1) * segWidth}px`)
          .join(', ')
        const totalWidth = group.colors.length * segWidth
        const hGradient = `repeating-linear-gradient(90deg, ${stops})`
        const vGradient = `repeating-linear-gradient(0deg, ${stops})`
        div.style.cssText = `
          position: absolute;
          left: ${group.left}px;
          top: ${group.top}px;
          width: ${group.width}px;
          height: ${group.height}px;
          pointer-events: none;
          border-radius: 2px;
          background:
            ${hGradient} top left / ${totalWidth}px ${BORDER_W}px repeat-x,
            ${hGradient} bottom left / ${totalWidth}px ${BORDER_W}px repeat-x,
            ${vGradient} top left / ${BORDER_W}px ${totalWidth}px repeat-y,
            ${vGradient} top right / ${BORDER_W}px ${totalWidth}px repeat-y;
        `
      }
      overlay.appendChild(div)
    }

    // --- Hover highlight for region-based selections ---
    if (hoveredSelGuid) {
      for (const sel of selections) {
        if (!sel.pdfRegion || sel.pdfRegion.page !== pageNumber || sel.guid !== hoveredSelGuid) continue
        const left = sel.pdfRegion.x * scale
        const top = sel.pdfRegion.y * scale
        const width = sel.pdfRegion.width * scale
        const height = sel.pdfRegion.height * scale
        const div = document.createElement('div')
        div.style.cssText = `
          position: absolute;
          left: ${left}px;
          top: ${top}px;
          width: ${width}px;
          height: ${height}px;
          pointer-events: none;
          background: rgba(60, 100, 240, 0.18);
          border: 1.5px solid rgba(60, 100, 240, 0.5);
          border-radius: 2px;
        `
        overlay.appendChild(div)
      }
    }

    // --- Hover highlight for region-anchored memos / quotes ---
    if (hoveredRegion && hoveredRegion.page === pageNumber) {
      const left = hoveredRegion.x * scale
      const top = hoveredRegion.y * scale
      const width = hoveredRegion.width * scale
      const height = hoveredRegion.height * scale
      const div = document.createElement('div')
      div.style.cssText = `
        position: absolute;
        left: ${left}px;
        top: ${top}px;
        width: ${width}px;
        height: ${height}px;
        pointer-events: none;
        background: rgba(60, 100, 240, 0.18);
        border: 1.5px solid rgba(60, 100, 240, 0.5);
        border-radius: 2px;
      `
      overlay.appendChild(div)
    }

    // --- Coding highlights (character-offset based) ---
    // Collect all coded ranges with their colors
    interface ColoredRange { cpStart: number; cpEnd: number; color: string }
    const coloredRanges: ColoredRange[] = []

    for (const sel of selections) {
      if (sel.pdfRegion) continue // handled above
      for (const coding of sel.codings) {
        const code = codeMap.get(coding.codeGuid)
        if (code) coloredRanges.push({ cpStart: sel.startPosition, cpEnd: sel.endPosition, color: code.color || '#888' })
      }
    }

    // externalHighlightRange is the persistent yellow used by the context-
    // menu hover-preview. Skip empty ranges — the interval sweep below
    // orders 'end' before 'start' at equal cp, which would otherwise
    // leave the colour active with no matching end and leak yellow into
    // every later interval. (Box-region quotes used to produce such
    // ranges; they now go through pulseRegion instead.)
    if (
      externalHighlightRange &&
      externalHighlightRange.startCp < externalHighlightRange.endCp
    ) {
      coloredRanges.push({ cpStart: externalHighlightRange.startCp, cpEnd: externalHighlightRange.endCp, color: '#fef08a' })
    }

    if (coloredRanges.length > 0) {
      // Interval sweep: split overlapping ranges into sub-intervals,
      // each with the full set of active colors at that position.
      // This matches how CodedTextView computes activeCodes per span.
      const events: { cp: number; type: 'start' | 'end'; color: string }[] = []
      for (const r of coloredRanges) {
        events.push({ cp: r.cpStart, type: 'start', color: r.color })
        events.push({ cp: r.cpEnd, type: 'end', color: r.color })
      }
      // Sort: by cp, then ends before starts at the same cp
      events.sort((a, b) => a.cp - b.cp || (a.type === 'end' ? -1 : 1))

      const activeColors: string[] = []
      let prevCp = -1
      interface Interval { cpStart: number; cpEnd: number; colors: string[] }
      const intervals: Interval[] = []

      for (const ev of events) {
        if (activeColors.length > 0 && ev.cp > prevCp) {
          intervals.push({ cpStart: prevCp, cpEnd: ev.cp, colors: [...new Set(activeColors)] })
        }
        if (ev.type === 'start') {
          activeColors.push(ev.color)
        } else {
          const idx = activeColors.indexOf(ev.color)
          if (idx !== -1) activeColors.splice(idx, 1)
        }
        prevCp = ev.cp
      }

      // Render each interval
      for (const iv of intervals) {
        if (iv.colors.length === 0) continue
        const uniqueColors = [...new Set(iv.colors)]

        for (const m of getMergedRects(iv.cpStart, iv.cpEnd)) {
          const div = document.createElement('div')

          const h = m.bottom - m.top + 3

          if (uniqueColors.length === 1) {
            div.style.cssText = `
              position: absolute;
              left: ${m.left}px; top: ${m.top}px;
              width: ${m.right - m.left}px; height: ${h}px;
              pointer-events: none; border-radius: 2px;
              background-color: ${uniqueColors[0]}25;
              border-bottom: 2px solid ${uniqueColors[0]};
            `
          } else {
            // Multi-code: blended highlight + dashed underline at same level as solid
            const segWidth = 4
            const stops = uniqueColors.map((c, i) =>
              `${c} ${i * segWidth}px, ${c} ${(i + 1) * segWidth}px`
            ).join(', ')
            const totalWidth = uniqueColors.length * segWidth
            div.style.cssText = `
              position: absolute;
              left: ${m.left}px; top: ${m.top}px;
              width: ${m.right - m.left}px; height: ${h}px;
              pointer-events: none;
              background-color: ${uniqueColors[0]}18;
              background-image: repeating-linear-gradient(90deg, ${stops});
              background-size: ${totalWidth}px 2px;
              background-position: bottom left;
              background-repeat: repeat-x;
            `
          }

          overlay.appendChild(div)
        }
      }
    }

    // --- Memo wave underlines (char-offset memos) ---
    if (contentMemos) {
      for (const memo of contentMemos) {
        if (memo.pdfRegion) continue // handled below
        if (memo.startPosition === undefined || memo.endPosition === undefined || memo.startPosition === memo.endPosition) continue
        for (const m of getMergedRects(memo.startPosition, memo.endPosition)) {
          const div = document.createElement('div')
          div.style.cssText = `
            position: absolute;
            left: ${m.left}px;
            top: ${m.top}px;
            width: ${m.right - m.left}px;
            height: ${m.bottom - m.top + 5}px;
            pointer-events: none;
            background-image: ${MEMO_WAVE};
            background-size: 12px 2.25px;
            background-position: bottom left;
            background-repeat: repeat-x;
          `
          overlay.appendChild(div)
        }
      }
    }

    // --- Memo wave borders for pdfRegion memos ---
    // A box memo draws the same zigzag wave around all four sides of its
    // region, matching the text-memo underline style. 0×0 regions are
    // point memos — skipped here and rendered as a circular icon below.
    if (contentMemos) {
      for (const memo of contentMemos) {
        if (!memo.pdfRegion || memo.pdfRegion.page !== pageNumber) continue
        if (memo.pdfRegion.width === 0 && memo.pdfRegion.height === 0) continue
        const left = memo.pdfRegion.x * scale
        const top = memo.pdfRegion.y * scale
        const width = memo.pdfRegion.width * scale
        const height = memo.pdfRegion.height * scale
        const WAVE_H = 2.25
        // Top edge
        const t = document.createElement('div')
        t.style.cssText = `position:absolute;left:${left}px;top:${top - WAVE_H}px;width:${width}px;height:${WAVE_H}px;pointer-events:none;background-image:${MEMO_WAVE};background-size:12px ${WAVE_H}px;background-repeat:repeat-x;`
        overlay.appendChild(t)
        // Bottom edge
        const b = document.createElement('div')
        b.style.cssText = `position:absolute;left:${left}px;top:${top + height}px;width:${width}px;height:${WAVE_H}px;pointer-events:none;background-image:${MEMO_WAVE};background-size:12px ${WAVE_H}px;background-repeat:repeat-x;`
        overlay.appendChild(b)
        // Left edge
        const l = document.createElement('div')
        l.style.cssText = `position:absolute;left:${left - WAVE_H}px;top:${top}px;width:${WAVE_H}px;height:${height}px;pointer-events:none;background-image:${MEMO_WAVE_V};background-size:${WAVE_H}px 12px;background-repeat:repeat-y;`
        overlay.appendChild(l)
        // Right edge
        const r = document.createElement('div')
        r.style.cssText = `position:absolute;left:${left + width}px;top:${top}px;width:${WAVE_H}px;height:${height}px;pointer-events:none;background-image:${MEMO_WAVE_V};background-size:${WAVE_H}px 12px;background-repeat:repeat-y;`
        overlay.appendChild(r)
      }
    }

    // --- Quote-click pulse (box region) ---
    if (pulseRegion && pulseRegion.page === pageNumber) {
      const left = pulseRegion.x * scale
      const top = pulseRegion.y * scale
      const width = pulseRegion.width * scale
      const height = pulseRegion.height * scale
      const div = document.createElement('div')
      div.style.cssText = `
        position: absolute;
        left: ${left}px; top: ${top}px;
        width: ${width}px; height: ${height}px;
        pointer-events: none;
        border-radius: 2px;
        background: rgba(60, 100, 240, 0.25);
        border: 2px solid rgba(60, 100, 240, 0.75);
        animation: quote-pulse 1.5s ease-out forwards;
      `
      overlay.appendChild(div)
    }

  }, [rendered, selections, codeMap, contentMemos, externalHighlightRange, pulseRegion, hoveredSelGuid, hoveredRegion, pageNumber, scale])

  // Hover/lock highlight — use native browser selection (matches plain text viewer).
  // Programmatically set window.getSelection() so the system highlight renders
  // behind text naturally.
  useEffect(() => {
    if (!rendered || !textLayerRef.current || !hoverHighlightRange) return

    const textSpans = textLayerRef.current.querySelectorAll<HTMLSpanElement>('[data-cpoffset]')
    let startNode: Node | null = null
    let startOffset = 0
    let endNode: Node | null = null
    let endOffset = 0

    for (const span of textSpans) {
      const cpOff = parseInt(span.dataset.cpoffset!, 10)
      const spanText = span.textContent || ''
      const spanCpLen = [...spanText].length
      const spanCpEnd = cpOff + spanCpLen

      if (hoverHighlightRange.startCp >= cpOff && hoverHighlightRange.startCp < spanCpEnd) {
        const localCp = hoverHighlightRange.startCp - cpOff
        const charIdx = [...spanText].slice(0, localCp).join('').length
        const textNode = span.firstChild || span
        startNode = textNode
        startOffset = charIdx
      }
      if (hoverHighlightRange.endCp > cpOff && hoverHighlightRange.endCp <= spanCpEnd) {
        const localCp = hoverHighlightRange.endCp - cpOff
        const charIdx = [...spanText].slice(0, localCp).join('').length
        const textNode = span.firstChild || span
        endNode = textNode
        endOffset = charIdx
      }
    }

    if (startNode && endNode) {
      try {
        const sel = window.getSelection()
        if (sel) {
          const range = document.createRange()
          range.setStart(startNode, startOffset)
          range.setEnd(endNode, endOffset)
          sel.removeAllRanges()
          sel.addRange(range)
        }
      } catch { /* ignore */ }
    }

    return () => {
      // Clear selection when hover ends (only if no new hover replaces it)
    }
  }, [rendered, hoverHighlightRange])

  // Clear browser selection when hover range is removed
  useEffect(() => {
    if (!hoverHighlightRange) {
      window.getSelection()?.removeAllRanges()
    }
  }, [hoverHighlightRange])

  return (
    <div
      data-pdf-page={pageNumber}
      data-pdf-scale={scale}
      style={{
        position: 'relative',
        width: pageSize.width || 'auto',
        height: pageSize.height || 'auto',
        marginBottom: 16,
        boxShadow: '0 1px 4px rgba(0,0,0,0.12)',
        background: 'white',
        borderRadius: 2,
        overflow: 'hidden'
      }}
    >
      <canvas ref={canvasRef} style={{ display: 'block' }} />
      <div
        ref={textLayerRef}
        className="textLayer pdfTextLayerNoSelect"
      />
      {/* Selection highlight overlay — drawn from browser selection, no gaps */}
      <div
        ref={selOverlayRef}
        style={{
          position: 'absolute',
          top: 0, left: 0,
          width: '100%', height: '100%',
          pointerEvents: 'none',
          zIndex: 1
        }}
      />
      {/* Coding highlight overlay */}
      <div
        ref={overlayRef}
        style={{
          position: 'absolute',
          top: 0, left: 0,
          width: '100%', height: '100%',
          pointerEvents: 'none'
        }}
      />
      {/* Box drag preview — dashed rectangle during active drag */}
      {boxDragPreview && boxDragPreview.page === pageNumber && (() => {
        const x = Math.min(boxDragPreview.startX, boxDragPreview.currentX) * scale
        const y = Math.min(boxDragPreview.startY, boxDragPreview.currentY) * scale
        const w = Math.abs(boxDragPreview.currentX - boxDragPreview.startX) * scale
        const h = Math.abs(boxDragPreview.currentY - boxDragPreview.startY) * scale
        return (
          <div style={{
            position: 'absolute', left: x, top: y, width: w, height: h,
            border: '2px dashed rgba(60, 100, 240, 0.7)',
            background: 'rgba(60, 100, 240, 0.08)',
            pointerEvents: 'none', zIndex: 10, borderRadius: 2
          }} />
        )
      })()}
      {/* Point-memo icons — rendered via React (not the imperative
          overlay) so they're clickable. A 0×0 pdfRegion encodes a point
          memo pinned to the page; double-click opens the memo editor. */}
      {contentMemos && contentMemos.filter((m) =>
        m.pdfRegion && m.pdfRegion.page === pageNumber &&
        m.pdfRegion.width === 0 && m.pdfRegion.height === 0
      ).map((m) => {
        const r = m.pdfRegion!
        const SIZE = 22
        return (
          <div
            key={`pt-memo-${m.guid}`}
            title={m.title || 'Memo'}
            onMouseDown={(e) => {
              if (e.button !== 0) return
              e.stopPropagation()
              e.preventDefault()
              setMemoDrag({ guid: m.guid, startClientX: e.clientX, startClientY: e.clientY, origX: r.x, origY: r.y })
            }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              onMemoDoubleClick?.(m.guid)
            }}
            style={{
              position: 'absolute',
              left: r.x * scale - SIZE / 2,
              top: r.y * scale - SIZE / 2,
              width: SIZE, height: SIZE,
              borderRadius: '50%',
              background: 'rgba(255, 255, 255, 0.9)',
              border: '1.5px solid #4a90d9',
              color: '#4a90d9',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: memoDrag?.guid === m.guid ? 'grabbing' : 'grab',
              boxShadow: '0 1px 3px rgba(0, 0, 0, 0.18)',
              zIndex: 11,
              userSelect: 'none'
            }}
          >
            <Icon icon={MEMO_POINT_ICON} style={{ fontSize: 11 }} />
          </div>
        )
      })}
      {/* Pending box selection — thin solid border until coded or dismissed */}
      {pendingBoxRegion && pendingBoxRegion.page === pageNumber && (() => {
        const x = pendingBoxRegion.x * scale
        const y = pendingBoxRegion.y * scale
        const w = pendingBoxRegion.width * scale
        const h = pendingBoxRegion.height * scale
        return (
          <div data-pending-box style={{
            position: 'absolute', left: x, top: y, width: w, height: h,
            border: '2px solid rgba(60, 100, 240, 0.6)',
            background: 'rgba(60, 100, 240, 0.06)',
            pointerEvents: 'none', zIndex: 10, borderRadius: 2
          }} />
        )
      })()}
    </div>
  )
}
