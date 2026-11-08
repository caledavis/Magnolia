/**
 * CodeLabel — the small, coloured, monospaced code name that sits next
 * to a bracket in every margin column. Shared by CodedTextView (text and
 * audio/video transcripts) and RichMarginColumn (PDF / image). Colocating the styling means changes
 * to font, size, weight, line-height, ellipsis, or the
 * `data-margin-label` hook apply everywhere at once.
 */
import type { MouseEvent } from 'react'
import { LABEL_H } from './bracketLayout'

interface Props {
  left: number
  top: number
  /** Bracket colour — drives the label text colour. */
  color: string
  /** Max width before the text is ellipsed. Callers pass their margin's
   *  label allotment (usually MARGIN_LABEL_W / LABEL_W). */
  maxWidth: number
  /** The label text itself. */
  text: string
  /** Tooltip shown on hover. Defaults to the label text when omitted. */
  title?: string
  /** When the user has locked the highlight for this code, render with
   *  an underline to signal the toggled state. Callers that don't
   *  support locking simply omit the prop. */
  locked?: boolean
  onMouseEnter?: (e: MouseEvent<HTMLDivElement>) => void
  onMouseLeave?: (e: MouseEvent<HTMLDivElement>) => void
  onClick?: (e: MouseEvent<HTMLDivElement>) => void
  onDoubleClick?: (e: MouseEvent<HTMLDivElement>) => void
  onContextMenu?: (e: MouseEvent<HTMLDivElement>) => void
}

export function CodeLabel({
  left,
  top,
  color,
  maxWidth,
  text,
  title,
  locked,
  onMouseEnter,
  onMouseLeave,
  onClick,
  onDoubleClick,
  onContextMenu
}: Props) {
  return (
    <div
      data-margin-label="1"
      style={{
        position: 'absolute',
        // From the margin's start edge (its right in a right-to-left
        // interface; see CodedTextView's margin overlay).
        insetInlineStart: left,
        top,
        maxWidth,
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        lineHeight: `${LABEL_H}px`,
        fontWeight: 600,
        color,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        cursor: 'pointer',
        pointerEvents: 'auto',
        textDecoration: locked ? 'underline' : undefined
      }}
      title={title ?? text}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      {text}
    </div>
  )
}
