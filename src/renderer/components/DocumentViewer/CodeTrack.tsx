/**
 * CodeTrack — horizontal time track sitting beneath the video player.
 *
 * The playhead is fixed at the horizontal centre; the track content slides
 * underneath it as the video plays. Codes are rendered as horizontal
 * brackets nested in vertically-stacked lanes (no cap — the track grows
 * as needed to fit overlapping codes).
 *
 * Interactions:
 *  - Click anywhere on the track background: seek the video to that point.
 *  - Drop a code (from the CodeBrowser) onto the track: create a new
 *    time-range coding starting at the current playhead position, default
 *    length 4 seconds, clamped to the video bounds.
 *  - Drag either end handle of a bracket: resize the code's time range.
 *  - Drag the middle of a bracket: shift the code in time without
 *    changing its length.
 *  - Right-click a bracket: show a remove-code context menu.
 */
import { useRef, useEffect, useState, useCallback, useMemo, type ReactNode } from 'react'
import { useDocumentStore } from '../../stores/document-store'
import { useCodeStore } from '../../stores/code-store'
import { ViewerZoomToolbar } from './ViewerZoomToolbar'
import type { Code, PlainTextSelection } from '../../models/types'
import {
  clamp,
  formatTime,
  formatTimeDecimal,
  snapTimeToSecond,
  DEFAULT_PX_PER_SECOND,
  MIN_PX_PER_SECOND,
  MAX_PX_PER_SECOND,
  LANE_HEIGHT,
  LANE_GAP,
  TRACK_TOP_PADDING
} from './video-time-utils'
import { useTranslation } from 'react-i18next'

interface Props {
  sourceGuid: string
  selections: PlainTextSelection[]
  duration: number
  /** Last known playhead time. Used for anything that needs a React-level
   *  re-render (drop position, bracket geometry after seek). The actual
   *  smooth scroll of the track is driven by `getCurrentTime()` below so
   *  we're not bottlenecked by `timeupdate`'s 4 Hz cadence. */
  currentTime: number
  /** Live read-out of the underlying <video> element's currentTime. Called
   *  every animation frame from a rAF loop inside the track to update the
   *  transform directly in the DOM, bypassing React entirely. */
  getCurrentTime: () => number
  pxPerSecond: number
  onSeek: (seconds: number) => void
  onZoomChange: (pxPerSec: number) => void
}

interface Lane {
  selections: { sel: PlainTextSelection; startTime: number; endTime: number }[]
}

/** Compute a nesting-lane assignment for a set of time-range selections.
 *  Sorted by startTime. Each bracket takes the lowest-index lane where it
 *  doesn't overlap any existing bracket. No cap on lane count. */
function assignLanes(selections: PlainTextSelection[]): Map<string, number> {
  const timed = selections
    .filter((s) => !!s.timeRange)
    .map((s) => ({ sel: s, startTime: s.timeRange!.startTime, endTime: s.timeRange!.endTime }))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)

  const lanes: Lane[] = []
  const result = new Map<string, number>()
  for (const t of timed) {
    let lane = 0
    while (lane < lanes.length) {
      const occupied = lanes[lane].selections.some(
        (other) => other.endTime > t.startTime && other.startTime < t.endTime
      )
      if (!occupied) break
      lane++
    }
    if (lane >= lanes.length) lanes.push({ selections: [] })
    lanes[lane].selections.push(t)
    result.set(t.sel.guid, lane)
  }
  return result
}

/** Pick a ruler tick interval (seconds) so ticks land 60-120 px apart. */
function pickTickInterval(pxPerSecond: number): number {
  const candidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800]
  for (const c of candidates) {
    if (c * pxPerSecond >= 80) return c
  }
  return 3600
}

function findCode(codes: Code[], guid: string): Code | undefined {
  for (const c of codes) {
    if (c.guid === guid) return c
    const child = findCode(c.children, guid)
    if (child) return child
  }
  return undefined
}

export function CodeTrack({
  sourceGuid,
  selections,
  duration,
  currentTime,
  getCurrentTime,
  pxPerSecond,
  onSeek,
  onZoomChange
}: Props) {
  const { t } = useTranslation()
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [viewportWidth, setViewportWidth] = useState(800)
  const codes = useCodeStore((s) => s.codes)

  const addTimeRangeSelection = useDocumentStore((s) => s.addTimeRangeSelection)
  const addCodingToSelection = useDocumentStore((s) => s.addCodingToSelection)
  const updateSelectionTimeRange = useDocumentStore((s) => s.updateSelectionTimeRange)
  const removeCoding = useDocumentStore((s) => s.removeCoding)
  const removeSelection = useDocumentStore((s) => s.removeSelection)

  // Observe the viewport width so the playhead stays at the actual centre.
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewportWidth(el.clientWidth))
    ro.observe(el)
    setViewportWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const laneByGuid = useMemo(() => assignLanes(selections), [selections])
  const timeRangeSelections = useMemo(
    () => selections.filter((s) => !!s.timeRange),
    [selections]
  )
  const laneCount = useMemo(() => {
    let max = -1
    for (const lane of laneByGuid.values()) if (lane > max) max = lane
    return max + 1
  }, [laneByGuid])

  // Translate x (in seconds) into a pixel position inside the scrollable
  // track content. The scrollable content is transform-translated so that
  // currentTime lands at the viewport centre.
  const centreX = viewportWidth / 2
  const contentWidth = Math.max(viewportWidth, duration * pxPerSecond)

  // Keep a ref to the latest scroll parameters so the rAF loop reads live
  // values without having to restart on every zoom / resize change.
  const scrollParamsRef = useRef({ getCurrentTime, centreX, pxPerSecond })
  useEffect(() => {
    scrollParamsRef.current = { getCurrentTime, centreX, pxPerSecond }
  }, [getCurrentTime, centreX, pxPerSecond])

  // rAF loop: runs continuously while the component is mounted, updating
  // the track-content transform every animation frame based on the video
  // element's live currentTime. This bypasses React's render cycle
  // entirely, giving buttery-smooth scrolling regardless of how often
  // `timeupdate` happens to fire.
  useEffect(() => {
    let raf = 0
    let lastOffset = Number.NaN
    const tick = () => {
      const { getCurrentTime: gct, centreX: cx, pxPerSecond: pps } = scrollParamsRef.current
      const offset = cx - gct() * pps
      // Only touch the DOM when the offset actually changes — this is a
      // tight loop and skipping no-op writes keeps the profile clean.
      if (offset !== lastOffset) {
        lastOffset = offset
        if (contentRef.current) {
          contentRef.current.style.transform = `translateX(${offset}px)`
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const tickInterval = pickTickInterval(pxPerSecond)
  const ticks = useMemo(() => {
    const arr: number[] = []
    for (let t = 0; t <= duration + tickInterval; t += tickInterval) {
      arr.push(Number(t.toFixed(3)))
    }
    return arr
  }, [duration, tickInterval])

  // Drag state for resize / move.
  const [drag, setDrag] = useState<{
    selGuid: string
    mode: 'resize-start' | 'resize-end' | 'move'
    originalRange: { startTime: number; endTime: number }
    startClientX: number
  } | null>(null)

  useEffect(() => {
    if (!drag) return
    const onMove = (e: MouseEvent) => {
      const deltaPx = e.clientX - drag.startClientX
      const deltaSec = deltaPx / pxPerSecond
      let start = drag.originalRange.startTime
      let end = drag.originalRange.endTime
      if (drag.mode === 'resize-start') {
        start = clamp(start + deltaSec, 0, end - 1)
      } else if (drag.mode === 'resize-end') {
        end = clamp(end + deltaSec, start + 1, duration)
      } else {
        const len = end - start
        const maxStart = Math.max(0, duration - len)
        start = clamp(start + deltaSec, 0, maxStart)
        end = start + len
      }
      // Snap to whole seconds so the bracket's time matches what the
      // transcript gutter will show (HH:MM:SS — one row per integer
      // second). Preserve a minimum 1-second duration after snap.
      start = snapTimeToSecond(start)
      end = snapTimeToSecond(end)
      if (end <= start) end = Math.min(Math.floor(duration), start + 1)
      if (end <= start && start > 0) start = Math.max(0, end - 1)
      updateSelectionTimeRange(sourceGuid, drag.selGuid, { startTime: start, endTime: end })
    }
    const onUp = () => setDrag(null)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [drag, duration, pxPerSecond, sourceGuid, updateSelectionTimeRange])

  // Cmd/Ctrl + wheel to zoom. Plain wheel scrolls horizontally (== seek).
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const delta = -e.deltaY * 0.005
        onZoomChange(clamp(pxPerSecond * (1 + delta), MIN_PX_PER_SECOND, MAX_PX_PER_SECOND))
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault()
        onSeek(clamp(getCurrentTime() + e.deltaX / pxPerSecond, 0, duration))
      }
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [pxPerSecond, onZoomChange, onSeek, getCurrentTime, duration])

  // Click on empty track background → seek. Uses the live playhead time so
  // clicks during playback land on the intended position rather than the
  // stale `currentTime` prop that only updates on `timeupdate` ticks.
  const handleBackgroundClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).dataset.bracket === '1') return
    const rect = viewportRef.current?.getBoundingClientRect()
    if (!rect) return
    const liveTime = getCurrentTime()
    const liveOffset = centreX - liveTime * pxPerSecond
    const xInViewport = e.clientX - rect.left
    const xInContent = xInViewport - liveOffset
    const seekTo = clamp(xInContent / pxPerSecond, 0, duration)
    onSeek(seekTo)
  }, [centreX, pxPerSecond, duration, onSeek, getCurrentTime])

  // Drop handler — add a code starting at the playhead.
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
    if (codeGuids.length === 0) return

    // Default length: 4 seconds, clamped so the code never extends
    // past the end of the video. If the playhead sits near the end, the
    // clamp produces a shorter code rather than an invisible one. Read the
    // playhead live so a drop during playback lands on the actual current
    // frame instead of the last `timeupdate` snapshot. Snap start/end to
    // whole seconds so the bracket's time matches the HH:MM:SS timestamp
    // shown in the transcript gutter.
    const defaultLen = 4
    const rawStart = clamp(getCurrentTime(), 0, duration)
    let start = snapTimeToSecond(rawStart)
    let end = snapTimeToSecond(Math.min(start + defaultLen, duration))
    if (end <= start) end = Math.min(Math.floor(duration), start + 1)
    if (end <= start && start > 0) start = Math.max(0, end - 1)
    const selGuid = addTimeRangeSelection(sourceGuid, start, end)
    for (const codeGuid of codeGuids) {
      addCodingToSelection(sourceGuid, selGuid, codeGuid)
    }
  }, [sourceGuid, getCurrentTime, duration, addTimeRangeSelection, addCodingToSelection])

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; selGuid: string } | null>(null)
  useEffect(() => {
    if (!ctxMenu) return
    const close = (ev: MouseEvent) => {
      if (!(ev.target as HTMLElement).closest('.context-menu')) setCtxMenu(null)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [ctxMenu])

  const trackHeight = TRACK_TOP_PADDING + Math.max(1, laneCount) * (LANE_HEIGHT + LANE_GAP) + 6

  return (
    <div
      ref={viewportRef}
      className="code-track"
      style={{
        position: 'relative',
        width: '100%',
        height: trackHeight,
        background: 'var(--bg-panel)',
        borderBottom: '1px solid var(--border-color)',
        overflow: 'hidden',
        cursor: 'pointer',
        userSelect: 'none',
        flexShrink: 0,
        outline: isDragOver ? '2px dashed var(--accent)' : 'none',
        outlineOffset: -2
      }}
      onClick={handleBackgroundClick}
      onDragOver={(e) => {
        if (
          e.dataTransfer.types.includes('application/x-magnolia-code') ||
          e.dataTransfer.types.includes('application/x-magnolia-codes')
        ) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setIsDragOver(true)
        }
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
    >
      {/* Track content — transform-translated each frame by the rAF loop
          above so currentTime lands at centre without any React-render
          latency. The initial transform is set inline to avoid a flash
          before the first frame fires. */}
      <div
        ref={contentRef}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: contentWidth,
          height: '100%',
          transform: `translateX(${centreX - currentTime * pxPerSecond}px)`,
          willChange: 'transform'
        }}
      >
        {/* Ruler ticks */}
        {ticks.map((t) => (
          <div
            key={t}
            style={{
              position: 'absolute',
              left: t * pxPerSecond,
              top: 0,
              bottom: 0,
              borderInlineStart: '1px solid var(--border-color)',
              opacity: 0.55,
              pointerEvents: 'none'
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: 2,
                left: 3,
                fontSize: 10,
                color: 'var(--text-muted)',
                fontFamily: 'var(--font-mono)',
                whiteSpace: 'nowrap'
              }}
            >
              {formatTime(t)}
            </span>
          </div>
        ))}

        {/* Code brackets */}
        {timeRangeSelections.map((sel) => {
          const lane = laneByGuid.get(sel.guid) ?? 0
          const top = TRACK_TOP_PADDING + lane * (LANE_HEIGHT + LANE_GAP)
          const left = sel.timeRange!.startTime * pxPerSecond
          const width = Math.max(
            6,
            (sel.timeRange!.endTime - sel.timeRange!.startTime) * pxPerSecond
          )
          const code = sel.codings.length > 0 ? findCode(codes, sel.codings[0].codeGuid) : undefined
          const color = code?.color || 'var(--accent)'
          return (
            <div
              key={sel.guid}
              data-bracket="1"
              style={{
                position: 'absolute',
                left,
                top,
                width,
                height: LANE_HEIGHT,
                background: color,
                opacity: 0.85,
                borderRadius: 2,
                display: 'flex',
                alignItems: 'center',
                paddingInlineStart: 6,
                paddingInlineEnd: 6,
                color: '#fff',
                fontSize: 10,
                fontWeight: 600,
                cursor: 'grab',
                boxShadow: '0 1px 2px rgba(0,0,0,0.18)',
                overflow: 'hidden'
              }}
              onMouseDown={(e) => {
                if (e.button !== 0) return
                e.stopPropagation()
                const target = e.target as HTMLElement
                const mode = target.dataset.handle === 'start'
                  ? 'resize-start'
                  : target.dataset.handle === 'end'
                    ? 'resize-end'
                    : 'move'
                setDrag({
                  selGuid: sel.guid,
                  mode,
                  originalRange: { ...sel.timeRange! },
                  startClientX: e.clientX
                })
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setCtxMenu({ x: e.clientX, y: e.clientY, selGuid: sel.guid })
              }}
              title={t('viewer.codeTimeRange', { code: code?.name ?? t('viewer.code'), start: formatTimeDecimal(sel.timeRange!.startTime), end: formatTimeDecimal(sel.timeRange!.endTime) })}
            >
              <span
                data-handle="start"
                data-bracket="1"
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: 5,
                  cursor: 'ew-resize',
                  background: 'rgba(0,0,0,0.2)',
                  borderTopLeftRadius: 2,
                  borderBottomLeftRadius: 2
                }}
              />
              <span
                style={{
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  textShadow: '0 1px 1px rgba(0,0,0,0.3)',
                  pointerEvents: 'none'
                }}
              >
                {code?.name ?? ''}
              </span>
              <span
                data-handle="end"
                data-bracket="1"
                style={{
                  position: 'absolute',
                  right: 0,
                  top: 0,
                  bottom: 0,
                  width: 5,
                  cursor: 'ew-resize',
                  background: 'rgba(0,0,0,0.2)',
                  borderTopRightRadius: 2,
                  borderBottomRightRadius: 2
                }}
              />
            </div>
          )
        })}
      </div>

      {/* Reset-zoom "100%" button — floats in the top-right of the track.
          Only appears when the zoom has been changed; clicking snaps the
          pixels-per-second back to the default. Matches the floating
          toolbar used by the PDF and image viewers. */}
      <div style={{ position: 'absolute', top: 6, right: 10, zIndex: 20, pointerEvents: 'auto' }}>
        <ViewerZoomToolbar
          zoom={pxPerSecond / DEFAULT_PX_PER_SECOND}
          onZoomChange={(next) => onZoomChange(
            clamp(next * DEFAULT_PX_PER_SECOND, MIN_PX_PER_SECOND, MAX_PX_PER_SECOND)
          )}
        />
      </div>

      {/* Fixed-centre playhead */}
      <div
        style={{
          position: 'absolute',
          left: centreX,
          top: 0,
          bottom: 0,
          width: 2,
          background: 'var(--danger)',
          transform: 'translateX(-1px)',
          pointerEvents: 'none',
          zIndex: 5
        }}
      >
        {/* Downward-pointing triangle at the top of the playhead — the
            point sits directly on the 2-px playhead line. Built with CSS
            borders so no SVG is needed. The parent bar sits at [0, 2] in
            its own coord space (its 1-px leftward transform centres the
            bar on centreX), so a 12-px-wide triangle must start at -5 to
            have its midpoint land on the bar's centre at x=1. */}
        <div
          style={{
            position: 'absolute',
            left: -4,
            top: 0,
            width: 0,
            height: 0,
            borderInlineStart: '5px solid transparent',
            borderInlineEnd: '5px solid transparent',
            borderTop: '8px solid var(--danger)'
          }}
        />
      </div>

      {/* Right-click context menu */}
      {ctxMenu && (() => {
        const sel = selections.find((s) => s.guid === ctxMenu.selGuid)
        if (!sel) return null as ReactNode
        return (
          <div
            className="context-menu"
            style={{ left: ctxMenu.x, top: ctxMenu.y, position: 'fixed', zIndex: 1000 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: '4px 14px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>{t('viewer.removeCode')}</div>
            {sel.codings.map((c) => {
              const code = findCode(codes, c.codeGuid)
              return (
                <div
                  key={c.guid}
                  className="context-menu-item"
                  style={{ color: 'var(--danger)' }}
                  onClick={() => {
                    removeCoding(sourceGuid, sel.guid, c.guid)
                    if (sel.codings.length <= 1) removeSelection(sourceGuid, sel.guid)
                    setCtxMenu(null)
                  }}
                >
                  <span className="color-pip" style={{ background: code?.color || '#888' }} />
                  {code?.name ?? t('common.unknown')}
                </div>
              )
            })}
            <div className="context-menu-separator" />
            <div
              className="context-menu-item"
              onClick={() => {
                removeSelection(sourceGuid, sel.guid)
                setCtxMenu(null)
              }}
            >
              {t('viewer.removeSelection')}
            </div>
          </div>
        )
      })()}
    </div>
  )
}
