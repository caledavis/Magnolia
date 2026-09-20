/**
 * VideoTranscriptView — read-only transcript rendering for the video
 * coding mode. Codes attach to TIME ranges on the CodeTrack, not to
 * character ranges; this view draws their line-anchors in the right
 * margin using the exact same bracket shapes as the other viewers
 * (CodedTextView / PDF viewer) via the shared `bracketLayout` helper.
 *
 * Video-specific behaviour on top of the shared bracket style:
 *  - Timestamps are rendered at each bracket's top + bottom cap. They are
 *    clickable — clicking seeks the video to that moment.
 *  - Timestamps are deduplicated per cap Y: when multiple codes begin (or
 *    end) at the same line anchor, only one timestamp label is drawn,
 *    since they would otherwise overlay each other with identical text.
 *  - Small drag handles sit on each cap; dragging them vertically rebinds
 *    the bracket's line-anchor without changing the canonical time range.
 *  - Selecting transcript lines + dropping a code creates a time-range
 *    coding whose bounds are derived from the selected lines' times.
 */
import { useRef, useMemo, useCallback, useState, useEffect, useLayoutEffect } from 'react'
import { useDocumentStore } from '../../stores/document-store'
import { useCodeStore } from '../../stores/code-store'
import { useMemoStore } from '../../stores/memo-store'
import { useQuoteStore } from '../../stores/quote-store'
import { formatTimestamp } from '../../utils/timestamp-parser'
import { snapTimeToSecond } from './video-time-utils'
import { layoutBrackets, capGeometry, COL_W } from './bracketLayout'
import { TranscriptGutter, TRANSCRIPT_ROW_STYLE } from './TranscriptGutter'
import { CodeLabel } from './CodeLabel'
import { MemoQuoteIcons } from './MemoQuoteIcons'
import { buildIconItems, layoutIcons, ICON_COL_W } from './iconLayout'
import { Icon, MEMO_RANGED_ICON, MEMO_POINT_ICON, QUOTE_ICON } from '../Icon'
import type { Code, Memo, MemoEditInitData, PlainTextSelection } from '../../models/types'
import { usePendingSelectionStore } from '../../stores/pending-selection-store'
import { useNewCodeTriggerStore } from '../../stores/new-code-trigger-store'
import { modKey } from '../../utils/platform'

interface LabelContextMenu {
  x: number
  y: number
  selGuid: string
  codingGuid: string
  codeGuid: string
  startTime: number
  endTime: number
}

interface Props {
  sourceGuid: string
  sourceName: string
  content: string
  selections: PlainTextSelection[]
  currentPlaybackTime: number
  videoDuration: number
  lineTimes?: Record<string, number>
  onTimestampClick?: (seconds: number) => void
  activeTimestampLine?: number | null
  /** Transient highlight on a content-line range — set briefly when the
   *  user double-clicks a query result or clicks a saved quote/memo
   *  anchored to this video. Rendered with the same selection-bg
   *  treatment used by the hover/lock highlight. */
  /** Transient highlight driven by scrollTarget. Carries a codepoint
   *  range — video memos/quotes are cp-anchored like the plain-text
   *  viewer, so the incoming range from a saved-pane click needs to be
   *  translated to content lines here via `lineCpBounds`. */
  externalHighlightRange?: { startCp: number; endCp: number } | null
}

function findCode(codes: Code[], guid: string): Code | undefined {
  for (const c of codes) {
    if (c.guid === guid) return c
    const child = findCode(c.children, guid)
    if (child) return child
  }
  return undefined
}

const LINE_HEIGHT = 22

/** Blue wavy underline used to mark memo'd text — same SVG pattern the
 *  plain-text, PDF, and image viewers use, so memos read identically
 *  across every coded surface. */
const MEMO_WAVE = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='2.25'%3E%3Cpath d='M0 2.25 L3 0 L6 2.25 L9 0 L12 2.25' fill='none' stroke='%234a90d9' stroke-width='1'/%3E%3C/svg%3E")`
const LINE_PADDING_X = 12
const MARGIN_LABEL_W = 150
const BRACKET_OVERLAY_LEFT_PAD = 6
/** Breathing room kept clear between a fully-expanded label and the true
 *  right edge of the pane. */
const LABEL_EDGE_PAD = 8
/** The memo/quote icon column is right-pinned (see MemoQuoteIcons'
 *  legacy layout) rather than packed away from labels like the other
 *  viewers, so a growing label must stay clear of it explicitly. */
const ICON_RESERVE_W = ICON_COL_W * 2

interface BracketEntry {
  top: number
  bottom: number
  color: string
  codeName: string
  selGuid: string
  codingGuid: string
  codeGuid: string
  startTime: number
  endTime: number
  startLine: number
  endLine: number
}

export function VideoTranscriptView({
  sourceGuid,
  sourceName,
  content,
  selections,
  currentPlaybackTime: _currentPlaybackTime,
  videoDuration,
  lineTimes,
  onTimestampClick,
  activeTimestampLine,
  externalHighlightRange
}: Props) {
  const lines = useMemo(() => content.split('\n'), [content])
  const codes = useCodeStore((s) => s.codes)
  const addTimeRangeSelection = useDocumentStore((s) => s.addTimeRangeSelection)
  const addCodingToSelection = useDocumentStore((s) => s.addCodingToSelection)
  const updateSelectionLineAnchors = useDocumentStore((s) => s.updateSelectionLineAnchors)
  const updateSelectionTimeRange = useDocumentStore((s) => s.updateSelectionTimeRange)
  const removeCoding = useDocumentStore((s) => s.removeCoding)
  const removeSelection = useDocumentStore((s) => s.removeSelection)
  const addMemo = useMemoStore((s) => s.addMemo)
  const removeMemo = useMemoStore((s) => s.removeMemo)
  const contentMemos = useMemoStore((s) => s.getContentMemosForSource(sourceGuid))
  const addQuote = useQuoteStore((s) => s.addQuote)
  const removeQuote = useQuoteStore((s) => s.removeQuote)
  const sourceQuotes = useQuoteStore((s) => s.getQuotesForSource(sourceGuid))

  const [labelMenu, setLabelMenu] = useState<LabelContextMenu | null>(null)
  // Transcript-body right-click menu — same affordances as the other viewers
  // (CodedTextView / PdfDocumentViewer): apply hotkeyed codes to the
  // selected lines, capture the selection as a quote, or attach a content
  // memo. `lineRange` is set when the user has a text selection covering one
  // or more transcript lines; `clickedLine` is the line the user right-
  // clicked when no selection is present (used so a bare right-click can
  // still anchor a memo at that line).
  const [transcriptMenu, setTranscriptMenu] = useState<{
    x: number
    y: number
    lineRange: { startLine: number; endLine: number } | null
    clickedLine: number | null
    /** Codepoint range + selected text when the user made a live text
     *  selection before right-clicking. Memos and quotes use this so
     *  they anchor to the actual selected characters (matching the
     *  plain-text viewer) rather than the enclosing lines. */
    textRange: { startCp: number; endCp: number; selectedText: string } | null
  } | null>(null)
  useEffect(() => {
    if (!labelMenu && !transcriptMenu) return
    const close = (ev: MouseEvent) => {
      if (!(ev.target as HTMLElement).closest('.context-menu')) {
        setLabelMenu(null)
        setTranscriptMenu(null)
      }
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [labelMenu, transcriptMenu])

  // Flatten the code tree and filter to hotkey-bound codes for the
  // right-click "Apply Code" section. Mirrors DocumentViewer's hotkey list.
  const hotkeyCodes = useMemo(() => {
    const out: Code[] = []
    const walk = (cs: Code[]) => {
      for (const c of cs) {
        if (c.hotkey !== undefined) out.push(c)
        walk(c.children)
      }
    }
    walk(codes)
    return out.sort((a, b) => (a.hotkey ?? 0) - (b.hotkey ?? 0))
  }, [codes])

  const containerRef = useRef<HTMLDivElement>(null)
  // Measured pane width — lets code-name labels use whatever room is
  // actually available before the pane's right edge instead of always
  // ellipsing at the fixed MARGIN_LABEL_W budget. maxContentRight tracks
  // the furthest-right extent of any rendered transcript line, so the
  // margin column itself sits flush against the content instead of
  // always being anchored to the pane's true right edge.
  const [containerWidth, setContainerWidth] = useState(0)
  const [maxContentRight, setMaxContentRight] = useState(0)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => {
      const containerRect = el.getBoundingClientRect()
      setContainerWidth(containerRect.width)
      let maxRight = 0
      el.querySelectorAll<HTMLElement>('[data-body="1"]').forEach((body) => {
        const rects = body.getClientRects()
        for (let i = 0; i < rects.length; i++) {
          const r = rects[i]
          if (r.width > 0 && r.height > 0) maxRight = Math.max(maxRight, r.right - containerRect.left)
        }
      })
      setMaxContentRight(maxRight)
    }
    const rafId = requestAnimationFrame(measure)
    const observer = new ResizeObserver(() => requestAnimationFrame(measure))
    observer.observe(el)
    return () => {
      cancelAnimationFrame(rafId)
      observer.disconnect()
    }
  }, [lines])
  const [pendingLineRange, setPendingLineRange] = useState<{ startLine: number; endLine: number } | null>(null)
  /** Codepoint range of the most recent text selection, captured on
   *  mouseup so a subsequent right-click that clears the live selection
   *  (possible when the user right-clicks outside the selected text)
   *  can still produce a memo / quote anchored to the exact selected
   *  characters. */
  const [pendingTextRange, setPendingTextRange] = useState<{
    startCp: number
    endCp: number
    selectedText: string
  } | null>(null)

  // Mirror to the global pending-selection-store so the New Code dialog
  // can apply a freshly-created code to whatever the user has selected
  // here. (Same plumbing as the plain-text and PDF viewers.)
  const setGlobalPendingSelection = usePendingSelectionStore((s) => s.setSelection)
  useEffect(() => {
    if (pendingTextRange) {
      setGlobalPendingSelection({ kind: 'text', sourceGuid, ...pendingTextRange })
    } else {
      setGlobalPendingSelection(null)
    }
  }, [pendingTextRange, sourceGuid, setGlobalPendingSelection])

  // Codepoint offset at the START of each content line (newline-delimited
  // split of `content`). Used to convert between character positions and
  // line-based positions when creating memos / quotes from a text
  // selection — memos and quotes store cp ranges (matching the plain-
  // text viewer) so they can cover part of a line rather than the whole
  // line. The final entry is the total codepoint length, for bounds.
  const lineCpBounds = useMemo(() => {
    const out: number[] = []
    let cp = 0
    for (let i = 0; i < lines.length; i++) {
      out.push(cp)
      cp += [...lines[i]].length + 1 // +1 for the newline separator
    }
    out.push(cp)
    return out
  }, [lines])

  /** Given a selection endpoint (node + offset), resolve the codepoint
   *  offset in `content` it corresponds to. Anchors on the body `<span
   *  data-body="1">` inside each line div so gutter text isn't counted. */
  const resolveCp = useCallback((node: Node, offset: number): number | null => {
    let el: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement
    while (el && !el.dataset?.lineIndex) el = el.parentElement
    if (!el || !el.dataset?.lineIndex) return null
    const lineIdx = parseInt(el.dataset.lineIndex, 10)
    if (lineIdx < 0 || lineIdx >= lineCpBounds.length - 1) return null
    const bodyEl = el.querySelector<HTMLElement>('[data-body="1"]')
    if (!bodyEl) return lineCpBounds[lineIdx]
    if (!bodyEl.contains(node) && node !== bodyEl) {
      // Selection endpoint is in the gutter or another sibling — clamp
      // to the start or end of the line text depending on which side.
      return lineCpBounds[lineIdx]
    }
    try {
      const r = document.createRange()
      r.setStart(bodyEl, 0)
      r.setEnd(node, offset)
      const preceding = r.toString()
      return lineCpBounds[lineIdx] + [...preceding].length
    } catch {
      return lineCpBounds[lineIdx]
    }
  }, [lineCpBounds])

  /** Resolve the current text selection (if any) to a cp range within
   *  `content`. Returns null when the selection doesn't fall inside the
   *  transcript container. */
  const resolveSelectionCpRange = useCallback((): {
    startCp: number
    endCp: number
    selectedText: string
  } | null => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
    const range = sel.getRangeAt(0)
    if (!containerRef.current?.contains(range.commonAncestorContainer)) return null
    const a = resolveCp(range.startContainer, range.startOffset)
    const b = resolveCp(range.endContainer, range.endOffset)
    if (a === null || b === null) return null
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    if (lo >= hi) return null
    return { startCp: lo, endCp: hi, selectedText: sel.toString() }
  }, [resolveCp])

  // --- Hover / lock highlight ------------------------------------------
  // Mirrors CodedTextView's hover+lock behaviour: rolling the cursor
  // over a bracket label (or the bracket shape) highlights the transcript
  // rows the code covers; clicking locks that highlight so the user can
  // move the mouse away and still see the span. Clicking the locked
  // bracket again — or anywhere else — releases the lock.
  const [hoveredSelGuid, setHoveredSelGuid] = useState<string | null>(null)
  const [lockedSelGuid, setLockedSelGuid] = useState<string | null>(null)
  const activeHighlightSelGuid = lockedSelGuid || hoveredSelGuid

  // --- Memo / quote cp-range hover + lock + popup ----------------------
  // Mirrors the plain-text viewer. Hovering a memo / quote icon
  // highlights the covered transcript rows; clicking locks the
  // highlight and (for multi-item stacks) opens a picker. Right-click
  // on a memo icon shows the same list so the user can delete.
  const [hoveredRange, setHoveredRange] = useState<{ startCp: number; endCp: number } | null>(null)
  const [lockedRange, setLockedRange] = useState<{ startCp: number; endCp: number } | null>(null)
  const [memoPopup, setMemoPopup] = useState<{
    items: Memo[]
    x: number
    y: number
    isQuote?: boolean
    showDelete?: boolean
  } | null>(null)

  // --- Display rows ------------------------------------------------------
  // The transcript is displayed in CHRONOLOGICAL order, not in the user's
  // typing order. Each display row carries either a real transcript line
  // (with its content index + text) or a phantom (rendered as an empty
  // line with just a timestamp in the gutter). Phantoms always include:
  //   • 0:00 — the start of the video
  //   • videoDuration — the end of the video
  //   • Every code boundary time (startTime / endTime) that isn't already
  //     the time of a real transcribed line, so code brackets can anchor
  //     precisely to their own boundaries instead of snapping to the
  //     nearest earlier line.
  interface DisplayRow {
    kind: 'real' | 'phantom'
    time: number
    contentIdx?: number
    text?: string
  }

  const displayRows: DisplayRow[] = useMemo(() => {
    const realTimeSet = new Set<number>()
    const realRows: DisplayRow[] = []
    const untimedRows: DisplayRow[] = []
    for (let i = 0; i < lines.length; i++) {
      const t = lineTimes?.[String(i)]
      if (t !== undefined) {
        realRows.push({ kind: 'real', time: t, contentIdx: i, text: lines[i] })
        realTimeSet.add(t)
      } else {
        // Untimed line — e.g. the transcript was edited before the
        // type-time recorder got a chance to tag it. Keep these at the
        // end in their insertion order so they're still visible.
        untimedRows.push({ kind: 'real', time: Number.POSITIVE_INFINITY, contentIdx: i, text: lines[i] })
      }
    }

    const phantomTimes = new Set<number>()
    phantomTimes.add(0)
    if (isFinite(videoDuration) && videoDuration > 0) phantomTimes.add(videoDuration)
    for (const sel of selections) {
      if (!sel.timeRange) continue
      phantomTimes.add(sel.timeRange.startTime)
      phantomTimes.add(sel.timeRange.endTime)
    }
    // Dedup phantoms by "displayed-second bucket" (formatTime floors to the
    // second). A phantom whose bucket already holds a real transcript line
    // is dropped — its canonical time is still stored on the selection, we
    // just don't render a second row with the same visible timestamp. Two
    // phantoms that round to the same second coalesce into one row so the
    // transcript doesn't grow duplicate "0:10" lines each time a code is
    // repositioned onto a point that already has a timestamp nearby.
    const realBuckets = new Set<number>()
    for (const r of realRows) {
      if (isFinite(r.time)) realBuckets.add(Math.floor(r.time))
    }
    const phantomByBucket = new Map<number, number>()
    for (const t of phantomTimes) {
      if (!isFinite(t) || t < 0) continue
      const bucket = Math.floor(t)
      if (realBuckets.has(bucket)) continue
      const existing = phantomByBucket.get(bucket)
      if (existing === undefined || t < existing) phantomByBucket.set(bucket, t)
    }
    const phantomRows: DisplayRow[] = [...phantomByBucket.values()]
      .map((t) => ({ kind: 'phantom' as const, time: t }))

    const sorted = [...realRows, ...phantomRows].sort(
      (a, b) => a.time - b.time || (a.contentIdx ?? Infinity) - (b.contentIdx ?? Infinity)
    )
    return [...sorted, ...untimedRows]
  }, [lines, lineTimes, selections, videoDuration])

  const totalLineCount = displayRows.length

  // --- Row geometry ------------------------------------------------------
  // Rows can grow past LINE_HEIGHT when a long transcript line wraps onto
  // more than one visual line. We measure each row's actual top + height
  // after layout and feed those into the bracket positioning + drag hit-
  // testing logic so brackets stay anchored to their rows regardless of
  // wrapping. Before the first measurement we fall back to the flat
  // idx * LINE_HEIGHT estimate so the initial paint still looks right.
  const rowRefs = useRef<(HTMLDivElement | null)[]>([])
  const [rowGeometry, setRowGeometry] = useState<{ top: number; height: number }[]>([])
  const measureRows = useCallback(() => {
    const next: { top: number; height: number }[] = []
    for (let i = 0; i < rowRefs.current.length; i++) {
      const el = rowRefs.current[i]
      if (el) next.push({ top: el.offsetTop, height: el.offsetHeight })
    }
    setRowGeometry((prev) => {
      if (prev.length !== next.length) return next
      for (let i = 0; i < next.length; i++) {
        if (prev[i].top !== next[i].top || prev[i].height !== next[i].height) return next
      }
      return prev
    })
  }, [])
  // Measure after mount and whenever the row set changes. Using
  // `displayRows` as the dep (rather than running every render) prevents
  // a feedback loop: a render that doesn't change the row structure
  // shouldn't trigger a measurement that might produce microscopic
  // layout diffs and kick off another state update.
  useLayoutEffect(() => {
    measureRows()
  }, [displayRows, measureRows])
  // Re-measure when the container resizes (text rewraps at new widths).
  // This is the single source of ongoing re-measurement — any width
  // change, font load, or zoom hits the same path.
  useEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measureRows())
    ro.observe(container)
    return () => ro.disconnect()
  }, [measureRows])

  const rowTop = useCallback(
    (idx: number): number =>
      idx < rowGeometry.length ? rowGeometry[idx].top : idx * LINE_HEIGHT,
    [rowGeometry]
  )
  const rowBottom = useCallback(
    (idx: number): number =>
      idx < rowGeometry.length
        ? rowGeometry[idx].top + rowGeometry[idx].height
        : (idx + 1) * LINE_HEIGHT,
    [rowGeometry]
  )
  const totalContentHeight = useMemo(
    () => (rowGeometry.length > 0
      ? rowGeometry[rowGeometry.length - 1].top + rowGeometry[rowGeometry.length - 1].height
      : totalLineCount * LINE_HEIGHT),
    [rowGeometry, totalLineCount]
  )

  /** Display-row index for a given real-line content index. */
  const displayIdxByContentIdx = useMemo(() => {
    const m = new Map<number, number>()
    for (let i = 0; i < displayRows.length; i++) {
      const r = displayRows[i]
      if (r.kind === 'real' && r.contentIdx !== undefined) m.set(r.contentIdx, i)
    }
    return m
  }, [displayRows])

  /** Display-row index whose time matches `time` — exact match first, then
   *  a same-second (bucketed) match to handle cases where phantom dedup
   *  collapsed the code's exact boundary into a sibling row, and finally
   *  the last row whose time ≤ `time` so we always return something.
   *
   *  When `mode === 'end'` the lookup is exclusive: a row whose time equals
   *  `time` exactly is NOT returned. This enforces the half-open interval
   *  `[startTime, endTime)` for code brackets — a code ending at the start
   *  of a segment must not visually include that segment. */
  const displayIdxForTime = useCallback((time: number, mode: 'start' | 'end' = 'start'): number => {
    if (mode === 'end') {
      let best = 0
      let bestTime = -Infinity
      for (let i = 0; i < displayRows.length; i++) {
        const t = displayRows[i].time
        if (!isFinite(t)) continue
        if (t < time - 1e-4 && t > bestTime) { best = i; bestTime = t }
      }
      return best
    }
    const targetBucket = Math.floor(time)
    let exact = -1
    let bucket = -1
    let best = 0
    let bestTime = -Infinity
    for (let i = 0; i < displayRows.length; i++) {
      const t = displayRows[i].time
      if (exact < 0 && Math.abs(t - time) < 1e-4) exact = i
      if (bucket < 0 && isFinite(t) && Math.floor(t) === targetBucket) bucket = i
      if (t <= time && t > bestTime) { best = i; bestTime = t }
    }
    if (exact >= 0) return exact
    if (bucket >= 0) return bucket
    return best
  }, [displayRows])

  /** Return the concatenated transcript text for every REAL display row
   *  whose time falls inside [startTime, endTime]. Used when an Add-as-
   *  Quote menu action fires on a bracket — we want the quote body to be
   *  the transcript text that actually corresponds to the coded moment,
   *  not whichever raw content range the selection happens to carry. */
  const textForTimeRange = useCallback((startTime: number, endTime: number): string => {
    const parts: string[] = []
    for (const row of displayRows) {
      if (row.kind !== 'real' || row.text === undefined) continue
      // Half-open [startTime, endTime): a row whose time matches endTime
      // exactly is NOT included — the code ends as that row begins.
      if (row.time >= startTime && row.time < endTime - 1e-4) parts.push(row.text)
    }
    return parts.join('\n')
  }, [displayRows])

  /** Return the range of CONTENT line indexes covered by a code's time
   *  range — used to stamp memo / quote startPosition + endPosition so
   *  the memo/quote points at sensible transcript content. Returns null
   *  when no real line falls in the range. */
  const contentRangeForTimeRange = useCallback((startTime: number, endTime: number): [number, number] | null => {
    let lo = Number.POSITIVE_INFINITY
    let hi = Number.NEGATIVE_INFINITY
    for (const row of displayRows) {
      if (row.kind !== 'real' || row.contentIdx === undefined) continue
      // Half-open [startTime, endTime): exclude a row whose time equals
      // endTime exactly — it belongs to the next code, not this one.
      if (row.time >= startTime && row.time < endTime - 1e-4) {
        if (row.contentIdx < lo) lo = row.contentIdx
        if (row.contentIdx > hi) hi = row.contentIdx
      }
    }
    if (!isFinite(lo) || !isFinite(hi)) return null
    return [lo, hi]
  }, [displayRows])

  /** Translate a code's time range to a cp range covering every real
   *  line inside the range. Used when the user picks "Add Selection Memo"
   *  or "Add as Quote" from a bracket label — memos/quotes anchor by
   *  cp (matching the plain-text viewer), so the bracket's coded text
   *  becomes the quote body / memo anchor. */
  const cpRangeForTimeRange = useCallback((startTime: number, endTime: number): { startCp: number; endCp: number } | null => {
    const lineRange = contentRangeForTimeRange(startTime, endTime)
    if (!lineRange) return null
    const [loLine, hiLine] = lineRange
    const startCp = lineCpBounds[loLine] ?? 0
    // Exclude the trailing newline after the last covered line.
    const endCp = Math.max(startCp, (lineCpBounds[hiLine + 1] ?? startCp) - 1)
    return { startCp, endCp }
  }, [contentRangeForTimeRange, lineCpBounds])

  // --- Bracket placement ------------------------------------------------
  // A bracket's display-row span is derived each render from the code's
  // canonical timeRange (unless the user has manually anchored the
  // bracket, in which case the stored content-line indexes are mapped
  // into display space). Because every code boundary is guaranteed to
  // have a matching display row (real or phantom), the start and end
  // display rows are always an exact time match.
  const entries: BracketEntry[] = useMemo(() => {
    const out: BracketEntry[] = []
    const maxRow = Math.max(0, totalLineCount - 1)
    for (const sel of selections) {
      if (!sel.timeRange) continue
      let startRow: number
      let endRow: number
      if (sel.manuallyAnchored) {
        const mapped = displayIdxByContentIdx.get(sel.startPosition ?? 0)
        const mappedEnd = displayIdxByContentIdx.get(sel.endPosition ?? sel.startPosition ?? 0)
        startRow = mapped ?? displayIdxForTime(sel.timeRange.startTime)
        endRow = mappedEnd ?? displayIdxForTime(sel.timeRange.endTime, 'end')
      } else {
        startRow = displayIdxForTime(sel.timeRange.startTime)
        endRow = displayIdxForTime(sel.timeRange.endTime, 'end')
      }
      startRow = Math.min(startRow, maxRow)
      endRow = Math.min(Math.max(endRow, startRow), maxRow)
      const top = rowTop(startRow) + 2
      const bottom = rowBottom(endRow) - 2
      for (const coding of sel.codings) {
        const code = findCode(codes, coding.codeGuid)
        if (!code) continue
        out.push({
          top,
          bottom,
          color: code.color || '#888',
          codeName: code.name,
          selGuid: sel.guid,
          codingGuid: coding.guid,
          codeGuid: code.guid,
          startTime: sel.timeRange.startTime,
          endTime: sel.timeRange.endTime,
          startLine: startRow,
          endLine: endRow
        })
      }
    }
    return out
  }, [selections, codes, displayIdxByContentIdx, displayIdxForTime, totalLineCount, rowTop, rowBottom])

  const placed = useMemo(() => layoutBrackets(entries), [entries])

  // Max-concurrent-codings count derived purely from each selection's
  // timeRange — no dependency on measured row geometry. We use this for
  // the content-wrapper's paddingRight so wrapping rows don't feed back
  // into bracket column counts and thence back into padding. Prior to
  // this, a row that wrapped changed bracketZoneW, changed paddingRight,
  // unwrapped the row, and re-triggered measurement — infinite loop.
  const maxColumn = useMemo(() => {
    const events: { t: number; delta: number }[] = []
    for (const sel of selections) {
      if (!sel.timeRange) continue
      const codingCount = sel.codings.length
      if (codingCount === 0) continue
      events.push({ t: sel.timeRange.startTime, delta: codingCount })
      events.push({ t: sel.timeRange.endTime, delta: -codingCount })
    }
    // Starts come before ends at the same instant so a zero-length touch
    // doesn't briefly hide an overlap.
    events.sort((a, b) => a.t - b.t || b.delta - a.delta)
    let current = 0
    let max = 0
    for (const e of events) {
      current += e.delta
      if (current > max) max = current
    }
    return max
  }, [selections])

  // cp-based highlights (memo / quote hover, saved-pane jump) are
  // applied at the character level inside the body span render below —
  // not as a row-level background — so the pulse covers only the
  // actual selected characters. See the body render for the per-
  // segment merging with memo wavy-underline ranges.

  /** Set of display-row indexes the active (hovered or locked) code
   *  covers. A selection can have multiple codings so we pick the first
   *  matching entry; each coding of the same selection shares the same
   *  line range anyway. */
  const highlightedRowSet = useMemo(() => {
    const set = new Set<number>()
    if (!activeHighlightSelGuid) return set
    const entry = entries.find((en) => en.selGuid === activeHighlightSelGuid)
    if (!entry) return set
    for (let i = entry.startLine; i <= entry.endLine; i++) set.add(i)
    return set
  }, [entries, activeHighlightSelGuid])

  // --- Memo coverage (cp-based) -----------------------------------------
  // Memos in the video transcript store cp (codepoint) ranges — exactly
  // the same coordinate system the plain-text viewer uses — so a memo
  // can cover part of a line rather than the whole line. For rendering
  // we translate each memo's cp range into per-line char-range overlaps
  // so the body span of each line can split into segments, wavy-
  // underlining only the covered characters.
  const memosByLine = useMemo(() => {
    const map = new Map<number, { relStart: number; relEnd: number; memo: Memo }[]>()
    if (!contentMemos || contentMemos.length === 0) return map
    for (let i = 0; i < lines.length; i++) {
      const lineStartCp = lineCpBounds[i] ?? 0
      // The line's displayed chars go from 0..lineLen within the line;
      // lineCpBounds[i+1] includes the newline terminator, so its char
      // length is lineCpBounds[i+1] - lineStartCp - 1 (except for the
      // last line which has no trailing newline in the content).
      const lineLen = Math.max(0, [...lines[i]].length)
      // A zero-length line is treated as lineLen=1 for overlap checks so
      // memos anchored at an empty line (e.g. the first line of a fresh
      // transcript) still surface — otherwise the memo would never
      // intersect the line's cp range and the icon + wave wouldn't show.
      const overlapWidth = Math.max(1, lineLen)
      for (const m of contentMemos) {
        const mStart = m.startPosition ?? 0
        const mEnd = m.endPosition ?? mStart
        // Expand zero-length memos by one cp so the icon renders on the
        // anchored line; otherwise relEnd === relStart and we skip.
        const effectiveEnd = Math.max(mEnd, mStart + 1)
        if (effectiveEnd <= lineStartCp || mStart >= lineStartCp + overlapWidth) continue
        const relStart = Math.max(0, Math.min(lineLen, mStart - lineStartCp))
        const relEnd = Math.max(relStart, Math.min(lineLen, effectiveEnd - lineStartCp))
        if (!map.has(i)) map.set(i, [])
        map.get(i)!.push({ relStart, relEnd, memo: m })
      }
    }
    return map
  }, [contentMemos, lines, lineCpBounds])

  /** Memo + quote icon groups for the right-margin column. Uses the
   *  same buildIconItems + layoutIcons + MemoQuoteIcons pipeline the
   *  plain-text and PDF viewers use, so icons look and behave
   *  identically across every viewer. The measure function maps each
   *  memo/quote's cp range to content-line indexes, then to display-row
   *  indexes, then to measured pixel Y positions. */
  const iconGroups = useMemo(() => {
    const measure = (ctx: { startPosition?: number; endPosition?: number }) => {
      const startCp = ctx.startPosition
      const endCp = ctx.endPosition ?? startCp
      if (startCp === undefined || endCp === undefined) return null
      let first = -1
      let last = -1
      for (let i = 0; i < lines.length; i++) {
        const lineStart = lineCpBounds[i] ?? 0
        const lineLen = [...lines[i]].length
        const lineEnd = lineStart + lineLen
        const effectiveEnd = Math.max(endCp, startCp + 1)
        if (effectiveEnd <= lineStart) break
        if (startCp >= lineEnd + 1) continue // +1 to include point memos at EOL
        if (first < 0) first = i
        last = i
      }
      if (first < 0) return null
      const firstDisplay = displayIdxByContentIdx.get(first)
      const lastDisplay = displayIdxByContentIdx.get(last)
      if (firstDisplay === undefined || lastDisplay === undefined) return null
      return { top: rowTop(firstDisplay), bottom: rowBottom(lastDisplay) }
    }
    const items = buildIconItems(
      contentMemos,
      sourceQuotes.map((q) => ({ guid: q.guid, startCp: q.startPosition, endCp: q.endPosition })),
      measure
    )
    return layoutIcons(items)
  }, [contentMemos, sourceQuotes, lines, lineCpBounds, displayIdxByContentIdx, rowTop, rowBottom])

  // Per-bracket timestamp labels used to live here, but the transcript
  // gutter already shows the start/end time of every code boundary (real
  // lines + phantoms cover each start/end), so a second set of timestamps
  // in the right margin was redundant. They've been removed.

  const bracketZoneW = Math.max(maxColumn * COL_W + 6, 16) + MARGIN_LABEL_W

  // --- Text selection → pending line range ------------------------------
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const handleMouseUp = () => {
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        setPendingLineRange(null)
        setPendingTextRange(null)
        return
      }
      const range = sel.getRangeAt(0)
      if (!container.contains(range.commonAncestorContainer)) return
      let startEl: HTMLElement | null = range.startContainer as HTMLElement
      let endEl: HTMLElement | null = range.endContainer as HTMLElement
      while (startEl && !startEl.dataset?.lineIndex) startEl = startEl.parentElement
      while (endEl && !endEl.dataset?.lineIndex) endEl = endEl.parentElement
      if (!startEl || !endEl) { setPendingLineRange(null); setPendingTextRange(null); return }
      const s = parseInt(startEl.dataset.lineIndex!, 10)
      const e = parseInt(endEl.dataset.lineIndex!, 10)
      setPendingLineRange({ startLine: Math.min(s, e), endLine: Math.max(s, e) })
      const cpRange = resolveSelectionCpRange()
      setPendingTextRange(cpRange)
    }
    container.addEventListener('mouseup', handleMouseUp)
    return () => container.removeEventListener('mouseup', handleMouseUp)
  }, [resolveSelectionCpRange])

  /** Look up the time at a given line index. If no entry exists, walk
   *  to the nearest tagged neighbour in the requested direction. */
  const timeForLine = useCallback((lineIndex: number, direction: 'start' | 'end' = 'start'): number => {
    if (!lineTimes) return direction === 'end' ? videoDuration : 0
    if (direction === 'start') {
      for (let i = lineIndex; i >= 0; i--) {
        const t = lineTimes[String(i)]
        if (t !== undefined) return t
      }
      return 0
    } else {
      for (let i = lineIndex + 1; i < lines.length + 1; i++) {
        const t = lineTimes[String(i)]
        if (t !== undefined) return t
      }
      return videoDuration
    }
  }, [lineTimes, videoDuration, lines.length])

  // --- Drag to rebind bracket line anchors ------------------------------
  const [anchorDrag, setAnchorDrag] = useState<{
    selGuid: string
    handle: 'start' | 'end'
    original: { startLine: number; endLine: number }
    originalTimeRange: { startTime: number; endTime: number }
  } | null>(null)

  useEffect(() => {
    if (!anchorDrag) return
    const container = containerRef.current
    if (!container) return
    const onMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect()
      const y = e.clientY - rect.top + container.scrollTop - 4 /* matches paddingTop */
      // Translate the cursor Y to a row index using measured row offsets
      // so wrapped (taller-than-LINE_HEIGHT) rows still hit correctly.
      // Falls back to the flat LINE_HEIGHT estimate before first measure.
      let rawRow = 0
      if (rowGeometry.length > 0) {
        for (let i = 0; i < rowGeometry.length; i++) {
          if (y >= rowGeometry[i].top) rawRow = i
          else break
        }
      } else {
        rawRow = Math.floor(y / LINE_HEIGHT)
      }
      const row = Math.max(0, Math.min(totalLineCount - 1, rawRow))
      // Translate the dragged-to display row back to a content line
      // index for persistence. Phantom rows aren't bindable — dragging
      // over them snaps to the nearest real line in the drag direction.
      const target = displayRows[row]
      let contentIdx: number | undefined
      if (target?.kind === 'real' && target.contentIdx !== undefined) {
        contentIdx = target.contentIdx
      } else {
        // Walk outward from the phantom row to find the nearest real.
        for (let step = 1; step < totalLineCount; step++) {
          const before = displayRows[row - step]
          if (before?.kind === 'real' && before.contentIdx !== undefined) {
            contentIdx = before.contentIdx
            break
          }
          const after = displayRows[row + step]
          if (after?.kind === 'real' && after.contentIdx !== undefined) {
            contentIdx = after.contentIdx
            break
          }
        }
      }
      if (contentIdx === undefined) return
      let { startLine, endLine } = anchorDrag.original
      if (anchorDrag.handle === 'start') startLine = Math.min(contentIdx, endLine)
      else endLine = Math.max(contentIdx, startLine)
      updateSelectionLineAnchors(sourceGuid, anchorDrag.selGuid, startLine, endLine)

      // Also push the dragged-to time into the canonical timeRange so the
      // CodeTrack (timeline) reflects the new duration. Phantoms carry the
      // exact boundary time, real rows carry the transcribed line's time —
      // either is a valid new boundary. Snap to whole seconds so the new
      // boundary lands on an integer-second row (matches the gutter's
      // HH:MM:SS precision). `preserveAnchor: true` keeps the line anchors
      // we just wrote via updateSelectionLineAnchors; without it the store
      // would reset manuallyAnchored when the time changes.
      const targetTime = target?.time
      if (targetTime !== undefined && isFinite(targetTime)) {
        let startTime = snapTimeToSecond(anchorDrag.originalTimeRange.startTime)
        let endTime = snapTimeToSecond(anchorDrag.originalTimeRange.endTime)
        const snappedTarget = snapTimeToSecond(targetTime)
        if (anchorDrag.handle === 'start') startTime = Math.min(snappedTarget, endTime - 1)
        else endTime = Math.max(snappedTarget, startTime + 1)
        updateSelectionTimeRange(sourceGuid, anchorDrag.selGuid, { startTime, endTime }, { preserveAnchor: true })
      }
    }
    const onUp = () => setAnchorDrag(null)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [anchorDrag, totalLineCount, displayRows, sourceGuid, updateSelectionLineAnchors, updateSelectionTimeRange, rowGeometry])

  // --- Drop handler -----------------------------------------------------
  const [isDragOver, setIsDragOver] = useState(false)
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    const multi = e.dataTransfer.getData('application/x-magnolia-codes')
    let codeGuids: string[] = []
    if (multi) {
      try { codeGuids = JSON.parse(multi).map((c: any) => c.guid) } catch { /* noop */ }
    } else {
      const single = e.dataTransfer.getData('application/x-magnolia-code')
      if (single) {
        try { codeGuids = [JSON.parse(single).guid] } catch { /* noop */ }
      }
    }
    if (codeGuids.length === 0 || !pendingLineRange) return
    const rawStart = timeForLine(pendingLineRange.startLine, 'start')
    const rawEnd = timeForLine(pendingLineRange.endLine, 'end')
    const startTime = snapTimeToSecond(rawStart)
    const endTime = Math.max(startTime + 1, snapTimeToSecond(rawEnd))
    const selGuid = addTimeRangeSelection(
      sourceGuid,
      startTime,
      endTime,
      pendingLineRange.startLine,
      pendingLineRange.endLine
    )
    for (const codeGuid of codeGuids) {
      addCodingToSelection(sourceGuid, selGuid, codeGuid)
    }
  }, [pendingLineRange, sourceGuid, addTimeRangeSelection, addCodingToSelection, timeForLine])

  /** Create a time-range coding spanning the given line range — the same
   *  path the drop handler takes, factored out for the right-click menu's
   *  "Apply Code" action. */
  const applyCodingToLineRange = useCallback(
    (codeGuid: string, startLine: number, endLine: number) => {
      const startTime = snapTimeToSecond(timeForLine(startLine, 'start'))
      const endTime = Math.max(startTime + 1, snapTimeToSecond(timeForLine(endLine, 'end')))
      const selGuid = addTimeRangeSelection(sourceGuid, startTime, endTime, startLine, endLine)
      addCodingToSelection(sourceGuid, selGuid, codeGuid)
    },
    [sourceGuid, addTimeRangeSelection, addCodingToSelection, timeForLine]
  )

  // --- Transcript right-click menu --------------------------------------
  // Resolve the line range from the current text selection (preferred) or,
  // if there is none, from the line element the user right-clicked. Phantom
  // rows have no data-line-index so a right-click on one falls back to no
  // line; the menu still opens to offer document-level actions.
  const handleTranscriptContextMenu = useCallback((e: React.MouseEvent) => {
    // Defer to the label's own onContextMenu — it stops propagation, but
    // bracket bars/caps in the right margin don't, so guard explicitly.
    const target = e.target as HTMLElement
    if (target.closest('.context-menu')) return

    let lineRange: { startLine: number; endLine: number } | null = null
    const sel = window.getSelection()
    if (
      sel && !sel.isCollapsed && sel.rangeCount > 0 &&
      containerRef.current?.contains(sel.getRangeAt(0).commonAncestorContainer)
    ) {
      const range = sel.getRangeAt(0)
      let startEl: HTMLElement | null = range.startContainer as HTMLElement
      let endEl: HTMLElement | null = range.endContainer as HTMLElement
      while (startEl && !startEl.dataset?.lineIndex) startEl = startEl.parentElement
      while (endEl && !endEl.dataset?.lineIndex) endEl = endEl.parentElement
      if (startEl && endEl) {
        const s = parseInt(startEl.dataset.lineIndex!, 10)
        const en = parseInt(endEl.dataset.lineIndex!, 10)
        lineRange = { startLine: Math.min(s, en), endLine: Math.max(s, en) }
      }
    }

    let clickedLine: number | null = null
    if (!lineRange) {
      let el: HTMLElement | null = target
      while (el && !el.dataset?.lineIndex) el = el.parentElement
      if (el?.dataset?.lineIndex) clickedLine = parseInt(el.dataset.lineIndex, 10)
    }

    // Prefer the live selection's cp range. If the right-click cleared
    // the selection (happens when the click lands outside the selected
    // text in some browsers) fall back to the cp range we captured on
    // the previous mouseup so the memo / quote still anchors to the
    // user's actual character selection.
    const textRange = resolveSelectionCpRange() ?? pendingTextRange

    // Derive a line range from the text range when the walk above
    // didn't find one — covers the same mouseup-vs-right-click race.
    let effectiveLineRange = lineRange
    if (!effectiveLineRange && pendingLineRange) effectiveLineRange = pendingLineRange

    e.preventDefault()
    setTranscriptMenu({ x: e.clientX, y: e.clientY, lineRange: effectiveLineRange, clickedLine, textRange })
  }, [resolveSelectionCpRange, pendingTextRange, pendingLineRange])

  const columnOriginX = BRACKET_OVERLAY_LEFT_PAD

  // The margin column (brackets + labels + icons) sits flush against the
  // widest rendered transcript line rather than always being anchored to
  // the pane's true right edge — ragged-right content (short exchanges,
  // one-word lines, etc.) shouldn't leave a dead gap before it starts.
  // One value for the whole transcript, capped at the old right-anchored
  // position so wide, wrapped-to-fill dialogue looks the same as before.
  const MARGIN_CONTENT_GAP = 24
  const MIN_MARGIN_LEFT = 150
  const marginCeilingPx = containerWidth - bracketZoneW
  const marginLeftPx = containerWidth <= 0
    ? 0
    : maxContentRight > 0
      ? Math.min(marginCeilingPx, Math.max(MIN_MARGIN_LEFT, maxContentRight + MARGIN_CONTENT_GAP))
      : marginCeilingPx

  // How much room a label starting at bracket-layout offset `labelLeft`
  // actually has before the pane's measured right edge, keeping clear of
  // the right-pinned icon column. Falls back to MARGIN_LABEL_W before the
  // container has been measured.
  const labelMaxWidthFor = (labelLeft: number): number => {
    if (containerWidth <= 0) return MARGIN_LABEL_W
    const available = containerWidth - (marginLeftPx + columnOriginX + labelLeft) - ICON_RESERVE_W - LABEL_EDGE_PAD
    return Math.max(MARGIN_LABEL_W, available)
  }

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        height: '100%',
        overflowY: 'auto',
        overflowX: 'hidden',
        fontFamily: 'var(--font-doc)',
        fontSize: 14,
        paddingLeft: LINE_PADDING_X,
        paddingTop: 4,
        paddingBottom: 40,
        outline: isDragOver ? '2px dashed var(--accent)' : 'none',
        outlineOffset: -2
      }}
      onDragOver={(e) => {
        if (
          e.dataTransfer.types.includes('application/x-magnolia-code') ||
          e.dataTransfer.types.includes('application/x-magnolia-codes')
        ) {
          e.preventDefault()
          e.dataTransfer.dropEffect = pendingLineRange ? 'copy' : 'none'
          setIsDragOver(true)
        }
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
      onContextMenu={handleTranscriptContextMenu}
      onClick={() => { if (lockedSelGuid) setLockedSelGuid(null) }}
    >
      {/* Transcript rows in chronological order. Real lines carry their
          data-line-index pointing at the CONTENT line index so text
          selection + drop still yields valid pendingLineRange values.
          Phantom rows (0:00, video-end, and any uncovered code boundary)
          are not selectable — they just provide a gutter timestamp + an
          anchor point for brackets. */}
      <div style={{ paddingRight: bracketZoneW + 20, position: 'relative' }}>
        {displayRows.map((row, displayIdx) => {
          // `highlightedRowSet` is the hover/lock pulse driven by the
          // CODE brackets — these always cover whole lines. cp-based
          // highlights (memo / quote hover, saved-pane jump) are
          // applied at the character level inside the body span below,
          // so we don't paint the row background for those here.
          const isHighlighted = highlightedRowSet.has(displayIdx)
          if (row.kind === 'real') {
            const isActive =
              row.contentIdx !== undefined && activeTimestampLine === row.contentIdx
            return (
              <div
                key={`real-${row.contentIdx}`}
                ref={(el) => { rowRefs.current[displayIdx] = el }}
                data-line-index={row.contentIdx}
                style={{
                  ...TRANSCRIPT_ROW_STYLE,
                  minHeight: LINE_HEIGHT,
                  lineHeight: `${LINE_HEIGHT}px`,
                  background: isHighlighted ? 'var(--selection-bg)' : 'transparent',
                  borderRadius: isHighlighted ? 2 : undefined
                }}
                onDoubleClick={() => {
                  if (isFinite(row.time) && onTimestampClick) onTimestampClick(row.time)
                }}
              >
                <TranscriptGutter
                  text={isFinite(row.time) ? formatTimestamp(row.time) : ''}
                  active={isActive}
                  invisible={!isFinite(row.time)}
                  onClick={isFinite(row.time) && onTimestampClick ? (e) => {
                    e.stopPropagation()
                    onTimestampClick(row.time)
                  } : undefined}
                  title={isFinite(row.time) ? 'Click to seek here' : undefined}
                />
                {(() => {
                  const contentIdx = row.contentIdx
                  const lineMemos = contentIdx !== undefined ? memosByLine.get(contentIdx) : undefined
                  const hasMemo = !!(lineMemos && lineMemos.length > 0)
                  const lineText = row.text || '\u00A0'

                  // Compute the char range within this line covered by
                  // the active cp highlight (locked > hovered > saved-
                  // pane target). Clamped to line bounds so we only
                  // paint the chars that are actually covered —
                  // matches the plain-text viewer's behaviour where
                  // only the memo / quote's selected text lights up.
                  let hoverRel: { relStart: number; relEnd: number } | null = null
                  const activeCp = lockedRange || hoveredRange || externalHighlightRange
                  if (activeCp && contentIdx !== undefined) {
                    const lineStart = lineCpBounds[contentIdx] ?? 0
                    const lineLen = [...lines[contentIdx]].length
                    const rs = Math.max(0, activeCp.startCp - lineStart)
                    const re = Math.min(lineLen, activeCp.endCp - lineStart)
                    if (re > rs) hoverRel = { relStart: rs, relEnd: re }
                  }

                  const hasHover = hoverRel !== null
                  const hasAnyAnnotation = hasMemo || hasHover

                  return (
                    <span
                      data-body="1"
                      style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                    >
                      {!hasAnyAnnotation
                        ? lineText
                        : (() => {
                            // Merge memo boundaries + hover boundaries
                            // into one break set so each segment is
                            // homogeneous w.r.t. memo coverage and
                            // hover coverage.
                            const chars = [...lineText]
                            const breaks = new Set<number>([0, chars.length])
                            if (lineMemos) {
                              for (const m of lineMemos) {
                                breaks.add(m.relStart)
                                breaks.add(m.relEnd)
                              }
                            }
                            if (hoverRel) {
                              breaks.add(hoverRel.relStart)
                              breaks.add(hoverRel.relEnd)
                            }
                            const sorted = [...breaks].sort((a, b) => a - b)
                            const out: React.ReactNode[] = []
                            for (let i = 0; i < sorted.length - 1; i++) {
                              const s = sorted[i]
                              const e = sorted[i + 1]
                              const seg = chars.slice(s, e).join('')
                              const inMemo = lineMemos
                                ? lineMemos.some((m) => m.relStart <= s && m.relEnd >= e)
                                : false
                              const inHover = hoverRel
                                ? hoverRel.relStart <= s && hoverRel.relEnd >= e
                                : false
                              const style: React.CSSProperties = {}
                              if (inMemo) {
                                style.backgroundImage = MEMO_WAVE
                                style.backgroundSize = '12px 2.25px'
                                style.backgroundRepeat = 'repeat-x'
                                style.backgroundPosition = 'left bottom'
                                style.paddingBottom = 2
                              }
                              if (inHover) {
                                style.backgroundColor = 'var(--selection-bg)'
                                style.borderRadius = 2
                              }
                              out.push(
                                <span key={i} style={Object.keys(style).length > 0 ? style : undefined}>
                                  {seg}
                                </span>
                              )
                            }
                            return out
                          })()}
                    </span>
                  )
                })()}
              </div>
            )
          }
          return (
            <div
              key={`phantom-${displayIdx}`}
              ref={(el) => { rowRefs.current[displayIdx] = el }}
              data-phantom="1"
              style={{
                ...TRANSCRIPT_ROW_STYLE,
                minHeight: LINE_HEIGHT,
                lineHeight: `${LINE_HEIGHT}px`,
                background: isHighlighted ? 'var(--selection-bg)' : undefined,
                borderRadius: isHighlighted ? 2 : undefined
              }}
              onDoubleClick={() => onTimestampClick?.(row.time)}
            >
              <TranscriptGutter
                text={formatTimestamp(row.time)}
                onClick={onTimestampClick ? (e) => {
                  e.stopPropagation()
                  onTimestampClick(row.time)
                } : undefined}
                title={onTimestampClick ? 'Click to seek here' : undefined}
              />
              <span style={{ flex: 1 }}>{'\u00A0'}</span>
            </div>
          )
        })}

        {/* Bracket overlay: positioned flush against the widest rendered
            line (marginLeftPx) rather than right-anchored to the pane
            edge, so ragged-right transcripts don't get a dead gap before
            it. Uses the same column / cap algorithm as the other viewers. */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: marginLeftPx,
            width: bracketZoneW,
            height: totalContentHeight,
            pointerEvents: 'none'
          }}
        >
          {/* Bars + caps (matches CodedTextView rendering). */}
          {placed.map((p) => {
            const top = p.top + 2
            const height = Math.max(4, p.bottom - p.top - 4)
            const barLeft = columnOriginX + p.column * COL_W
            const topCap = capGeometry(p.column, p.topCapTargetCol, columnOriginX)
            const botCap = capGeometry(p.column, p.bottomCapTargetCol, columnOriginX)
            return (
              <div key={`shape-${p.selGuid}:${p.codingGuid}`}>
                <div style={{
                  position: 'absolute',
                  left: topCap.left, top, width: topCap.width, height: 2,
                  background: p.color
                }} />
                <div style={{
                  position: 'absolute',
                  left: barLeft, top, width: 2, height,
                  background: p.color
                }} />
                <div style={{
                  position: 'absolute',
                  left: botCap.left, top: top + height - 2, width: botCap.width, height: 2,
                  background: p.color
                }} />
                {/* Small drag handles for rebinding line anchors.
                    Centred on the top and bottom corners of the
                    vertical bar so the handle sits exactly on the
                    ] bracket's corner, half the previous size (4×4
                    hollow dots). The caps still show past the handle
                    on their outer side. */}
                <div
                  title="Drag to rebind bracket start to a different line"
                  style={{
                    position: 'absolute',
                    left: barLeft - 1, top: top - 2,
                    width: 6, height: 6, borderRadius: 3,
                    background: 'var(--bg-primary)',
                    border: `1.5px solid ${p.color}`,
                    cursor: 'ns-resize',
                    pointerEvents: 'auto',
                    boxSizing: 'border-box'
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    // Seed the drag with the selection's stored CONTENT
                    // line indexes — the persistence model stores those,
                    // not the display-row indexes we rendered from.
                    const sel = selections.find((s) => s.guid === p.selGuid)
                    setAnchorDrag({
                      selGuid: p.selGuid,
                      handle: 'start',
                      original: {
                        startLine: sel?.startPosition ?? 0,
                        endLine: sel?.endPosition ?? sel?.startPosition ?? 0
                      },
                      originalTimeRange: {
                        startTime: sel?.timeRange?.startTime ?? p.startTime,
                        endTime: sel?.timeRange?.endTime ?? p.endTime
                      }
                    })
                  }}
                />
                <div
                  title="Drag to rebind bracket end to a different line"
                  style={{
                    position: 'absolute',
                    left: barLeft - 1, top: top + height - 4,
                    width: 6, height: 6, borderRadius: 3,
                    background: 'var(--bg-primary)',
                    border: `1.5px solid ${p.color}`,
                    cursor: 'ns-resize',
                    pointerEvents: 'auto',
                    boxSizing: 'border-box'
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    const sel = selections.find((s) => s.guid === p.selGuid)
                    setAnchorDrag({
                      selGuid: p.selGuid,
                      handle: 'end',
                      original: {
                        startLine: sel?.startPosition ?? 0,
                        endLine: sel?.endPosition ?? sel?.startPosition ?? 0
                      },
                      originalTimeRange: {
                        startTime: sel?.timeRange?.startTime ?? p.startTime,
                        endTime: sel?.timeRange?.endTime ?? p.endTime
                      }
                    })
                  }}
                />
              </div>
            )
          })}

          {/* Code-name labels — identical style to CodedTextView's.
              Hovering highlights the transcript lines the code covers
              (see `highlightedRowSet` above); clicking toggles a lock so
              the highlight stays after the cursor moves away. Double-
              click jumps the playhead to the code's start time. */}
          {placed.map((p) => {
            const code = findCode(codes, p.codeGuid)
            const isLocked = lockedSelGuid === p.selGuid
            return (
              <CodeLabel
                key={`label-${p.selGuid}:${p.codingGuid}`}
                left={columnOriginX + p.labelLeft}
                top={p.labelTop}
                color={p.color}
                maxWidth={labelMaxWidthFor(p.labelLeft)}
                text={p.codeName}
                locked={isLocked}
                title={`${code?.name ?? 'Code'} — click to lock highlight, double-click to seek, right-click for options`}
                onMouseEnter={() => setHoveredSelGuid(p.selGuid)}
                onMouseLeave={() => setHoveredSelGuid(null)}
                onClick={(e) => {
                  e.stopPropagation()
                  setLockedSelGuid((prev) => (prev === p.selGuid ? null : p.selGuid))
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  if (onTimestampClick) onTimestampClick(p.startTime)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setLabelMenu({
                    x: e.clientX,
                    y: e.clientY,
                    selGuid: p.selGuid,
                    codingGuid: p.codingGuid,
                    codeGuid: p.codeGuid,
                    startTime: p.startTime,
                    endTime: p.endTime
                  })
                }}
              />
            )
          })}

          {/* Memo + quote icons — the same MemoQuoteIcons component used
              by every other viewer, so order, colour, hit-testing, and
              visuals stay in lock-step. Quote icon sits one column in
              from the right edge, memo icon on the far right. */}
          <MemoQuoteIcons
            groups={iconGroups}
            findMemo={(guid) => useMemoStore.getState().findMemo(guid)}
            onMemoClick={(memoGuid) => {
              const memo = useMemoStore.getState().findMemo(memoGuid)
              if (memo) {
                window.api.openMemoEditWindow({
                  memo,
                  theme: document.documentElement.getAttribute('data-theme') || ''
                } as MemoEditInitData)
              }
            }}
            onMemoPopup={(e, memos) =>
              setMemoPopup({ items: memos, x: e.clientX, y: e.clientY })
            }
            onMemoContextMenu={(e, memos) => {
              const items = memos.map((m) => useMemoStore.getState().findMemo(m.guid)).filter((m): m is Memo => !!m)
              setMemoPopup({ items, x: e.clientX, y: e.clientY, showDelete: true })
            }}
            onHoverRange={setHoveredRange}
            onLockRange={setLockedRange}
            lockedRange={lockedRange}
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
              if (qs.length === 1 && !showDelete) {
                setLockedRange({ startCp: qs[0].startCp, endCp: qs[0].endCp })
              }
              setMemoPopup({ items, x: e.clientX, y: e.clientY, isQuote: true, showDelete })
            }}
          />
        </div>

        {/* Drag-over overlay hint */}
        {isDragOver && !pendingLineRange && (
          <div
            style={{
              position: 'absolute',
              top: 0, left: 0, right: 0, bottom: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(224, 80, 80, 0.08)',
              pointerEvents: 'none',
              zIndex: 10
            }}
          >
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              Select transcript lines first, or drop on the code track above
            </span>
          </div>
        )}
        {isDragOver && pendingLineRange && (
          <div
            style={{
              position: 'absolute',
              top: 0, left: 0, right: 0, bottom: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(124, 111, 240, 0.08)',
              pointerEvents: 'none',
              zIndex: 10
            }}
          >
            <span style={{ color: 'var(--accent)', fontWeight: 600, fontSize: 14 }}>
              Drop code to apply to selection ({formatTimestamp(timeForLine(pendingLineRange.startLine, 'start'))} – {formatTimestamp(timeForLine(pendingLineRange.endLine, 'end'))})
            </span>
          </div>
        )}
      </div>

      {/* Right-click context menu on a code label — mirrors the other
          viewers' "Add Memo / Add Quote / Remove Code" actions, adapted
          to the line-anchor + time-range data model.
          • Remove Code: drops the coding; if it was the only coding on
            the selection, the selection itself is removed.
          • Add Selection Memo: attaches a memo to the bracket's transcript
            line range (startPosition / endPosition carry line indexes).
          • Add as Quote: captures the concatenated text of the bracket's
            transcript lines as the quote body. */}
      {labelMenu && (() => {
        const code = findCode(codes, labelMenu.codeGuid)
        return (
          <div
            className="context-menu"
            style={{ position: 'fixed', left: labelMenu.x, top: labelMenu.y, zIndex: 1000 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: '4px 14px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, userSelect: 'none' }}>
              {code?.name ?? 'Code'} — {formatTimestamp(labelMenu.startTime)}
            </div>
            <div className="context-menu-separator" />
            <div
              className="context-menu-item"
              onClick={() => {
                const text = textForTimeRange(labelMenu.startTime, labelMenu.endTime)
                const cp = cpRangeForTimeRange(labelMenu.startTime, labelMenu.endTime)
                addQuote(
                  sourceGuid,
                  sourceName,
                  cp?.startCp ?? 0,
                  cp?.endCp ?? 0,
                  text
                )
                setLabelMenu(null)
              }}
            >
              Add as Quote
            </div>
            <div
              className="context-menu-item"
              onClick={() => {
                const cp = cpRangeForTimeRange(labelMenu.startTime, labelMenu.endTime)
                const guid = addMemo('content', '', {
                  sourceGuid,
                  startPosition: cp?.startCp ?? 0,
                  endPosition: cp?.endCp ?? 0
                })
                const memo = useMemoStore.getState().findMemo(guid)
                if (memo) {
                  window.api.openMemoEditWindow({
                    memo,
                    theme: document.documentElement.getAttribute('data-theme') || ''
                  } as MemoEditInitData)
                }
                setLabelMenu(null)
              }}
            >
              Add Selection Memo
            </div>
            <div className="context-menu-separator" />
            <div
              className="context-menu-item"
              style={{ color: 'var(--menu-fg-danger)' }}
              onClick={() => {
                removeCoding(sourceGuid, labelMenu.selGuid, labelMenu.codingGuid)
                const target = selections.find((s) => s.guid === labelMenu.selGuid)
                if (target && target.codings.length <= 1) {
                  removeSelection(sourceGuid, labelMenu.selGuid)
                }
                setLabelMenu(null)
              }}
            >
              Remove Code
            </div>
          </div>
        )
      })()}

      {/* Right-click menu on the transcript body. Mirrors the affordances
          the other viewers expose (CodedTextView, PdfDocumentViewer):
            • Apply Code  — hotkeyed codes only, like DocumentViewer's menu
            • Add as Quote  — captures the selected lines' text
            • Add Selection Memo  — anchors to the line range or single line
          Quote/Apply require a line selection; Add Memo always works (it
          falls back to the right-clicked line when nothing is selected). */}
      {transcriptMenu && (() => {
        const range = transcriptMenu.lineRange
        const textRange = transcriptMenu.textRange
        const memoLine = range?.startLine ?? transcriptMenu.clickedLine
        const memoEndLine = range?.endLine ?? transcriptMenu.clickedLine
        const canMemo = memoLine !== null && memoEndLine !== null
        return (
          <div
            className="context-menu"
            style={{ position: 'fixed', left: transcriptMenu.x, top: transcriptMenu.y, zIndex: 1000 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="context-menu-item" onClick={() => {
              useNewCodeTriggerStore.getState().request()
              setTranscriptMenu(null)
            }}>
              New Code
            </div>
            <div className="context-menu-separator" />
            {range && (
              <>
                <div style={{ padding: '4px 14px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, userSelect: 'none' }}>
                  Apply Code
                </div>
                <div style={{ padding: '0 14px 6px', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4, maxWidth: 220, userSelect: 'none' }}>
                  To apply any code, select content and drag the code from the Code Browser to the selection.
                </div>
                {hotkeyCodes.map((code) => (
                  <div
                    key={code.guid}
                    className="context-menu-item"
                    onClick={() => {
                      applyCodingToLineRange(code.guid, range.startLine, range.endLine)
                      setTranscriptMenu(null)
                    }}
                  >
                    <span className="color-pip" style={{ background: code.color || '#888' }} />
                    <span style={{ flex: 1 }}>{code.name}</span>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 12 }}>
                      {modKey(code.hotkey)}
                    </span>
                  </div>
                ))}
                {hotkeyCodes.length === 0 && (
                  <div className="context-menu-item" style={{ color: 'var(--menu-fg-muted)', pointerEvents: 'none' }}>
                    No hotkeys assigned — right-click a code to assign one
                  </div>
                )}
                <div className="context-menu-separator" />
                <div
                  className="context-menu-item"
                  onClick={() => {
                    // Prefer the cp-based text range (matching the plain-
                    // text viewer — quote covers the user's exact
                    // selection, not the enclosing lines). Fall back to
                    // joining whole lines when no live selection
                    // survived to right-click time.
                    if (textRange) {
                      addQuote(sourceGuid, sourceName, textRange.startCp, textRange.endCp, textRange.selectedText)
                    } else {
                      const parts: string[] = []
                      for (let i = range.startLine; i <= range.endLine; i++) {
                        parts.push(lines[i] ?? '')
                      }
                      const startCp = lineCpBounds[range.startLine] ?? 0
                      const endCp = (lineCpBounds[range.endLine + 1] ?? startCp) - 1
                      addQuote(sourceGuid, sourceName, startCp, Math.max(endCp, startCp), parts.join('\n'))
                    }
                    setTranscriptMenu(null)
                  }}
                >
                  Add as Quote
                </div>
              </>
            )}
            {range && canMemo && <div className="context-menu-separator" />}
            {canMemo && (
              <div
                className="context-menu-item"
                onClick={() => {
                  let startCp: number
                  let endCp: number
                  if (textRange) {
                    startCp = textRange.startCp
                    endCp = textRange.endCp
                  } else {
                    // No live text selection survived to right-click.
                    // Cover the entire right-clicked line (or line
                    // range) so the memo still has a non-zero span —
                    // wavy-underline + icon render correctly only when
                    // relEnd > relStart in memosByLine.
                    const lo = memoLine!
                    const hi = memoEndLine!
                    startCp = lineCpBounds[lo] ?? 0
                    endCp = Math.max(startCp + 1, (lineCpBounds[hi + 1] ?? startCp) - 1)
                  }
                  const guid = addMemo('content', '', {
                    sourceGuid,
                    startPosition: startCp,
                    endPosition: endCp
                  })
                  const memo = useMemoStore.getState().findMemo(guid)
                  if (memo) {
                    window.api.openMemoEditWindow({
                      memo,
                      theme: document.documentElement.getAttribute('data-theme') || ''
                    } as MemoEditInitData)
                  }
                  setTranscriptMenu(null)
                }}
              >
                Add Selection Memo
              </div>
            )}
          </div>
        )
      })()}

      {/* Memo / quote picker popup — mirrors CodedTextView. A
          left-click on a stacked memo or quote icon opens this so the
          user can pick among multiple items at the same line; a
          right-click on a memo or quote icon opens the same UI with
          delete entries. Hovering an item pulses its cp range via
          hoveredRange; clicking locks the range. */}
      {memoPopup && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 99 }}
            onClick={() => { setMemoPopup(null); setLockedRange(null); setHoveredRange(null) }}
          />
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
                onMouseLeave={() => { setHoveredRange(null) }}
                onClick={() => {
                  if (m.startPosition !== undefined && m.endPosition !== undefined && m.startPosition !== m.endPosition) {
                    setLockedRange({ startCp: m.startPosition, endCp: m.endPosition })
                  }
                  if (!memoPopup.isQuote) {
                    const memo = useMemoStore.getState().findMemo(m.guid)
                    if (memo) {
                      window.api.openMemoEditWindow({
                        memo,
                        theme: document.documentElement.getAttribute('data-theme') || ''
                      } as MemoEditInitData)
                    }
                  }
                  setMemoPopup(null)
                }}
              >
                <Icon
                  icon={memoPopup.isQuote ? QUOTE_ICON : (m.startPosition === m.endPosition ? MEMO_POINT_ICON : MEMO_RANGED_ICON)}
                  style={{
                    marginRight: 6,
                    fontSize: 10,
                    color: memoPopup.isQuote ? 'var(--quote-icon-color)' : undefined
                  }}
                />
                <span style={{ flex: 1 }}>{m.title || (memoPopup.isQuote ? 'Quote' : 'Untitled Memo')}</span>
              </div>
            ))}
            {memoPopup.isQuote && memoPopup.showDelete && memoPopup.items.map((m) => (
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
                  removeQuote(m.guid)
                  setMemoPopup(null)
                  setLockedRange(null)
                  setHoveredRange(null)
                }}
              >
                Delete &quot;{(m.title || 'Quote').slice(0, 20)}&quot;
              </div>
            ))}
            {!memoPopup.isQuote && memoPopup.showDelete && memoPopup.items.map((m) => (
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
                  removeMemo(m.guid)
                  setMemoPopup(null)
                  setLockedRange(null)
                  setHoveredRange(null)
                }}
              >
                Delete &quot;{(m.title || 'Untitled Memo').slice(0, 20)}&quot;
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
