/**
 * ImageDocumentViewer — single-image viewer with rectangle (box) coding.
 *
 * Mirrors PdfDocumentViewer's box-selection mode but trimmed to one page
 * and no text. Reuses:
 *   - The existing region-based PlainTextSelection (`pdfRegion`, page=1)
 *   - RichMarginColumn for code brackets, memo icons, quote icons, and
 *     the lock-on-click highlight mechanism
 *   - The store's addSelection / addCodingToSelection / removeCoding /
 *     removeSelection / addMemo / Quote APIs
 *
 * Coordinates throughout are image pixels with a top-left origin.
 */
import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { useDocumentStore } from '../../stores/document-store'
import { useCodeStore } from '../../stores/code-store'
import { useMemoStore } from '../../stores/memo-store'
import { useQuoteStore } from '../../stores/quote-store'
import { ImagePageRenderer } from './ImagePageRenderer'
import { RichMarginColumn } from './RichMarginColumn'
import { Icon, QUOTE_ICON, MEMO_POINT_ICON, MEMO_RANGED_ICON } from '../Icon'
import { ViewerZoomToolbar } from './ViewerZoomToolbar'
import type { CodingRightClickContext } from './CodedTextView'
import type { Code, Memo, MemoEditInitData, TextSource, PdfRegionSelection } from '../../models/types'
import { usePendingSelectionStore } from '../../stores/pending-selection-store'
import { useNewCodeTriggerStore } from '../../stores/new-code-trigger-store'
import { modKey } from '../../utils/platform'

// Horizontal space the right-hand RichMarginColumn + its 8-px gap actually
// occupy in the flex row. The margin column has flex-basis 260 plus an 8-px
// marginLeft, so 268 is the real footprint.
const MARGIN_COL_RESERVED_W = 268
const SCROLL_PADDING = 16
// Don't upscale tiny images past 1.0 on auto-fit — large QDA detail is
// usually preferred to a stretched, blurry blow-up.
const FIT_MAX_ZOOM = 1.0
// Hard zoom range users can reach via wheel / repeated 100% taps.
const MIN_ZOOM = 0.1
const MAX_ZOOM = 6

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

interface Props {
  source: TextSource
}

export function ImageDocumentViewer({ source }: Props) {
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

  // Image bytes → object URL for the <img>
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  useEffect(() => {
    const filePath = source.formatData?.imageFilePath as string | undefined
    if (!filePath) return
    let cancelled = false
    let url: string | null = null
    window.api.readImageFile(filePath).then((buffer) => {
      if (cancelled) return
      const blob = new Blob([buffer], { type: source.formatData?.mimeType || 'image/png' })
      url = URL.createObjectURL(blob)
      setImageUrl(url)
    }).catch(console.error)
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
      setImageUrl(null)
    }
  }, [source.formatData?.imageFilePath, source.formatData?.mimeType])

  // Box-mode state — same shape as PdfDocumentViewer but without per-page tracking.
  const [boxDrag, setBoxDrag] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null)
  const [pendingBoxSelection, setPendingBoxSelection] = useState<{ pdfRegion: PdfRegionSelection } | null>(null)

  // Mirror the box-region selection into the global pending-selection-
  // store so the New Code dialog can apply a freshly-created code to
  // the user's current box. Image documents have no text content, so
  // only the region path is wired here.
  const setGlobalPendingSelection = usePendingSelectionStore((s) => s.setSelection)
  useEffect(() => {
    if (pendingBoxSelection) {
      setGlobalPendingSelection({
        kind: 'region',
        sourceGuid: source.guid,
        pdfRegion: pendingBoxSelection.pdfRegion
      })
    } else {
      setGlobalPendingSelection(null)
    }
  }, [pendingBoxSelection, source.guid, setGlobalPendingSelection])
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; context: CodingRightClickContext } | null>(null)
  const [menuHighlight, setMenuHighlight] = useState<{ startCp: number; endCp: number } | null>(null)
  const [hoveredRange, setHoveredRange] = useState<{ startCp: number; endCp: number } | null>(null)
  const [lockedRange, setLockedRange] = useState<{ startCp: number; endCp: number } | null>(null)
  const [hoveredSelGuid, setHoveredSelGuid] = useState<string | null>(null)
  const [hoveredRegion, setHoveredRegion] = useState<PdfRegionSelection | null>(null)
  const [memoPopup, setMemoPopup] = useState<{ items: Memo[]; x: number; y: number; isQuote?: boolean; showDelete?: boolean } | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const pagesContentRef = useRef<HTMLDivElement>(null)
  // Flex-row wrapper (parent of both the image area and the margin
  // column). Passed to RichMarginColumn as containerRef so bracket Y
  // coordinates are computed relative to the flex row rather than the
  // centred image wrapper — otherwise the vertical-centring offset is
  // invisible to the bracket math and the brackets sit above the image.
  const flexRowRef = useRef<HTMLDivElement>(null)
  const [imageLoaded, setImageLoaded] = useState(false)

  // Scroll-to-region: when a user single-clicks a box quote in the Saved
  // Quotes pane, the store sets scrollTarget with the quote's pdfRegion.
  // We park it and scroll once the image is loaded so the page DOM exists.
  const scrollTarget = useDocumentStore((s) => s.scrollTarget)
  const clearScrollTarget = useDocumentStore((s) => s.clearScrollTarget)
  const [pendingRegionScroll, setPendingRegionScroll] = useState<PdfRegionSelection | null>(null)
  const [pulseRegion, setPulseRegion] = useState<PdfRegionSelection | null>(null)
  // The pulse-clear timer lives in a ref so it survives the immediate
  // re-run of this effect caused by clearScrollTarget() below. Otherwise
  // React's cleanup would cancel the timer, pulseRegion would never reset,
  // and any later overlay rebuild (e.g. from a hover) would replay the
  // pulse animation on every click.
  const pulseClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!scrollTarget) return
    if (scrollTarget.pdfRegion) {
      setPendingRegionScroll(scrollTarget.pdfRegion)
      setPulseRegion(scrollTarget.pdfRegion)
      if (pulseClearTimerRef.current) clearTimeout(pulseClearTimerRef.current)
      pulseClearTimerRef.current = setTimeout(() => setPulseRegion(null), 1600)
    }
    clearScrollTarget()
  }, [scrollTarget, clearScrollTarget])
  useEffect(() => {
    if (!pendingRegionScroll) return
    const sc = scrollContainerRef.current
    if (!sc) return
    const pageEl = sc.querySelector<HTMLElement>('[data-pdf-page="1"]')
    if (!pageEl) return
    const pageScale = parseFloat(pageEl.dataset.pdfScale || '1') || 1
    const scRect = sc.getBoundingClientRect()
    const pageRect = pageEl.getBoundingClientRect()
    const regionTopInSc = (pageRect.top - scRect.top) + sc.scrollTop + pendingRegionScroll.y * pageScale
    const regionCenterY = regionTopInSc + (pendingRegionScroll.height * pageScale) / 2
    sc.scrollTo({ top: Math.max(0, regionCenterY - sc.clientHeight / 2), behavior: 'smooth' })
    // Also centre horizontally when the image is wider than the viewport.
    const regionLeftInSc = (pageRect.left - scRect.left) + sc.scrollLeft + pendingRegionScroll.x * pageScale
    const regionCenterX = regionLeftInSc + (pendingRegionScroll.width * pageScale) / 2
    sc.scrollTo({
      top: Math.max(0, regionCenterY - sc.clientHeight / 2),
      left: Math.max(0, regionCenterX - sc.clientWidth / 2),
      behavior: 'smooth'
    })
    setPendingRegionScroll(null)
  }, [pendingRegionScroll, imageLoaded])

  // Zoom state. Initialised to 1.0; replaced with a fit-to-window scale as
  // soon as the image's natural dimensions are known. Reset whenever the
  // user opens a different image source.
  const [zoom, setZoom] = useState(1)
  useEffect(() => {
    setZoom(1)
    setImageLoaded(false)
  }, [source.guid])

  /** Compute a zoom that fits the image's natural size into the visible
   *  area of the scroll container, leaving room for the margin column.
   *  Capped at FIT_MAX_ZOOM so small images don't upscale into a blur. */
  const computeFitZoom = useCallback((naturalW: number, naturalH: number): number => {
    const el = scrollContainerRef.current
    if (!el || naturalW <= 0 || naturalH <= 0) return 1
    const availW = Math.max(1, el.clientWidth - SCROLL_PADDING * 2 - MARGIN_COL_RESERVED_W)
    const availH = Math.max(1, el.clientHeight - SCROLL_PADDING * 2)
    return Math.min(availW / naturalW, availH / naturalH, FIT_MAX_ZOOM)
  }, [])

  const handleImageLoad = useCallback((naturalW: number, naturalH: number) => {
    setImageLoaded(true)
    setZoom(computeFitZoom(naturalW, naturalH))
  }, [computeFitZoom])

  /** Re-fit the image to the current container size. Pulls natural
   *  dimensions off the rendered <img>, so it stays accurate after a
   *  window resize even though the original load-time fit didn't. */
  const handleFit = useCallback(() => {
    const img = pagesContentRef.current?.querySelector('img') as HTMLImageElement | null
    if (!img || !img.naturalWidth || !img.naturalHeight) return
    setZoom(computeFitZoom(img.naturalWidth, img.naturalHeight))
  }, [computeFitZoom])

  // Cmd/Ctrl + wheel zoom — same multiplicative-step UX as RelationshipMap.
  // Native addEventListener with passive:false so preventDefault works.
  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const handler = (e: WheelEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const delta = -e.deltaY * 0.005
      setZoom((z) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z + delta * z)))
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])

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

  /** Convert client mouse coords into image-pixel coords on the page. */
  const clientToImageCoords = useCallback((clientX: number, clientY: number, pageEl: HTMLElement) => {
    const scale = parseFloat(pageEl.dataset.pdfScale || '1') || 1
    const rect = pageEl.getBoundingClientRect()
    const x = (clientX - rect.left) / scale
    const y = (clientY - rect.top) / scale
    return { x, y }
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
        const name = `Region`
        const selGuid = addSelection(source.guid, 0, 0, name, region)
        addCodingToSelection(source.guid, selGuid, codeGuid)
      }
      setPendingBoxSelection(null)
    },
    [source, addSelection, addCodingToSelection]
  )

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    let ps: CodingRightClickContext['pendingSelection'] | undefined
    if (pendingBoxSelection) {
      const r = pendingBoxSelection.pdfRegion
      ps = { startCp: 0, endCp: 0, selectedText: 'Region', pdfRegion: r }
    }

    // Box hit-test — find any coded OR memo region under the click point.
    // Smaller regions win on overlap (most specific).
    const pageEl = findPageEl(e.target)
    let hitX = 0
    let hitY = 0
    const existingCodings: CodingRightClickContext['existingCodings'] = []
    const overlappingMemos: CodingRightClickContext['overlappingMemos'] = []
    if (pageEl) {
      const coords = clientToImageCoords(e.clientX, e.clientY, pageEl)
      hitX = coords.x
      hitY = coords.y
      const regionContains = (r: { page: number; x: number; y: number; width: number; height: number }): boolean =>
        r.page === 1 && hitX >= r.x && hitX <= r.x + r.width && hitY >= r.y && hitY <= r.y + r.height

      const boxCandidates = source.selections
        .filter((s) => s.pdfRegion && regionContains(s.pdfRegion))
        .sort((a, b) => (a.pdfRegion!.width * a.pdfRegion!.height) - (b.pdfRegion!.width * b.pdfRegion!.height))
      // If no explicit selection is pending, treat the smallest hit box as the
      // implicit target so "Add Selection Memo" / "Add as Quote" attach to the
      // same region as the existing coding.
      if (!ps && boxCandidates.length > 0) {
        const r = boxCandidates[0].pdfRegion!
        ps = { startCp: 0, endCp: 0, selectedText: 'Region', pdfRegion: r }
      }
      for (const sel2 of boxCandidates) {
        for (const coding of sel2.codings) {
          existingCodings.push({
            selectionGuid: sel2.guid, codingGuid: coding.guid, codeGuid: coding.codeGuid,
            startCp: sel2.startPosition, endCp: sel2.endPosition
          })
        }
      }

      const boxMemos = (contentMemos || []).filter((m) =>
        m.pdfRegion && m.pdfRegion.page === 1 &&
        hitX >= m.pdfRegion.x && hitX <= m.pdfRegion.x + m.pdfRegion.width &&
        hitY >= m.pdfRegion.y && hitY <= m.pdfRegion.y + m.pdfRegion.height
      ).sort((a, b) => (a.pdfRegion!.width * a.pdfRegion!.height) - (b.pdfRegion!.width * b.pdfRegion!.height))
      for (const m of boxMemos) {
        overlappingMemos.push({ guid: m.guid, title: m.title, startCp: m.startPosition ?? 0, endCp: m.endPosition ?? m.startPosition ?? 0 })
      }
    }

    // Pin the click position so "Add Selection Memo" with no selection
    // creates a point memo at exactly that spot.
    const pdfPoint = !ps && pageEl
      ? { page: 1, x: hitX, y: hitY }
      : undefined

    if (ps || existingCodings.length > 0 || overlappingMemos.length > 0 || source) {
      setContextMenu({ x: e.clientX, y: e.clientY, context: { existingCodings, pendingSelection: ps, pdfPoint, overlappingMemos } })
    }
  }, [pendingBoxSelection, source, contentMemos, clientToImageCoords, findPageEl])

  const handleApplyCode = useCallback((codeGuid: string) => {
    if (!contextMenu?.context.pendingSelection) return
    const ps = contextMenu.context.pendingSelection
    if (ps.pdfRegion) applyCodingToRegion(codeGuid, ps.pdfRegion)
    setContextMenu(null); setMenuHighlight(null)
  }, [contextMenu, applyCodingToRegion])

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
  //   1. Pending BOX selection — user drew a box before drag.
  //   2. Drop on an existing box coding → add codes to that box.
  //   3. Drop on a memo-only box region → create a coded selection using
  //      the memo's box.
  const handleDrop = useCallback((codeGuids: string[], dropClientX?: number, dropClientY?: number) => {
    if (pendingBoxSelection) {
      for (const cg of codeGuids) applyCodingToRegion(cg, pendingBoxSelection.pdfRegion)
      return
    }

    if (dropClientX !== undefined && dropClientY !== undefined) {
      const pageEl = document.elementFromPoint(dropClientX, dropClientY) as HTMLElement | null
      let page: HTMLElement | null = pageEl
      while (page && !page.dataset?.pdfPage) page = page.parentElement
      if (page) {
        const { x, y } = clientToImageCoords(dropClientX, dropClientY, page)
        const containsPoint = (r: { page: number; x: number; y: number; width: number; height: number }): boolean =>
          r.page === 1 && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height

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

        const memoCandidates = (contentMemos || [])
          .filter((m): m is typeof m & { pdfRegion: NonNullable<typeof m.pdfRegion> } => !!m.pdfRegion && containsPoint(m.pdfRegion))
          .sort((a, b) => (a.pdfRegion.width * a.pdfRegion.height) - (b.pdfRegion.width * b.pdfRegion.height))
        if (memoCandidates.length > 0) {
          const memo = memoCandidates[0]
          for (const cg of codeGuids) applyCodingToRegion(cg, memo.pdfRegion)
        }
      }
    }
  }, [pendingBoxSelection, applyCodingToRegion, source, addCodingToSelection, clientToImageCoords, contentMemos])

  // Hotkeys + ESC handling
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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
      if (pendingBoxSelection) {
        e.preventDefault()
        applyCodingToRegion(code.guid, pendingBoxSelection.pdfRegion)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [hotkeyMap, pendingBoxSelection, applyCodingToRegion, boxDrag, contextMenu])

  return (
    <div
      ref={containerRef}
      style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}
      onMouseDown={(e) => {
        if (contextMenu && !(e.target as HTMLElement).closest('.context-menu')) {
          setContextMenu(null); setMenuHighlight(null)
        }
        // Clear margin-column lock when clicking outside a margin label /
        // popup, matching the plain-text + PDF viewer behavior.
        if (lockedRange) {
          const t = e.target as HTMLElement
          if (!t.closest('.context-menu') && !t.closest('[data-margin-label="1"]')) {
            setLockedRange(null)
            setHoveredRange(null)
          }
        }
      }}
    >
      {/* Top control bar — connected zoom strip mirroring the PDF viewer
          and the mockup's button group. */}
      <div className="viewer-toolbar">
        <div className="zoom-strip">
          <button onClick={() => setZoom((z) => Math.max(0.1, z * 0.9))} title="Zoom out">−</button>
          <button onClick={() => setZoom(1)} title="Reset to 100%">100%</button>
          <button onClick={() => setZoom((z) => Math.min(6, z * 1.1))} title="Zoom in">+</button>
          <button onClick={handleFit} title="Fit to window">Fit</button>
        </div>
        <span className="viewer-spacer" />
        <span className="viewer-meta">Image</span>
      </div>
      <div
        ref={scrollContainerRef}
        className="image-scroll-area"
        style={{
          flex: 1, overflowY: 'auto', overflowX: 'auto',
          background: 'var(--bg-panel)', padding: '16px', position: 'relative',
          cursor: 'crosshair',
          userSelect: 'none'
        }}
        onMouseUp={(e) => {
          if (boxDrag) {
            const pageEl = scrollContainerRef.current?.querySelector(`[data-pdf-page="1"]`) as HTMLElement | null
            if (pageEl) {
              const coords = clientToImageCoords(e.clientX, e.clientY, pageEl)
              const x = Math.min(boxDrag.startX, coords.x)
              const y = Math.min(boxDrag.startY, coords.y)
              const width = Math.abs(coords.x - boxDrag.startX)
              const height = Math.abs(coords.y - boxDrag.startY)
              if (width >= 5 && height >= 5) {
                setPendingBoxSelection({ pdfRegion: { page: 1, x, y, width, height } })
              }
            }
            setBoxDrag(null)
          }
        }}
        onMouseDown={(e) => {
          if (e.button !== 0) return
          const pageEl = findPageEl(e.target)
          if (!pageEl) return
          const coords = clientToImageCoords(e.clientX, e.clientY, pageEl)
          setBoxDrag({ startX: coords.x, startY: coords.y, currentX: coords.x, currentY: coords.y })
          setPendingBoxSelection(null)
          e.preventDefault()
        }}
        onMouseMove={(e) => {
          if (boxDrag) {
            const pageEl = scrollContainerRef.current?.querySelector(`[data-pdf-page="1"]`) as HTMLElement | null
            if (!pageEl) return
            const scale = parseFloat(pageEl.dataset.pdfScale || '1') || 1
            const rect = pageEl.getBoundingClientRect()
            const cx = Math.max(0, Math.min((e.clientX - rect.left) / scale, rect.width / scale))
            const cy = Math.max(0, Math.min((e.clientY - rect.top) / scale, rect.height / scale))
            setBoxDrag((prev) => prev ? { ...prev, currentX: cx, currentY: cy } : null)
          }
        }}
        onContextMenu={(e) => {
          if (boxDrag) { setBoxDrag(null); e.preventDefault(); return }
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
          const multiData = e.dataTransfer.getData('application/x-magnolia-codes')
          if (multiData) { try { handleDrop(JSON.parse(multiData).map((c: any) => c.guid), e.clientX, e.clientY) } catch {} return }
          const data = e.dataTransfer.getData('application/x-magnolia-code')
          if (data) { try { handleDrop([JSON.parse(data).guid], e.clientX, e.clientY) } catch {} }
        }}
      >
        {/* Outer flex row fills the scroll container's inner area. A
            flex:1 image-area (left) and a fixed-width margin column (right)
            sit side by side. The image-area centres the image on both
            axes within its allocation, so a fit-to-window image is
            actually centred in the available viewing space rather than
            hugging the left edge of a margin:auto group. `flex-basis:
            auto` + `flex-shrink: 0` on the image-area means it grows
            with content when the user zooms in, letting the scroll
            container expose the overflow from (0,0). `flexRowRef` is
            passed to RichMarginColumn as its coordinate reference so
            bracket Y values include the image's vertical centring
            offset — without that, the image floats down while the
            margin column stays top-anchored and the brackets would
            appear above the coded regions. */}
        <div ref={flexRowRef} style={{ minWidth: '100%', minHeight: '100%', display: 'flex', alignItems: 'center' }}>
          <div style={{ flexGrow: 1, flexShrink: 0, flexBasis: 'auto', display: 'flex', justifyContent: 'center', alignItems: 'center', minWidth: 0 }}>
          <div ref={pagesContentRef} style={{ flexShrink: 0 }}>
            {!imageUrl && (
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading image…</div>
            )}
            {imageUrl && (
              <ImagePageRenderer
                imageUrl={imageUrl}
                scale={zoom}
                selections={source.selections}
                codeMap={codeMap}
                contentMemos={contentMemos}
                hoveredSelGuid={hoveredSelGuid}
                hoveredRegion={hoveredRegion}
                pulseRegion={pulseRegion}
                boxDragPreview={boxDrag}
                pendingBoxRegion={pendingBoxSelection?.pdfRegion ?? null}
                onMemoDoubleClick={(memoGuid) => {
                  const memo = useMemoStore.getState().findMemo(memoGuid)
                  if (memo) window.api.openMemoEditWindow({ memo, theme: document.documentElement.getAttribute('data-theme') || '' } as MemoEditInitData)
                }}
                onMemoMove={(memoGuid, x, y) => {
                  const memo = useMemoStore.getState().findMemo(memoGuid)
                  if (!memo || !memo.pdfRegion) return
                  useMemoStore.getState().updateMemo({
                    ...memo,
                    pdfRegion: { ...memo.pdfRegion, x, y }
                  })
                }}
                onLoad={handleImageLoad}
              />
            )}
          </div>
          </div>
          <div style={{ flexShrink: 1, flexGrow: 0, flexBasis: 260, position: 'relative', marginLeft: 8, alignSelf: 'stretch', minWidth: 180 }}>
            <RichMarginColumn
              contentRef={pagesContentRef}
              containerRef={flexRowRef}
              selections={source.selections}
              codes={codes}
              contentMemos={contentMemos}
              quotes={quoteRanges}
              rendered={imageLoaded}
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
          {/* New Code — always at the top. Auto-applies the new code to
              the current text/region selection via handleCreateCode. */}
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
            // Point memo: encoded as a 0×0 region so the existing pdfRegion
            // plumbing carries it; the page renderer draws a circular icon.
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

      {/* Memo / quote popup — matches PdfDocumentViewer exactly */}
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
