/**
 * RichMarginColumn — renders vertical code bracket lines with code name labels,
 * memo icons, and quote icons alongside rich text content.
 *
 * Matches the plain text CodedTextView margin column exactly:
 * - Vertical bars with top/bottom caps pointing left
 * - Code name labels at the start of each bracket
 * - Quote icon column (18px) with badge count
 * - Memo icon column (18px) with badge count
 */
import { useEffect, useRef, useState } from 'react'
import type { PlainTextSelection, Code, Memo } from '../../models/types'
import { layoutBrackets, capGeometry, COL_W, LABEL_H, LABEL_GAP } from './bracketLayout'
import { CodeLabel } from './CodeLabel'
import { layoutIcons, buildIconItems, ICON_COL_W, LINE_GROUP_TOLERANCE, type IconGroup } from './iconLayout'
import { MemoQuoteIcons } from './MemoQuoteIcons'
import { useMemoStore } from '../../stores/memo-store'
import { measureLabelWidth } from '../../utils/measure-text'

interface CpRange { startCp: number; endCp: number }

interface Props {
  contentRef: React.RefObject<HTMLDivElement>
  containerRef: React.RefObject<HTMLDivElement>
  selections: PlainTextSelection[]
  codes: Code[]
  contentMemos?: Memo[]
  quotes?: { guid: string; startCp: number; endCp: number; pdfRegion?: import('../../models/types').PdfRegionSelection }[]
  rendered: boolean
  onMemoClick?: (memoGuid: string) => void
  onMemoPopup?: (e: React.MouseEvent, memos: Memo[]) => void
  onHoverRange?: (range: CpRange | null) => void
  onHoverSelectionGuid?: (guid: string | null) => void
  /** Forwarded to MemoQuoteIcons — fired when the user hovers a memo /
   *  quote icon whose underlying item has a pdfRegion. Image + PDF
   *  viewers use this to highlight the box on the page. */
  onHoverRegion?: (region: import('../../models/types').PdfRegionSelection | null) => void
  onLockRange?: (range: CpRange | null) => void
  lockedRange?: CpRange | null
  onContextMenu?: (e: React.MouseEvent, context: {
    existingCodings?: { selectionGuid: string; codingGuid: string; codeGuid: string; startCp: number; endCp: number }[]
    overlappingMemos?: { guid: string; title: string; startCp: number; endCp: number }[]
  }) => void
  onQuoteClick?: (e: React.MouseEvent, quotes: { guid: string; startCp: number; endCp: number }[], showDelete?: boolean) => void
  alignRight?: boolean
  /** The true scroll viewport (not the pages/image content box, which
   *  only spans its own natural size). Used solely to let code-name
   *  labels paint into whatever blank space sits between the content
   *  and the pane's real right edge — the column's own reserved layout
   *  width (preferredW, below) is untouched by this. */
  viewportRef?: React.RefObject<HTMLDivElement>
}

interface CodeBracket {
  top: number
  height: number
  color: string
  codeName: string
  column: number
  labelTop: number
  /** Left offset for the code-name label, in px from the margin's left edge.
   *  Sits just after the rightmost bracket column that vertically overlaps
   *  this label's Y range. */
  labelLeft: number
  /** Column the top cap extends leftward to (usually the innermost empty
   *  column at this bracket's top Y). Equals `column` when no extension. */
  topCapTargetCol: number
  /** Column the bottom cap extends leftward to, similarly. */
  bottomCapTargetCol: number
  codeGuid: string
  selectionGuid: string
  codingGuid: string
  selStartCp: number
  selEndCp: number
  isRegion: boolean
}

// Bracket column geometry is shared via bracketLayout.ts. Icon geometry
// is shared via iconLayout.ts.
/** Historical default / minimum for the label column. */
const LABEL_W = 80
/** Small horizontal breathing room between a code label and the icon(s)
 *  that follow it on the same row. */
const LABEL_TO_ICON_GAP = 4
/** Breathing room kept clear between a fully-expanded label and the true
 *  right edge of the pane. */
const LABEL_EDGE_PAD = 8

/**
 * For each icon group, compute the X offset at which it should render so
 * that it sits immediately right of any overlapping bracket label (or
 * bracket bar if the label lives on a different row). Two icon groups
 * that share a Y band (quote + memo on the same line) get stacked: the
 * memo is pushed right by ICON_COL_W.
 */
function computeIconLefts(
  groups: IconGroup[],
  brackets: { top: number; height: number; column: number; labelTop: number; labelLeft: number; codeName: string }[],
  labelMaxWidthFor: (labelLeft: number) => number
): IconGroup[] {
  if (groups.length === 0) return groups
  // Pre-measure each bracket's label width once (canvas measurement is cheap).
  const labelRights = brackets.map((b) => b.labelLeft + Math.min(labelMaxWidthFor(b.labelLeft), measureLabelWidth(b.codeName)))

  const baseLeftFor = (iconTop: number): number => {
    let x = 0
    const iconBot = iconTop + LABEL_H
    for (let i = 0; i < brackets.length; i++) {
      const b = brackets[i]
      const labelBot = b.labelTop + LABEL_H
      const barBot = b.top + b.height
      const labelOverlaps = b.labelTop < iconBot && labelBot > iconTop
      if (labelOverlaps) {
        // Label on this row — sit just past its rendered end.
        x = Math.max(x, labelRights[i] + LABEL_TO_ICON_GAP)
        continue
      }
      const barOverlaps = b.top < iconBot && barBot > iconTop
      if (barOverlaps) {
        // Bar only — label is on a different row; sit just past the bar's column.
        x = Math.max(x, (b.column + 1) * COL_W + LABEL_GAP)
      }
    }
    return x
  }

  // Pair memo groups with quotes on the same row so the memo sits to
  // the right of the quote (matches the old stacked-column layout).
  return groups.map((g) => {
    let left = baseLeftFor(g.top)
    if (g.type === 'memo') {
      const matchingQuote = groups.find(
        (q) => q.type === 'quote' && Math.abs(q.top - g.top) < LINE_GROUP_TOLERANCE
      )
      if (matchingQuote) left += ICON_COL_W
    }
    return { ...g, leftX: left }
  })
}

function buildCodeMap(codes: Code[]): Map<string, Code> {
  const m = new Map<string, Code>()
  const walk = (list: Code[]) => { for (const c of list) { m.set(c.guid, c); walk(c.children) } }
  walk(codes)
  return m
}

function collectTextNodes(container: HTMLElement): { node: Text; cpStart: number; cpEnd: number }[] {
  const result: { node: Text; cpStart: number; cpEnd: number }[] = []
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode()) !== null) {
    let el: HTMLElement | null = node.parentElement
    while (el && el !== container && (!el.dataset || el.dataset.cpoffset === undefined)) {
      el = el.parentElement
    }
    if (!el || el.dataset?.cpoffset === undefined) continue
    const baseCp = parseInt(el.dataset.cpoffset, 10)
    let cpBefore = 0
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let tn: Node | null
    while ((tn = tw.nextNode()) !== null) {
      if (tn === node) break
      cpBefore += [...(tn.textContent || '')].length
    }
    const nodeCps = [...(node.textContent || '')].length
    result.push({ node: node as Text, cpStart: baseCp + cpBefore, cpEnd: baseCp + cpBefore + nodeCps })
  }
  return result
}

function getRangeYBounds(
  contentEl: HTMLElement,
  containerEl: HTMLElement,
  cpStart: number,
  cpEnd: number,
  textNodes: { node: Text; cpStart: number; cpEnd: number }[]
): { top: number; bottom: number } | null {
  let minTop = Infinity
  let maxBottom = -Infinity

  for (const tn of textNodes) {
    if (cpEnd <= tn.cpStart || cpStart >= tn.cpEnd) continue
    const overlapStart = Math.max(cpStart, tn.cpStart) - tn.cpStart
    const overlapEnd = Math.min(cpEnd, tn.cpEnd) - tn.cpStart
    const chars = [...(tn.node.textContent || '')]

    let charStart = 0
    for (let i = 0; i < overlapStart && i < chars.length; i++) charStart += chars[i].length
    let charEnd = 0
    for (let i = 0; i < overlapEnd && i < chars.length; i++) charEnd += chars[i].length

    if (charStart >= charEnd) continue

    try {
      const range = document.createRange()
      range.setStart(tn.node, charStart)
      range.setEnd(tn.node, charEnd)
      const rects = range.getClientRects()
      for (let i = 0; i < rects.length; i++) {
        minTop = Math.min(minTop, rects[i].top)
        maxBottom = Math.max(maxBottom, rects[i].bottom)
      }
    } catch { /* ignore */ }
  }

  if (minTop === Infinity) return null

  const containerRect = containerEl.getBoundingClientRect()
  const PAD = 2
  return {
    top: minTop - containerRect.top + containerEl.scrollTop - PAD,
    bottom: maxBottom - containerRect.top + containerEl.scrollTop + PAD
  }
}

/**
 * For region-based PDF selections: look up the page element by
 * `data-pdf-page` and compute the vertical bounds of the region rectangle
 * in the scroll container's coordinate space. Uses the `data-pdf-scale`
 * attribute the page renderer stamps on its root.
 */
function getPdfRegionYBounds(
  containerEl: HTMLElement,
  region: { page: number; x: number; y: number; width: number; height: number }
): { top: number; bottom: number } | null {
  const pageEl = containerEl.querySelector<HTMLElement>(`[data-pdf-page="${region.page}"]`)
  if (!pageEl) return null
  const scale = parseFloat(pageEl.dataset.pdfScale || '1') || 1
  const containerRect = containerEl.getBoundingClientRect()
  const pageRect = pageEl.getBoundingClientRect()
  const top = pageRect.top - containerRect.top + containerEl.scrollTop + region.y * scale
  const bottom = top + region.height * scale
  const PAD = 2
  return { top: top - PAD, bottom: bottom + PAD }
}

export function RichMarginColumn({ contentRef, containerRef, selections, codes, contentMemos, quotes, rendered, onMemoClick, onMemoPopup, onHoverRange, onHoverSelectionGuid, onHoverRegion, onLockRange, lockedRange, onContextMenu, onQuoteClick, alignRight, viewportRef }: Props) {
  const [brackets, setBrackets] = useState<CodeBracket[]>([])
  // This column's own root div — measured against viewportRef so labels
  // know how far they can paint into blank space beyond the column's own
  // reserved width, without that reserved width itself changing.
  const columnRef = useRef<HTMLDivElement>(null)
  const [measureTick, setMeasureTick] = useState(0)
  useEffect(() => {
    const viewportEl = viewportRef?.current
    const contentEl = contentRef.current
    if (!viewportEl && !contentEl) return
    const observer = new ResizeObserver(() => setMeasureTick((t) => t + 1))
    if (viewportEl) observer.observe(viewportEl)
    // Also watch the actual image/PDF content box — when the viewer
    // centers it in extra space (e.g. ImageDocumentViewer at a small
    // zoom in a wide pane), the viewport itself doesn't resize on zoom,
    // but the content box does, and that's what flushShiftPx depends on.
    if (contentEl) observer.observe(contentEl)
    return () => observer.disconnect()
  }, [viewportRef, contentRef])
  // How far the column's own box sits to the right of the actual content
  // (image / PDF pages) it's supposed to be flush against. Non-zero only
  // when a centering wrapper (like ImageDocumentViewer's) leaves blank
  // space between the content and this column's nominal position.
  const flushShiftPx = (() => {
    const columnRect = columnRef.current?.getBoundingClientRect()
    const contentRect = contentRef.current?.getBoundingClientRect()
    if (!columnRect || !contentRect) return 0
    return Math.max(0, columnRect.left - (contentRect.right + 8))
  })()
  const labelMaxWidthFor = (labelLeft: number): number => {
    const columnRect = columnRef.current?.getBoundingClientRect()
    const viewportRect = viewportRef?.current?.getBoundingClientRect()
    if (!columnRect || !viewportRect) return LABEL_W
    const available = viewportRect.right - (columnRect.left - flushShiftPx + labelLeft) - LABEL_EDGE_PAD
    return Math.max(LABEL_W, available)
  }
  const [iconGroups, setIconGroups] = useState<IconGroup[]>([])
  const codeMap = buildCodeMap(codes)

  useEffect(() => {
    if (!rendered || !contentRef.current || !containerRef.current) return

    const timer = setTimeout(() => {
      if (!contentRef.current || !containerRef.current) return
      const textNodes = collectTextNodes(contentRef.current)
      const newBrackets: CodeBracket[] = []

      // --- Code brackets ---
      // Build per-(selection, coding) inputs, then delegate the placement
      // algorithm to the shared bracketLayout helper so the behavior here
      // matches CodedTextView exactly.
      interface Entry {
        top: number; bottom: number; color: string; codeName: string
        codeGuid: string; selectionGuid: string; codingGuid: string
        selStartCp: number; selEndCp: number; isRegion: boolean
      }
      const entries: Entry[] = []

      for (const sel of selections) {
        if (sel.codings.length === 0) continue

        // Region-based selections: measure against the PDF page element
        // instead of walking text-node cpoffsets.
        let bounds: { top: number; bottom: number } | null
        if (sel.pdfRegion) {
          bounds = getPdfRegionYBounds(containerRef.current!, sel.pdfRegion)
        } else {
          bounds = getRangeYBounds(contentRef.current!, containerRef.current!, sel.startPosition, sel.endPosition, textNodes)
        }
        if (!bounds) continue

        for (const coding of sel.codings) {
          const code = codeMap.get(coding.codeGuid)
          if (!code) continue
          entries.push({
            top: bounds.top, bottom: bounds.bottom,
            color: code.color || '#888', codeName: code.name,
            codeGuid: code.guid, selectionGuid: sel.guid,
            codingGuid: coding.guid,
            selStartCp: sel.startPosition, selEndCp: sel.endPosition,
            isRegion: !!sel.pdfRegion
          })
        }
      }

      const placed = layoutBrackets(entries)
      for (const p of placed) {
        newBrackets.push({
          top: p.top,
          height: p.bottom - p.top,
          color: p.color,
          codeName: p.codeName,
          column: p.column,
          labelTop: p.labelTop,
          labelLeft: p.labelLeft,
          topCapTargetCol: p.topCapTargetCol,
          bottomCapTargetCol: p.bottomCapTargetCol,
          codeGuid: p.codeGuid,
          selectionGuid: p.selectionGuid,
          codingGuid: p.codingGuid,
          selStartCp: p.selStartCp,
          selEndCp: p.selEndCp,
          isRegion: p.isRegion
        })
      }

      // --- Icons (memos + quotes) ---
      // Use the shared iconLayout helper so this viewer and CodedTextView
      // produce identical icon groupings.
      const items = buildIconItems(contentMemos, quotes, ({ pdfRegion, startPosition, endPosition }) => {
        if (pdfRegion) return getPdfRegionYBounds(containerRef.current!, pdfRegion)
        if (startPosition === undefined) return null
        return getRangeYBounds(
          contentRef.current!, containerRef.current!,
          startPosition, endPosition ?? startPosition + 1, textNodes
        )
      })
      const baseGroups = layoutIcons(items)
      const packedGroups = computeIconLefts(baseGroups, newBrackets, labelMaxWidthFor)
      setBrackets(newBrackets)
      setIconGroups(packedGroups)
    }, 150)

    return () => clearTimeout(timer)
  }, [rendered, selections, contentMemos, quotes, codes, measureTick])

  const maxCol = brackets.length > 0 ? Math.max(...brackets.map((b) => b.column)) : 0
  const bracketZoneW = (maxCol + 1) * COL_W + 6

  const iconsW = ICON_COL_W + ICON_COL_W // quote + memo icon columns
  const preferredW = bracketZoneW + LABEL_W + 4 + iconsW
  // When alignRight (PDF viewer), fill available flex space; otherwise fixed width
  const useFlexWidth = alignRight

  return (
    <div ref={columnRef} style={{
      position: useFlexWidth ? 'relative' : 'absolute',
      ...(useFlexWidth ? {} : { left: 0, width: preferredW }),
      top: 0,
      ...(useFlexWidth ? { width: '100%', minWidth: bracketZoneW + iconsW } : {}),
      minHeight: '100%',
      pointerEvents: 'none',
      overflow: 'visible'
    }}>
    {/* Shifts everything left by flushShiftPx so brackets/labels/icons sit
        flush against the actual content edge instead of this column's own
        (possibly further-right) box — see flushShiftPx above. The box
        itself keeps its normal reserved width; only what's painted inside
        it moves. */}
    <div style={{ position: 'absolute', inset: 0, transform: `translateX(${-flushShiftPx}px)`, pointerEvents: 'none' }}>
      {/* Code bracket lines */}
      {brackets.map((b, i) => {
        const barX = b.column * COL_W + 4
        const topCap = capGeometry(b.column, b.topCapTargetCol, 4)
        const botCap = capGeometry(b.column, b.bottomCapTargetCol, 4)
        return (
          <div key={`bracket-${i}`} style={{ pointerEvents: 'auto' }}>
            {/* Vertical bar */}
            <div style={{
              position: 'absolute',
              left: barX,
              top: b.top + 4,
              height: b.height - 8,
              width: 2,
              background: b.color
            }} />
            {/* Top cap */}
            <div style={{
              position: 'absolute',
              left: topCap.left,
              top: b.top + 4,
              width: topCap.width,
              height: 2,
              background: b.color
            }} />
            {/* Bottom cap */}
            <div style={{
              position: 'absolute',
              left: botCap.left,
              top: b.top + b.height - 6,
              width: botCap.width,
              height: 2,
              background: b.color
            }} />
            {/* Code name label — sits just to the right of the rightmost
                bracket column at this label's Y, and truncates only once
                it runs out of room before the pane's right edge. */}
            <CodeLabel
              left={b.labelLeft}
              top={b.labelTop}
              color={b.color}
              maxWidth={labelMaxWidthFor(b.labelLeft)}
              text={b.codeName}
              onMouseEnter={() => {
                if (b.isRegion) {
                  onHoverSelectionGuid?.(b.selectionGuid)
                } else {
                  onHoverRange?.({ startCp: b.selStartCp, endCp: b.selEndCp })
                }
              }}
              onMouseLeave={() => {
                if (b.isRegion) {
                  onHoverSelectionGuid?.(null)
                } else {
                  if (!lockedRange) onHoverRange?.(null)
                }
              }}
              onClick={() => {
                if (b.isRegion) {
                  // Region selections don't use char-offset lock
                  return
                } else {
                  const r = { startCp: b.selStartCp, endCp: b.selEndCp }
                  if (lockedRange && lockedRange.startCp === r.startCp && lockedRange.endCp === r.endCp) {
                    onLockRange?.(null)
                  } else {
                    onLockRange?.(r)
                  }
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onContextMenu?.(e, {
                  existingCodings: [{
                    selectionGuid: b.selectionGuid,
                    codingGuid: b.codingGuid,
                    codeGuid: b.codeGuid,
                    startCp: b.selStartCp,
                    endCp: b.selEndCp
                  }]
                })
              }}
            />
          </div>
        )
      })}

      {/* Memo + quote icons — shared with CodedTextView via MemoQuoteIcons */}
      <MemoQuoteIcons
        groups={iconGroups}
        findMemo={(guid) => useMemoStore.getState().findMemo(guid)}
        onMemoClick={onMemoClick}
        onMemoPopup={onMemoPopup}
        onMemoContextMenu={(e, memos) => {
          onContextMenu?.(e, {
            overlappingMemos: memos.map((m) => ({
              guid: m.guid,
              title: m.title || 'Untitled Memo',
              startCp: m.startPosition ?? 0,
              endCp: m.endPosition ?? m.startPosition ?? 0
            }))
          })
        }}
        onHoverRange={onHoverRange}
        onHoverRegion={onHoverRegion}
        onLockRange={onLockRange}
        lockedRange={lockedRange}
        onQuoteClick={onQuoteClick}
      />
    </div>
    </div>
  )
}
