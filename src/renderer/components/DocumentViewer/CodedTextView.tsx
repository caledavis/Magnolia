import React, { useMemo, useRef, useCallback, useState, useEffect } from 'react'
import type { PlainTextSelection, Code, Memo, SourceType } from '../../models/types'
import { codepointToCharIndex } from '../../utils/unicode'
import { Icon, QUOTE_ICON, MEMO_POINT_ICON, MEMO_RANGED_ICON } from '../Icon'
import { useQuoteStore } from '../../stores/quote-store'
import { getFormat, type LineAnnotation, type InlineRange } from '../../utils/format-registry'
import { layoutBrackets, capGeometry, COL_W, LABEL_H, LABEL_GAP } from './bracketLayout'
import { layoutIcons, buildIconItems, ICON_COL_W, LINE_GROUP_TOLERANCE, type IconGroup } from './iconLayout'
import { measureLabelWidth } from '../../utils/measure-text'
import { MemoQuoteIcons } from './MemoQuoteIcons'
import { TranscriptGutter, TRANSCRIPT_ROW_STYLE } from './TranscriptGutter'
import { CodeLabel } from './CodeLabel'
import { useMemoStore } from '../../stores/memo-store'
import { blendColors, multiColorUnderline } from '../../utils/code-highlight'

interface Props {
  text: string
  sourceType?: SourceType
  selections: PlainTextSelection[]
  codes: Code[]
  contentMemos?: Memo[]
  quotes?: { guid: string; startCp: number; endCp: number }[]
  externalHighlightRange?: { startCp: number; endCp: number } | null
  onTextSelected: (startCp: number, endCp: number, selectedText: string) => void
  onMemoClick?: (memoGuid: string) => void
  onCodingRightClick: (
    e: React.MouseEvent,
    context: CodingRightClickContext
  ) => void
  /** Called when a [HH:MM:SS] timestamp is clicked (audio transcripts). */
  onTimestampClick?: (seconds: number) => void
  /** Codepoint range to highlight as "currently playing" (audio playback tracking). */
  playbackHighlightRange?: { startCp: number; endCp: number } | null
  /** Map of line index → { text, seconds } for timestamp display in place of line numbers. */
  lineTimestamps?: Map<number, { text: string; seconds: number }>
  /** Line index currently active during audio playback. */
  activeTimestampLine?: number | null
  /** Codepoint ranges to visually hide (render as zero-width). Text still exists for codepoint consistency. */
  hiddenRanges?: { cpStart: number; cpEnd: number }[]
  /** Hide the line-number gutter on the left. Used by SurveyViewer
   *  (each survey cell is rendered as its own CodedTextView, and
   *  per-cell "1" gutters read as visual noise). When true, lines
   *  render flush-left and no `TranscriptGutter` is emitted. */
  hideLineNumbers?: boolean
}

export interface CodingRightClickContext {
  // When right-clicking on already-coded text, these list every coding on the span
  existingCodings: { selectionGuid: string; codingGuid: string; codeGuid: string; startCp: number; endCp: number }[]
  // When right-clicking on a fresh text selection (uncoded), this is the pending range.
  // If pdfRegion is set, this is a box selection on a PDF page.
  pendingSelection?: { startCp: number; endCp: number; selectedText: string; pdfRegion?: import('../../models/types').PdfRegionSelection }
  // The codepoint offset at the right-click position. Previously fed
  // text point-memo creation; now only used by viewers that look up
  // existing codings/memos at a click position.
  codepointOffset?: number
  // Right-click position on a PDF page or image (no text/box selection).
  // Used by PDF and image viewers to create point memos pinned to a spot
  // on the page. Always page 1 for images.
  pdfPoint?: { page: number; x: number; y: number }
  // Memos that overlap the right-clicked position
  overlappingMemos?: { guid: string; title: string; startCp: number; endCp: number }[]
}

interface Span {
  charStart: number
  charEnd: number
  cpStart: number
  cpEnd: number
  activeCodes: { codeGuid: string; color: string; codingGuid: string; selectionGuid: string }[]
}

/** Resolve a DOM boundary (node + offset) to a codepoint in the document.
 *  Walks up to the nearest [data-cpoffset] span; if the boundary landed on
 *  a non-cpoffset element (e.g. whitespace between spans, a line wrapper
 *  past its last atom), falls back to the nearest preceding cpoffset span's
 *  end position. */
function resolveCpInContainer(container: HTMLElement, node: Node, offset: number): number | null {
  let targetNode: Node
  let charOffset: number

  if (node.nodeType === Node.TEXT_NODE) {
    targetNode = node
    charOffset = offset
  } else {
    const children = node.childNodes
    if (offset >= children.length) {
      const last = children[children.length - 1]
      if (!last) return null
      targetNode = last
      charOffset = last.textContent?.length ?? 0
    } else {
      targetNode = children[offset]
      charOffset = 0
    }
  }

  let el = targetNode instanceof HTMLElement ? targetNode : targetNode.parentElement
  while (el && el !== container) {
    if (el.dataset.cpoffset !== undefined) {
      const cpStart = parseInt(el.dataset.cpoffset, 10)
      if (targetNode.nodeType === Node.TEXT_NODE) {
        const textBefore = targetNode.textContent?.slice(0, charOffset) ?? ''
        return cpStart + [...textBefore].length
      }
      return cpStart
    }
    el = el.parentElement
  }
  let cur: Node | null = targetNode
  while (cur && cur !== container) {
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

export function CodedTextView({
  text,
  sourceType,
  selections,
  codes,
  contentMemos,
  quotes: quotesProp,
  externalHighlightRange,
  onTextSelected,
  onMemoClick,
  onCodingRightClick,
  onTimestampClick,
  playbackHighlightRange,
  lineTimestamps,
  activeTimestampLine,
  hiddenRanges,
  hideLineNumbers
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)

  // Margin hover: the codepoint range to programmatically select
  const [hoveredRange, setHoveredRange] = useState<{ startCp: number; endCp: number } | null>(null)
  const [lockedRange, setLockedRange] = useState<{ startCp: number; endCp: number } | null>(null)
  const [memoPopup, setMemoPopup] = useState<{ items: Memo[]; x: number; y: number; isQuote?: boolean; showDelete?: boolean } | null>(null)

  const activeRange = externalHighlightRange || lockedRange || hoveredRange

  const codeMap = useMemo(() => {
    const m = new Map<string, Code>()
    const walk = (list: Code[]) => {
      for (const c of list) {
        m.set(c.guid, c)
        walk(c.children)
      }
    }
    walk(codes)
    return m
  }, [codes])

  // Build spans with highlight information
  const spans = useMemo(() => {
    if (!text) return []
    const codepoints = [...text]
    const len = codepoints.length

    type Event = {
      pos: number
      type: 'start' | 'end'
      codeGuid: string
      color: string
      codingGuid: string
      selectionGuid: string
    }
    const events: Event[] = []

    for (const sel of selections) {
      for (const coding of sel.codings) {
        const code = codeMap.get(coding.codeGuid)
        if (!code) continue
        events.push({
          pos: sel.startPosition,
          type: 'start',
          codeGuid: coding.codeGuid,
          color: code.color || '#888',
          codingGuid: coding.guid,
          selectionGuid: sel.guid
        })
        events.push({
          pos: sel.endPosition,
          type: 'end',
          codeGuid: coding.codeGuid,
          color: code.color || '#888',
          codingGuid: coding.guid,
          selectionGuid: sel.guid
        })
      }
    }

    if (events.length === 0) {
      return [{
        charStart: 0,
        charEnd: text.length,
        cpStart: 0,
        cpEnd: len,
        activeCodes: []
      }] as Span[]
    }

    events.sort((a, b) => {
      if (a.pos !== b.pos) return a.pos - b.pos
      if (a.type === 'start' && b.type === 'end') return -1
      if (a.type === 'end' && b.type === 'start') return 1
      return 0
    })

    const result: Span[] = []
    const active: Map<
      string,
      { codeGuid: string; color: string; codingGuid: string; selectionGuid: string }
    > = new Map()
    let currentPos = 0

    for (const evt of events) {
      if (evt.pos > currentPos && currentPos < len) {
        const spanEnd = Math.min(evt.pos, len)
        result.push({
          charStart: codepointToCharIndex(text, currentPos),
          charEnd: codepointToCharIndex(text, spanEnd),
          cpStart: currentPos,
          cpEnd: spanEnd,
          activeCodes: Array.from(active.values())
        })
        currentPos = spanEnd
      }

      const key = `${evt.codingGuid}`
      if (evt.type === 'start') {
        active.set(key, {
          codeGuid: evt.codeGuid,
          color: evt.color,
          codingGuid: evt.codingGuid,
          selectionGuid: evt.selectionGuid
        })
      } else {
        active.delete(key)
      }
    }

    if (currentPos < len) {
      result.push({
        charStart: codepointToCharIndex(text, currentPos),
        charEnd: text.length,
        cpStart: currentPos,
        cpEnd: len,
        activeCodes: Array.from(active.values())
      })
    }

    return result
  }, [text, selections, codeMap])

  // Split text into lines for line number display
  const lines = useMemo(() => {
    if (spans.length === 0) return []

    // Walk through spans and split by newline characters to build lines,
    // where each line is an array of sub-spans
    const result: { spans: (Span & { lineCharStart: number; lineCharEnd: number })[] }[] = []
    let currentLine: (Span & { lineCharStart: number; lineCharEnd: number })[] = []

    for (const span of spans) {
      const content = text.slice(span.charStart, span.charEnd)
      // Split this span's content by newlines
      let searchFrom = 0
      while (true) {
        const nlIdx = content.indexOf('\n', searchFrom)
        if (nlIdx === -1) {
          // Rest of span is on current line
          if (searchFrom < content.length) {
            currentLine.push({
              ...span,
              lineCharStart: span.charStart + searchFrom,
              lineCharEnd: span.charStart + content.length
            })
          }
          break
        } else {
          // Push content up to and including the newline onto current line
          currentLine.push({
            ...span,
            lineCharStart: span.charStart + searchFrom,
            lineCharEnd: span.charStart + nlIdx + 1
          })
          result.push({ spans: currentLine })
          currentLine = []
          searchFrom = nlIdx + 1
        }
      }
    }
    // Push final line
    if (currentLine.length > 0) {
      result.push({ spans: currentLine })
    }

    return result
  }, [spans, text])

  // Format-aware annotations per line (block class + inline styles)
  const formatAnnotations = useMemo((): LineAnnotation[] | null => {
    const fmt = getFormat(sourceType)
    return fmt.parseDocument(text)
  }, [sourceType, text])

  const handleMouseUp = useCallback(() => {
    if (!containerRef.current) return

    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return

    const range = sel.getRangeAt(0)
    const container = containerRef.current

    const startCp = resolveCpInContainer(container, range.startContainer, range.startOffset)
    const endCp = resolveCpInContainer(container, range.endContainer, range.endOffset)
    if (startCp === null || endCp === null) return

    if (startCp < endCp) {
      const selectedText = [...text].slice(startCp, endCp).join('')
      onTextSelected(startCp, endCp, selectedText)
    }
  }, [text, onTextSelected])

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, span: Span) => {
      e.preventDefault()

      const hasExisting = span.activeCodes.length > 0

      // Also check if there's a pending text selection
      const sel = window.getSelection()
      let pendingSelection: CodingRightClickContext['pendingSelection'] | undefined

      if (sel && !sel.isCollapsed && sel.rangeCount > 0 && containerRef.current) {
        const range = sel.getRangeAt(0)
        const container = containerRef.current
        const startCp = resolveCpInContainer(container, range.startContainer, range.startOffset)
        const endCp = resolveCpInContainer(container, range.endContainer, range.endOffset)
        if (startCp !== null && endCp !== null && startCp < endCp) {
          pendingSelection = {
            startCp,
            endCp,
            selectedText: [...text].slice(startCp, endCp).join('')
          }
        }
      }

      // Find the codepoint at the actual click position from the DOM
      let clickCp = span.cpStart
      const clickTarget = e.target as HTMLElement
      // Walk up to find the nearest element with data-cpoffset
      let cpEl: HTMLElement | null = clickTarget
      while (cpEl && cpEl.dataset.cpoffset === undefined) {
        cpEl = cpEl.parentElement
      }
      if (cpEl?.dataset.cpoffset !== undefined) {
        clickCp = parseInt(cpEl.dataset.cpoffset, 10)
      }
      const overlappingMemos = memoRanges
        .filter((mr) => clickCp >= mr.startCp && clickCp < mr.endCp)
        .map((mr) => {
          const memo = contentMemos?.find(
            (m) => m.startPosition === mr.startCp && m.endPosition === mr.endCp
          )
          return memo ? { guid: memo.guid, title: memo.title || 'Untitled Memo', startCp: mr.startCp, endCp: mr.endCp } : null
        })
        .filter((x): x is { guid: string; title: string; startCp: number; endCp: number } => x !== null)

      onCodingRightClick(e, {
        existingCodings: span.activeCodes.map((ac) => {
          const sel = selections.find((s) => s.guid === ac.selectionGuid)
          return {
            selectionGuid: ac.selectionGuid,
            codingGuid: ac.codingGuid,
            codeGuid: ac.codeGuid,
            startCp: sel?.startPosition ?? 0,
            endCp: sel?.endPosition ?? 0
          }
        }),
        pendingSelection,
        codepointOffset: span.cpStart,
        overlappingMemos: overlappingMemos.length > 0 ? overlappingMemos : undefined
      })
    },
    [text, onCodingRightClick]
  )

  // Build margin annotations: map each line to its active codings
  const marginAnnotations = useMemo(() => {
    if (lines.length === 0) return { perLine: [] as any[], maxCol: 0 }

    // For each selection+coding, figure out which lines it spans
    type MarginEntry = {
      codeGuid: string
      codeName: string
      color: string
      startLine: number
      endLine: number // inclusive
      selStartCp: number // codepoint range for highlighting
      selEndCp: number
      selectionGuid: string
      codingGuid: string
    }

    const entries: MarginEntry[] = []

    // Build a mapping from char position to line index
    const lineRanges: { charStart: number; charEnd: number }[] = lines.map((line) => {
      if (line.spans.length === 0) return { charStart: 0, charEnd: 0 }
      return {
        charStart: line.spans[0].lineCharStart,
        charEnd: line.spans[line.spans.length - 1].lineCharEnd
      }
    })

    const charToLine = (charIdx: number): number => {
      for (let i = 0; i < lineRanges.length; i++) {
        if (charIdx < lineRanges[i].charEnd) return i
      }
      return lineRanges.length - 1
    }

    for (const sel of selections) {
      const selCharStart = codepointToCharIndex(text, sel.startPosition)
      const selCharEnd = codepointToCharIndex(text, sel.endPosition)
      if (selCharStart >= selCharEnd) continue
      const startLine = charToLine(selCharStart)
      const endLine = charToLine(selCharEnd - 1)

      for (const coding of sel.codings) {
        const code = codeMap.get(coding.codeGuid)
        if (!code) continue
        entries.push({
          codeGuid: coding.codeGuid,
          codeName: code.name,
          color: code.color || '#888',
          startLine,
          endLine,
          selStartCp: sel.startPosition,
          selEndCp: sel.endPosition,
          selectionGuid: sel.guid,
          codingGuid: coding.guid
        })
      }
    }

    // Deduplicate brackets: same code on same line range = one bracket
    const seen = new Set<string>()
    const unique = entries.filter((e) => {
      const key = `${e.codeGuid}:${e.startLine}:${e.endLine}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    // Track extra labels: same code on same line range but different selection positions
    // These get labels but not extra brackets
    const extraLabelsSeen = new Set<string>()
    for (const e of unique) extraLabelsSeen.add(`${e.codeGuid}:${e.selStartCp}:${e.selEndCp}`)
    const extraLabels: MarginEntry[] = entries.filter((e) => {
      const selKey = `${e.codeGuid}:${e.selStartCp}:${e.selEndCp}`
      if (extraLabelsSeen.has(selKey)) return false
      extraLabelsSeen.add(selKey)
      return true
    })

    // Assign columns to avoid overlapping brackets
    // Sort by startLine, then longer spans first (so they sit in outer columns)
    const sorted = [...unique].sort((a, b) => {
      if (a.startLine !== b.startLine) return a.startLine - b.startLine
      const aLen = a.endLine - a.startLine
      const bLen = b.endLine - b.startLine
      return bLen - aLen
    })

    const columnAssignments: (MarginEntry & { column: number })[] = []
    const columnEnds: number[] = [] // tracks the endLine of each column

    for (const entry of sorted) {
      let col = 0
      for (col = 0; col < columnEnds.length; col++) {
        if (columnEnds[col] < entry.startLine) break
      }
      if (col === columnEnds.length) columnEnds.push(-1)
      columnEnds[col] = entry.endLine
      columnAssignments.push({ ...entry, column: col })
    }

    // Build extra label entries with the same column as their parent bracket
    const extraLabelAssignments: (MarginEntry & { column: number })[] = extraLabels.map((e) => {
      // Find the matching bracket entry to inherit its column
      const match = columnAssignments.find((ca) => ca.codeGuid === e.codeGuid && ca.startLine === e.startLine && ca.endLine === e.endLine)
      return { ...e, column: match?.column ?? 0 }
    })

    // For labels: assign a label row offset so labels on the same line don't overlap
    // Include both bracket entries and extra label entries
    const allLabelEntries = [...columnAssignments, ...extraLabelAssignments]
    const labelOffsets = new Map<MarginEntry, number>()
    const startLineGroups = new Map<number, (typeof allLabelEntries)[number][]>()
    for (const entry of allLabelEntries) {
      const group = startLineGroups.get(entry.startLine) || []
      group.push(entry)
      startLineGroups.set(entry.startLine, group)
    }
    for (const [, group] of startLineGroups) {
      // Sort within group by column so labels stack in order
      group.sort((a, b) => a.column - b.column)
      for (let i = 0; i < group.length; i++) {
        labelOffsets.set(group[i], i)
      }
    }

    // Build per-line annotation info
    const perLine: {
      annotations: {
        codeName: string
        color: string
        column: number
        isStart: boolean
        isEnd: boolean
        isMid: boolean
        isLabelOnly: boolean // extra label entry — no bracket, just the name
        labelOffset: number // vertical offset for the label (0, 1, 2...)
        codeGuid: string
        selStartCp: number
        selEndCp: number
        selectionGuid: string
        codingGuid: string
      }[]
    }[] = lines.map(() => ({ annotations: [] }))

    for (const entry of columnAssignments) {
      for (let line = entry.startLine; line <= entry.endLine; line++) {
        if (line < 0 || line >= perLine.length) continue
        perLine[line].annotations.push({
          codeName: entry.codeName,
          color: entry.color,
          column: entry.column,
          isStart: line === entry.startLine,
          isEnd: line === entry.endLine,
          isMid: line > entry.startLine && line < entry.endLine,
          isLabelOnly: false,
          labelOffset: labelOffsets.get(entry) ?? 0,
          codeGuid: entry.codeGuid,
          selStartCp: entry.selStartCp,
          selEndCp: entry.selEndCp,
          selectionGuid: entry.selectionGuid,
          codingGuid: entry.codingGuid
        })
      }
    }

    // Add extra labels (no brackets) for same-code different-selection on same lines
    for (const entry of extraLabelAssignments) {
      const line = entry.startLine
      if (line < 0 || line >= perLine.length) continue
      perLine[line].annotations.push({
        codeName: entry.codeName,
        color: entry.color,
        column: entry.column,
        isStart: false,
        isEnd: false,
        isMid: false,
        isLabelOnly: true,
        labelOffset: labelOffsets.get(entry) ?? 0,
        codeGuid: entry.codeGuid,
        selStartCp: entry.selStartCp,
        selEndCp: entry.selEndCp,
        selectionGuid: entry.selectionGuid,
        codingGuid: entry.codingGuid
      })
    }

    const maxCol = columnEnds.length
    return { perLine, maxCol }
  }, [lines, selections, text, codeMap])

  // Width for the line-number gutter — sized to fit the widest line
  // number at the shared font-size-sm mono. 24 px of horizontal padding
  // plus ~8 px per digit, floored at 40 so the column never gets awkward
  // on very short documents.
  const lineNumberGutterWidth = useMemo(
    () => Math.max(40, 24 + String(Math.max(1, lines.length)).length * 8),
    [lines.length]
  )

  // Programmatically select the text corresponding to the active margin range
  useEffect(() => {
    // A margin HOVER is a transient preview; a lockedRange (click) or an
    // externalHighlightRange (programmatic navigation) is deliberate. The
    // distinction matters because this effect borrows the single native
    // selection to paint its highlight — and must not trample the user's
    // own in-progress text selection while doing so.
    const isHoverOnly = !externalHighlightRange && !lockedRange
    const liveSel = window.getSelection()
    const userHasManualSelection = !!liveSel && !liveSel.isCollapsed && liveSel.rangeCount > 0

    if (!containerRef.current || !activeRange) {
      // Don't wipe a selection the user is actively building (e.g. they
      // selected text and are now moving the mouse off a margin label on
      // the way to drag a code onto it). Only clear the preview selection
      // when there's no user selection to protect.
      if (!userHasManualSelection) window.getSelection()?.removeAllRanges()
      return
    }

    // Hovering a margin label must never disturb an in-progress manual
    // selection. Without this guard, sweeping the cursor over an existing
    // code/memo/quote label en route to dragging a code would hijack the
    // native selection AND (via the onTextSelected call below) retarget the
    // coding to the hovered range — so the code lands on the wrong text, or
    // the selection appears to vanish entirely.
    if (isHoverOnly && userHasManualSelection) return

    const container = containerRef.current
    const { startCp, endCp } = activeRange

    // Find the DOM spans covering this codepoint range
    const allSpans = container.querySelectorAll<HTMLSpanElement>('[data-cpoffset]')
    let startNode: Node | null = null
    let startOffset = 0
    let endNode: Node | null = null
    let endOffset = 0

    // Find the deepest text node inside a span (handles memo wrapper nesting)
    const findTextNode = (el: HTMLElement): Node => {
      let node: Node = el
      while (node.firstChild && node.firstChild.nodeType !== Node.TEXT_NODE) {
        node = node.firstChild
      }
      return node.firstChild || node
    }

    for (const span of allSpans) {
      const cpOff = parseInt(span.dataset.cpoffset!, 10)
      const spanText = span.textContent || ''
      const spanCpLen = [...spanText].length
      const spanCpEnd = cpOff + spanCpLen

      if (startCp >= cpOff && startCp < spanCpEnd) {
        const localCp = startCp - cpOff
        const charIdx = [...spanText].slice(0, localCp).join('').length
        startNode = findTextNode(span)
        startOffset = charIdx
      }
      if (endCp > cpOff && endCp <= spanCpEnd) {
        const localCp = endCp - cpOff
        const charIdx = [...spanText].slice(0, localCp).join('').length
        endNode = findTextNode(span)
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
          // Only register the working coding selection for a DELIBERATE
          // range (clicking a coding label = lockedRange, or programmatic
          // navigation = externalHighlightRange). A mere hover previews
          // visually but must not become the pending coding target — that
          // was the source of codes landing on whatever label the cursor
          // happened to pass over.
          if (!isHoverOnly) {
            onTextSelected(startCp, endCp, [...text].slice(startCp, endCp).join(''))
          }
        }
      } catch {
        // Range might be invalid in edge cases
      }
    }
  }, [activeRange, text, onTextSelected, externalHighlightRange, lockedRange])

  // Precompute memo ranges for highlighting
  const memoRanges = useMemo(() => {
    if (!contentMemos || contentMemos.length === 0) return []
    return contentMemos
      .filter((m) => m.startPosition !== undefined && m.endPosition !== undefined && m.startPosition !== m.endPosition)
      .map((m) => ({ startCp: m.startPosition!, endCp: m.endPosition!, title: m.title }))
  }, [contentMemos])

  // Precompute quote ranges for highlighting
  const quoteRanges = useMemo(() => {
    if (!quotesProp || quotesProp.length === 0) return []
    return quotesProp.map((q) => ({ startCp: q.startCp, endCp: q.endCp, guid: q.guid }))
  }, [quotesProp])

  type SpanAtom = { cpStart: number; cpEnd: number; node: React.ReactNode }

  const buildSpanAtoms = (span: Span & { lineCharStart: number; lineCharEnd: number }, key: string): SpanAtom[] => {
    const hasHighlight = span.activeCodes.length > 0
    const uniqueColors = [...new Set(span.activeCodes.map((ac) => ac.color))]
    const isMultiCode = uniqueColors.length > 1

    const codeBg = hasHighlight
      ? blendColors(uniqueColors, isMultiCode ? 0.15 : 0.12)
      : 'transparent'

    const underlineStyle = hasHighlight ? multiColorUnderline(uniqueColors) : {}

    const spanCps = [...text.slice(span.lineCharStart, span.lineCharEnd)]
    const cpOffset = span.cpStart + [...text.slice(span.charStart, span.lineCharStart)].length
    const cpEnd = cpOffset + spanCps.length

    const overlapping = memoRanges.filter(
      (mr) => cpOffset < mr.endCp && cpEnd > mr.startCp
    )
    const hasMemo = overlapping.length > 0
    const hasAnyAnnotation = hasMemo

    // Build ALL background images in one combined list.
    // CSS backgroundImage order: first = painted on top.
    // Order (top to bottom): code underline, memo wave.
    const allBgImages: string[] = []
    const allBgSizes: string[] = []
    const allBgPositions: string[] = []

    // When annotations are present, convert ALL underlines to background images
    // so we can stack them at precise vertical positions.
    // Order (top to bottom): code underline, memo wave, quote wave.
    if (hasAnyAnnotation && hasHighlight) {
      // Convert single-code borderBottom to a linear-gradient background
      if (underlineStyle.borderBottom && !underlineStyle.backgroundImage) {
        const color = uniqueColors[0] || '#888'
        allBgImages.push(`linear-gradient(${color}, ${color})`)
        allBgSizes.push('100% 2px')
        allBgPositions.push('left calc(100% - 5px)')
      }
      // Multi-code gradient underline
      if (underlineStyle.backgroundImage) {
        allBgImages.push(underlineStyle.backgroundImage as string)
        allBgSizes.push(underlineStyle.backgroundSize as string || '4px 2.5px')
        allBgPositions.push('left calc(100% - 5px)')
      }
    }
    // Memo wave is rendered on a WRAPPER span (not per-atom) to keep it continuous.
    // Atoms just get paddingBottom for spacing.
    const codeStyle: React.CSSProperties = {
      backgroundColor: codeBg,
      borderRadius: hasHighlight ? 2 : 0,
      position: 'relative' as const,
      // When no annotations: use original underlineStyle (borderBottom or backgroundImage)
      ...(!hasAnyAnnotation ? underlineStyle : {}),
      // When annotations: use combined background images for all underlines + waves.
      // The highlight colour is added as the last (bottom) background layer,
      // sized to cover only the content area (not the padding where waves render).
      ...(hasAnyAnnotation ? (() => {
        const allBgRepeats: string[] = allBgImages.map(() => 'repeat-x')
        // Add highlight as the last (bottom) background layer, covering only content area
        if (hasHighlight && codeBg !== 'transparent') {
          allBgImages.push(`linear-gradient(${codeBg}, ${codeBg})`)
          allBgSizes.push('100% calc(100% - 8px)')
          allBgPositions.push('top left')
          allBgRepeats.push('no-repeat')
        }
        return {
          paddingBottom: 8,
          backgroundColor: 'transparent',
          ...(allBgImages.length > 0 ? {
            backgroundImage: allBgImages.join(', '),
            backgroundSize: allBgSizes.join(', '),
            backgroundPosition: allBgPositions.join(', '),
            backgroundRepeat: allBgRepeats.join(', ')
          } : {})
        }
      })() : {})
    }

    // No memos — single atom
    if (overlapping.length === 0) {
      const content = text.slice(span.lineCharStart, span.lineCharEnd)
      const codeTitles = hasHighlight
        ? span.activeCodes.map((ac) => codeMap.get(ac.codeGuid)?.name).filter(Boolean).join(', ')
        : undefined
      return [{
        cpStart: cpOffset,
        cpEnd,
        node: (
          <span
            key={key}
            data-cpoffset={cpOffset}
            style={codeStyle}
            onContextMenu={(e) => handleContextMenu(e, span)}
            title={codeTitles}
          >
            {content}
          </span>
        )
      }]
    }

    // Sub-split at memo and quote boundaries for precise atom codepoint ranges
    const breakpoints = new Set<number>()
    breakpoints.add(cpOffset)
    breakpoints.add(cpEnd)
    for (const mr of overlapping) {
      if (mr.startCp > cpOffset && mr.startCp < cpEnd) breakpoints.add(mr.startCp)
      if (mr.endCp > cpOffset && mr.endCp < cpEnd) breakpoints.add(mr.endCp)
    }
    const sorted = [...breakpoints].sort((a, b) => a - b)

    const atoms: SpanAtom[] = []
    for (let i = 0; i < sorted.length - 1; i++) {
      const segStart = sorted[i]
      const segEnd = sorted[i + 1]
      const localStart = segStart - cpOffset
      const localEnd = segEnd - cpOffset
      const segText = spanCps.slice(localStart, localEnd).join('')

      const segMemos = overlapping.filter(
        (mr) => segStart < mr.endCp && segEnd > mr.startCp
      )
      const hasMemo = segMemos.length > 0

      const memoTitles = segMemos.map((m) => m.title || 'Content Memo').join(', ')
      const codeTitles = hasHighlight
        ? span.activeCodes.map((ac) => codeMap.get(ac.codeGuid)?.name).filter(Boolean).join(', ')
        : ''
      const titleParts = [codeTitles, hasMemo ? `Memo: ${memoTitles}` : ''].filter(Boolean)

      atoms.push({
        cpStart: segStart,
        cpEnd: segEnd,
        node: (
          <span
            key={`${key}-${i}`}
            data-cpoffset={segStart}
            style={codeStyle}
            onContextMenu={(e) => handleContextMenu(e, span)}
            title={titleParts.length > 0 ? titleParts.join(' | ') : undefined}
          >
            {segText}
          </span>
        )
      })
    }

    return atoms
  }

  const MARGIN_COL_W = 10
  const MARGIN_LABEL_W = 80
  const LABEL_LINE_H = 14 // height per label row
  const { perLine, maxCol } = marginAnnotations
  // Always reserve margin space so adding the first code doesn't cause a reflow.
  const effectiveMaxCol = Math.max(maxCol, 1)
  const bracketZoneW = effectiveMaxCol * MARGIN_COL_W + 6
  const marginW = bracketZoneW + MARGIN_LABEL_W + 4

  // Bracket overlay: measure coded text positions and render brackets in a single
  // overlay div, independent of per-line margin columns. This handles wrapped lines
  // correctly because positions are measured from actual DOM bounding rects.
  const bracketOverlayRef = useRef<HTMLDivElement>(null)
  const [iconGroups, setIconGroups] = useState<IconGroup[]>([])
  /** React-rendered label data for the bracket overlay. Labels need to
   *  live in React so mouseenter/click handlers survive overlay rebuilds. */
  interface BracketLabel {
    key: string
    left: number
    top: number
    color: string
    codeName: string
    selStartCp: number
    selEndCp: number
    selectionGuid: string
    codingGuid: string
    codeGuid: string
  }
  const [bracketLabels, setBracketLabels] = useState<BracketLabel[]>([])

  // Re-measure on container resize (e.g. when the user drags a split-pane).
  // The overlay effect below has no deps and re-runs on every render; this
  // state bump triggers that re-render after the resize has settled.
  const [resizeTick, setResizeTick] = useState(0)
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let frameId = 0
    const observer = new ResizeObserver(() => {
      // Debounce via rAF so we re-measure once after layout settles.
      if (frameId) cancelAnimationFrame(frameId)
      frameId = requestAnimationFrame(() => setResizeTick((t) => t + 1))
    })
    observer.observe(container)
    return () => {
      observer.disconnect()
      if (frameId) cancelAnimationFrame(frameId)
    }
  }, [])
  useEffect(() => {
    if (!containerRef.current || !bracketOverlayRef.current) return
    const container = containerRef.current
    const overlay = bracketOverlayRef.current
    overlay.innerHTML = ''

    // Bail only when there's nothing at all to paint. Memos and
    // quotes are independent of selections — a content memo or quote
    // can exist on uncoded text — so previously bailing on
    // `selections.length === 0` meant their icons never reached the
    // overlay.
    const hasMemos = !!contentMemos && contentMemos.length > 0
    const hasQuotes = !!quotesProp && quotesProp.length > 0
    if (selections.length === 0 && !hasMemos && !hasQuotes) {
      setBracketLabels([])
      setIconGroups([])
      return
    }

    const rafId = requestAnimationFrame(() => {
      if (!containerRef.current || !bracketOverlayRef.current) return
      const containerRect = container.getBoundingClientRect()
      const allSpans = container.querySelectorAll<HTMLSpanElement>('[data-cpoffset]')

      // Find the margin column div position (same as plain text viewer)
      // The margin column is a flex child positioned after the line content
      const firstMarginDiv = container.querySelector<HTMLDivElement>('[data-margin-col]')
      let marginLeftPx = containerRect.width - (MARGIN_LABEL_W + bracketZoneW + 14)
      if (firstMarginDiv) {
        const rect = firstMarginDiv.getBoundingClientRect()
        marginLeftPx = rect.left - containerRect.left + container.scrollLeft
      }

      // Build span data once
      interface SpanPos { cpStart: number; cpEnd: number; rects: DOMRect[] }
      const spanPositions: SpanPos[] = []
      for (const span of allSpans) {
        if (span.style.display === 'none' || !span.textContent) continue
        const cpStart = parseInt(span.dataset.cpoffset!, 10)
        const cpEnd = cpStart + [...span.textContent].length
        const rects: DOMRect[] = []
        const clientRects = span.getClientRects()
        for (let i = 0; i < clientRects.length; i++) {
          if (clientRects[i].height > 0 && clientRects[i].width > 0) rects.push(clientRects[i])
        }
        if (rects.length > 0) spanPositions.push({ cpStart, cpEnd, rects })
      }

      // Build one entry per (selection, coding) and measure each entry's
      // visual bounds from the already-collected spanPositions. Each coding
      // gets its own bar — so a selection with three codes draws three
      // brackets, each in its own column and color.
      interface Entry {
        top: number
        bottom: number
        color: string
        codeName: string
        // Selection metadata carried through so label hover / click /
        // right-click can reference the originating selection + coding.
        selStartCp: number
        selEndCp: number
        selectionGuid: string
        codingGuid: string
        codeGuid: string
      }
      const entries: Entry[] = []

      for (const sel of selections) {
        if (sel.codings.length === 0) continue

        let minTop = Infinity
        let maxBottom = -Infinity
        for (const sp of spanPositions) {
          if (sp.cpStart >= sel.endPosition || sp.cpEnd <= sel.startPosition) continue
          for (const r of sp.rects) {
            minTop = Math.min(minTop, r.top - containerRect.top + container.scrollTop)
            maxBottom = Math.max(maxBottom, r.bottom - containerRect.top + container.scrollTop)
          }
        }
        if (minTop === Infinity) continue

        for (const coding of sel.codings) {
          const code = codeMap.get(coding.codeGuid)
          if (!code) continue
          entries.push({
            top: minTop,
            bottom: maxBottom,
            color: code.color || '#888',
            codeName: code.name,
            selStartCp: sel.startPosition,
            selEndCp: sel.endPosition,
            selectionGuid: sel.guid,
            codingGuid: coding.guid,
            codeGuid: code.guid
          })
        }
      }

      // Delegate placement (clusters, columns, cap extension, labels) to
      // the shared bracketLayout helper so this viewer and the PDF viewer
      // render brackets identically.
      const placed = layoutBrackets(entries)

      // Render. Caps and bars are drawn imperatively into the overlay.
      // Labels are collected into React state (see setBracketLabels below).
      const labels: BracketLabel[] = []
      for (const p of placed) {
        const top = p.top + 2
        const height = Math.max(4, p.bottom - p.top - 4)
        const columnOriginX = marginLeftPx + 4
        const barLeft = columnOriginX + p.column * COL_W
        const topCap = capGeometry(p.column, p.topCapTargetCol, columnOriginX)
        const botCap = capGeometry(p.column, p.bottomCapTargetCol, columnOriginX)

        const capT = document.createElement('div')
        capT.style.cssText = `position:absolute; left:${topCap.left}px; top:${top}px; width:${topCap.width}px; height:2px; background:${p.color}`
        overlay.appendChild(capT)

        const bar = document.createElement('div')
        bar.style.cssText = `position:absolute; left:${barLeft}px; top:${top}px; height:${height}px; width:2px; background:${p.color}`
        overlay.appendChild(bar)

        const capB = document.createElement('div')
        capB.style.cssText = `position:absolute; left:${botCap.left}px; top:${top + height - 2}px; width:${botCap.width}px; height:2px; background:${p.color}`
        overlay.appendChild(capB)

        // Labels are rendered via React (see bracketLabels state) so their
        // event listeners survive every overlay rebuild.
        labels.push({
          key: `${p.selectionGuid}:${p.codingGuid}`,
          left: marginLeftPx + p.labelLeft,
          top: p.labelTop,
          color: p.color,
          codeName: p.codeName,
          selStartCp: p.selStartCp,
          selEndCp: p.selEndCp,
          selectionGuid: p.selectionGuid,
          codingGuid: p.codingGuid,
          codeGuid: p.codeGuid
        })
      }
      setBracketLabels(labels)

      // --- Memo + quote icon groups ----------------------------------
      // Measure the visual top/bottom Y of an arbitrary codepoint range
      // by creating a precise DOM Range over the target chars. Using the
      // pre-computed span rects here would be wrong for memos / quotes:
      // a single [data-cpoffset] span can wrap across multiple lines
      // (atoms aren't split at memo/quote boundaries), so including the
      // whole span's rects drags `minT` up to a line above where the
      // target range actually starts — the quote icon then renders
      // above the quoted text.
      const measureRange = (
        startCp: number,
        endCp: number
      ): { top: number; bottom: number } | null => {
        let minT = Infinity
        let maxB = -Infinity
        for (const span of allSpans) {
          if (!span.textContent) continue
          const spanCpStart = parseInt(span.dataset.cpoffset!, 10)
          if (isNaN(spanCpStart)) continue
          const spanChars = [...span.textContent]
          const spanCpEnd = spanCpStart + spanChars.length
          if (spanCpEnd <= startCp || spanCpStart >= endCp) continue

          // Walk the text nodes inside this span; build a precise sub-
          // range for the portion overlapping [startCp, endCp].
          const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT)
          let cursor = spanCpStart
          let tn: Node | null
          while ((tn = walker.nextNode()) !== null) {
            const text = tn.textContent || ''
            const chars = [...text]
            const nodeCpEnd = cursor + chars.length
            if (nodeCpEnd <= startCp || cursor >= endCp) {
              cursor = nodeCpEnd
              continue
            }
            const overlapStart = Math.max(startCp, cursor) - cursor
            const overlapEnd = Math.min(endCp, nodeCpEnd) - cursor
            if (overlapStart >= overlapEnd) {
              cursor = nodeCpEnd
              continue
            }
            // Convert codepoint offsets → UTF-16 char offsets.
            let charStart = 0
            for (let i = 0; i < overlapStart; i++) charStart += chars[i].length
            let charEnd = charStart
            for (let i = overlapStart; i < overlapEnd; i++) charEnd += chars[i].length
            try {
              const range = document.createRange()
              range.setStart(tn, charStart)
              range.setEnd(tn, charEnd)
              const rects = range.getClientRects()
              for (let i = 0; i < rects.length; i++) {
                const r = rects[i]
                if (r.width <= 0 || r.height <= 0) continue
                minT = Math.min(minT, r.top - containerRect.top + container.scrollTop)
                maxB = Math.max(maxB, r.bottom - containerRect.top + container.scrollTop)
              }
            } catch { /* ignore cross-node ranges */ }
            cursor = nodeCpEnd
          }
        }
        return minT === Infinity ? null : { top: minT, bottom: maxB }
      }

      const items = buildIconItems(contentMemos, quotesProp, ({ startPosition, endPosition }) => {
        if (startPosition === undefined) return null
        return measureRange(startPosition, endPosition ?? startPosition + 1)
      })
      const baseGroups = layoutIcons(items)

      // Pack each icon as close as possible to any overlapping code-name
      // label, matching the RichMarginColumn behaviour. Coordinates are
      // container-absolute (same origin as the bracket labels below).
      const LABEL_TO_ICON_GAP = 4
      const columnOriginX = marginLeftPx + 4
      const baseLeftFor = (iconTop: number): number => {
        let x = marginLeftPx
        const iconBot = iconTop + LABEL_H
        for (const p of placed) {
          const labelBot = p.labelTop + LABEL_H
          const labelOverlaps = p.labelTop < iconBot && labelBot > iconTop
          if (labelOverlaps) {
            const rendered = Math.min(MARGIN_LABEL_W, measureLabelWidth(p.codeName))
            x = Math.max(x, marginLeftPx + p.labelLeft + rendered + LABEL_TO_ICON_GAP)
            continue
          }
          // Bar-only overlap (label is stacked on a different row): sit
          // just right of the bracket column.
          const barTop = p.top + 2
          const barBot = Math.max(barTop + 2, p.bottom - 2)
          if (barTop < iconBot && barBot > iconTop) {
            x = Math.max(x, columnOriginX + (p.column + 1) * COL_W + LABEL_GAP)
          }
        }
        return x
      }
      const packedGroups: IconGroup[] = baseGroups.map((g) => {
        let left = baseLeftFor(g.top)
        if (g.type === 'memo') {
          const matchingQuote = baseGroups.find(
            (q) => q.type === 'quote' && Math.abs(q.top - g.top) < LINE_GROUP_TOLERANCE
          )
          if (matchingQuote) left += ICON_COL_W
        }
        return { ...g, leftX: left }
      })
      setIconGroups(packedGroups)
    })
    return () => cancelAnimationFrame(rafId)
  })

  return (
    <div
      ref={containerRef}
      className="text-document"
      onMouseUp={handleMouseUp}
      onMouseDown={() => { if (lockedRange) setLockedRange(null) }}
      style={{
        fontFamily: 'var(--font-doc)',
        fontSize: 14,
        paddingTop: 4,
        cursor: 'text',
        position: 'relative',
        userSelect: 'text'
      }}
    >
      {/* Bracket overlay — positioned by DOM measurement, independent of line wrapping */}
      <div ref={bracketOverlayRef} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none', zIndex: 1 }} />
      {/* Label overlay — React-rendered so mouseenter/click handlers
          persist across overlay rebuilds. Labels live in their own layer
          so the imperative bracket-shapes layer can be freely cleared. */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none', zIndex: 1 }}>
        {bracketLabels.map((lb) => {
          const range = { startCp: lb.selStartCp, endCp: lb.selEndCp }
          return (
            <CodeLabel
              key={lb.key}
              left={lb.left}
              top={lb.top}
              color={lb.color}
              maxWidth={MARGIN_LABEL_W}
              text={lb.codeName}
              onMouseEnter={() => setHoveredRange(range)}
              onMouseLeave={() => { if (!lockedRange) setHoveredRange(null) }}
              onClick={() => {
                if (lockedRange && lockedRange.startCp === range.startCp && lockedRange.endCp === range.endCp) {
                  setLockedRange(null)
                } else {
                  setLockedRange(range)
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onCodingRightClick(e, {
                  existingCodings: [{
                    selectionGuid: lb.selectionGuid,
                    codingGuid: lb.codingGuid,
                    codeGuid: lb.codeGuid,
                    startCp: lb.selStartCp,
                    endCp: lb.selEndCp
                  }]
                })
              }}
            />
          )
        })}
      </div>
      {/* Memo + quote icon overlay — shared with the PDF viewer via
          MemoQuoteIcons. Anchored to the far right of the container; the
          per-line reserved space in the text flow leaves a 36-px column
          that these icons occupy. */}
      {/* Icon overlay spans the full container so each icon's `leftX`
          (set by the layout pass above in container-absolute coords)
          places it directly. */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none', zIndex: 2 }}>
        <MemoQuoteIcons
          groups={iconGroups}
          findMemo={(guid) => useMemoStore.getState().findMemo(guid)}
          onMemoClick={onMemoClick}
          onMemoPopup={(e, memos) => setMemoPopup({ items: memos, x: e.clientX, y: e.clientY })}
          onMemoContextMenu={(e, memos) => {
            onCodingRightClick(e, {
              existingCodings: [],
              overlappingMemos: memos.map((m) => ({
                guid: m.guid,
                title: m.title || 'Untitled Memo',
                startCp: m.startPosition ?? 0,
                endCp: m.endPosition ?? m.startPosition ?? 0
              }))
            })
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
            if (qs.length === 1) setLockedRange({ startCp: qs[0].startCp, endCp: qs[0].endCp })
            setMemoPopup({ items, x: e.clientX, y: e.clientY, isQuote: true, showDelete })
          }}
        />
      </div>
      {lines.map((line, lineIdx) => {
        const lineAnns = perLine[lineIdx]?.annotations ?? []
        const fmtLine = formatAnnotations?.[lineIdx]
        const fmtBlockClass = fmtLine?.blockClass || ''

        // Check if this line overlaps with the playback highlight range
        const lineSpans = line.spans
        const lineCpS = lineSpans.length > 0 ? lineSpans[0].cpStart : 0
        const lineCpE = lineSpans.length > 0 ? lineSpans[lineSpans.length - 1].cpEnd : 0
        const isPlaybackLine = playbackHighlightRange
          ? lineCpS < playbackHighlightRange.endCp && lineCpE > playbackHighlightRange.startCp
          : false

        return (
          <div
            key={lineIdx}
            style={{
              ...TRANSCRIPT_ROW_STYLE,
              // Fixed-pixel line-box so the smaller gutter span
              // inherits the same line-box height as the body. Without
              // this the gutter's line-height computes as a multiple
              // of its own 10px font, leaving the gutter label floating
              // above the body's baseline. Identical values to the
              // video transcript viewer's LINE_HEIGHT (22px) so all
              // text-row layouts share one source of truth.
              minHeight: 22,
              lineHeight: '22px',
              background: isPlaybackLine ? 'var(--selection-bg)' : undefined,
              borderRadius: isPlaybackLine ? 2 : undefined
            }}
          >
            {/* Line number or timestamp. Same TranscriptGutter that the
                video transcript uses, so widths, padding, and the active-
                playback treatment stay in sync across all three viewers.
                Hidden entirely for SurveyViewer (hideLineNumbers). */}
            {hideLineNumbers ? null : lineTimestamps ? (() => {
              const ts = lineTimestamps.get(lineIdx)
              const isActive = activeTimestampLine === lineIdx
              return (
                <TranscriptGutter
                  text={ts ? ts.text : ''}
                  active={isActive}
                  invisible={!ts}
                  onClick={ts && onTimestampClick ? () => onTimestampClick(ts.seconds) : undefined}
                  title={ts ? `Jump to ${ts.text}` : undefined}
                />
              )
            })() : (
              <TranscriptGutter text={String(lineIdx + 1)} width={lineNumberGutterWidth} />
            )}
            {/* Line content */}
            <span
              className={fmtBlockClass || undefined}
              style={{
                flex: 1,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word'
              }}
              onContextMenu={(e) => {
                // If right-clicking on unhighlighted area with a text selection
                const sel = window.getSelection()
                if (sel && !sel.isCollapsed) {
                  handleContextMenu(e, {
                    charStart: 0, charEnd: 0,
                    cpStart: 0, cpEnd: 0,
                    activeCodes: [],
                    lineCharStart: 0, lineCharEnd: 0
                  } as any)
                }
              }}
            >
              {(() => {
                // Build precise atoms (sub-split at memo boundaries) for all spans.
                let atoms: SpanAtom[] = []
                for (let si = 0; si < line.spans.length; si++) {
                  atoms.push(...buildSpanAtoms(line.spans[si], `${lineIdx}-${si}`))
                }
                if (atoms.length === 0) return null

                // Hide atoms that overlap with hidden ranges (e.g. timestamp prefixes).
                // For atoms fully inside a hidden range: remove entirely.
                // For atoms partially overlapping: trim the displayed text.
                if (hiddenRanges && hiddenRanges.length > 0) {
                  const filtered: SpanAtom[] = []
                  for (const a of atoms) {
                    const hr = hiddenRanges.find((r) => r.cpStart < a.cpEnd && r.cpEnd > a.cpStart)
                    if (!hr) { filtered.push(a); continue }
                    // Fully hidden
                    if (a.cpStart >= hr.cpStart && a.cpEnd <= hr.cpEnd) continue
                    // Partial overlap: the hidden range covers the start of this atom
                    if (hr.cpEnd > a.cpStart && hr.cpEnd < a.cpEnd) {
                      // Trim the beginning — render only the portion after the hidden range
                      const trimCps = hr.cpEnd - a.cpStart
                      const origText = (a.node as any)?.props?.children
                      if (typeof origText === 'string') {
                        const trimmedText = [...origText].slice(trimCps).join('')
                        filtered.push({
                          cpStart: hr.cpEnd,
                          cpEnd: a.cpEnd,
                          node: <span key={(a.node as any)?.key + '-t'} data-cpoffset={hr.cpEnd} style={(a.node as any)?.props?.style}>{trimmedText}</span>
                        })
                      } else {
                        filtered.push(a) // can't trim, keep as-is
                      }
                    } else {
                      filtered.push(a) // other partial overlaps — keep
                    }
                  }
                  atoms = filtered
                  // A transcript line that consists only of a hidden timestamp
                  // prefix (e.g. "[00:00:00] " with nothing after) leaves the
                  // atoms list empty. Bail out before atoms[0] below crashes.
                  if (atoms.length === 0) return null
                }

                // Apply format-specific inline styles — sub-split atoms at range boundaries
                const fmtInline = fmtLine?.inline
                if (fmtInline && fmtInline.length > 0) {
                  // Collect all boundary codepoints from format ranges
                  const fmtBreaks = new Set<number>()
                  for (const r of fmtInline) {
                    fmtBreaks.add(r.cpStart)
                    fmtBreaks.add(r.cpEnd)
                  }

                  // Sub-split atoms at format boundaries
                  const splitAtoms: typeof atoms = []
                  for (const atom of atoms) {
                    // Collect breaks that fall inside this atom
                    const innerBreaks = [...fmtBreaks].filter(
                      (bp) => bp > atom.cpStart && bp < atom.cpEnd
                    ).sort((a, b) => a - b)

                    if (innerBreaks.length === 0) {
                      splitAtoms.push(atom)
                    } else {
                      // Split the atom's text at these breakpoints
                      const origNode = atom.node as React.ReactElement
                      const origText = origNode?.props?.children as string || ''
                      const origCps = [...origText]
                      const allBounds = [atom.cpStart, ...innerBreaks, atom.cpEnd]

                      for (let bi = 0; bi < allBounds.length - 1; bi++) {
                        const subCpStart = allBounds[bi]
                        const subCpEnd = allBounds[bi + 1]
                        const localStart = subCpStart - atom.cpStart
                        const localEnd = subCpEnd - atom.cpStart
                        const subText = origCps.slice(localStart, localEnd).join('')
                        if (subText.length === 0) continue

                        const subNode = React.cloneElement(origNode, {
                          key: `${origNode.key}-sub${bi}`,
                          'data-cpoffset': subCpStart,
                          children: subText
                        })
                        splitAtoms.push({ cpStart: subCpStart, cpEnd: subCpEnd, node: subNode })
                      }
                    }
                  }

                  // Apply styles to sub-atoms
                  for (const atom of splitAtoms) {
                    const overlapping = fmtInline.filter(
                      (r) => r.cpStart <= atom.cpStart && r.cpEnd >= atom.cpEnd
                    )
                    if (overlapping.length > 0) {
                      const isHidden = overlapping.some((r) => r.hidden)
                      const extraStyle: React.CSSProperties = isHidden
                        ? { display: 'inline-block', width: 0, overflow: 'hidden', fontSize: 0, lineHeight: 0 }
                        : {}
                      if (!isHidden) {
                        for (const r of overlapping) {
                          if (!r.hidden) Object.assign(extraStyle, r.style)
                        }
                      }
                      const origNode = atom.node as React.ReactElement
                      if (origNode?.props) {
                        atom.node = React.cloneElement(origNode, {
                          style: { ...origNode.props.style, ...extraStyle }
                        })
                      }
                    }
                  }

                  // Replace atoms with sub-split versions
                  atoms.length = 0
                  atoms.push(...splitAtoms)
                }

                const lineCpStart = atoms[0].cpStart
                const lineCpEnd = atoms[atoms.length - 1].cpEnd

                // Wrap memo ranges in continuous spans with wave background.
                const lineMemoRanges = memoRanges.filter(
                  (mr) => mr.startCp < lineCpEnd && mr.endCp > lineCpStart
                )
                if (lineMemoRanges.length === 0) {
                  return atoms.map((a) => a.node)
                }

                // Merge overlapping memo ranges
                const merged: { startCp: number; endCp: number }[] = []
                const sorted = [...lineMemoRanges].sort((a, b) => a.startCp - b.startCp)
                for (const r of sorted) {
                  const s = Math.max(r.startCp, lineCpStart)
                  const e = Math.min(r.endCp, lineCpEnd)
                  if (merged.length > 0 && s <= merged[merged.length - 1].endCp) {
                    merged[merged.length - 1].endCp = Math.max(merged[merged.length - 1].endCp, e)
                  } else {
                    merged.push({ startCp: s, endCp: e })
                  }
                }

                // Wrap atoms inside memo ranges with a single continuous wave span
                const result: React.ReactNode[] = []
                let ai = 0
                for (const mr of merged) {
                  // Atoms before this memo range
                  while (ai < atoms.length && atoms[ai].cpEnd <= mr.startCp) {
                    result.push(atoms[ai].node); ai++
                  }
                  // Atoms inside this memo range
                  const children: React.ReactNode[] = []
                  while (ai < atoms.length && atoms[ai].cpStart < mr.endCp) {
                    children.push(atoms[ai].node); ai++
                  }
                  if (children.length > 0) {
                    result.push(
                      <span
                        key={`memo-wrap-${lineIdx}-${mr.startCp}`}
                        style={{
                          paddingBottom: 5,
                          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='2.25'%3E%3Cpath d='M0 2.25 L3 0 L6 2.25 L9 0 L12 2.25' fill='none' stroke='%234a90d9' stroke-width='1'/%3E%3C/svg%3E")`,
                          backgroundSize: '12px 2.25px',
                          backgroundPosition: 'bottom left',
                          backgroundRepeat: 'repeat-x'
                        }}
                      >
                        {children}
                      </span>
                    )
                  }
                }
                while (ai < atoms.length) { result.push(atoms[ai].node); ai++ }
                return result
              })()}
            </span>
            {/* Right margin: code annotations */}
            {marginW > 0 && (
              <div
                data-margin-col="1"
                style={{
                  width: marginW,
                  minWidth: marginW,
                  flexShrink: 0,
                  alignSelf: 'stretch',
                  position: 'relative',
                  userSelect: 'none',
                  marginLeft: 8
                }}
              >
                {/* Per-line bracket/label rendering removed — overlay handles this */}
              </div>
            )}
            {/* Empty space reserved for the memo + quote icons — icons are
                drawn absolutely in an overlay so their Y positions match
                segment tops regardless of where the memo's start codepoint
                lands within wrapped text. */}
            <div
              style={{
                display: 'flex',
                flexShrink: 0,
                paddingLeft: 2,
                paddingRight: 4,
                width: 18 * 2 + 2 + 4,
                minWidth: 18 * 2 + 2 + 4
              }}
            />
          </div>
        )
      })}

      {/* Memo/Quote picker popup */}
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
                onMouseLeave={() => {
                  setHoveredRange(null)
                }}
                onClick={() => {
                  if (m.startPosition !== undefined && m.endPosition !== undefined && m.startPosition !== m.endPosition) {
                    setLockedRange({ startCp: m.startPosition, endCp: m.endPosition })
                  }
                  if (!memoPopup.isQuote) onMemoClick?.(m.guid)
                  setMemoPopup(null)
                }}
              >
                <Icon
                  icon={memoPopup.isQuote ? QUOTE_ICON : (m.startPosition === m.endPosition ? MEMO_POINT_ICON : MEMO_RANGED_ICON)}
                  style={{ marginRight: 6, fontSize: 10, color: memoPopup.isQuote ? '#d94a4a' : undefined }}
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
                    style={{ color: 'var(--danger)' }}
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
