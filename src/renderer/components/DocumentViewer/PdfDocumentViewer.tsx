/**
 * PdfDocumentViewer — full-featured PDF viewer with coding support.
 * Renders PDF pages via pdfjs-dist with text selection, coding highlights,
 * context menu, drag-drop, and hotkey coding.
 */
import { useState, useCallback, useMemo, useRef, useEffect, useLayoutEffect, useId } from 'react'
import { useDocumentStore } from '../../stores/document-store'
import { useCodeStore } from '../../stores/code-store'
// A source's memos and quotes are filtered out of the stores' lists, a new
// array each time; comparing them item by item keeps the coded view from
// redrawing (and re-measuring) on every hover and caret move.
import { useShallow } from 'zustand/react/shallow'
import { useMemoStore } from '../../stores/memo-store'
import { useQuoteStore } from '../../stores/quote-store'
import { PdfPageRenderer } from './PdfPageRenderer'
import { RichMarginColumn } from './RichMarginColumn'
import { Icon, QUOTE_ICON, MEMO_POINT_ICON, MEMO_RANGED_ICON, faCrosshairs, faICursor } from '../Icon'
import { DocumentToolbarPortal } from './DocumentToolbar'
import type { CodingRightClickContext } from './CodedTextView'
import type { Code, Memo, MemoEditInitData, TextSource, PdfRegionSelection } from '../../models/types'
import 'pdfjs-dist/web/pdf_viewer.css'
import { usePendingSelectionStore } from '../../stores/pending-selection-store'
import { useNewCodeTriggerStore } from '../../stores/new-code-trigger-store'
import { useRememberedScroll } from '../../utils/use-remembered-scroll'
import { paneScrollKey, type SplitPane } from '../../utils/split-view'
import { SelectionMenuButton, boxSelectionAnchor, textSelectionAnchor } from './SelectionMenuButton'
import { ApplyCodeMenuList } from './ApplyCodeMenuList'
import { roundRegionToWholePixels } from '../../utils/region-rounding'
import { useTranslation } from 'react-i18next'
import { digitKey } from '../../utils/keys'
import { loadPdfjs, pdfParams } from '../../utils/pdfjs'
import { flattenCodesWithDepth } from '../../utils/code-tree'
import { draggedCodeGuids } from '../../utils/code-drag'
import { drawnText } from '../../utils/pdf-text-map'
import { moveCaret, type Caret } from '../../utils/text-caret'
import { areaKey, describeArea, revealArea } from '../../utils/area-keys'

function buildCodeMap(codes: Code[]): Map<string, Code> {
  const m = new Map<string, Code>()
  const walk = (list: Code[]) => { for (const c of list) { m.set(c.guid, c); walk(c.children) } }
  walk(codes)
  return m
}

/** The DOM point of drawn position `cp` in the pages' text layers (none
 *  if no page holds it). The reverse of resolveCp. */
function drawnPoint(container: HTMLElement, cp: number): { node: Node; offset: number } | null {
  for (const span of container.querySelectorAll<HTMLElement>('[data-cpoffset]')) {
    const start = parseInt(span.dataset.cpoffset!, 10)
    const chars = [...(span.textContent || '')]
    if (cp >= start && cp <= start + chars.length) {
      const node = span.firstChild ?? span
      return { node, offset: chars.slice(0, cp - start).join('').length }
    }
  }
  return null
}

/** Read by screen readers, not shown. */
const VISUALLY_HIDDEN: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, overflow: 'hidden',
  clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0
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
  /** Which half of a split view this is; each remembers its own place. */
  pane?: SplitPane
  /** The half the reader is working in: only it takes code hotkeys,
   *  mirrors its selection for the New Code dialog and follows quote /
   *  memo clicks. Always true when the document isn't split. */
  active?: boolean
  onActivate?: () => void
}

export function PdfDocumentViewer({ source, content, pane = 'primary', active = true, onActivate }: Props) {
  const { t } = useTranslation()
  const addSelection = useDocumentStore((s) => s.addSelection)
  const addCodingToSelection = useDocumentStore((s) => s.addCodingToSelection)
  const removeCoding = useDocumentStore((s) => s.removeCoding)
  const removeSelection = useDocumentStore((s) => s.removeSelection)
  const codes = useCodeStore((s) => s.codes)
  const findCode = useCodeStore((s) => s.findCode)
  const addMemo = useMemoStore((s) => s.addMemo)
  const removeMemo = useMemoStore((s) => s.removeMemo)
  const contentMemos = useMemoStore(useShallow((s) => s.getContentMemosForSource(source.guid)))
  const sourceQuotes = useQuoteStore(useShallow((s) => s.getQuotesForSource(source.guid)))
  // The PDF's text (`content`, where its passages are) and the text pdf.js
  // draws can differ (utils/pdf-text-map.ts): this viewer works in drawn
  // positions, and converts to and from the PDF's text at its edges.
  const pdfPageOffsetsOfText: number[] | undefined = source.formatData?.pdfPageOffsets
  const { map: textMap, pageOffsets } = useMemo(
    () => drawnText(source.guid, pdfPageOffsetsOfText || []),
    [source.guid, pdfPageOffsetsOfText]
  )
  const viewSelections = useMemo(
    () => source.selections.map((sel) => (sel.pdfRegion ? sel : {
      ...sel,
      startPosition: textMap.toView(sel.startPosition, 'start'),
      endPosition: textMap.toView(sel.endPosition, 'end')
    })),
    [source.selections, textMap]
  )
  const viewMemos = useMemo(
    () => contentMemos.map((m) => (m.pdfRegion || m.startPosition === undefined || m.endPosition === undefined ? m : {
      ...m,
      startPosition: textMap.toView(m.startPosition, 'start'),
      endPosition: textMap.toView(m.endPosition, 'end')
    })),
    [contentMemos, textMap]
  )
  const quoteRanges = useMemo(() =>
    sourceQuotes.map((q) => ({
      guid: q.guid,
      startCp: q.pdfRegion ? q.startPosition : textMap.toView(q.startPosition, 'start'),
      endCp: q.pdfRegion ? q.endPosition : textMap.toView(q.endPosition, 'end'),
      pdfRegion: q.pdfRegion
    })),
    [sourceQuotes, textMap]
  )
  /** A drawn span as positions in the PDF's text. */
  const toText = useCallback(
    (startCp: number, endCp: number) => ({ start: textMap.toDoc(startCp, 'start'), end: textMap.toDoc(endCp, 'end') }),
    [textMap]
  )
  /** The PDF's text a drawn span covers. */
  const textOf = useCallback((startCp: number, endCp: number) => {
    const { start, end } = toText(startCp, endCp)
    return [...content].slice(start, end).join('')
  }, [content, toText])

  const [pdfDocument, setPdfDocument] = useState<any>(null)
  const [pendingSelection, setPendingSelection] = useState<{ startCp: number; endCp: number; selectedText: string } | null>(null)
  // The keyboard's caret, in the PDF's text (see handleCaretKey below).
  const [pdfCaret, setPdfCaretState] = useState<Caret | null>(null)
  const pdfCaretRef = useRef<Caret | null>(null)
  const setPdfCaret = useCallback((c: Caret | null) => { pdfCaretRef.current = c; setPdfCaretState(c) }, [])
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
    if (!active) return
    if (pendingBoxSelection) {
      setGlobalPendingSelection({
        kind: 'region',
        sourceGuid: source.guid,
        pdfRegion: pendingBoxSelection.pdfRegion
      })
    } else if (pendingSelection) {
      const { start, end } = toText(pendingSelection.startCp, pendingSelection.endCp)
      setGlobalPendingSelection({ kind: 'text', sourceGuid: source.guid, ...pendingSelection, startCp: start, endCp: end })
    } else {
      setGlobalPendingSelection(null)
    }
  }, [active, pendingSelection, pendingBoxSelection, source.guid, setGlobalPendingSelection, toText])
  // A half of a split view that stops being active drops its selection, so
  // the New Code dialog can never code a stale selection in the other half.
  const wasActiveRef = useRef(active)
  useEffect(() => {
    if (wasActiveRef.current && !active) {
      setPendingSelection(null)
      setPendingBoxSelection(null)
      setBoxDrag(null)
      setContextMenu(null)
      setMenuHighlight(null)
      setGlobalPendingSelection(null)
    }
    wasActiveRef.current = active
  }, [active, setGlobalPendingSelection])

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
    if (!scrollTarget || !active) return
    if (scrollTarget.pdfRegion) {
      setPulseRegion(scrollTarget.pdfRegion)
      setPendingRegionScroll(scrollTarget.pdfRegion)
      if (pulseClearTimerRef.current) clearTimeout(pulseClearTimerRef.current)
      pulseClearTimerRef.current = setTimeout(() => setPulseRegion(null), 1600)
    } else if (scrollTarget.startCp < scrollTarget.endCp) {
      // Text quote — mirror the plain-text viewer: scroll to the range
      // and natively select it via lockedRange. No yellow overlay.
      const r = { startCp: textMap.toView(scrollTarget.startCp, 'start'), endCp: textMap.toView(scrollTarget.endCp, 'end') }
      setLockedRange(r)
      setPendingTextScroll(r)
    }
    clearScrollTarget()
  }, [scrollTarget, clearScrollTarget, active, textMap])

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

  // Return to the page the reader was on, once this document's pages have
  // laid out, unless a saved quote/memo click is taking them to a specific
  // spot. Saved as they scroll, so it also survives switching to a tool
  // tab (which unmounts this viewer) and reopening the project.
  const rememberScroll = useRememberedScroll(paneScrollKey(source.guid, pane), scrollContainerRef, {
    ready: allPagesRendered,
    skipRestore: !!(pendingRegionScroll || pendingTextScroll)
  })

  const codeMap = useMemo(() => buildCodeMap(codes), [codes])
  const flatCodes = useMemo(() => flattenCodesWithDepth(codes), [codes])
  const hotkeyMap = useMemo(() => {
    const map = new Map<number, Code>()
    for (const { code } of flatCodes) {
      if (code.hotkey !== undefined) map.set(code.hotkey, code)
    }
    return map
  }, [flatCodes])

  const numPages = pdfDocument ? pdfDocument.numPages : 0

  // Load PDF document. Two supported sources:
  //   1. formatData.pdfFilePath — temp-file path, bytes fetched via IPC
  //      (fast; no base64 decode, no huge IPC payload).
  //   2. formatData.pdfBase64 — legacy path for PDFs already in memory.
  // The PDF is reloaded only when where its bytes come from changes, not
  // when other formatData (page sizes, say) is filled in.
  const pdfFilePath: string | undefined = source.formatData?.pdfFilePath
  const pdfBase64: string | undefined = source.formatData?.pdfBase64
  useEffect(() => {
    if (!pdfFilePath && !pdfBase64) return
    let cancelled = false
    // pdf.js keeps each document (its bytes, fonts and page caches) in its
    // worker until the document is destroyed, so this run destroys what it
    // loaded when the viewer closes or the PDF changes; otherwise memory
    // grows with every PDF viewed.
    let loadingTask: { promise: Promise<any>; destroy: () => Promise<void> } | null = null

    const loadPdf = async () => {
      const pdfjsLib = await loadPdfjs()

      let bytes: Uint8Array
      if (pdfFilePath) {
        bytes = await window.api.readPdfFile(pdfFilePath)
      } else {
        const binary = atob(pdfBase64!)
        bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      }
      if (cancelled) return

      const task = pdfjsLib.getDocument(pdfParams(bytes))
      loadingTask = task
      const doc = await task.promise
      // If the viewer went away while this loaded, cleanup has already
      // destroyed the task, and with it this document.
      if (cancelled) return
      pagesRenderedCount.current = 0
      setAllPagesRendered(false)
      setPdfDocument(doc)
    }

    loadPdf().catch((err) => {
      // Destroying a task mid-load rejects its promise; that's expected.
      if (!cancelled) console.error(err)
    })
    return () => {
      cancelled = true
      // The pages stop drawing from this document before it goes.
      // Destroying the loading task destroys its document too, loaded yet
      // or not.
      setPdfDocument(null)
      if (loadingTask) void loadingTask.destroy()
    }
  }, [pdfBase64, pdfFilePath])

  const applyCodingToRange = useCallback(
    (codeGuid: string, drawnStart: number, drawnEnd: number, text: string) => {
      const { start: startCp, end: endCp } = toText(drawnStart, drawnEnd)
      const existingSel = source.selections.find(
        (s) => !s.pdfRegion && s.startPosition === startCp && s.endPosition === endCp
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
    [source, addSelection, addCodingToSelection, toText]
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
        const name = t('viewer.regionPage', { page: region.page })
        const selGuid = addSelection(source.guid, 0, 0, name, region)
        addCodingToSelection(source.guid, selGuid, codeGuid)
      }
      setPendingBoxSelection(null)
    },
    [source.selections, source.guid, addCodingToSelection, t, addSelection]
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
    setPendingSelection({ startCp: lo, endCp: hi, selectedText: textOf(lo, hi) })
    // The keyboard carries on from a mouse selection.
    const { start, end } = toText(lo, hi)
    setPdfCaret({ anchor: start, focus: end })
  }, [textOf, toText, setPdfCaret])

  // ── The keyboard's caret (as in a text document: utils/text-caret.ts) ──
  // It moves through the PDF's text; its selection is drawn on the page
  // (through textMap) as a real selection, which codes, menus and paste
  // act on as they do on a mouse selection.
  const docCps = useMemo(() => [...content], [content])
  const docLineStarts = useMemo(() => {
    const starts = [0]
    docCps.forEach((c, i) => { if (c === '\n') starts.push(i + 1) })
    return starts
  }, [docCps])
  const [caretBox, setCaretBox] = useState<{ left: number; top: number; height: number } | null>(null)
  const [caretFocused, setCaretFocused] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const hintId = useId()
  const handleCaretKey = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (selectionMode === 'box') {
      // Drawing an area (utils/area-keys.ts).
      const next = areaKey(e, e.currentTarget, pendingBoxSelection?.pdfRegion ?? null)
      if (!next) return
      e.preventDefault()
      setPendingBoxSelection({ pdfRegion: next })
      const container = e.currentTarget
      requestAnimationFrame(() => revealArea(next, container))
      setAnnouncement(describeArea(next, container, t))
      return
    }
    const current = pdfCaretRef.current ?? { anchor: 0, focus: 0 }
    const wasSelection = current.anchor !== current.focus
    let next: Caret
    let said = ''
    if (e.key === 'Escape' && wasSelection) {
      next = { anchor: current.focus, focus: current.focus }
    } else if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'a') {
      next = { anchor: 0, focus: docCps.length }
    } else {
      const moved = moveCaret(current, e, docCps, docLineStarts, getComputedStyle(e.currentTarget).direction === 'rtl')
      if (!moved) return
      next = moved.caret
      said = moved.passed
    }
    e.preventDefault()
    setPdfCaret(next)
    const start = Math.min(next.anchor, next.focus)
    const end = Math.max(next.anchor, next.focus)
    if (start !== end) {
      const vs = textMap.toView(start, 'start')
      const ve = textMap.toView(end, 'end')
      setPendingSelection({ startCp: vs, endCp: ve, selectedText: docCps.slice(start, end).join('') })
      if (e.shiftKey || e.key.toLowerCase() === 'a') {
        const chosen = docCps.slice(start, end).join('')
        said = t('viewer.selectedText', { text: chosen.length > 300 ? chosen.slice(0, 300) + '…' : chosen })
      }
    } else if (wasSelection) {
      setPendingSelection(null)
    }
    setAnnouncement(said)
  }, [selectionMode, pendingBoxSelection, docCps, docLineStarts, textMap, t, setPdfCaret])

  // Draw the caret's selection on the page, or the caret itself.
  useLayoutEffect(() => {
    const sc = scrollContainerRef.current
    if (!sc || !pdfCaret || !caretFocused) { setCaretBox(null); return }
    const start = Math.min(pdfCaret.anchor, pdfCaret.focus)
    const end = Math.max(pdfCaret.anchor, pdfCaret.focus)
    const a = drawnPoint(sc, textMap.toView(start, 'start'))
    const b = start === end ? a : drawnPoint(sc, textMap.toView(end, 'end'))
    if (!a || !b) { setCaretBox(null); return }
    const focusPoint = pdfCaret.focus === start ? a : b
    const holder = focusPoint.node.nodeType === Node.TEXT_NODE ? focusPoint.node.parentElement : (focusPoint.node as HTMLElement)
    holder?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const sel = window.getSelection()
    if (start === end) {
      sel?.removeAllRanges()
      const r = document.createRange()
      r.setStart(a.node, Math.min(a.offset, (a.node.textContent || '').length))
      r.collapse(true)
      const rect = r.getClientRects()[0] ?? holder?.getBoundingClientRect()
      if (!rect) { setCaretBox(null); return }
      const box = sc.getBoundingClientRect()
      setCaretBox({ left: rect.left - box.left + sc.scrollLeft, top: rect.top - box.top + sc.scrollTop, height: rect.height || 14 })
      return
    }
    setCaretBox(null)
    try {
      const r = document.createRange()
      r.setStart(a.node, a.offset)
      r.setEnd(b.node, b.offset)
      sel?.removeAllRanges()
      sel?.addRange(r)
    } catch { /* a point no page holds yet */ }
  }, [pdfCaret, caretFocused, textMap, allPagesRendered])

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
        ps = { startCp: lo, endCp: hi, selectedText: textOf(lo, hi) }
      }
    }
    if (!ps && pendingSelection) ps = pendingSelection
    // Box mode: use the pending box selection if no text selection exists.
    if (!ps && pendingBoxSelection) {
      const r = pendingBoxSelection.pdfRegion
      ps = {
        startCp: 0, endCp: 0,
        selectedText: t('viewer.regionPage', { page: r.page }),
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
      for (const sel2 of viewSelections) {
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
        ps = { startCp: 0, endCp: 0, selectedText: t('viewer.regionPage', { page: r.page }), pdfRegion: r }
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
      for (const m of viewMemos) {
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
  }, [pendingSelection, pendingBoxSelection, findPageEl, source, viewSelections, viewMemos, textOf, t, clientToPdfCoords, contentMemos])

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

  const handleCreateMemo = useCallback((drawnStart: number, drawnEnd: number, pdfRegion?: PdfRegionSelection) => {
    const { start, end } = pdfRegion ? { start: drawnStart, end: drawnEnd } : toText(drawnStart, drawnEnd)
    const guid = addMemo('content', '', { sourceGuid: source.guid, startPosition: start, endPosition: end, pdfRegion })
    const memo = useMemoStore.getState().findMemo(guid)
    if (memo) window.api.openMemoEditWindow({ memo, theme: document.documentElement.getAttribute('data-theme') || '' } as MemoEditInitData)
    setContextMenu(null)
  }, [source.guid, addMemo, toText])

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
        for (const cg of codeGuids) applyCodingToRange(cg, lo, hi, textOf(lo, hi))
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
  }, [pendingSelection, pendingBoxSelection, applyCodingToRange, applyCodingToRegion, textOf, source, addCodingToSelection, clientToPdfCoords, contentMemos])

  // Cmd/Ctrl + wheel zoom. Native addEventListener with passive:false so
  // preventDefault() actually stops the page-level scroll. Mirrors
  // the relationship map's wheel-zoom UX (MapCanvas).
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

  // Hotkeys + ESC handling (the active half of a split only)
  useEffect(() => {
    if (!active) return
    const handleKeyDown = (e: KeyboardEvent) => {
      // ESC: cancel box drag or pending box, or close context menu
      if (e.key === 'Escape') {
        if (boxDrag) { setBoxDrag(null); return }
        if (pendingBoxSelection) { setPendingBoxSelection(null); return }
        if (contextMenu) { setContextMenu(null); setMenuHighlight(null); return }
        return
      }
      if (!e.metaKey && !e.ctrlKey) return
      const digit = digitKey(e)
      if (digit === null) return
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
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [active, hotkeyMap, pendingSelection, pendingBoxSelection, applyCodingToRange, applyCodingToRegion, boxDrag, contextMenu, source.guid, source.name])

  return (
    <div
      ref={containerRef}
      style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}
      onMouseDownCapture={onActivate}
      onContextMenuCapture={onActivate}
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
      {pendingSelection && <SelectionMenuButton containerRef={containerRef} anchor={textSelectionAnchor} />}
      {pendingBoxSelection && <SelectionMenuButton containerRef={containerRef} anchor={boxSelectionAnchor} />}
      {/* Zoom and selection mode, in the document bar. In a split, the
          bar shows the tools of the active half. */}
      {active && (
        <DocumentToolbarPortal slot="start">
          <div className="zoom-strip">
            <button onClick={() => setZoom((z) => Math.max(0.25, z * 0.9))} title={t('viewer.zoomOut')}>−</button>
            <button className="zoom-reset" onClick={() => setZoom(1)} title={t('viewer.resetZoom')}>100%</button>
            <button onClick={() => setZoom((z) => Math.min(4, z * 1.1))} title={t('viewer.zoomIn')}>+</button>
            <button onClick={handleFit} title={t('viewer.fitWindow')}>{t('viewer.fit')}</button>
          </div>
          <div className="zoom-strip">
            <button
              onClick={() => { setSelectionMode('text'); setPendingBoxSelection(null); setBoxDrag(null) }}
              title={t('viewer.textSelection')}
              className={selectionMode === 'text' ? 'active' : ''}
              aria-pressed={selectionMode === 'text'}
            >
              <Icon icon={faICursor} />
            </button>
            <button
              onClick={() => { setSelectionMode('box'); setPendingSelection(null) }}
              title={t('viewer.boxSelection')}
              className={selectionMode === 'box' ? 'active' : ''}
              aria-pressed={selectionMode === 'box'}
            >
              <Icon icon={faCrosshairs} />
            </button>
          </div>
        </DocumentToolbarPortal>
      )}
      <div
        ref={scrollContainerRef}
        className="pdf-scroll-area"
        onScroll={rememberScroll}
        // The PDF's text takes the focus, for its keyboard caret.
        tabIndex={0}
        aria-describedby={hintId}
        onKeyDown={handleCaretKey}
        onFocus={(e) => { if (e.target === e.currentTarget) setCaretFocused(true) }}
        onBlur={(e) => { if (e.target === e.currentTarget) setCaretFocused(false) }}
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
                // Round to the same whole-pixel corners the writer will
                // round to on save — see region-rounding.ts.
                setPendingBoxSelection({ pdfRegion: { page: boxDrag.page, ...roundRegionToWholePixels(x, y, width, height) } })
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
          // Magnolia's menu replaces the system one (Look Up, Copy…),
          // which would otherwise open on top of it over selected text.
          e.preventDefault()
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
          const guids = draggedCodeGuids(e)
          if (guids.length > 0) handleDrop(guids, e.clientX, e.clientY)
        }}
      >
        {/* What the keyboard does here, what it just did, and where its
            caret is (not part of the text). */}
        <span id={hintId} style={VISUALLY_HIDDEN}>{t(selectionMode === 'box' ? 'viewer.areaKeysHint' : 'viewer.keyboardHint')}</span>
        <span aria-live="polite" style={VISUALLY_HIDDEN}>{announcement}</span>
        {caretBox && (
          <div
            aria-hidden="true"
            className="text-caret"
            style={{ position: 'absolute', left: caretBox.left, top: caretBox.top, height: caretBox.height, width: 2, background: 'var(--text-primary)', pointerEvents: 'none', zIndex: 5 }}
          />
        )}
        <div style={{ display: 'flex', alignItems: 'flex-start' }}>
          {/* PDF pages — takes available space */}
          <div ref={pagesContentRef} style={{ flexShrink: 0 }}>
            {!pdfDocument && (
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>{t('viewer.loadingPdf')}</div>
            )}
            {pdfDocument && Array.from({ length: numPages }, (_, i) => (
              <PdfPageRenderer
                key={i}
                pdfDocument={pdfDocument}
                pageNumber={i + 1}
                pageTextOffset={pageOffsets[i] || 0}
                scale={zoom}
                selections={viewSelections}
                codeMap={codeMap}
                contentMemos={viewMemos}
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
          <div style={{ flexShrink: 1, flexGrow: 0, flexBasis: 260, position: 'relative', marginInlineStart: 8, alignSelf: 'stretch', minWidth: 180 }}>
            <RichMarginColumn
          contentRef={pagesContentRef}
          containerRef={pagesContentRef}
          selections={viewSelections}
          codes={codes}
          contentMemos={viewMemos}
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
              title: t('viewer.quote'),
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
            {t('viewer.newCode')}
          </div>
          <div className="context-menu-separator" />
          {contextMenu.context.pendingSelection && (
            <>
              <div style={{ padding: '4px 14px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, userSelect: 'none' }}>{t('viewer.applyCode')}</div>
              <ApplyCodeMenuList codes={flatCodes} onApply={handleApplyCode} />
            </>
          )}
          {contextMenu.context.pendingSelection && contextMenu.context.existingCodings.length > 0 && <div className="context-menu-separator" />}
          {contextMenu.context.existingCodings.length > 0 && (
            <>
              <div style={{ padding: '4px 14px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, userSelect: 'none' }}>{t('viewer.removeCode')}</div>
              {contextMenu.context.existingCodings.map((ec) => {
                const code = findCode(ec.codeGuid)
                return (
                  <div key={ec.codingGuid} className="context-menu-item" style={{ color: 'var(--menu-fg-danger)' }}
                    onClick={() => handleRemoveCoding(ec.selectionGuid, ec.codingGuid)}
                    onMouseEnter={() => setMenuHighlight({ startCp: ec.startCp, endCp: ec.endCp })}
                    onMouseLeave={() => setMenuHighlight(null)}
                  >
                    <span className="color-pip" style={{ background: code?.color || '#888' }} />
                    {code?.name ?? t('common.unknown')}
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
                const q = ps.pdfRegion ? { start: ps.startCp, end: ps.endCp } : toText(ps.startCp, ps.endCp)
                useQuoteStore.getState().addQuote(source.guid, source.name, q.start, q.end, ps.selectedText, ps.pdfRegion)
                setPendingBoxSelection(null)
                setContextMenu(null)
              }}>{t('viewer.addAsQuote')}</div>
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
          }}>{t('viewer.addSelectionMemo')}</div>
          {contextMenu.context.overlappingMemos && contextMenu.context.overlappingMemos.length > 0 && (
            <>
              <div className="context-menu-separator" />
              <div style={{ padding: '4px 14px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, userSelect: 'none' }}>{t('viewer.deleteMemo')}</div>
              {contextMenu.context.overlappingMemos.map((m) => (
                <div key={m.guid} className="context-menu-item" style={{ color: 'var(--menu-fg-danger)' }}
                  onMouseEnter={() => setHoveredRange({ startCp: m.startCp, endCp: m.endCp })}
                  onMouseLeave={() => setHoveredRange(null)}
                  onClick={() => { removeMemo(m.guid); setContextMenu(null); setMenuHighlight(null) }}
                >
                  {m.title || t('memos.untitled')}
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
                  style={{ marginInlineEnd: 6, fontSize: 10, color: memoPopup.isQuote ? 'var(--quote-icon-color)' : undefined }}
                />
                <span style={{ flex: 1 }}>{m.title || (memoPopup.isQuote ? t('viewer.quote') : t('memos.untitled'))}</span>
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
                    {t('viewer.deleteNamed', { name: (m.title || t('viewer.quote')).slice(0, 20) })}
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
