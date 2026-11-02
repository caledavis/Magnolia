/**
 * TranscriptGutter — the fixed-width, right-aligned, monospaced label at
 * the start of every transcript / document line, as rendered by
 * CodedTextView (the line number, or the line's timestamp in an audio or
 * video transcript). Styling lives here so a change to the width,
 * padding, or active treatment applies everywhere.
 *
 * Also exports TRANSCRIPT_ROW_STYLE, the shared row-container style used
 * by every viewer that wraps a gutter + body. Keeping it here means
 * cross-viewer alignment rules (baseline alignment in particular) stay
 * consistent without each viewer re-declaring them.
 */
import type { CSSProperties, MouseEvent } from 'react'

/** Row-container style shared by every text viewer. Callers spread this
 *  and then add their own size / highlight / data-attribute bits — the
 *  common alignment + layout properties live here once. */
export const TRANSCRIPT_ROW_STYLE: CSSProperties = {
  display: 'flex',
  // Baseline alignment so the smaller gutter label sits on the same
  // baseline as the body text instead of floating at the top of a
  // shorter line-box.
  alignItems: 'baseline',
  position: 'relative'
}

interface Props {
  /** The label text (line number or HH:MM:SS timestamp). */
  text: string
  /** Active-playback row — renders in the accent colour + bold. */
  active?: boolean
  /** Optional click handler. When provided the cursor becomes a pointer. */
  onClick?: (e: MouseEvent<HTMLSpanElement>) => void
  /** Tooltip shown on hover. */
  title?: string
  /** Render the text invisibly — keeps the column width so content stays
   *  aligned, but the label itself isn't shown. */
  invisible?: boolean
  /** Column width in px. Defaults to the timestamp width (80). Line-number
   *  gutters pass a narrower value — everything else (font, padding,
   *  alignment, active treatment) stays shared so visual tweaks to one
   *  gutter apply to all of them. */
  width?: number
}

export function TranscriptGutter({ text, active, onClick, title, invisible, width = 80 }: Props) {
  return (
    <span
      data-gutter="1"
      style={{
        width,
        minWidth: width,
        textAlign: 'right',
        paddingLeft: 12,
        paddingRight: 12,
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        color: invisible ? 'transparent' : active ? 'var(--accent)' : 'var(--text-muted)',
        fontWeight: active ? 600 : undefined,
        userSelect: 'none',
        flexShrink: 0,
        cursor: onClick ? 'pointer' : 'default'
      }}
      onClick={onClick}
      title={title}
    >
      {text}
    </span>
  )
}
