/**
 * PdfDocumentViewer — full-featured PDF viewer with coding support.
 * Renders PDF pages via pdfjs-dist with text selection, coding highlights,
 * context menu, drag-drop, and hotkey coding.
 */
import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { useDocumentStore } from '../../stores/document-store'
import { useCodeStore } from '../../stores/code-store'
import { useMemoStore } from '../../stores/memo-store'
import { useQuoteStore } from '../../stores/quote-store'
import { PdfPageRenderer } from './PdfPageRenderer'
import { RichMarginColumn } from './RichMarginColumn'
import { Icon, QUOTE_ICON, MEMO_POINT_ICON, MEMO_RANGED_ICON, faCrosshairs, faICursor } from '../Icon'
import { ViewerZoomToolbar } from './ViewerZoomToolbar'
import type { CodingRightClickContext } from './CodedTextView'
import type { Code, Memo, MemoEditInitData, TextSource, PdfRegionSelection } from '../../models/types'
import 'pdfjs-dist/web/pdf_viewer.css'
import { usePendingSelectionStore } from '../../stores/pending-selection-store'
import { useNewCodeTriggerStore } from '../../stores/new-code-trigger-store'
import { usePdfViewStore } from '../../stores/pdf-view-store'
import { modKey } from '../../utils/platform'

function flattenCodes(codes: Code[], depth = 0): { code: Code; depth: number }[] {
  const result: { code: Code; depth: number }[] = []
  for (const code of codes) {
    result.push({ code, depth })
    result.push(...flattenCodes(code.children, depth + 1))
  }
  return result
}

function buildCodeMap(codes: Code[]): Map<string, Code> {
  const m = new Map<string, Code>()
  const walk = (list: Code[]) => { for (const c of list) { m.set(c.guid, c); walk(c.children) } }
  walk(codes)
  return m
}

/** Resolve a DOM position to a codepoint via data-cpoffset */
function resolveCp(node: Node, offset: number): number | null {
  let targetNode = node
  let charOffset = offset
  if (node.nodeType === Node.ELEMENT_NODE) {
    const children = node.childNodes
    if (offset < children.length) { targetNode = children[offset]; charOffset = 0 }
    else if (children.length > 0) { targetNode = children[children.length - 1]; charOffset = (targetNode.textContent || '').length }
  }
  let el = targetNode instanceof HTMLElement ? targetNode : targetNode.parentElement
  while (el) {
    if (el.dataset?.cpoffset !== undefined) {
      const cpStart = parseInt(el.dataset.cpoffset, 10)
      if (targetNode.nodeType === Node.TEXT_NODE) {
        return cpStart + [...(targetNode.textContent || '').slice(0, charOffset)].length
      }
      return cpStart
    }
    el = el.parentElement
  }
  // Fallback: pdfjs's text layer inserts <br> elements between lines, and
  // triple-click / shift-End selections commonly land on one of them.
  // Walk backwards in document order to the nearest cpoffset-bearing span
  // and use its end position.
  let cur: Node | null = targetNode
  while (cur) {
    if (cur instanceof HTMLElement && cur.dataset.cpoffset !== undefined) {
      const cpStart = parseInt(cur.dataset.cpoffset, 10)
      return cpStart + [...(cur.textContent || '')].length
    }
    if (cur.previousSibling) {
      cur = cur.previousSibling
      while (cur.lastChild) cur = cur.lastChild
    } else {
      cur = cur.parentNode
    }
  }
  return null
}

interface Props {
  source: TextSource
  content: string
}

export function PdfDocumentViewer({ source, content }: Props) {
  const addSelection = useDocumentStore((s) => s.addSelection)
  const addCodingToSelection = useDocumentStore((s) => s.addCodingToSelection)
  const removeCoding = useDocumentStore((s) => s.removeCoding)
  const removeSelection = useDocumentStore((s) => s.removeSelection)
  const codes = useCodeStore((s) => s.codes)
  const findCode = useCodeStore((s) => s.findCode)
  const addMemo = useMemoStore((s) => s.addMemo)
  const removeMemo = useMemoStore((s) => s.removeMemo)
  const contentMemos = useMemoStore((s) => s.getContentMemosForSource(source.guid))
  const sourceQuotes = useQuoteStore((s) => s.getQuotesForSource(source.guid))
  const quoteRanges = useMemo(() =>
    sourceQuotes.map((q) => ({ guid: q.guid, startCp: q.startPosition, endCp: q.endPosition, pdfRegion: q.pdfRegion })),
    [sourceQuotes]
  )

  const [pdfDocument, setPdfDocument] = useState<any>(null)
  const [pendingSelection, setPendingSelection] = useState<{ startCp: number; endCp: number; selectedText: string } | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; context: CodingRightClickContext } | null>(null)
  const [menuHighlight, setMenuHighlight] = useState<{ startCp: number; endCp: number } | null>(null)
  const [hoveredRange, setHoveredRange] = useState<{ startCp: number; endCp: number } | null>(null)
  const [lockedRange, setLockedRange] = useState<{ startCp: number; endCp: number } | null>(null)
  const [hoveredSelGuid, setHoveredSelGuid] = useState<string | null>(null)
  const [hoveredRegion, setHoveredRegion] = useState<PdfRegionSelection | null>(null)
  const [memoPopup, setMemoPopup] = useState<{ items: Memo[]; x: number; y: number; isQuote?: boolean; showDelete?: boolean } | null>(null)

  // Box selection mode
  const [selectionMode, setSelectionMode] = useState<'text' | 'box'>('text')
  const [boxDrag, setBoxDrag] = useState<{
    page: number; startX: number; startY: number; currentX: number; currentY: number
  } | null>(null)
  const [pendingBoxSelection, setPendingBoxSelection] = useState<{ pdfRegion: PdfRegionSelection } | null>(null)

  // Mirror the active selection (text OR region) into the global
  // pending-selection-store so the New Code dialog can apply a
  // freshly-created code to whatever the user currently has selected.
  // Only one of the two is ever non-null at a time. Box selections
  // take precedence — they're the more recent intent if both happen
  // to be set.
  const setGlobalPendingSelection = usePendingSelectionStore((s) => s.setSelection)
  useEffect(() => {
    if (pendingBoxSelection) {
      setGlobalPendingSelection({
        kind: 'region',
        sourceGuid: source.guid,
        pdfRegion: pendingBoxSelection.pdfRegion
      })
    } else if (pendingSelection) {
      setGlobalPendingSelection({ kind: 'text', sourceGuid: source.guid, ...pendingSelection })
    } else {
      setGlobalPendingSelection(null)
    }
  }, [pendingSelection, pendingBoxSelection, source.guid, setGlobalPendingSelection])

  const containerRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const pagesContentRef = useRef<HTMLDivElement>(null)
  const [allPagesRendered, setAllPagesRendered] = useState(false)
  const pagesRenderedCount = useRef(0)

  // Zoom — applied as the PdfPageRenderer scale prop. Defaults to 1.2
  // (matches the historical hard-coded value). Box-drag and right-click
  // hit-testing read the current scale off `data-pdf-scale` on the page
  // element, so changing zoom here is automatically picked up everywhere.
  const PDF_DEFAULT_ZOOM = 1.2
  const [zoom, setZoom] = useState(PDF_DEFAULT_ZOOM)
  // Reset zoom when the user switches to a different PDF — otherwise the
  // new doc inherits the previous one's manual zoom level, which is jarring.
  useEffect(() => {
    setZoom(PDF_DEFAULT_ZOOM)
  }, [source.guid])

  const scrollTarget = useDocumentStore((s) => s.scrollTarget)
  const clearScrollTarget = useDocumentStore((s) => s.clearScrollTarget)
  /** Brief pulse after a box-quote click. Text quotes get native text
   *  selection (via lockedRange) instead, matching the plain-text viewer. */
  const [pulseRegion, setPulseRegion] = useState<PdfRegionSelection | null>(null)
  /** Deferred scroll targets. We wait for the relevant DOM (page element
   *  for box, text-layer span for char range) to exist before scrolling,
   *  which is driven by allPagesRendered flipping to true. */
  const [pendingRegionScroll, setPendingRegionScroll] = useState<PdfRegionSelection | null>(null)
  const [pendingTextScroll, setPendingTextScroll] = useState<{ startCp: number; endCp: number } | null>(null)

  // The pulse-clear timer is held in a ref so it survives the immediate
  // re-run of this effect caused by clearScrollTarget() below. If we used
  // an effect-scoped variable, React's cleanup would cancel the timer,
  // pulseRegion would never reset to null, and any later re-render of the
  // page overlay (e.g. from a hover) would rebuild the pulse <div> with a
  // fresh CSS animation — re-firing the pulse on every click.
  const pulseClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!scrollTarget) return
    if (scrollTarget.pdfRegion) {
      setPulseRegion(scrollTarget.pdfRegion)
      setPendingRegionScroll(scrollTarget.pdfRegion)
      if (pulseClearTimerRef.current) clearTimeout(pulseClearTimerRef.current)
      pulseClearTimerRef.current = setTimeout(() => setPulseRegion(null), 1600)
    } else if (scrollTarget.startCp < scrollTarget.endCp) {
      // Text quote — mirror the plain-text viewer: scroll to the range
      // and natively select it via lockedRange. No yellow overlay.
      const r = { startCp: scrollTarget.startCp, endCp: scrollTarget.endCp }
      setLockedRange(r)
      setPendingTextScroll(r)
    }
    clearScrollTarget()
  }, [scrollTarget, clearScrollTarget])

  // Perform the deferred region scroll once the target page's DOM exists.
  // allPagesRendered is the cheap way to know the layout has settled.
  useEffect(() => {
    if (!pendingRegionScroll) return
    const sc = scrollContainerRef.current
    if (!sc) return
    const pageEl = sc.querySelector<HTMLElement>(`[data-pdf-page="${pendingRegionScroll.page}"]`)
    if (!pageEl) return
    const pageScale = parseFloat(pageEl.dataset.pdfScale || '1') || 1
    const scRect = sc.getBoundingClientRect()
    const pageRect = pageEl.getBoundingClientRect()
    const regionTopInSc = (pageRect.top - scRect.top) + sc.scrollTop + pendingRegionScroll.y * pageScale
    const regionCenterY = regionTopInSc + (pendingRegionScroll.height * pageScale) / 2
    sc.scrollTo({ top: Math.max(0, regionCenterY - sc.clientHeight / 2), behavior: 'smooth' })
    setPendingRegionScroll(null)
  }, [pendingRegionScroll, allPagesRendered])

  // Deferred text-range scroll: find a text-layer span containing startCp
  // and scrollIntoView. Mirrors DocumentViewer.tsx's scroll-to-quote logic.
  useEffect(() => {
    if (!pendingTextScroll || !allPagesRendered) return
    const sc = scrollContainerRef.current
    if (!sc) return
    const spans = sc.querySelectorAll<HTMLSpanElement>('[data-cpoffset]')
    for (const span of spans) {
      const cpOff = parseInt(span.dataset.cpoffset!, 10)
      if (isNaN(cpOff)) continue
      const spanCpLen = [...(span.textContent || '')].length
      if (pendingTextScroll.startCp >= cpOff && pendingTextScroll.startCp < cpOff + spanCpLen) {
        span.scrollIntoView({ behavior: 'smooth', block: 'center' })
        break
      }
    }
    setPendingTextScroll(null)
  }, [pendingTextScroll, allPagesRendered])

  // Persist the scroll position continuously (not just on unmount — the
  // component can be torn down without a clean unmount opportunity, e.g.
  // when a tool tab like Preferences takes over) so switching away and
  // back — even via a tool tab — restores the same page. See
  // pdf-view-store.ts for why this lives outside the component.
  useEffect(() => {
    const sc = scrollContainerRef.current
    if (!sc) return
    let raf = 0
    const handleScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        usePdfViewStore.getState().setScrollPosition(source.guid, sc.scrollTop)
      })
    }
    sc.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      sc.removeEventListener('scroll', handleScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [source.guid])

  // Restore that position once, the first time this document's pages have
  // finished laying out. An explicit scroll target (opened via a saved
  // quote/memo click) takes priority over the last-viewed position.
  const restoredScrollGuidRef = useRef<string | null>(null)
  useEffect(() => {
    if (!allPagesRendered) return
    if (restoredScrollGuidRef.current === source.guid) return
    restoredScrollGuidRef.current = source.guid
    if (pendingRegionScroll || pendingTextScroll) return
    const sc = scrollContainerRef.current
    const saved = usePdfViewStore.getState().scrollPositions[source.guid]
    if (sc && saved) sc.scrollTop = saved
  }, [allPagesRendered, source.guid, pendingRegionScroll, pendingTextScroll])

  const codeMap = useMemo(() => buildCodeMap(codes), [codes])
  const flatCodes = useMemo(() => flattenCodes(codes), [codes])
  const hotkeyMap = useMemo(() => {
    const map = new Map<number, Code>()
    for (const { code } of flatCodes) {
      if (code.hotkey !== undefined) map.set(code.hotkey, code)
    }
    return map
  }, [flatCodes])
  const hotkeyCodes = useMemo(
    () => flatCodes.filter(({ code }) => code.hotkey !== undefined)
      .sort((a, b) => (a.code.hotkey ?? 0) - (b.code.hotkey ?? 0)),
    [flatCodes]
  )

  const pageOffsets: number[] = source.formatData?.pdfPageOffsets || []
  const numPages = pdfDocument ? pdfDocument.numPages : 0

  // Extract each page's text from the full content using pageOffsets
  const contentCps = useMemo(() => [...content], [content])
  const getPageText = useCallback((pageIdx: number): string => {
    const start = pageOffsets[pageIdx] || 0
    const end = pageIdx + 1 < pageOffsets.length ? pageOffsets[pageIdx + 1] - 1 : contentCps.length // -1 for page separator \n
    return contentCps.slice(start, end).join('')
  }, [pageOffsets, contentCps])

  // Load PDF document. Two supported sources:
  //   1. formatData.pdfFilePath — temp-file path, bytes fetched via IPC
  //      (fast; no base64 decode, no huge IPC payload).
  //   2. formatData.pdfBase64 — legacy path for PDFs already in memory.
  useEffect(() => {
    const fd = source.formatData
    if (!fd?.pdfFilePath && !fd?.pdfBase64) return
    let cancelled = false

    const loadPdf = async () => {
      const pdfjsLib = await import('pdfjs-dist')
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href
      // Point pdfjs at its bundled font/cmap directories so it doesn't warn
      // about missing standard fonts or fall back to CoreText system fonts.
      const standardFontDataUrl = new URL('pdfjs-dist/standard_fonts/', import.meta.url).href
      const cMapUrl = new URL('pdfjs-dist/cmaps/', import.meta.url).href

      let bytes: Uint8Array
      if (fd.pdfFilePath) {
        bytes = await window.api.readPdfFile(fd.pdfFilePath)
      } else {
        const binary = atob(fd.pdfBase64)
        bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      }
      if (cancelled) return

      const doc = await pdfjsLib.getDocument({
        data: bytes,
        standardFontDataUrl,
        cMapUrl,
        cMapPacked: true
      }).promise
      if (!cancelled) {
        pagesRenderedCount.current = 0
        setAllPagesRendered(false)
        setPdfDocument(doc)
      }
    }

    loadPdf().catch(console.error)
    return () => { cancelled = true }
  }, [source.formatData?.pdfBase64, source.formatData?.pdfFilePath])

  const applyCodingToRange = useCallback(
    (codeGuid: string, startCp: number, endCp: number, text: string) => {
      const existingSel = source.selections.find(
        (s) => s.startPosition === startCp && s.endPosition === endCp
      )
      if (existingSel) {
        if (!existingSel.codings.some((c) => c.codeGuid === codeGuid)) {
          addCodingToSelection(source.guid, existingSel.guid, codeGuid)
        }
      } else {
        const truncatedName = text.length > 60 ? text.slice(0, 57) + '...' : text
        const selGuid = addSelection(source.guid, startCp, endCp, truncatedName)
        addCodingToSelection(source.guid, selGuid, codeGuid)
      }
    },
    [source, addSelection, addCodingToSelection]
  )

  /** Convert a client mouse position into PDF user-space coords on a page. */
  const clientToPdfCoords = useCallback((clientX: number, clientY: number, pageEl: HTMLElement) => {
    const page = parseInt(pageEl.dataset.pdfPage || '0', 10)
    const scale = parseFloat(pageEl.dataset.pdfScale || '1') || 1
    const rect = pageEl.getBoundingClientRect()
    const x = (clientX - rect.left) / scale
    const y = (clientY - rect.top) / scale
    return { page, x, y }
  }, [])

  /** Find the [data-pdf-page] ancestor from an event target. */
  const findPageEl = useCallback((target: EventTarget | null): HTMLElement | null => {
    let el = target as HTMLElement | null
    while (el && !el.dataset?.pdfPage) el = el.parentElement
    return el
  }, [])

  const applyCodingToRegion = useCallback(
    (codeGuid: string, region: PdfRegionSelection) => {
      const existingSel = source.selections.find(
        (s) => s.pdfRegion &&
          s.pdfRegion.page === region.page &&
          Math.abs(s.pdfRegion.x - region.x) < 0.5 &&
          Math.abs(s.pdfRegion.y - region.y) < 0.5 &&
          Math.abs(s.pdfRegion.width - region.width) < 0.5 &&
          Math.abs(s.pdfRegion.height - region.height) < 0.5
      )
      if (existingSel) {
        if (!existingSel.codings.some((c) => c.codeGuid === codeGuid)) {
          addCodingToSelection(source.guid, existingSel.guid, codeGuid)
        }
      } else {
        const name = `Region p${region.page}`
        const selGuid = addSelection(source.guid, 0, 0, name, region)
        addCodingToSelection(source.guid, selGuid, codeGuid)
      }
      setPendingBoxSelection(null)
    },
    [source, addSelection, addCodingToSelection]
  )

  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)

    const startCp = resolveCp(range.startContainer, range.startOffset)
    const endCp = resolveCp(range.endContainer, range.endOffset)
    if (startCp === null || endCp === null || startCp === endCp) return

    const lo = Math.min(startCp, endCp)
    const hi = Math.max(startCp, endCp)
    const selectedText = [...content].slice(lo, hi).join('')
    setPendingSelection({ startCp: lo, endCp: hi, selectedText })
  }, [content])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    const sel = window.getSelection()
    let ps: CodingRightClickContext['pendingSelection'] | undefined
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0)
      const s = resolveCp(range.startContainer, range.startOffset)
      const en = resolveCp(range.endContainer, range.endOffset)
      if (s !== null && en !== null && s !== en) {
        const lo = Math.min(s, en)
        const hi = Math.max(s, en)
        ps = { startCp: lo, endCp: hi, selectedText: [...content].slice(lo, hi).join('') }
      }
    }
    if (!ps && pendingSelection) ps = pendingSelection
    // Box mode: use the pending box selection if no text selection exists.
    if (!ps && pendingBoxSelection) {
      const r = pendingBoxSelection.pdfRegion
      ps = {
        startCp: 0, endCp: 0,
        selectedText: `Region p${r.page}`,
        pdfRegion: r
      }
    }

    // Find existing codings at click position. Prefer the event target
    // (right-click reliably reports a target) and fall back to the browser
    // caret. Without the target fallback, right-clicking PDF text often
    // misses because the browser doesn't always reposition the caret.
    let clickCp: number | null = null
    const targetEl = e.target as Node | null
    if (targetEl) {
      clickCp = resolveCp(targetEl, 0)
    }
    if (clickCp === null && sel && sel.rangeCount > 0) {
      clickCp = resolveCp(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset)
    }
    const existingCodings: CodingRightClickContext['existingCodings'] = []
    if (clickCp !== null) {
      for (const sel2 of source.selections) {
        if (sel2.pdfRegion) continue // handled by box hit-test below
        if (clickCp >= sel2.startPosition && clickCp < sel2.endPosition) {
          for (const coding of sel2.codings) {
            existingCodings.push({
              selectionGuid: sel2.guid, codingGuid: coding.guid, codeGuid: coding.codeGuid,
              startCp: sel2.startPosition, endCp: sel2.endPosition
            })
          }
        }
      }
    }

    // Box hit-test: find any coded OR memo region under the click point.
    // Smaller regions win on overlap (most specific).
    const pageEl = findPageEl(e.target)
    let boxHitPage: number | null = null
    let boxHitX = 0
    let boxHitY = 0
    if (pageEl) {
      const coords = clientToPdfCoords(e.clientX, e.clientY, pageEl)
      boxHitPage = coords.page
      boxHitX = coords.x
      boxHitY = coords.y
      const regionContains = (r: { page: number; x: number; y: number; width: number; height: number }): boolean =>
        r.page === boxHitPage && boxHitX >= r.x && boxHitX <= r.x + r.width && boxHitY >= r.y && boxHitY <= r.y + r.height
      // Collect all box-coded selections whose region contains the click, sorted smallest-first.
      const boxCandidates = source.selections
        .filter((s) => s.pdfRegion && regionContains(s.pdfRegion))
        .sort((a, b) => (a.pdfRegion!.width * a.pdfRegion!.height) - (b.pdfRegion!.width * b.pdfRegion!.height))
      // If no explicit selection is pending, treat the smallest hit box as the
      // implicit target so "Add Selection Memo" / "Add as Quote" attach to the
      // same region as the existing coding.
      if (!ps && boxCandidates.length > 0) {
        const r = boxCandidates[0].pdfRegion!
        ps = { startCp: 0, endCp: 0, selectedText: `Region p${r.page}`, pdfRegion: r }
      }
      for (const sel2 of boxCandidates) {
        for (const coding of sel2.codings) {
          existingCodings.push({
            selectionGuid: sel2.guid, codingGuid: coding.guid, codeGuid: coding.codeGuid,
            startCp: sel2.startPosition, endCp: sel2.endPosition
          })
        }
      }
    }

    const overlappingMemos: CodingRightClickContext['overlappingMemos'] = []
    if (clickCp !== null) {
      for (const m of contentMemos || []) {
        if (m.pdfRegion) continue // handled below
        if (m.startPosition !== undefined && m.endPosition !== undefined && clickCp >= m.startPosition && clickCp < m.endPosition) {
          overlappingMemos.push({ guid: m.guid, title: m.title, startCp: m.startPosition, endCp: m.endPosition })
        }
      }
    }
    if (boxHitPage !== null) {
      const boxMemos = (contentMemos || []).filter((m) =>
        m.pdfRegion && m.pdfRegion.page === boxHitPage &&
        boxHitX >= m.pdfRegion.x && boxHitX <= m.pdfRegion.x + m.pdfRegion.width &&
        boxHitY >= m.pdfRegion.y && boxHitY <= m.pdfRegion.y + m.pdfRegion.height
      ).sort((a, b) => (a.pdfRegion!.width * a.pdfRegion!.height) - (b.pdfRegion!.width * b.pdfRegion!.height))
      for (const m of boxMemos) {
        overlappingMemos.push({ guid: m.guid, title: m.title, startCp: m.startPosition ?? 0, endCp: m.endPosition ?? m.startPosition ?? 0 })
      }
    }

    // Pin the click position on the PDF page so "Add Selection Memo" with
    // no selection creates a point memo at exactly that spot. Skipped when
    // a pending or implicit selection is present — those carry their own
    // anchor.
    const pdfPoint = !ps && boxHitPage !== null
      ? { page: boxHitPage, x: boxHitX, y: boxHitY }
      : undefined

    if (ps || existingCodings.length > 0 || overlappingMemos.length > 0 || source) {
      setContextMenu({ x: e.clientX, y: e.clientY, context: { existingCodings, pendingSelection: ps, codepointOffset: clickCp ?? undefined, pdfPoint, overlappingMemos } })
    }
  }, [content, pendingSelection, pendingBoxSelection, source, contentMemos, clientToPdfCoords, findPageEl])

  const handleApplyCode = useCallback((codeGuid: string) => {
    if (!contextMenu?.context.pendingSelection) return
    const ps = contextMenu.context.pendingSelection
    if (ps.pdfRegion) {
      applyCodingToRegion(codeGuid, ps.pdfRegion)
    } else {
      applyCodingToRange(codeGuid, ps.startCp, ps.endCp, ps.selectedText)
    }
    setContextMenu(null); setMenuHighlight(null)
  }, [contextMenu, applyCodingToRange, applyCodingToRegion])

  const handleRemoveCoding = useCallback((selectionGuid: string, codingGuid: string) => {
    removeCoding(source.guid, selectionGuid, codingGuid)
    const sel = source.selections.find((s) => s.guid === selectionGuid)
    if (sel && sel.codings.length <= 1) removeSelection(source.guid, selectionGuid)
    setContextMenu(null); setMenuHighlight(null)
  }, [source, removeCoding, removeSelection])

  const handleCreateMemo = useCallback((startCp: number, endCp: number, pdfRegion?: PdfRegionSelection) => {
    const guid = addMemo('content', '', { sourceGuid: source.guid, startPosition: startCp, endPosition: endCp, pdfRegion })
    const memo = useMemoStore.getState().findMemo(guid)
    if (memo) window.api.openMemoEditWindow({ memo, theme: document.documentElement.getAttribute('data-theme') || '' } as MemoEditInitData)
    setContextMenu(null)
  }, [source.guid, addMemo])

  // Drag-drop coding. Priority order:
  //   1. Pending TEXT selection — user explicitly selected text before drag.
  //   2. Pending BOX selection — user drew a box before drag.
  //   3. Live browser selection — fallback if neither pending.
  //   4. Drop on an existing box coding — add codes to that box.
  // A pending selection beats a box under the cursor: otherwise a
  // stray box covering the page would swallow every text-selection drop.
  const handleDrop = useCallback((codeGuids: string[], dropClientX?: number, dropClientY?: number) => {
    if (pendingSelection) {
      for (const cg of codeGuids) applyCodingToRange(cg, pendingSelection.startCp, pendingSelection.endCp, pendingSelection.selectedText)
      return
    }
    if (pendingBoxSelection) {
      for (const cg of codeGuids) applyCodingToRegion(cg, pendingBoxSelection.pdfRegion)
      return
    }

    const winSel = window.getSelection()
    if (winSel && !winSel.isCollapsed && winSel.rangeCount > 0) {
      const range = winSel.getRangeAt(0)
      const s = resolveCp(range.startContainer, range.startOffset)
      const e = resolveCp(range.endContainer, range.endOffset)
      if (s !== null && e !== null && s !== e) {
        const lo = Math.min(s, e); const hi = Math.max(s, e)
        for (const cg of codeGuids) applyCodingToRange(cg, lo, hi, [...content].slice(lo, hi).join(''))
        return
      }
    }

    // Last resort — drop landed on an existing box region. Two cases:
    //   a) an already-coded box region → add the dragged code(s) to it.
    //   b) a memo-only box region (pdfRegion on a memo, no selection yet)
    //      → create a new coded selection using the memo's region.
    // Smaller region wins when multiple contain the drop point.
    if (dropClientX !== undefined && dropClientY !== undefined) {
      const pageEl = document.elementFromPoint(dropClientX, dropClientY) as HTMLElement | null
      let page: HTMLElement | null = pageEl
      while (page && !page.dataset?.pdfPage) page = page.parentElement
      if (page) {
        const { page: pageNum, x, y } = clientToPdfCoords(dropClientX, dropClientY, page)
        const containsPoint = (r: { page: number; x: number; y: number; width: number; height: number }): boolean =>
          r.page === pageNum && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height

        // (a) existing coded region?
        const codedCandidates = source.selections
          .filter((s) => s.pdfRegion && containsPoint(s.pdfRegion))
          .sort((a, b) => (a.pdfRegion!.width * a.pdfRegion!.height) - (b.pdfRegion!.width * b.pdfRegion!.height))
        if (codedCandidates.length > 0) {
          const target = codedCandidates[0]
          for (const cg of codeGuids) {
            if (!target.codings.some((c) => c.codeGuid === cg)) {
              addCodingToSelection(source.guid, target.guid, cg)
            }
          }
          return
        }

        // (b) memo-only region? Create a coded selection using the memo's box.
        const memoCandidates = (contentMemos || [])
          .filter((m): m is typeof m & { pdfRegion: NonNullable<typeof m.pdfRegion> } => !!m.pdfRegion && containsPoint(m.pdfRegion))
          .sort((a, b) => (a.pdfRegion.width * a.pdfRegion.height) - (b.pdfRegion.width * b.pdfRegion.height))
        if (memoCandidates.length > 0) {
          const memo = memoCandidates[0]
          for (const cg of codeGuids) applyCodingToRegion(cg, memo.pdfRegion)
        }
      }
    }
  }, [pendingSelection, pendingBoxSelection, applyCodingToRange, applyCodingToRegion, content, source, addCodingToSelection, clientToPdfCoords, contentMemos])

  // Cmd/Ctrl + wheel zoom. Native addEventListener with passive:false so
  // preventDefault() actually stops the page-level scroll. Mirrors
  // RelationshipMap's wheel-zoom UX.
  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const handler = (e: WheelEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const delta = -e.deltaY * 0.005
      setZoom((z) => Math.max(0.25, Math.min(4, z + delta * z)))
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])

  /** Fit-to-width: scale the first page so its native width fills the
   *  area left of the margin column. Multi-page PDFs scroll vertically
   *  the same way as before; only the rendered scale changes. */
  const handleFit = useCallback(() => {
    const sc = scrollContainerRef.current
    if (!sc) return
    const pageEl = sc.querySelector('[data-pdf-page="1"]') as HTMLElement | null
    if (!pageEl) return
    const currentScale = parseFloat(pageEl.dataset.pdfScale || '1') || 1
    const naturalW = pageEl.offsetWidth / currentScale
    if (naturalW <= 0) return
    // Keep this in sync with the JSX layout: 16px scroll padding on each
    // side, plus the RichMarginColumn flex-basis (260) + ml-8 gap.
    const PADDING = 32
    const MARGIN_COL_RESERVED_W = 268
    const availW = Math.max(1, sc.clientWidth - PADDING - MARGIN_COL_RESERVED_W)
    const fitScale = Math.max(0.25, Math.min(4, availW / naturalW))
    setZoom(fitScale)
  }, [])

  // Hotkeys + ESC handling
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // ESC: cancel box drag or pending box, or close context menu
      if (e.key === 'Escape') {
        if (boxDrag) { setBoxDrag(null); return }
        if (pendingBoxSelection) { setPendingBoxSelection(null); return }
        if (contextMenu) { setContextMenu(null); setMenuHighlight(null); return }
        return
      }
      if (!e.metaKey && !e.ctrlKey) return
      const digit = parseInt(e.key, 10)
      if (isNaN(digit) || digit < 0 || digit > 9) return
      const code = hotkeyMap.get(digit)
      if (!code) return
      // Box selection takes priority
      if (pendingBoxSelection) {
        e.preventDefault()
        applyCodingToRegion(code.guid, pendingBoxSelection.pdfRegion)
        return
      }
      if (pendingSelection) {
        e.preventDefault()
        applyCodingToRange(code.guid, pendingSelection.startCp, pendingSelection.endCp, pendingSelection.selectedText)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [hotkeyMap, pendingSelection, pendingBoxSelection, applyCodingToRange, applyCodingToRegion, boxDrag, contextMenu])

  return (
    <div
      ref={containerRef}
      style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}
      onMouseDown={(e) => {
        if (contextMenu && !(e.target as HTMLElement).closest('.context-menu')) {
          setContextMenu(null); setMenuHighlight(null)
        }
        // Clear margin-column lock when clicking outside a margin label / popup,
        // matching the plain-text viewer's behavior.
        if (lockedRange) {
          const t = e.target as HTMLElement
          if (!t.closest('.context-menu') && !t.closest('[data-margin-label="1"]')) {
            setLockedRange(null)
            setHoveredRange(null)
          }
        }
      }}
    >
      {/* Top control bar — zoom strip + selection-mode toggle. Mirrors
          the mockup's connected button group. */}
      <div className="viewer-toolbar">
        <div className="zoom-strip">
          <button onClick={() => setZoom((z) => Math.max(0.25, z * 0.9))} title="Zoom out">−</button>
          <button onClick={() => setZoom(1)} title="Reset to 100%">100%</button>
          <button onClick={() => setZoom((z) => Math.min(4, z * 1.1))} title="Zoom in">+</button>
          <button onClick={handleFit} title="Fit to window">Fit</button>
        </div>
        <div className="zoom-strip" style={{ marginLeft: 6 }}>
          <button
            onClick={() => { setSelectionMode('text'); setPendingBoxSelection(null); setBoxDrag(null) }}
            title="Text selection"
            className={selectionMode === 'text' ? 'active' : ''}
          >
            <Icon icon={faICursor} />
          </button>
          <button
            onClick={() => { setSelectionMode('box'); setPendingSelection(null) }}
            title="Box selection"
            className={selectionMode === 'box' ? 'active' : ''}
          >
            <Icon icon={faCrosshairs} />
          </button>
        </div>
        <span className="viewer-spacer" />
        <span className="viewer-meta">PDF</span>
      </div>
      <div
        ref={scrollContainerRef}
        className="pdf-scroll-area"
        style={{
          flex: 1, overflowY: 'auto', overflowX: 'auto',
          background: 'var(--bg-panel)', padding: '16px', position: 'relative',
          cursor: selectionMode === 'box' ? 'crosshair' : 'auto',
          userSelect: selectionMode === 'box' ? 'none' : 'auto'
        }}
        onMouseUp={(e) => {
          if (selectionMode === 'box' && boxDrag) {
            // Finalize box drag
            const pageEl = scrollContainerRef.current?.querySelector(`[data-pdf-page="${boxDrag.page}"]`) as HTMLElement | null
            if (pageEl) {
              const coords = clientToPdfCoords(e.clientX, e.clientY, pageEl)
              const x = Math.min(boxDrag.startX, coords.x)
              const y = Math.min(boxDrag.startY, coords.y)
              const width = Math.abs(coords.x - boxDrag.startX)
              const height = Math.abs(coords.y - boxDrag.startY)
              // Min 5pt in each dimension to avoid accidental clicks
              if (width >= 5 && height >= 5) {
                setPendingBoxSelection({ pdfRegion: { page: boxDrag.page, x, y, width, height } })
              }
            }
            setBoxDrag(null)
            return
          }
          if (selectionMode === 'text') handleMouseUp()
        }}
        onMouseDown={(e) => {
          if (selectionMode === 'box' && e.button === 0) {
            const pageEl = findPageEl(e.target)
            if (!pageEl) return
            const coords = clientToPdfCoords(e.clientX, e.clientY, pageEl)
            setBoxDrag({ page: coords.page, startX: coords.x, startY: coords.y, currentX: coords.x, currentY: coords.y })
            setPendingBoxSelection(null)
            e.preventDefault()
          }
        }}
        onMouseMove={(e) => {
          if (selectionMode === 'box' && boxDrag) {
            const pageEl = scrollContainerRef.current?.querySelector(`[data-pdf-page="${boxDrag.page}"]`) as HTMLElement | null
            if (!pageEl) return
            const scale = parseFloat(pageEl.dataset.pdfScale || '1') || 1
            const rect = pageEl.getBoundingClientRect()
            // Clamp to page bounds
            const cx = Math.max(0, Math.min((e.clientX - rect.left) / scale, rect.width / scale))
            const cy = Math.max(0, Math.min((e.clientY - rect.top) / scale, rect.height / scale))
            setBoxDrag((prev) => prev ? { ...prev, currentX: cx, currentY: cy } : null)
          }
        }}
        onContextMenu={(e) => {
          // Right-click during box drag → cancel drag
          if (boxDrag) { setBoxDrag(null); e.preventDefault(); return }
          handleContextMenu(e)
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('application/x-magnolia-code') || e.dataTransfer.types.includes('application/x-magnolia-codes')) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }
        }}
        onDrop={(e) => {
          e.preventDefault()
          const multiData = e.dataTransfer.getData('application/x-magnolia-codes')
          if (multiData) { try { handleDrop(JSON.parse(multiData).map((c: any) => c.guid), e.clientX, e.clientY) } catch {} return }
          const data = e.dataTransfer.getData('application/x-magnolia-code')
          if (data) { try { handleDrop([JSON.parse(data).guid], e.clientX, e.clientY) } catch {} }
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start' }}>
          {/* PDF pages — takes available space */}
          <div ref={pagesContentRef} style={{ flexShrink: 0 }}>
            {!pdfDocument && (
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading PDF...</div>
            )}
            {pdfDocument && Array.from({ length: numPages }, (_, i) => (
              <PdfPageRenderer
                key={i}
                pdfDocument={pdfDocument}
                pageNumber={i + 1}
                pageTextOffset={pageOffsets[i] || 0}
                pageText={getPageText(i)}
                scale={zoom}
                selections={source.selections}
                codeMap={codeMap}
                contentMemos={contentMemos}
                quotes={quoteRanges}
                externalHighlightRange={menuHighlight}
                pulseRegion={pulseRegion}
                hoverHighlightRange={lockedRange || hoveredRange}
                hoveredSelGuid={hoveredSelGuid}
                hoveredRegion={hoveredRegion}
                boxDragPreview={boxDrag}
                pendingBoxRegion={pendingBoxSelection?.pdfRegion ?? null}
                onMemoDoubleClick={(memoGuid) => {
                  const memo = useMemoStore.getState().findMemo(memoGuid)
                  if (memo) window.api.openMemoEditWindow({ memo, theme: document.documentElement.getAttribute('data-theme') || '' } as MemoEditInitData)
                }}
                onMemoMove={(memoGuid, page, x, y) => {
                  const memo = useMemoStore.getState().findMemo(memoGuid)
                  if (!memo || !memo.pdfRegion) return
                  useMemoStore.getState().updateMemo({
                    ...memo,
                    pdfRegion: { ...memo.pdfRegion, page, x, y }
                  })
                }}
                onRendered={() => {
                  pagesRenderedCount.current++
                  if (pagesRenderedCount.current >= numPages) {
                    setAllPagesRendered(true)
                  }
                }}
              />
            ))}
          </div>
          {/* Margin column — inline to the right, shrinks gracefully before overlapping.
              Min-width reserves enough room for a readable code label even when
              the bracket zone grows with many overlapping codings. */}
          <div style={{ flexShrink: 1, flexGrow: 0, flexBasis: 260, position: 'relative', marginLeft: 8, alignSelf: 'stretch', minWidth: 180 }}>
            <RichMarginColumn
          contentRef={pagesContentRef}
          containerRef={pagesContentRef}
          selections={source.selections}
          codes={codes}
          contentMemos={contentMemos}
          quotes={quoteRanges}
          rendered={allPagesRendered}
          alignRight
          viewportRef={scrollContainerRef}
          lockedRange={lockedRange}
          onHoverRange={setHoveredRange}
          onHoverSelectionGuid={setHoveredSelGuid}
          onHoverRegion={setHoveredRegion}
          onLockRange={setLockedRange}
          onMemoClick={(memoGuid) => {
            const memo = useMemoStore.getState().findMemo(memoGuid)
            if (memo) {
              window.api.openMemoEditWindow({ memo, theme: document.documentElement.getAttribute('data-theme') || '' } as MemoEditInitData)
            }
          }}
          onMemoPopup={(e, memos) => {
            setMemoPopup({ items: memos, x: e.clientX, y: e.clientY })
          }}
          onContextMenu={(e, ctx) => {
            setContextMenu({
              x: e.clientX,
              y: e.clientY,
              context: {
                existingCodings: ctx.existingCodings || [],
                overlappingMemos: ctx.overlappingMemos
              }
            })
          }}
          onQuoteClick={(e, qs, showDelete) => {
            const items = qs.map((q) => ({
              guid: q.guid,
              type: 'content' as const,
              title: 'Quote',
              content: '',
              createdDateTime: '',
              startPosition: q.startCp,
              endPosition: q.endCp
            }))
            if (qs.length === 1) setLockedRange({ startCp: qs[0].startCp, endCp: qs[0].endCp })
            setMemoPopup({ items, x: e.clientX, y: e.clientY, isQuote: true, showDelete })
          }}
        />
          </div>
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(e) => e.stopPropagation()}>
          {/* New Code — always at the top. If there's a pending text or
              region selection it auto-applies the new code via
              handleCreateCode in App.tsx (reads pending-selection-store). */}
          <div className="context-menu-item" onClick={() => {
            useNewCodeTriggerStore.getState().request()
            setContextMenu(null); setMenuHighlight(null)
          }}>
            New Code
          </div>
          <div className="context-menu-separator" />
          {contextMenu.context.pendingSelection && (
            <>
              <div style={{ padding: '4px 14px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, userSelect: 'none' }}>Apply Code</div>
              <div style={{ padding: '0 14px 6px', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4, maxWidth: 220, userSelect: 'none' }}>
                To apply any code, select content and drag the code from the Code Browser to the selection.
              </div>
              {hotkeyCodes.map(({ code }) => (
                <div key={code.guid} className="context-menu-item" onClick={() => handleApplyCode(code.guid)}>
                  <span className="color-pip" style={{ background: code.color || '#888' }} />
                  <span style={{ flex: 1 }}>{code.name}</span>
                  <span style={{ fontSize: 10, color: 'var(--menu-fg-muted)', marginLeft: 12 }}>{modKey(code.hotkey)}</span>
                </div>
              ))}
              {hotkeyCodes.length === 0 && (
                <div className="context-menu-item" style={{ color: 'var(--menu-fg-muted)', pointerEvents: 'none' }}>No hotkeys assigned</div>
              )}
            </>
          )}
          {contextMenu.context.pendingSelection && contextMenu.context.existingCodings.length > 0 && <div className="context-menu-separator" />}
          {contextMenu.context.existingCodings.length > 0 && (
            <>
              <div style={{ padding: '4px 14px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, userSelect: 'none' }}>Remove Code</div>
              {contextMenu.context.existingCodings.map((ec) => {
                const code = findCode(ec.codeGuid)
                return (
                  <div key={ec.codingGuid} className="context-menu-item" style={{ color: 'var(--menu-fg-danger)' }}
                    onClick={() => handleRemoveCoding(ec.selectionGuid, ec.codingGuid)}
                    onMouseEnter={() => setMenuHighlight({ startCp: ec.startCp, endCp: ec.endCp })}
                    onMouseLeave={() => setMenuHighlight(null)}
                  >
                    <span className="color-pip" style={{ background: code?.color || '#888' }} />
                    {code?.name ?? 'Unknown'}
                  </div>
                )
              })}
            </>
          )}
          {contextMenu.context.pendingSelection && (
            <>
              <div className="context-menu-separator" />
              <div className="context-menu-item" onClick={() => {
                const ps = contextMenu.context.pendingSelection!
                useQuoteStore.getState().addQuote(source.guid, source.name, ps.startCp, ps.endCp, ps.selectedText, ps.pdfRegion)
                setPendingBoxSelection(null)
                setContextMenu(null)
              }}>Add as Quote</div>
            </>
          )}
          {(contextMenu.context.pendingSelection || contextMenu.context.existingCodings.length > 0) && <div className="context-menu-separator" />}
          <div className="context-menu-item" onClick={() => {
            if (contextMenu.context.pendingSelection) {
              const ps = contextMenu.context.pendingSelection
              handleCreateMemo(ps.startCp, ps.endCp, ps.pdfRegion)
              setPendingBoxSelection(null)
            }
            // Pin a point memo to the click position. Encoded as a 0×0
            // pdfRegion so the existing pdfRegion plumbing (storage, right
            // column anchoring, click-to-open) carries it for free; the
            // page renderer dispatches 0×0 to a circular icon overlay.
            else if (contextMenu.context.pdfPoint) {
              const p = contextMenu.context.pdfPoint
              handleCreateMemo(0, 0, { page: p.page, x: p.x, y: p.y, width: 0, height: 0 })
            }
          }}>Add Selection Memo</div>
          {contextMenu.context.overlappingMemos && contextMenu.context.overlappingMemos.length > 0 && (
            <>
              <div className="context-menu-separator" />
              <div style={{ padding: '4px 14px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, userSelect: 'none' }}>Delete Memo</div>
              {contextMenu.context.overlappingMemos.map((m) => (
                <div key={m.guid} className="context-menu-item" style={{ color: 'var(--menu-fg-danger)' }}
                  onMouseEnter={() => setHoveredRange({ startCp: m.startCp, endCp: m.endCp })}
                  onMouseLeave={() => setHoveredRange(null)}
                  onClick={() => { removeMemo(m.guid); setContextMenu(null); setMenuHighlight(null) }}
                >
                  {m.title || 'Untitled Memo'}
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* Memo/Quote popup — matches CodedTextView memoPopup exactly */}
      {memoPopup && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 99 }} onClick={() => { setMemoPopup(null); setLockedRange(null); setHoveredRange(null) }} />
          <div
            className="context-menu"
            style={{
              position: 'fixed',
              left: memoPopup.x,
              top: memoPopup.y,
              zIndex: 100,
              minWidth: 140
            }}
          >
            {/* Browse items (left-click, or memo right-click) */}
            {!(memoPopup.isQuote && memoPopup.showDelete) && memoPopup.items.map((m) => (
              <div
                key={m.guid}
                className="context-menu-item"
                style={{ display: 'flex', alignItems: 'center' }}
                onMouseEnter={() => {
                  if (m.startPosition !== undefined && m.endPosition !== undefined && m.startPosition !== m.endPosition) {
                    setHoveredRange({ startCp: m.startPosition, endCp: m.endPosition })
                  }
                }}
                onMouseLeave={() => setHoveredRange(null)}
                onClick={() => {
                  if (m.startPosition !== undefined && m.endPosition !== undefined && m.startPosition !== m.endPosition) {
                    setLockedRange({ startCp: m.startPosition, endCp: m.endPosition })
                  }
                  if (!memoPopup.isQuote) {
                    const memo = useMemoStore.getState().findMemo(m.guid)
                    if (memo) window.api.openMemoEditWindow({ memo, theme: document.documentElement.getAttribute('data-theme') || '' } as MemoEditInitData)
                  }
                  setMemoPopup(null)
                }}
              >
                <Icon
                  icon={memoPopup.isQuote ? QUOTE_ICON : (m.startPosition === m.endPosition ? MEMO_POINT_ICON : MEMO_RANGED_ICON)}
                  style={{ marginRight: 6, fontSize: 10, color: memoPopup.isQuote ? 'var(--quote-icon-color)' : undefined }}
                />
                <span style={{ flex: 1 }}>{m.title || (memoPopup.isQuote ? 'Quote' : 'Untitled Memo')}</span>
              </div>
            ))}
            {/* Delete options for quotes (right-click only) */}
            {memoPopup.isQuote && memoPopup.showDelete && (
              <>
                {memoPopup.items.map((m) => (
                  <div
                    key={`del-${m.guid}`}
                    className="context-menu-item"
                    style={{ color: 'var(--menu-fg-danger)' }}
                    onMouseEnter={() => {
                      if (m.startPosition !== undefined && m.endPosition !== undefined) {
                        setHoveredRange({ startCp: m.startPosition, endCp: m.endPosition })
                      }
                    }}
                    onMouseLeave={() => setHoveredRange(null)}
                    onClick={() => {
                      useQuoteStore.getState().removeQuote(m.guid)
                      setMemoPopup(null)
                      setLockedRange(null)
                      setHoveredRange(null)
                    }}
                  >
                    Delete "{(m.title || 'Quote').slice(0, 20)}"
                  </div>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
