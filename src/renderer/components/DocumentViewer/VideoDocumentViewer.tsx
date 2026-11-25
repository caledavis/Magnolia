/**
 * VideoDocumentViewer — video player with horizontal CodeTrack and a
 * transcript area beneath.
 *
 * Mirrors AudioDocumentViewer's controls and keyboard handling, plus:
 *  - Volume slider + mute toggle
 *  - Frame-step nudge (arrow keys while paused, ~1/30s at a time)
 *  - Horizontal CodeTrack between the video and the transcript
 *
 * Coding model: codes attach to time ranges on the CodeTrack, not to
 * character offsets in the transcript. Text selection in the transcript
 * is translated into a time range via the transcript's per-line timestamp
 * map (see TranscriptEditor's videoMode).
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import { TranscriptEditor } from './TranscriptEditor'
import { CodeTrack } from './CodeTrack'
import { WaveformSeekBar } from './WaveformSeekBar'
import { useDocumentStore } from '../../stores/document-store'
import { usePreferencesStore } from '../../stores/preferences-store'
import { Icon, faPlay, faPause, faBackward, faForward, faVolumeHigh, faVolumeLow, faVolumeXmark } from '../Icon'
import { formatTime, clamp, snapTimeToSecond, DEFAULT_PX_PER_SECOND } from './video-time-utils'
import { decodePeaks } from '../../utils/waveform-peaks'
import { useRememberedPlayhead } from '../../utils/use-remembered-playhead'
import type { TextSource, VideoFormatData } from '../../models/types'
import { useTranslation } from 'react-i18next'
import { keyCombo, digitKey } from '../../utils/keys'
import { useCodeStore } from '../../stores/code-store'
import { usePendingSelectionStore } from '../../stores/pending-selection-store'
import type { Code } from '../../models/types'
import { draggedCodeGuids } from '../../utils/code-drag'

interface Props {
  source: TextSource
  content: string
}

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2]
/** Approximate "one frame" for arrow-key nudge when paused. 30 fps is a
 *  reasonable default that works well for most video. */
const FRAME_STEP_SECONDS = 1 / 30

/** Read by screen readers, not shown. */
const VISUALLY_HIDDEN: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, overflow: 'hidden',
  clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0
}

/** Keys this viewer handles act only where they mean the video: on the
 *  page itself or in the viewer, not in a list, a menu, a field, or the
 *  transcript (whose own caret uses the arrows). */
function keysForVideo(root: HTMLElement | null): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el || el === document.body) return true
  if (!root?.contains(el)) return false
  return !el.closest('input, textarea, select, [contenteditable="true"], .text-document, [role="menu"], [role="tree"], [role="grid"], [data-bracket]')
}

function hotkeyCode(codes: Code[], digit: number): Code | undefined {
  for (const c of codes) {
    if (c.hotkey === digit) return c
    const inner = hotkeyCode(c.children, digit)
    if (inner) return inner
  }
  return undefined
}

export function VideoDocumentViewer({ source, content }: Props) {
  const { t } = useTranslation()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [pxPerSecond, setPxPerSecond] = useState(DEFAULT_PX_PER_SECOND)
  // A stretch marked with the keyboard: I at its start, O at its end.
  const rootRef = useRef<HTMLDivElement>(null)
  const [marks, setMarks] = useState<{ start: number; end?: number } | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const codes = useCodeStore((s) => s.codes)
  const updateSourceFormatData = useDocumentStore((s) => s.updateSourceFormatData)

  // scrollTarget driven by a saved-pane click or query-result double-
  // click. For video: seek the playhead to the target time, and pulse a
  // line-range highlight in the transcript. Mirrors the image/PDF
  // viewers' local consumption of scrollTarget.
  const [externalHighlight, setExternalHighlight] = useState<{ startCp: number; endCp: number; timeRange?: { startTime: number; endTime: number } } | null>(null)
  const scrollTarget = useDocumentStore((s) => (s as any).scrollTarget)
  const clearScrollTarget = useDocumentStore((s) => (s as any).clearScrollTarget)
  useEffect(() => {
    if (!scrollTarget) return
    if (scrollTarget.timeRange && videoRef.current && videoRef.current.readyState >= 1) {
      videoRef.current.currentTime = scrollTarget.timeRange.startTime
    } else if (scrollTarget.timeRange && videoRef.current) {
      // Video not yet loaded — seek once metadata arrives.
      const v = videoRef.current
      const onReady = () => {
        v.currentTime = scrollTarget.timeRange!.startTime
        v.removeEventListener('loadedmetadata', onReady)
      }
      v.addEventListener('loadedmetadata', onReady)
    }
    setExternalHighlight({
      startCp: scrollTarget.startCp,
      endCp: scrollTarget.endCp,
      timeRange: scrollTarget.timeRange
    })
    clearScrollTarget?.()
    const timer = setTimeout(() => setExternalHighlight(null), 1800)
    return () => clearTimeout(timer)
  }, [scrollTarget, clearScrollTarget])

  const videoData = source.formatData as VideoFormatData | undefined
  const hasVideo = !!videoData?.videoFilePath

  // Stream the video (window.api.mediaUrl) rather than loading it whole —
  // a long screen recording is over a gigabyte. The seek bar's waveform
  // reads the file a range at a time; until it's decoded (or if that fails
  // — unsupported codec, no audio track) it shows the plain progress bar.
  const [videoUrl, setVideoUrl] = useState('')
  const [peaks, setPeaks] = useState<Float32Array | null>(null)
  useEffect(() => {
    if (!hasVideo) return
    const abort = new AbortController()
    const handle = videoData!.videoFilePath!
    setPeaks(null)
    setVideoUrl(window.api.mediaUrl(handle, videoData!.mimeType || 'video/mp4'))
    window.api.openMedia(handle)
      .then((media) => decodePeaks(media, { signal: abort.signal, onProgress: setPeaks }))
      .then((p) => { if (!abort.signal.aborted) setPeaks(p) })
      .catch((err: unknown) => { if (!abort.signal.aborted) console.warn('Waveform unavailable:', err) })
    return () => abort.abort()
  }, [hasVideo, videoData?.videoFilePath]) // eslint-disable-line react-hooks/exhaustive-deps

  // The playhead is remembered between visits.
  const { restore: restorePlayhead, save: savePlayhead } = useRememberedPlayhead(source.guid, videoRef)
  const handleTimeUpdate = useCallback(() => {
    if (videoRef.current) setCurrentTime(videoRef.current.currentTime)
    savePlayhead()
  }, [savePlayhead])

  const handleLoadedMetadata = useCallback(() => {
    if (!videoRef.current) return
    const v = videoRef.current
    setDuration(v.duration)
    restorePlayhead()
    // Update the source's formatData with duration/dimensions read from
    // the element if they weren't extracted during import.
    const needsUpdate = !videoData?.duration || !videoData.width || !videoData.height
    if (needsUpdate) {
      updateSourceFormatData(source.guid, {
        duration: v.duration,
        width: v.videoWidth,
        height: v.videoHeight
      })
    }
  }, [source.guid, updateSourceFormatData, videoData, restorePlayhead])

  const handlePlay = useCallback(() => setIsPlaying(true), [])
  const handlePause = useCallback(() => {
    setIsPlaying(false)
    // Sync to the exact paused position so the seek bar (frame-accurate
    // while playing) doesn't step back to the last timeupdate.
    if (videoRef.current) setCurrentTime(videoRef.current.currentTime)
    savePlayhead()
  }, [savePlayhead])

  const getVideo = () => videoRef.current

  const togglePlayPause = useCallback(() => {
    const v = getVideo(); if (!v) return
    if (v.paused) v.play(); else v.pause()
  }, [])

  const seekTo = useCallback((seconds: number) => {
    const v = getVideo(); if (!v || v.readyState < 1) return
    v.currentTime = clamp(seconds, 0, isFinite(v.duration) ? v.duration : seconds)
  }, [])

  const rewind = useCallback((seconds: number) => {
    const v = getVideo(); if (!v || v.readyState < 1) return
    v.currentTime = Math.max(0, v.currentTime - seconds)
  }, [])

  const fastForward = useCallback((seconds: number) => {
    const v = getVideo(); if (!v || v.readyState < 1) return
    const dur = v.duration
    v.currentTime = isFinite(dur) ? Math.min(dur, v.currentTime + seconds) : v.currentTime + seconds
  }, [])

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed
  }, [speed])

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume
      videoRef.current.muted = muted
    }
  }, [volume, muted])

  // Hold-to-repeat for the rewind/forward buttons.
  const holdTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startHold = useCallback((action: () => void) => {
    action()
    holdTimerRef.current = setInterval(action, 200)
  }, [])
  const stopHold = useCallback(() => {
    if (holdTimerRef.current) { clearInterval(holdTimerRef.current); holdTimerRef.current = null }
  }, [])

  // Seek bar — click + drag scrubbing (same UX as the audio viewer).
  const seekBarRef = useRef<HTMLDivElement>(null)
  const seekFromEvent = useCallback((e: MouseEvent | React.MouseEvent) => {
    const v = getVideo()
    if (!v || v.readyState < 1 || !seekBarRef.current) return
    const rect = seekBarRef.current.getBoundingClientRect()
    const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1)
    const dur = v.duration
    if (isFinite(dur)) v.currentTime = ratio * dur
  }, [])
  const handleSeekBarMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    seekFromEvent(e)
    const onMove = (ev: MouseEvent) => seekFromEvent(ev)
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [seekFromEvent])

  // Frame-step via ← → while paused.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !keysForVideo(rootRef.current)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const v = getVideo(); if (!v) return
      if (!v.paused) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        v.currentTime = Math.max(0, v.currentTime - FRAME_STEP_SECONDS)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        const dur = v.duration
        v.currentTime = isFinite(dur) ? Math.min(dur, v.currentTime + FRAME_STEP_SECONDS) : v.currentTime + FRAME_STEP_SECONDS
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Marking a stretch to code, and coding it, with the keyboard.
  const applyToMarks = useCallback((codeGuids: string[]) => {
    if (!marks || marks.end === undefined) return false
    const ds = useDocumentStore.getState()
    const src = ds.sources.find((s) => s.guid === source.guid)
    const existing = src?.selections.find((s) => s.timeRange && s.timeRange.startTime === marks.start && s.timeRange.endTime === marks.end)
    const selGuid = existing?.guid ?? ds.addTimeRangeSelection(source.guid, marks.start, marks.end)
    for (const g of codeGuids) {
      const sel = ds.sources.find((s) => s.guid === source.guid)?.selections.find((s) => s.guid === selGuid)
      if (!sel?.codings.some((c) => c.codeGuid === g)) ds.addCodingToSelection(source.guid, selGuid, g)
    }
    return true
  }, [marks, source.guid])
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !keysForVideo(rootRef.current)) return
      const v = getVideo(); if (!v) return
      const now = Math.round(v.currentTime * 10) / 10
      if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault()
        setMarks({ start: now })
        setAnnouncement(t('viewer.markedStart', { time: formatTime(now) }))
      } else if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault()
        const start = marks?.start ?? 0
        if (now <= start) {
          setAnnouncement(t('viewer.markEndBeforeStart'))
          return
        }
        setMarks({ start, end: now })
        setAnnouncement(t('viewer.markedStretch', { start: formatTime(start), end: formatTime(now) }))
      } else if (e.key === 'Escape' && marks) {
        setMarks(null)
        setAnnouncement(t('viewer.marksCleared'))
      } else if ((e.metaKey || e.ctrlKey) && marks?.end !== undefined) {
        const digit = digitKey(e)
        const code = digit === null ? undefined : hotkeyCode(codes, digit)
        if (code && applyToMarks([code.guid])) e.preventDefault()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [marks, codes, applyToMarks, t])
  // A marked stretch is the pending selection (for the New Code dialog).
  const setGlobalPending = usePendingSelectionStore((s) => s.setSelection)
  useEffect(() => {
    if (marks?.end !== undefined) {
      setGlobalPending({ kind: 'time', sourceGuid: source.guid, startTime: marks.start, endTime: marks.end })
      return () => setGlobalPending(null)
    }
  }, [marks, source.guid, setGlobalPending])

  // Preferences / foot pedal bindings (reused from audio viewer).
  const footPedalMappings = usePreferencesStore((s) => s.footPedalMappings)
  const prefsLoaded = usePreferencesStore((s) => s.loaded)
  const loadPrefs = usePreferencesStore((s) => s.load)
  useEffect(() => { if (!prefsLoaded) loadPrefs() }, [prefsLoaded, loadPrefs])
  useEffect(() => {
    // See AudioDocumentViewer for the rationale — same listener,
    // same reason: foot pedals trigger playback shortcuts while the
    // user types into the transcript textarea. Matching against the
    // configured mapping (rather than the focus target) lets unrelated
    // typing pass through while real shortcuts still fire.
    const handler = (e: KeyboardEvent) => {
      const combo = keyCombo(e)
      if (!combo) return
      if (combo === footPedalMappings.playPause) { e.preventDefault(); togglePlayPause() }
      else if (combo === footPedalMappings.rewind) { e.preventDefault(); rewind(footPedalMappings.rewindSeconds) }
      else if (combo === footPedalMappings.fastForward) { e.preventDefault(); fastForward(footPedalMappings.fastForwardSeconds) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [footPedalMappings, togglePlayPause, rewind, fastForward])

  // Transcript-only fallback (no video binary available — e.g. a video
  // transcript imported from another tool with the media missing). With no
  // timeline to anchor to, render the transcript character-precise like a
  // text/audio document (no `videoMode`) so codings highlight the exact
  // coded text rather than widening to whole lines. Mirrors
  // AudioDocumentViewer's path.
  if (!hasVideo) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <TranscriptEditor
          sourceGuid={source.guid}
          sourceName={source.name}
          content={content}
          selections={source.selections}
          currentPlaybackTime={0}
          externalHighlight={externalHighlight}
        />
      </div>
    )
  }

  const effectiveDuration = duration || videoData?.duration || 0

  return (
    <div
      ref={rootRef}
      style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-panel)', position: 'relative' }}
    >
      <span aria-live="polite" style={VISUALLY_HIDDEN}>{announcement}</span>
      {/* Video element — centred inside a flex-container slot. Height is
          capped at ~45% of the viewer so the transcript has room. */}
      <div
        style={{
          flexShrink: 0,
          width: '100%',
          maxHeight: '45%',
          background: '#000',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: 160
        }}
        onDragOver={(e) => {
          if (
            e.dataTransfer.types.includes('application/x-magnolia-code') ||
            e.dataTransfer.types.includes('application/x-magnolia-codes')
          ) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }
        }}
        // The video takes the focus: Space plays, I and O mark a stretch.
        tabIndex={0}
        role="group"
        aria-label={source.name}
        aria-description={t('viewer.videoKeysHint')}
        className="video-frame"
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || e.key !== ' ') return
          e.preventDefault()
          togglePlayPause()
        }}
        onDrop={(e) => {
          // Forward a drop on the video frame to the CodeTrack's create-
          // at-playhead logic — same behaviour as dropping on the track.
          const codeGuids = draggedCodeGuids(e)
          if (codeGuids.length === 0) return
          e.preventDefault()
          // A stretch marked with I and O takes it.
          if (applyToMarks(codeGuids)) return
          // Snap to whole seconds — see CodeTrack's drop handler for the
          // rationale (transcript gutter uses HH:MM:SS precision).
          const defaultLen = 4
          const rawStart = clamp(currentTime, 0, effectiveDuration)
          let start = snapTimeToSecond(rawStart)
          let end = snapTimeToSecond(Math.min(start + defaultLen, effectiveDuration))
          if (end <= start) end = Math.min(Math.floor(effectiveDuration), start + 1)
          if (end <= start && start > 0) start = Math.max(0, end - 1)
          const selGuid = useDocumentStore.getState().addTimeRangeSelection(source.guid, start, end)
          for (const codeGuid of codeGuids) {
            useDocumentStore.getState().addCodingToSelection(source.guid, selGuid, codeGuid)
          }
        }}
      >
        <video
          ref={videoRef}
          src={videoUrl}
          preload="auto"
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onPlay={handlePlay}
          onPause={handlePause}
          onEnded={handlePause}
          onClick={togglePlayPause}
          style={{ maxWidth: '100%', maxHeight: '100%', background: '#000' }}
        />
      </div>

      {/* Controls bar — sits on the panel surface so the viewer
          reads as a single continuous surface with the surrounding
          tools. */}
      <div style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        background: 'var(--bg-panel)',
        borderBottom: '1px solid var(--border-color)',
        userSelect: 'none'
      }}>
        <button
          style={buttonStyle(false)}
          onMouseDown={() => startHold(() => rewind(2))}
          onMouseUp={stopHold}
          onMouseLeave={stopHold}
          title={t('media.rewind')}
        >
          <Icon icon={faBackward} />
        </button>
        <button
          style={buttonStyle(isPlaying)}
          onClick={togglePlayPause}
          title={isPlaying ? t('media.pause') : t('media.play')}
        >
          <Icon icon={isPlaying ? faPause : faPlay} />
        </button>
        <button
          style={buttonStyle(false)}
          onMouseDown={() => startHold(() => fastForward(2))}
          onMouseUp={stopHold}
          onMouseLeave={stopHold}
          title={t('media.fastForward')}
        >
          <Icon icon={faForward} />
        </button>

        {/* Seek bar */}
        <WaveformSeekBar
          ref={seekBarRef}
          peaks={peaks}
          progress={effectiveDuration > 0 ? currentTime / effectiveDuration : 0}
          playing={isPlaying}
          getProgress={() => {
            const v = videoRef.current
            return v && isFinite(v.duration) && v.duration > 0 ? v.currentTime / v.duration : 0
          }}
          onMouseDown={handleSeekBarMouseDown}
        />

        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', minWidth: 80, textAlign: 'center', flexShrink: 0 }}>
          {formatTime(currentTime)} / {formatTime(effectiveDuration)}
        </span>

        {/* Mute toggle */}
        <button
          style={buttonStyle(false)}
          onClick={() => setMuted((m) => !m)}
          title={muted ? t('media.unmute') : t('media.mute')}
        >
          <Icon icon={faVolumeXmark} />
        </button>
        {/* Volume slider flanked by down / up icons. Clicking either icon
            nudges the volume in that direction in 10% steps so the user
            can change it without having to grab the slider thumb. */}
        <button
          style={{ ...buttonStyle(false), border: 'none', background: 'transparent', width: 20 }}
          onClick={() => {
            setVolume((v) => Math.max(0, v - 0.1))
            if (muted) setMuted(false)
          }}
          title={t('media.volumeDown')}
        >
          <Icon icon={faVolumeLow} />
        </button>
        <input
          type="range"
          className="themed-range"
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          onChange={(e) => {
            setVolume(parseFloat(e.target.value))
            if (muted && parseFloat(e.target.value) > 0) setMuted(false)
          }}
          style={{ width: 70, flexShrink: 0, ['--filled' as any]: `${(muted ? 0 : volume) * 100}%` }}
          title={t('media.volume')}
        />
        <button
          style={{ ...buttonStyle(false), border: 'none', background: 'transparent', width: 20 }}
          onClick={() => {
            setVolume((v) => Math.min(1, v + 0.1))
            if (muted) setMuted(false)
          }}
          title={t('media.volumeUp')}
        >
          <Icon icon={faVolumeHigh} />
        </button>

        {/* Speed */}
        <select
          value={speed}
          onChange={(e) => setSpeed(parseFloat(e.target.value))}
          style={{
            background: 'var(--bg-primary)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-primary)',
            fontSize: 11,
            padding: '1px 4px',
            cursor: 'pointer',
            flexShrink: 0
          }}
        >
          {SPEED_OPTIONS.map((s) => <option key={s} value={s}>{s}x</option>)}
        </select>

      </div>

      {/* CodeTrack */}
      <CodeTrack
        sourceGuid={source.guid}
        selections={source.selections}
        duration={effectiveDuration}
        currentTime={currentTime}
        getCurrentTime={() => videoRef.current?.currentTime ?? currentTime}
        pxPerSecond={pxPerSecond}
        onSeek={seekTo}
        onZoomChange={setPxPerSecond}
        markedRange={marks}
      />

      {/* Transcript */}
      <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
        <TranscriptEditor
          sourceGuid={source.guid}
          sourceName={source.name}
          content={content}
          selections={source.selections}
          currentPlaybackTime={currentTime}
          onTimestampClick={seekTo}
          videoMode
          lineTimes={videoData?.lineTimes}
          externalHighlight={externalHighlight}
        />
      </div>
    </div>
  )
}

function buttonStyle(active: boolean): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 32, height: 32, padding: 0,
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--radius-md)',
    background: active ? 'var(--accent)' : 'var(--bg-primary)',
    color: active ? '#fff' : 'var(--text-primary)',
    cursor: 'pointer',
    transition: 'background 0.15s, color 0.15s',
    flexShrink: 0
  }
}

