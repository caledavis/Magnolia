/**
 * WaveformSeekBar — media seek bar drawn as an audio waveform.
 *
 * Thin mirrored bars; the portion before the playhead is filled with the
 * accent colour, the rest with the border colour. Rendered as SVG so the
 * theme's CSS variables apply directly (and live on theme switch).
 *
 * While `peaks` is null (still decoding, or the audio couldn't be
 * decoded) it falls back to the plain progress bar.
 *
 * The played portion is set imperatively, not through React: media
 * `timeupdate` only fires ~4×/s, so while playing the bar polls
 * `getProgress` every animation frame instead — without re-rendering the
 * viewer (transcript, code track) 60 times a second.
 */
import { forwardRef, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { peakToHeight, resamplePeaks } from '../../utils/waveform-peaks'

interface Props {
  peaks: Float32Array | null
  /** 0..1 — used while paused (and after seeks). */
  progress: number
  /** While true, progress is read from `getProgress` every frame. */
  playing?: boolean
  /** Live 0..1 position, e.g. from the media element's currentTime. */
  getProgress?: () => number
  onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void
}

const HEIGHT = 32
const BAR_WIDTH = 2
const BAR_GAP = 1
/** Smallest bar, so silence still reads as a continuous line. */
const MIN_BAR_HEIGHT = 2

export const WaveformSeekBar = forwardRef<HTMLDivElement, Props>(function WaveformSeekBar(
  { peaks, progress, playing = false, getProgress, onMouseDown },
  ref
) {
  const innerRef = useRef<HTMLDivElement | null>(null)
  const clipRectRef = useRef<SVGRectElement>(null)
  const fillRef = useRef<HTMLDivElement>(null)
  const getProgressRef = useRef(getProgress)
  getProgressRef.current = getProgress
  const [width, setWidth] = useState(0)
  // useId() yields ':r0:'-style ids, which don't survive inside url(#…).
  const clipId = 'waveform-clip' + useId().replace(/:/g, '')

  useEffect(() => {
    const el = innerRef.current
    if (!el) return
    const obs = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const bars = useMemo(() => {
    if (!peaks || width <= 0) return null
    const count = Math.floor((width + BAR_GAP) / (BAR_WIDTH + BAR_GAP))
    const values = resamplePeaks(peaks, count)
    const rects: JSX.Element[] = []
    for (let i = 0; i < values.length; i++) {
      const h = Math.max(MIN_BAR_HEIGHT, peakToHeight(values[i]) * HEIGHT)
      rects.push(
        <rect key={i} x={i * (BAR_WIDTH + BAR_GAP)} y={(HEIGHT - h) / 2} width={BAR_WIDTH} height={h} rx={1} />
      )
    }
    return rects
  }, [peaks, width])

  const applyProgress = (p: number) => {
    const pct = `${Math.max(0, Math.min(1, p)) * 100}%`
    clipRectRef.current?.setAttribute('width', pct)
    if (fillRef.current) fillRef.current.style.width = pct
  }

  // Paused: follow the prop. Skipped while playing — a timeupdate render
  // carries a slightly older time than the frame loop and would jitter.
  // `bars` is a dependency so a freshly mounted svg/fallback gets a width.
  useLayoutEffect(() => {
    if (!playing || !getProgressRef.current) applyProgress(progress)
  }, [progress, playing, bars])

  useEffect(() => {
    if (!playing || !getProgressRef.current) return
    let frame = requestAnimationFrame(function tick() {
      if (getProgressRef.current) applyProgress(getProgressRef.current())
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [playing])

  const setRefs = (el: HTMLDivElement | null) => {
    innerRef.current = el
    if (typeof ref === 'function') ref(el)
    else if (ref) ref.current = el
  }

  return (
    <div
      ref={setRefs}
      style={{
        flex: 1,
        height: HEIGHT,
        cursor: 'pointer',
        position: 'relative',
        minWidth: 60,
        display: 'flex',
        alignItems: 'center'
      }}
      onMouseDown={onMouseDown}
    >
      {bars ? (
        <svg width={width} height={HEIGHT} style={{ display: 'block', pointerEvents: 'none' }}>
          <defs>
            <clipPath id={clipId}>
              <rect ref={clipRectRef} x={0} y={0} width={0} height={HEIGHT} />
            </clipPath>
          </defs>
          <g fill="var(--border-color)">{bars}</g>
          <g fill="var(--accent)" clipPath={`url(#${clipId})`}>{bars}</g>
        </svg>
      ) : (
        <div style={{ width: '100%', height: 6, background: 'var(--bg-tertiary)', borderRadius: 3, pointerEvents: 'none' }}>
          <div ref={fillRef} style={{ height: '100%', width: 0, background: 'var(--accent)', borderRadius: 3 }} />
        </div>
      )}
    </div>
  )
})
