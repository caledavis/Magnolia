/**
 * AudioDocumentViewer — audio player with transcript area.
 * Uses native HTML5 <audio> element for reliable playback.
 * Transcript supports transcription mode (editable) and coding mode (read-only with full coding).
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import { TranscriptEditor } from './TranscriptEditor'
import { WaveformSeekBar } from './WaveformSeekBar'
import { usePreferencesStore } from '../../stores/preferences-store'
import { useDocumentStore } from '../../stores/document-store'
import { Icon, faPlay, faPause, faBackward, faForward, faVolumeHigh, faVolumeLow, faVolumeXmark } from '../Icon'
import { decodePeaks } from '../../utils/waveform-peaks'
import type { TextSource } from '../../models/types'

interface Props {
  source: TextSource
  content: string
}

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2]

function transportBtnStyle(active: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--radius-md)',
    background: active ? 'var(--accent)' : 'var(--bg-primary)',
    color: active ? '#fff' : 'var(--text-primary)',
    cursor: 'pointer',
    transition: 'background 0.15s, color 0.15s',
    padding: 0,
    flexShrink: 0
  }
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function keyComboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Cmd')
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return ''
  parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key)
  return parts.join('+')
}

export function AudioDocumentViewer({ source, content }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)

  // Highlight pulse driven by document-store scrollTarget (set when the
  // user clicks a saved quote / memo / query result that points at this
  // audio transcript). Mirrors the ImageDocumentViewer pattern: consume
  // the scrollTarget locally and clear it.
  const [externalHighlight, setExternalHighlight] = useState<{ startCp: number; endCp: number } | null>(null)
  const scrollTarget = useDocumentStore((s) => (s as any).scrollTarget)
  const clearScrollTarget = useDocumentStore((s) => (s as any).clearScrollTarget)
  useEffect(() => {
    if (!scrollTarget) return
    setExternalHighlight({ startCp: scrollTarget.startCp, endCp: scrollTarget.endCp })
    clearScrollTarget?.()
    const timer = setTimeout(() => setExternalHighlight(null), 1800)
    return () => clearTimeout(timer)
  }, [scrollTarget, clearScrollTarget])

  const audioData = source.formatData as {
    audioFilePath?: string
    mimeType: string
    channels: number
    duration: number
    lineTimes?: Record<string, number>
  } | undefined
  const hasAudio = !!(audioData?.audioFilePath)

  // Load audio file via IPC → create blob URL (avoids file:// and protocol issues).
  // The same bytes feed the seek bar's waveform; until decoding finishes
  // (or if it fails) the seek bar shows the plain progress bar.
  const [audioUrl, setAudioUrl] = useState('')
  const [peaks, setPeaks] = useState<Float32Array | null>(null)
  useEffect(() => {
    if (!hasAudio) return
    let revoke: string | null = null
    const abort = new AbortController()
    setPeaks(null)
    window.api.readAudioFile(audioData!.audioFilePath!).then((buffer: ArrayBuffer) => {
      if (abort.signal.aborted) return
      const blob = new Blob([buffer], { type: audioData!.mimeType || 'audio/mpeg' })
      const url = URL.createObjectURL(blob)
      revoke = url
      setAudioUrl(url)
      decodePeaks(buffer, { signal: abort.signal, onProgress: setPeaks })
        .then((p) => { if (!abort.signal.aborted) setPeaks(p) })
        .catch((err: any) => { if (!abort.signal.aborted) console.warn('Waveform unavailable:', err) })
    }).catch((err: any) => console.error('Failed to load audio:', err))
    return () => {
      abort.abort()
      if (revoke) URL.revokeObjectURL(revoke)
    }
  }, [hasAudio, audioData?.audioFilePath]) // eslint-disable-line react-hooks/exhaustive-deps

  // Audio event handlers
  const handleTimeUpdate = useCallback(() => {
    if (audioRef.current) setCurrentTime(audioRef.current.currentTime)
  }, [])

  const handleLoadedMetadata = useCallback(() => {
    if (audioRef.current) setDuration(audioRef.current.duration)
  }, [])

  const handlePlay = useCallback(() => setIsPlaying(true), [])
  const handlePause = useCallback(() => {
    setIsPlaying(false)
    // Sync to the exact paused position so the seek bar (frame-accurate
    // while playing) doesn't step back to the last timeupdate.
    if (audioRef.current) setCurrentTime(audioRef.current.currentTime)
  }, [])

  const getAudio = () => audioRef.current

  const togglePlayPause = useCallback(() => {
    const a = getAudio(); if (!a) return
    if (a.paused) a.play(); else a.pause()
  }, [])

  const seekTo = useCallback((seconds: number) => {
    const a = getAudio(); if (!a || a.readyState < 1) return
    a.currentTime = Math.max(0, seconds)
  }, [])

  const rewind = useCallback((seconds: number) => {
    const a = getAudio(); if (!a || a.readyState < 1) return
    a.currentTime = Math.max(0, a.currentTime - seconds)
  }, [])

  const fastForward = useCallback((seconds: number) => {
    const a = getAudio(); if (!a || a.readyState < 1) return
    const dur = a.duration
    a.currentTime = isFinite(dur) ? Math.min(dur, a.currentTime + seconds) : a.currentTime + seconds
  }, [])

  // Apply speed
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed
  }, [speed])

  // Apply volume + muted
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume
      audioRef.current.muted = muted
    }
  }, [volume, muted])

  // Hold-to-repeat for rewind/forward buttons
  const holdTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startHold = useCallback((action: () => void) => {
    action() // fire once immediately
    holdTimerRef.current = setInterval(action, 200) // repeat every 200ms while held
  }, [])
  const stopHold = useCallback(() => {
    if (holdTimerRef.current) { clearInterval(holdTimerRef.current); holdTimerRef.current = null }
  }, [])

  // Seek bar: click + drag scrubbing
  const seekBarRef = useRef<HTMLDivElement>(null)
  const seekFromEvent = useCallback((e: MouseEvent | React.MouseEvent) => {
    const a = getAudio()
    if (!a || a.readyState < 1 || !seekBarRef.current) return
    const rect = seekBarRef.current.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const dur = a.duration
    if (isFinite(dur)) a.currentTime = ratio * dur
  }, [])

  const handleSeekBarMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    seekFromEvent(e)
    const onMove = (ev: MouseEvent) => seekFromEvent(ev)
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [seekFromEvent])

  // (Export moved to TranscriptEditor toolbar)

  // Preferences / foot pedal
  const footPedalMappings = usePreferencesStore((s) => s.footPedalMappings)
  const prefsLoaded = usePreferencesStore((s) => s.loaded)
  const loadPrefs = usePreferencesStore((s) => s.load)
  useEffect(() => { if (!prefsLoaded) loadPrefs() }, [prefsLoaded, loadPrefs])

  useEffect(() => {
    // Foot-pedal shortcuts have to fire even when the transcription
    // textarea has focus — that's the whole point of the pedals:
    // users keep their hands on the keyboard to type and trigger
    // playback with their feet. We deliberately do NOT bail when
    // focus is in an input/textarea/contenteditable; instead we
    // match against the configured mapping first and only call
    // preventDefault for matching keys, so unrelated typing passes
    // through to whatever has focus unchanged. The match itself
    // doesn't move focus (no .focus() call here, and the media
    // element is invisible to the focus chain), so the cursor stays
    // exactly where the transcriber put it.
    const handler = (e: KeyboardEvent) => {
      const combo = keyComboFromEvent(e)
      if (!combo) return
      if (combo === footPedalMappings.playPause) { e.preventDefault(); togglePlayPause() }
      else if (combo === footPedalMappings.rewind) { e.preventDefault(); rewind(footPedalMappings.rewindSeconds) }
      else if (combo === footPedalMappings.fastForward) { e.preventDefault(); fastForward(footPedalMappings.fastForwardSeconds) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [footPedalMappings, togglePlayPause, rewind, fastForward])

  // Transcript-only mode
  if (!hasAudio) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <TranscriptEditor sourceGuid={source.guid} sourceName={source.name} content={content} selections={source.selections} currentPlaybackTime={0} lineTimes={audioData?.lineTimes} externalHighlight={externalHighlight} />
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Hidden audio element */}
      <audio
        ref={audioRef}
        src={audioUrl}
        preload="auto"
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onPlay={handlePlay}
        onPause={handlePause}
        onEnded={handlePause}
      />

      {/* Audio controls bar — sits on the panel surface so the
          viewer reads as a single continuous surface with the
          surrounding tools. */}
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
        {/* Rewind (hold to repeat) */}
        <button
          style={transportBtnStyle(false)}
          onMouseDown={() => startHold(() => rewind(2))}
          onMouseUp={stopHold}
          onMouseLeave={stopHold}
          title="Rewind (hold to repeat)"
        >
          <Icon icon={faBackward} />
        </button>

        {/* Play/Pause */}
        <button
          style={transportBtnStyle(isPlaying)}
          onClick={togglePlayPause}
          title={isPlaying ? 'Pause' : 'Play'}
        >
          <Icon icon={isPlaying ? faPause : faPlay} />
        </button>

        {/* Fast Forward (hold to repeat) */}
        <button
          style={transportBtnStyle(false)}
          onMouseDown={() => startHold(() => fastForward(2))}
          onMouseUp={stopHold}
          onMouseLeave={stopHold}
          title="Fast Forward (hold to repeat)"
        >
          <Icon icon={faForward} />
        </button>

        {/* Seek bar (click + drag to scrub) */}
        <WaveformSeekBar
          ref={seekBarRef}
          peaks={peaks}
          progress={duration > 0 ? currentTime / duration : 0}
          playing={isPlaying}
          getProgress={() => {
            const a = audioRef.current
            return a && isFinite(a.duration) && a.duration > 0 ? a.currentTime / a.duration : 0
          }}
          onMouseDown={handleSeekBarMouseDown}
        />

        {/* Time display */}
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', minWidth: 80, textAlign: 'center', flexShrink: 0 }}>
          {formatTime(currentTime)} / {formatTime(duration || audioData?.duration || 0)}
        </span>

        {/* Mute toggle */}
        <button
          style={transportBtnStyle(false)}
          onClick={() => setMuted((m) => !m)}
          title={muted ? 'Unmute' : 'Mute'}
        >
          <Icon icon={faVolumeXmark} />
        </button>
        {/* Volume slider flanked by down / up icons. Clicking either icon
            nudges the volume in that direction in 10% steps so the user
            can change it without having to grab the slider thumb. */}
        <button
          style={{ ...transportBtnStyle(false), border: 'none', background: 'transparent', width: 20 }}
          onClick={() => {
            setVolume((v) => Math.max(0, v - 0.1))
            if (muted) setMuted(false)
          }}
          title="Volume down"
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
          title="Volume"
        />
        <button
          style={{ ...transportBtnStyle(false), border: 'none', background: 'transparent', width: 20 }}
          onClick={() => {
            setVolume((v) => Math.min(1, v + 0.1))
            if (muted) setMuted(false)
          }}
          title="Volume up"
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

      {/* Transcript */}
      <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
        <TranscriptEditor
          sourceGuid={source.guid}
          sourceName={source.name}
          content={content}
          selections={source.selections}
          currentPlaybackTime={currentTime}
          onTimestampClick={seekTo}
          lineTimes={audioData?.lineTimes}
          externalHighlight={externalHighlight}
        />
      </div>
    </div>
  )
}
