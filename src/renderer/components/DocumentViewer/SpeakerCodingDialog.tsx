import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon, faPlay, faPause } from '../Icon'
import type { DetectedSpeaker } from '../../utils/transcript-speakers'
import { useCodeColourPresets } from '../../utils/code-colours'

/** Seconds of audio the play button previews. */
const CLIP_SECONDS = 5

/** An SVG path covering the whole viewport with a rounded-rect hole over the
 *  given box — used as an evenodd `clip-path` so a single dimming overlay hugs
 *  the Code Browser's actual shape (including its themed rounded corners). */
function spotlightHolePath(vw: number, vh: number, rect: DOMRect, radius: number): string {
  const n = (v: number) => Math.round(v * 100) / 100
  const x = rect.left, y = rect.top, w = rect.width, h = rect.height
  const r = Math.max(0, Math.min(radius, w / 2, h / 2))
  const outer = `M0 0H${n(vw)}V${n(vh)}H0Z`
  const hole = r > 0
    ? `M${n(x + r)} ${n(y)}H${n(x + w - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w)} ${n(y + r)}` +
      `V${n(y + h - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w - r)} ${n(y + h)}` +
      `H${n(x + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(y + h - r)}` +
      `V${n(y + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + r)} ${n(y)}Z`
    : `M${n(x)} ${n(y)}H${n(x + w)}V${n(y + h)}H${n(x)}Z`
  return `${outer} ${hole}`
}

/** A speaker's chosen code: an existing one (dragged in) or a new one to be
 *  created on Apply. */
type Assignment =
  | { kind: 'existing'; guid: string; name: string; color?: string }
  | { kind: 'new'; name: string; color: string }

export interface SpeakerAssignment {
  speakerId: string
  /** An existing code's guid, or null when a new code should be created. */
  codeGuid: string | null
  /** For a new code: its name + color (codeGuid is null). */
  newCode?: { name: string; color: string }
  ranges: { startChar: number; endChar: number }[]
}

interface Props {
  open: boolean
  speakers: DetectedSpeaker[]
  /** The audio/video source the transcript was imported into. */
  source: { guid: string; sourceType?: string; formatData?: any; name?: string } | undefined
  onApply: (assignments: SpeakerAssignment[]) => void
  onClose: () => void
}

export function SpeakerCodingDialog({ open, speakers, source, onApply, onClose }: Props) {
  const [assignments, setAssignments] = useState<Record<string, Assignment>>({})
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [editingNew, setEditingNew] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const colourPresets = useCodeColourPresets()
  const [playingId, setPlayingId] = useState<string | null>(null)

  // Reset when the dialog (re)opens for a fresh import.
  useEffect(() => {
    if (open) {
      setAssignments({})
      setEditingNew(null)
      setPlayingId(null)
    }
  }, [open, speakers])

  // Track the Code Browser's on-screen box (and its corner radius) so we can
  // dim EVERYTHING ELSE while leaving it interactive — the user drags codes out
  // of it onto the speakers.
  const [cbRect, setCbRect] = useState<DOMRect | null>(null)
  const [cbRadius, setCbRadius] = useState(0)
  useLayoutEffect(() => {
    if (!open) return
    const measure = () => {
      const el = document.querySelector('[data-spotlight="code-browser"]') as HTMLElement | null
      if (el) {
        setCbRect(el.getBoundingClientRect())
        setCbRadius(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0)
      } else {
        setCbRect(null)
        setCbRadius(0)
      }
    }
    measure()
    const raf = requestAnimationFrame(measure) // catch post-layout position
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', measure)
    }
  }, [open])

  // ── Media for the preview clips ───────────────────────────────────────────
  const mediaHandle: string | undefined =
    source?.sourceType === 'video' ? source?.formatData?.videoFilePath : source?.formatData?.audioFilePath
  const mimeType: string = source?.formatData?.mimeType || (source?.sourceType === 'video' ? 'video/mp4' : 'audio/mpeg')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const stopAtRef = useRef<number>(Infinity)
  const [mediaUrl, setMediaUrl] = useState('')

  useEffect(() => {
    if (!open || !mediaHandle) return
    let revoke: string | null = null
    let cancelled = false
    const read = source?.sourceType === 'video' ? window.api.readVideoFile : window.api.readAudioFile
    read(mediaHandle)
      .then((buffer: ArrayBuffer) => {
        if (cancelled) return
        const url = URL.createObjectURL(new Blob([buffer], { type: mimeType }))
        revoke = url
        setMediaUrl(url)
      })
      .catch((err: unknown) => console.error('Speaker preview: failed to load media:', err))
    return () => {
      cancelled = true
      if (revoke) URL.revokeObjectURL(revoke)
      setMediaUrl('')
    }
  }, [open, mediaHandle, mimeType, source?.sourceType])

  const playPreview = (sp: DetectedSpeaker) => {
    const a = audioRef.current
    if (!a) return
    if (playingId === sp.id && !a.paused) { a.pause(); return }
    const stopAt = sp.previewEnd > sp.previewStart
      ? Math.min(sp.previewStart + CLIP_SECONDS, sp.previewEnd)
      : sp.previewStart + CLIP_SECONDS
    stopAtRef.current = stopAt
    const start = () => {
      a.currentTime = Math.max(0, sp.previewStart)
      a.play().then(() => setPlayingId(sp.id)).catch(() => setPlayingId(null))
    }
    if (a.readyState < 1) a.addEventListener('loadedmetadata', start, { once: true })
    else start()
  }

  const onTimeUpdate = () => {
    const a = audioRef.current
    if (a && a.currentTime >= stopAtRef.current) {
      a.pause()
      stopAtRef.current = Infinity
    }
  }

  // ── Code assignment via drag-and-drop ─────────────────────────────────────
  const handleDrop = (speakerId: string, e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(null)
    const raw =
      e.dataTransfer.getData('application/x-magnolia-code') ||
      e.dataTransfer.getData('application/x-magnolia-codes')
    if (!raw) return
    try {
      const parsed = JSON.parse(raw)
      const code = Array.isArray(parsed) ? parsed[0] : parsed
      if (code?.guid) {
        setAssignments((a) => ({ ...a, [speakerId]: { kind: 'existing', guid: code.guid, name: code.name, color: code.color } }))
        setEditingNew(null)
      }
    } catch { /* ignore malformed drag data */ }
  }

  const acceptsCode = (e: React.DragEvent) =>
    e.dataTransfer.types.includes('application/x-magnolia-code') ||
    e.dataTransfer.types.includes('application/x-magnolia-codes')

  const startNewCode = (speakerId: string) => {
    setNewName(speakerId)
    setEditingNew(speakerId)
  }
  const confirmNewCode = (speakerId: string, index: number) => {
    const name = newName.trim()
    if (!name) { setEditingNew(null); return }
    setAssignments((a) => ({ ...a, [speakerId]: { kind: 'new', name, color: colourPresets[index % colourPresets.length] } }))
    setEditingNew(null)
  }
  const clearAssignment = (speakerId: string) =>
    setAssignments((a) => { const next = { ...a }; delete next[speakerId]; return next })

  const assignedCount = Object.keys(assignments).length

  const handleApply = () => {
    const byId = new Map(speakers.map((s) => [s.id, s]))
    const out: SpeakerAssignment[] = []
    for (const [speakerId, asn] of Object.entries(assignments)) {
      const sp = byId.get(speakerId)
      if (!sp) continue
      out.push({
        speakerId,
        codeGuid: asn.kind === 'existing' ? asn.guid : null,
        newCode: asn.kind === 'new' ? { name: asn.name, color: asn.color } : undefined,
        ranges: sp.ranges
      })
    }
    onApply(out)
  }

  const title = useMemo(
    () => `${speakers.length} speaker${speakers.length === 1 ? '' : 's'} detected`,
    [speakers.length]
  )

  if (!open) return null

  // Dim everything except the Code Browser with a single overlay clipped to a
  // rounded-rect hole over its box (full-screen dim when it isn't on screen).
  // Clicking a dimmed area skips. The hole receives no pointer events, so the
  // Code Browser under it stays fully interactive.
  const DIALOG_W = 560
  const vw = window.innerWidth
  const vh = window.innerHeight
  const dim = 'rgba(0,0,0,0.45)'
  const clipPath = cbRect ? `path(evenodd, "${spotlightHolePath(vw, vh, cbRect, cbRadius)}")` : undefined

  // Sit the dialog in the larger free band beside the Code Browser so it
  // doesn't cover the codes the user needs to drag.
  let dialogLeft = (vw - DIALOG_W) / 2
  if (cbRect) {
    const freeLeft = cbRect.left
    const freeRight = vw - cbRect.right
    dialogLeft = freeLeft >= freeRight
      ? (cbRect.left - DIALOG_W) / 2
      : cbRect.right + (freeRight - DIALOG_W) / 2
  }
  dialogLeft = Math.max(8, Math.min(dialogLeft, vw - DIALOG_W - 8))

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: dim, zIndex: 1000, clipPath }} />
      <div
        style={{ position: 'fixed', left: dialogLeft, top: '50%', transform: 'translateY(-50%)', width: DIALOG_W, maxWidth: '92vw', maxHeight: '86vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md, 8px)', boxShadow: '0 10px 40px rgba(0,0,0,0.35)', zIndex: 1001 }}
      >
        <div style={{ padding: '16px 20px 8px' }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>{title}</h2>
          <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
            Optionally code each speaker's lines.
          </p>
        </div>

        <div style={{ overflowY: 'auto', padding: '8px 20px', flex: 1 }}>
          {speakers.map((sp, i) => {
            const asn = assignments[sp.id]
            return (
              <div key={sp.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border-color)' }}>
                <div style={{ minWidth: 96 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{sp.id}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{sp.segmentCount} segment{sp.segmentCount === 1 ? '' : 's'}</div>
                </div>

                <button
                  onClick={() => playPreview(sp)}
                  disabled={!mediaUrl}
                  title={mediaUrl ? (playingId === sp.id ? 'Pause' : 'Play a sample of this speaker') : 'No media attached to preview'}
                  style={{ width: 30, height: 30, borderRadius: '50%', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', cursor: mediaUrl ? 'pointer' : 'not-allowed', flexShrink: 0, opacity: mediaUrl ? 1 : 0.5, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  <Icon icon={playingId === sp.id ? faPause : faPlay} />
                </button>

                <div style={{ flex: 1, minWidth: 0 }}>
                  {asn ? (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 12, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', maxWidth: '100%' }}>
                      <span style={{ width: 9, height: 9, borderRadius: '50%', background: (asn.kind === 'existing' ? asn.color : asn.color) || '#888', flexShrink: 0 }} />
                      <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {asn.name}{asn.kind === 'new' ? ' (new)' : ''}
                      </span>
                      <button onClick={() => clearAssignment(sp.id)} title="Remove" style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, lineHeight: 1 }}>×</button>
                    </div>
                  ) : editingNew === sp.id ? (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input
                        autoFocus
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') confirmNewCode(sp.id, i); if (e.key === 'Escape') setEditingNew(null) }}
                        placeholder="New code name"
                        style={{ flex: 1, fontSize: 12, padding: '4px 6px', border: '1px solid var(--border-color)', borderRadius: 4, background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                      />
                      <button onClick={() => confirmNewCode(sp.id, i)} style={{ fontSize: 11, padding: '4px 8px', border: '1px solid var(--border-color)', borderRadius: 4, background: 'var(--bg-secondary)', color: 'var(--text-primary)', cursor: 'pointer' }}>Create</button>
                    </div>
                  ) : (
                    <div
                      onDragOver={(e) => { if (acceptsCode(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragOver(sp.id) } }}
                      onDragLeave={() => setDragOver((d) => (d === sp.id ? null : d))}
                      onDrop={(e) => handleDrop(sp.id, e)}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 8px', borderRadius: 6, border: `1px dashed ${dragOver === sp.id ? 'var(--accent-color, #5080e0)' : 'var(--border-color)'}`, background: dragOver === sp.id ? 'var(--bg-secondary)' : 'transparent' }}
                    >
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Drag a code here</span>
                      <button onClick={() => startNewCode(sp.id)} style={{ fontSize: 11, padding: '2px 8px', border: '1px solid var(--border-color)', borderRadius: 4, background: 'var(--bg-secondary)', color: 'var(--text-primary)', cursor: 'pointer', flexShrink: 0 }}>+ New code</button>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 20px', borderTop: '1px solid var(--border-color)' }}>
          <button onClick={onClose} style={{ fontSize: 12, padding: '6px 14px', border: '1px solid var(--border-color)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', cursor: 'pointer' }}>Skip</button>
          <button
            onClick={handleApply}
            disabled={assignedCount === 0}
            style={{ fontSize: 12, padding: '6px 14px', border: '1px solid var(--border-color)', borderRadius: 6, background: assignedCount === 0 ? 'var(--bg-secondary)' : 'var(--accent-color, #5080e0)', color: assignedCount === 0 ? 'var(--text-muted)' : '#fff', cursor: assignedCount === 0 ? 'not-allowed' : 'pointer' }}
          >
            Code {assignedCount > 0 ? `${assignedCount} speaker${assignedCount === 1 ? '' : 's'}` : 'speakers'}
          </button>
        </div>

        {mediaUrl && (
          <audio ref={audioRef} src={mediaUrl} onTimeUpdate={onTimeUpdate} onPause={() => setPlayingId(null)} onEnded={() => setPlayingId(null)} style={{ display: 'none' }} />
        )}
      </div>
    </>
  )
}
