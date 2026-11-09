/**
 * TranscriptEditor — transcript area with two modes:
 *
 * 1. Transcription Mode (ON): Plain textarea (TranscriptionArea). As each
 *    new line is created the current playhead time is silently tagged
 *    against that line index in formatData.lineTimes — no bracketed
 *    timestamps are ever injected into the transcript text. This is the
 *    same behaviour for both audio and video.
 * 2. Coding Mode (OFF): Read-only coded view — CodedTextView with a
 *    timestamp gutter fed from lineTimes, for audio and video alike.
 */
import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { CodedTextView, type CodingRightClickContext } from './CodedTextView'
import { useDocumentStore } from '../../stores/document-store'
import { useCodeStore } from '../../stores/code-store'
import { useMemoStore } from '../../stores/memo-store'
import { useQuoteStore } from '../../stores/quote-store'
import { Icon, faPenLine } from '../Icon'
import { detectAndConvertTimestamps, migrateInlineTimestamps, formatTimestamp, parseSubtitleTranscript, parseNoScribeHtmlTranscript } from '../../utils/timestamp-parser'
import { detectSpeakers, type DetectedSpeaker } from '../../utils/transcript-speakers'
import { SpeakerCodingDialog, type SpeakerAssignment } from './SpeakerCodingDialog'
import type { Code, Memo, MemoEditInitData, PlainTextSelection } from '../../models/types'
import { useNewCodeTriggerStore } from '../../stores/new-code-trigger-store'
import { exportPdfWithHeader, buildPdfDocument, escHtml } from '../../utils/pdf-export'
import { modKey } from '../../utils/platform'
import { useRememberedScroll } from '../../utils/use-remembered-scroll'
import { onSelectionDrop } from '../../utils/selection-drag'
import { SelectionDragHandle, textSelectionAnchor } from './SelectionDragHandle'
import { useTranslation } from 'react-i18next'
import { t, formatDateTime } from '../../i18n'
import { digitKey } from '../../utils/keys'

interface Props {
  sourceGuid: string
  sourceName: string
  content: string
  selections: PlainTextSelection[]
  currentPlaybackTime: number
  onTimestampClick?: (seconds: number) => void
  /** A video's transcript rather than audio's; only the transcription
   *  area's wording differs. Both code in CodedTextView, and both record
   *  line times silently to formatData.lineTimes while transcribing. */
  videoMode?: boolean
  lineTimes?: Record<string, number>
  /** Pulsed highlight fed from the parent viewer when the user clicks a
   *  saved quote / memo / query result, forwarded to CodedTextView as
   *  externalHighlightRange (cp coords). The video viewer also seeks to
   *  the optional timeRange itself. */
  externalHighlight?: {
    startCp: number
    endCp: number
    timeRange?: { startTime: number; endTime: number }
  } | null
}

function flattenCodes(codes: Code[], depth = 0): { code: Code; depth: number }[] {
  const result: { code: Code; depth: number }[] = []
  for (const code of codes) {
    result.push({ code, depth })
    result.push(...flattenCodes(code.children, depth + 1))
  }
  return result
}

/**
 * Build the HTML body for a Transcript PDF export. Styled to match the
 * Codebook and Query Results PDFs: same system-sans body font, 11 px
 * body with an 18 px title, grey subtitle, and each line as its own
 * row with a mono-formatted timestamp gutter on the left.
 *
 * Timestamps come from `lineTimes` when available (audio + video
 * sources); untimed lines render with a blank gutter so everything
 * still aligns vertically.
 */
function buildTranscriptHtml(
  sourceName: string,
  content: string,
  lineTimes?: Record<string, number>
): string {
  const now = formatDateTime(new Date())
  const baseName = sourceName.replace(/\.[^.]+$/, '')
  const title = t('transcript.pdfTitle', { name: baseName })
  const lines = content.split('\n')
  const lineCount = lines.length

  const body = lines.map((line, i) => {
    const t = lineTimes?.[String(i)]
    const ts = t !== undefined ? formatTimestamp(t) : ''
    return `<div class="line">
      <span class="ts">${escHtml(ts)}</span>
      <span class="text">${escHtml(line) || '&nbsp;'}</span>
    </div>`
  }).join('')

  // Per-line layout: time gutter on the left, transcript text on the
  // right. Body typography, h1, .subtitle come from buildPdfDocument.
  const extraCss = `
  .line { display: flex; padding: 2px 0; border-bottom: 1px solid #f0f0f0; }
  .line:last-child { border-bottom: none; }
  .ts { font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 10px; color: #888; width: 72px; min-width: 72px; flex-shrink: 0; padding-inline-end: 12px; text-align: end; }
  .text { flex: 1; white-space: pre-wrap; word-break: break-word; unicode-bidi: plaintext; }
`

  return buildPdfDocument({
    title,
    subtitle: escHtml(t('transcript.pdfSubtitle', { count: lineCount, date: now })),
    body,
    extraCss
  })
}

export function TranscriptEditor({
  sourceGuid, sourceName, content, selections, currentPlaybackTime,
  onTimestampClick, videoMode = false, lineTimes, externalHighlight
}: Props) {
  const { t } = useTranslation()
  const [exportMenu, setExportMenu] = useState<{ x: number; y: number } | null>(null)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [speakerDialog, setSpeakerDialog] = useState<{ speakers: DetectedSpeaker[]; source: any } | null>(null)
  const updateSourceContent = useDocumentStore((s) => s.updateSourceContent)
  const applyTranscriptEdit = useDocumentStore((s) => s.applyTranscriptEdit)
  const updateLineTimes = useDocumentStore((s) => s.updateLineTimes)

  // One-shot migration: legacy audio transcripts stored timestamps inline
  // as "HH:MM:SS " prefixes. When we open such a source for the first time
  // after the model switched to lineTimes, strip the prefixes into a
  // lineTimes map so the gutter can render from formatData.lineTimes like
  // the video transcript does. Skipped once lineTimes is populated or the
  // transcript has no inline markers.
  useEffect(() => {
    const hasLineTimes = lineTimes && Object.keys(lineTimes).length > 0
    if (hasLineTimes || !content) return
    const migrated = migrateInlineTimestamps(content)
    if (!migrated) return
    updateSourceContent(sourceGuid, migrated.content)
    updateLineTimes(sourceGuid, migrated.lineTimes)
  }, [sourceGuid, content, lineTimes, updateSourceContent, updateLineTimes])

  // Build the timestamp map for CodedTextView (coding mode — replaces
  // line numbers) straight from formatData.lineTimes.
  const lineTimestampMap = useMemo(() => {
    if (!lineTimes || Object.keys(lineTimes).length === 0) return undefined
    const map = new Map<number, { text: string; seconds: number }>()
    for (const [k, v] of Object.entries(lineTimes)) {
      const idx = parseInt(k, 10)
      const total = Math.max(0, Math.floor(v))
      const h = Math.floor(total / 3600)
      const m = Math.floor((total % 3600) / 60)
      const s = total % 60
      const text = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      map.set(idx, { text, seconds: v })
    }
    return map
  }, [lineTimes])

  const activeTimestampLine = useMemo(() => {
    if (!lineTimes || currentPlaybackTime <= 0) return null
    let active: number | null = null
    let activeTime = -Infinity
    for (const [k, v] of Object.entries(lineTimes)) {
      if (v <= currentPlaybackTime && v > activeTime) {
        active = parseInt(k, 10)
        activeTime = v
      }
    }
    return active
  }, [lineTimes, currentPlaybackTime])
  const addSelection = useDocumentStore((s) => s.addSelection)
  const addCodingToSelection = useDocumentStore((s) => s.addCodingToSelection)
  const removeCoding = useDocumentStore((s) => s.removeCoding)
  const removeSelection = useDocumentStore((s) => s.removeSelection)
  const codes = useCodeStore((s) => s.codes)
  const findCode = useCodeStore((s) => s.findCode)
  const addCode = useCodeStore((s) => s.addCode)
  const addMemo = useMemoStore((s) => s.addMemo)
  const removeMemo = useMemoStore((s) => s.removeMemo)
  // Shallow-compared so an unchanged list keeps its identity: this editor
  // re-renders on every playback tick, and a fresh array each time would
  // re-render the coded view (and its margin measuring) along with it.
  const contentMemos = useMemoStore(useShallow((s) => s.getContentMemosForSource(sourceGuid)))
  const sourceQuotes = useQuoteStore(useShallow((s) => s.getQuotesForSource(sourceGuid)))
  const quoteRanges = useMemo(() =>
    sourceQuotes.map((q) => ({ guid: q.guid, startCp: q.startPosition, endCp: q.endPosition })),
    [sourceQuotes]
  )

  // Apply the speaker-coding dialog: create any new codes, then code every one
  // of each assigned speaker's lines with its code.
  const handleSpeakerApply = useCallback((assignments: SpeakerAssignment[]) => {
    for (const asn of assignments) {
      const codeGuid = asn.codeGuid ?? (asn.newCode ? addCode(asn.newCode.name, asn.newCode.color) : null)
      if (!codeGuid) continue
      for (const r of asn.ranges) {
        if (r.endChar <= r.startChar) continue
        const selGuid = addSelection(sourceGuid, r.startChar, r.endChar, asn.newCode?.name ?? '')
        addCodingToSelection(sourceGuid, selGuid, codeGuid)
      }
    }
    setSpeakerDialog(null)
  }, [addCode, addSelection, addCodingToSelection, sourceGuid])

  // Coding mode state
  const [pendingSelection, setPendingSelection] = useState<{ startCp: number; endCp: number; selectedText: string } | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; context: CodingRightClickContext } | null>(null)
  const [menuHighlight, setMenuHighlight] = useState<{ startCp: number; endCp: number } | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounterRef = useRef(0)

  // Return to where the reader was in the coded transcript, unless a quote
  // or query-result click is highlighting a specific passage. Transcription
  // mode's textarea isn't tracked; switching back restores the position.
  const codingAreaRef = useRef<HTMLDivElement>(null)
  const rememberScroll = useRememberedScroll(sourceGuid, codingAreaRef, {
    ready: !isTranscribing && !!content,
    skipRestore: !!externalHighlight
  })

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

  const applyCodingToRange = useCallback(
    (codeGuid: string, startCp: number, endCp: number, text: string) => {
      const source = useDocumentStore.getState().sources.find((s) => s.guid === sourceGuid)
      const existingSel = source?.selections.find(
        (s) => s.startPosition === startCp && s.endPosition === endCp
      )
      if (existingSel) {
        if (!existingSel.codings.some((c) => c.codeGuid === codeGuid)) {
          addCodingToSelection(sourceGuid, existingSel.guid, codeGuid)
        }
      } else {
        const truncatedName = text.length > 60 ? text.slice(0, 57) + '...' : text
        const selGuid = addSelection(sourceGuid, startCp, endCp, truncatedName)
        addCodingToSelection(sourceGuid, selGuid, codeGuid)
      }
    },
    [sourceGuid, addSelection, addCodingToSelection]
  )

  // Stable props for the coded view, which is memoised so playback ticks
  // don't re-render it (only a change of the active timestamp line does).
  const codedHighlight = useMemo(
    () => (externalHighlight
      ? { startCp: externalHighlight.startCp, endCp: externalHighlight.endCp }
      : menuHighlight),
    [externalHighlight, menuHighlight]
  )
  const openMemo = useCallback((memoGuid: string) => {
    const memo = useMemoStore.getState().findMemo(memoGuid)
    if (memo) {
      window.api.openMemoEditWindow({ memo, theme: document.documentElement.getAttribute('data-theme') || '' } as MemoEditInitData)
    }
  }, [])

  const handleTextSelected = useCallback(
    (startCp: number, endCp: number, selectedText: string) => {
      setPendingSelection({ startCp, endCp, selectedText })
    },
    []
  )

  const handleRightClick = useCallback(
    (e: React.MouseEvent, ctx: CodingRightClickContext) => {
      const fullCtx: CodingRightClickContext = {
        ...ctx,
        pendingSelection: ctx.pendingSelection || pendingSelection || undefined
      }
      const hasMemos = (fullCtx.overlappingMemos?.length ?? 0) > 0
      if (fullCtx.existingCodings.length > 0 || fullCtx.pendingSelection || hasMemos) {
        setContextMenu({ x: e.clientX, y: e.clientY, context: fullCtx })
      }
    },
    [pendingSelection]
  )

  const handleApplyCode = useCallback(
    (codeGuid: string) => {
      if (!contextMenu?.context.pendingSelection) return
      const { startCp, endCp, selectedText } = contextMenu.context.pendingSelection
      applyCodingToRange(codeGuid, startCp, endCp, selectedText)
      setContextMenu(null); setMenuHighlight(null)
    },
    [contextMenu, applyCodingToRange]
  )

  const handleRemoveCoding = useCallback(
    (selectionGuid: string, codingGuid: string) => {
      removeCoding(sourceGuid, selectionGuid, codingGuid)
      const source = useDocumentStore.getState().sources.find((s) => s.guid === sourceGuid)
      const sel = source?.selections.find((s) => s.guid === selectionGuid)
      if (sel && sel.codings.length <= 1) removeSelection(sourceGuid, selectionGuid)
      setContextMenu(null); setMenuHighlight(null)
    },
    [sourceGuid, removeCoding, removeSelection]
  )

  const handleCreateMemo = useCallback(
    (startCp: number, endCp: number) => {
      const guid = addMemo('content', '', { sourceGuid, startPosition: startCp, endPosition: endCp })
      const memo = useMemoStore.getState().findMemo(guid)
      if (memo) {
        window.api.openMemoEditWindow({ memo, theme: document.documentElement.getAttribute('data-theme') || '' } as MemoEditInitData)
      }
      setContextMenu(null)
    },
    [sourceGuid, addMemo]
  )

  const handleDrop = useCallback(
    (codeGuids: string[]) => {
      if (pendingSelection) {
        for (const codeGuid of codeGuids) {
          applyCodingToRange(codeGuid, pendingSelection.startCp, pendingSelection.endCp, pendingSelection.selectedText)
        }
      }
    },
    [pendingSelection, applyCodingToRange]
  )

  // Hotkey coding: Cmd+0-9
  useEffect(() => {
    if (isTranscribing) return // No coding hotkeys in transcription mode
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return
      const digit = digitKey(e)
      if (digit === null) return
      const code = hotkeyMap.get(digit)
      if (!code || !pendingSelection) return
      e.preventDefault()
      applyCodingToRange(code.guid, pendingSelection.startCp, pendingSelection.endCp, pendingSelection.selectedText)
    }
    window.addEventListener('keydown', handleKeyDown)
    // The selection dragged by its grab handle onto a code in the Code
    // Browser (as its hotkey) or into Saved Quotes (as "Add as Quote").
    const stopSelectionDrop = onSelectionDrop(sourceGuid, {
      code: (codeGuid) => {
        if (pendingSelection) applyCodingToRange(codeGuid, pendingSelection.startCp, pendingSelection.endCp, pendingSelection.selectedText)
      },
      quote: () => {
        if (!pendingSelection) return
        const name = useDocumentStore.getState().sources.find((s) => s.guid === sourceGuid)?.name || ''
        useQuoteStore.getState().addQuote(sourceGuid, name, pendingSelection.startCp, pendingSelection.endCp, pendingSelection.selectedText)
      }
    })
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      stopSelectionDrop()
    }
  }, [isTranscribing, hotkeyMap, pendingSelection, applyCodingToRange, sourceGuid])

  // Clear coding state when switching modes
  const toggleMode = useCallback(() => {
    setPendingSelection(null)
    setContextMenu(null)
    setMenuHighlight(null)
    setIsTranscribing((prev) => !prev)
  }, [])

  return (
    <div
      style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      onMouseDown={(e) => {
        if (contextMenu && !(e.target as HTMLElement).closest('.context-menu')) {
          setContextMenu(null); setMenuHighlight(null)
        }
      }}
    >
      {/* Coding Mode toolbar — sits on the panel surface so the
          viewer reads as a single continuous surface with the
          surrounding tools. */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        padding: '4px 12px',
        background: 'var(--bg-panel)',
        borderBottom: '1px solid var(--border-color)',
        gap: 8,
        flexShrink: 0,
        userSelect: 'none'
      }}>
        <button
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 32,
            height: 32,
            padding: 0,
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-md)',
            background: isTranscribing ? 'var(--accent)' : 'var(--bg-primary)',
            color: isTranscribing ? '#fff' : 'var(--text-muted)',
            cursor: 'pointer',
            transition: 'background 0.15s, color 0.15s',
            flexShrink: 0
          }}
          onClick={toggleMode}
          title={isTranscribing ? t('transcript.switchToCoding') : t('transcript.switchToTranscribing')}
        >
          <Icon icon={faPenLine} />
        </button>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
          {isTranscribing ? t('transcript.transcribingMode') : t('transcript.codingMode')}
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', flex: 1 }}>
          {isTranscribing ? t('transcript.transcribingHint') : t('transcript.codingHint')}
        </span>
        <button
          style={{
            padding: '3px 10px',
            fontSize: 11,
            fontWeight: 600,
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--bg-primary)',
            color: 'var(--text-primary)',
            cursor: 'pointer'
          }}
          onClick={async () => {
            const result = await window.api.importTranscript()
            if (!result) return
            // Structured transcripts (WebVTT / SRT subtitles, noScribe HTML)
            // parse straight to clean text + per-line times (ms precision,
            // markup stripped) and carry their provenance NOTE/metadata. Other
            // formats fall back to the inline-timestamp path, which the
            // migrate-on-open effect turns into lineTimes.
            const parsed =
              parseSubtitleTranscript(result.content) ||
              parseNoScribeHtmlTranscript(result.content)
            if (parsed) {
              updateSourceContent(sourceGuid, parsed.content)
              updateLineTimes(sourceGuid, parsed.lineTimes)
              // Keep the file's provenance (transcription tool, source media,
              // language settings, …) as a document memo so it isn't lost when
              // the markup is stripped out.
              if (parsed.notes.length > 0) {
                addMemo('document', t('transcript.importedNotes'), {
                  content: parsed.notes.join('\n\n'),
                  sourceGuids: [sourceGuid]
                })
              }
              // Offer to auto-code each detected speaker's lines.
              const speakers = detectSpeakers(parsed)
              if (speakers.length > 0) {
                const src = useDocumentStore.getState().sources.find((s) => s.guid === sourceGuid)
                setSpeakerDialog({ speakers, source: src })
              }
            } else {
              updateSourceContent(sourceGuid, detectAndConvertTimestamps(result.content))
            }
          }}
          title={t('transcript.importTitle')}
        >
          {t('common.import')}
        </button>
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            style={{
              padding: '3px 10px',
              fontSize: 11,
              fontWeight: 600,
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-primary)',
              color: 'var(--text-primary)',
              cursor: 'pointer'
            }}
            onClick={(e) => setExportMenu(exportMenu ? null : { x: e.currentTarget.getBoundingClientRect().right, y: e.currentTarget.getBoundingClientRect().bottom })}
            title={t('transcript.exportTitle')}
          >
            {t('common.export')}
          </button>
          {exportMenu && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 99 }} onClick={() => setExportMenu(null)} />
              <div className="context-menu" style={{ position: 'fixed', left: exportMenu.x, top: exportMenu.y, transform: 'translateX(-100%)', zIndex: 100, minWidth: 140 }}>
                <div className="context-menu-item" onClick={() => {
                  setExportMenu(null)
                  const blob = new Blob([content], { type: 'text/plain' })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a'); a.href = url; a.download = sourceName.replace(/\.[^.]+$/, '') + `-${t('transcript.fileSuffix')}.txt`; a.click()
                  URL.revokeObjectURL(url)
                }}>{t('transcript.exportTxt')}</div>
                <div className="context-menu-item" onClick={() => {
                  setExportMenu(null)
                  const blob = new Blob([content], { type: 'text/markdown' })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a'); a.href = url; a.download = sourceName.replace(/\.[^.]+$/, '') + `-${t('transcript.fileSuffix')}.md`; a.click()
                  URL.revokeObjectURL(url)
                }}>{t('transcript.exportMarkdown')}</div>
                <div className="context-menu-item" onClick={async () => {
                  setExportMenu(null)
                  const html = buildTranscriptHtml(sourceName, content, lineTimes)
                  const baseName = sourceName.replace(/\.[^.]+$/, '')
                  await exportPdfWithHeader(html, t('transcript.pdfTitle', { name: baseName }))
                }}>{t('transcript.exportPdf')}</div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Content area */}
      {isTranscribing ? (
        /* Transcription mode (audio + video): plain textarea with silent
           per-line time tagging. No timestamp text is injected. */
        <TranscriptionArea
          content={content}
          currentPlaybackTime={currentPlaybackTime}
          lineTimes={lineTimes}
          mediaKind={videoMode ? 'video' : 'audio'}
          onContentChange={(newContent) => applyTranscriptEdit(sourceGuid, newContent)}
          onLineTimesChange={(newLineTimes) => updateLineTimes(sourceGuid, newLineTimes)}
        />
      ) : (
        /* Coding mode — audio AND video both use the character-precise
           CodedTextView so a code highlights the exact coded text. The
           per-line timestamp gutter (lineTimestampMap) gives the time
           context; for video the CodeTrack timeline
           (rendered by VideoDocumentViewer) projects codings that carry a
           time range. */
        /* Coding mode: read-only highlighted text with full coding.
           Class hook so theme CSS can match this transcript's margins
           to the video transcript's container padding. */
        <div
          ref={codingAreaRef}
          className="transcript-coding-area"
          onScroll={rememberScroll}
          style={{
            flex: 1,
            overflow: 'auto',
            position: 'relative',
            outline: isDragOver && pendingSelection ? '2px dashed var(--accent)' : 'none',
            outlineOffset: -2
          }}
          onDragEnter={(e) => {
            if (e.dataTransfer.types.includes('application/x-magnolia-code') || e.dataTransfer.types.includes('application/x-magnolia-codes')) {
              e.preventDefault()
              dragCounterRef.current++
              setIsDragOver(true)
            }
          }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('application/x-magnolia-code') || e.dataTransfer.types.includes('application/x-magnolia-codes')) {
              e.preventDefault()
              e.dataTransfer.dropEffect = pendingSelection ? 'copy' : 'none'
            }
          }}
          onDragLeave={() => {
            dragCounterRef.current--
            if (dragCounterRef.current <= 0) { dragCounterRef.current = 0; setIsDragOver(false) }
          }}
          onDrop={(e) => {
            e.preventDefault()
            dragCounterRef.current = 0
            setIsDragOver(false)
            const multiData = e.dataTransfer.getData('application/x-magnolia-codes')
            if (multiData) { try { handleDrop(JSON.parse(multiData).map((c: any) => c.guid)) } catch {} return }
            const data = e.dataTransfer.getData('application/x-magnolia-code')
            if (data) { try { handleDrop([JSON.parse(data).guid]) } catch {} }
          }}
        >
          {pendingSelection && <SelectionDragHandle containerRef={codingAreaRef} sourceGuid={sourceGuid} anchor={textSelectionAnchor} />}
          {content ? (
            <CodedTextView
              text={content}
              sourceType="text"
              selections={selections}
              codes={codes}
              contentMemos={contentMemos}
              quotes={quoteRanges}
              externalHighlightRange={codedHighlight}
              lineTimestamps={lineTimestampMap}
              activeTimestampLine={activeTimestampLine}
              onTimestampClick={onTimestampClick}
              onTextSelected={handleTextSelected}
              onMemoClick={openMemo}
              onCodingRightClick={handleRightClick}
            />
          ) : (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
              {t('transcript.empty')}
            </div>
          )}

          {/* Drag overlay */}
          {isDragOver && pendingSelection && (
            <div style={{
              position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(124, 111, 240, 0.08)', pointerEvents: 'none', zIndex: 10
            }}>
              <span style={{ color: 'var(--accent)', fontWeight: 600, fontSize: 14 }}>{t('viewer.dropToApply')}</span>
            </div>
          )}
          {isDragOver && !pendingSelection && (
            <div style={{
              position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(224, 80, 80, 0.08)', pointerEvents: 'none', zIndex: 10
            }}>
              <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{t('viewer.selectFirst')}</span>
            </div>
          )}
        </div>
      )}

      {/* Context menu (coding mode only) */}
      {!isTranscribing && contextMenu && (
        <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(e) => e.stopPropagation()}>
          <div className="context-menu-item" onClick={() => {
            useNewCodeTriggerStore.getState().request()
            setContextMenu(null)
          }}>
            {t('viewer.newCode')}
          </div>
          <div className="context-menu-separator" />
          {contextMenu.context.pendingSelection && (
            <>
              <div style={{ padding: '4px 14px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, userSelect: 'none' }}>{t('viewer.applyCode')}</div>
              <div style={{ padding: '0 14px 6px', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4, maxWidth: 220, userSelect: 'none' }}>
                {t('viewer.applyHint')}
              </div>
              {hotkeyCodes.map(({ code }) => (
                <div key={code.guid} className="context-menu-item" onClick={() => handleApplyCode(code.guid)}>
                  <span className="color-pip" style={{ background: code.color || '#888' }} />
                  <span style={{ flex: 1 }}>{code.name}</span>
                  <span style={{ fontSize: 10, color: 'var(--menu-fg-muted)', marginInlineStart: 12 }}>{modKey(code.hotkey!)}</span>
                </div>
              ))}
              {hotkeyCodes.length === 0 && (
                <div className="context-menu-item" style={{ color: 'var(--menu-fg-muted)', pointerEvents: 'none' }}>{t('viewer.noHotkeysShort')}</div>
              )}
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
                useQuoteStore.getState().addQuote(sourceGuid, useDocumentStore.getState().sources.find((s) => s.guid === sourceGuid)?.name || '', ps.startCp, ps.endCp, ps.selectedText)
                setContextMenu(null)
              }}>{t('viewer.addAsQuote')}</div>
            </>
          )}
          {/* Memos in transcript contexts must attach to a range — no
              point memos. Only show this item when the user has a live
              text selection. */}
          {contextMenu.context.pendingSelection && (
            <>
              <div className="context-menu-separator" />
              <div className="context-menu-item" onClick={() => {
                handleCreateMemo(contextMenu.context.pendingSelection!.startCp, contextMenu.context.pendingSelection!.endCp)
              }}>{t('viewer.addSelectionMemo')}</div>
            </>
          )}
          {contextMenu.context.overlappingMemos && contextMenu.context.overlappingMemos.length > 0 && (
            <>
              <div className="context-menu-separator" />
              <div style={{ padding: '4px 14px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, userSelect: 'none' }}>{t('viewer.deleteMemo')}</div>
              {contextMenu.context.overlappingMemos.map((m) => (
                <div key={m.guid} className="context-menu-item" style={{ color: 'var(--menu-fg-danger)' }}
                  onClick={() => { removeMemo(m.guid); setContextMenu(null); setMenuHighlight(null) }}>
                  {m.title || t('memos.untitled')}
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {speakerDialog && (
        <SpeakerCodingDialog
          open
          speakers={speakerDialog.speakers}
          source={speakerDialog.source}
          onApply={handleSpeakerApply}
          onClose={() => setSpeakerDialog(null)}
        />
      )}
    </div>
  )
}

/**
 * TranscriptionArea — plain textarea used during video transcription.
 * Unlike audio transcription it does NOT inject bracketed timestamps into
 * the transcript text; instead it silently tags each newly-created line
 * with the current playhead time. The tags travel in formatData.lineTimes
 * and drive bracket placement, click-to-seek, and time-range coding on
 * text selections.
 *
 * The line-times table is remapped on every edit:
 *  - Inserting lines shifts existing indices outward and tags the newly
 *    inserted indices with the current playhead time.
 *  - Removing lines drops any tags for deleted indices and shifts tags on
 *    later lines down accordingly.
 *  - Editing text within a line preserves that line's tag.
 */
interface TranscriptionAreaProps {
  content: string
  currentPlaybackTime: number
  lineTimes?: Record<string, number>
  /** Which media is playing — used only for the banner copy. */
  mediaKind: 'audio' | 'video'
  onContentChange: (newContent: string) => void
  onLineTimesChange: (newLineTimes: Record<string, number>) => void
}

function TranscriptionArea({
  content,
  currentPlaybackTime,
  lineTimes,
  mediaKind,
  onContentChange,
  onLineTimesChange
}: TranscriptionAreaProps) {
  const { t } = useTranslation()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const preEditRef = useRef<{ content: string; selStart: number } | null>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  // Snapshot the pre-edit state so onChange can diff against it.
  const handleBeforeInput = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    preEditRef.current = { content: ta.value, selStart: ta.selectionStart }
  }, [])

  const handleKeyDownSnapshot = useCallback(() => {
    // Backspace / Delete go through onBeforeInput in modern browsers, but
    // snapshotting here too means we never miss an edit.
    const ta = textareaRef.current
    if (!ta) return
    preEditRef.current = { content: ta.value, selStart: ta.selectionStart }
  }, [])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newContent = e.target.value
    const ta = textareaRef.current
    const pre = preEditRef.current
    const prevTimes = lineTimes || {}

    // Compute line count before and after.
    const oldContent = pre?.content ?? content
    const oldLines = oldContent.split('\n').length
    const newLines = newContent.split('\n').length

    let nextTimes: Record<string, number> = prevTimes
    if (newLines !== oldLines && pre && ta) {
      const newCaret = ta.selectionStart
      // Line index of the caret in the new content (0-based).
      const newCaretLineIndex = newContent.slice(0, newCaret).split('\n').length - 1
      const diff = newLines - oldLines
      if (diff > 0) {
        // Lines inserted. The inserted block ends at newCaretLineIndex. The
        // first inserted index is (newCaretLineIndex - diff + 1). Shift any
        // existing tags at index >= firstInserted upward by `diff`, then
        // stamp each inserted index with the current playhead time.
        const firstInserted = newCaretLineIndex - diff + 1
        nextTimes = {}
        for (const [k, v] of Object.entries(prevTimes)) {
          const i = parseInt(k, 10)
          if (i >= firstInserted) nextTimes[String(i + diff)] = v
          else nextTimes[k] = v
        }
        for (let i = firstInserted; i <= newCaretLineIndex; i++) {
          nextTimes[String(i)] = currentPlaybackTime
        }
      } else if (diff < 0) {
        // Lines removed. Figure out where. The caret in the new content
        // sits on the line that survived the join; the removed indices
        // were at `newCaretLineIndex + 1 ... newCaretLineIndex + (-diff)`.
        const firstRemoved = newCaretLineIndex + 1
        const removedCount = -diff
        nextTimes = {}
        for (const [k, v] of Object.entries(prevTimes)) {
          const i = parseInt(k, 10)
          if (i >= firstRemoved && i < firstRemoved + removedCount) {
            // Dropped — this line no longer exists.
            continue
          }
          if (i >= firstRemoved + removedCount) nextTimes[String(i - removedCount)] = v
          else nextTimes[k] = v
        }
      }
    }

    preEditRef.current = null
    onContentChange(newContent)
    if (nextTimes !== prevTimes) onLineTimesChange(nextTimes)
  }, [content, lineTimes, currentPlaybackTime, onContentChange, onLineTimesChange])

  // On the very first keystroke in an empty transcript, tag line 0 with
  // the current playhead time so there's always at least one anchor.
  useEffect(() => {
    if (!content && !lineTimes) return
    const hasAny = lineTimes && Object.keys(lineTimes).length > 0
    if (!hasAny && content.length > 0) {
      onLineTimesChange({ '0': currentPlaybackTime })
    }
  }, [content, lineTimes, currentPlaybackTime, onLineTimesChange])

  return (
    <div style={{ flex: 1, overflow: 'hidden', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{
        padding: '4px 12px',
        fontSize: 10,
        color: 'var(--text-muted)',
        background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border-color)',
        userSelect: 'none',
        flexShrink: 0
      }}>
        {mediaKind === 'video' ? t('transcript.typingHintVideo') : t('transcript.typingHintAudio')}{' '}
        {t('transcript.enterHint')}
      </div>
      <textarea
        ref={textareaRef}
        value={content}
        onBeforeInput={handleBeforeInput}
        onKeyDown={handleKeyDownSnapshot}
        onChange={handleChange}
        placeholder={t('transcript.placeholder')}
        spellCheck={true}
        style={{
          flex: 1,
          width: '100%',
          border: 'none',
          outline: 'none',
          padding: '10px 14px',
          fontFamily: 'var(--font-doc)',
          fontSize: 14,
          // Taller line-height widens blank lines between paragraphs so
          // transcript breaks read with more breathing room. Within-
          // paragraph wrapped lines also get the same increase.
          lineHeight: '30px',
          background: 'var(--bg-primary)',
          color: 'var(--text-primary)',
          resize: 'none'
        }}
      />
    </div>
  )
}
