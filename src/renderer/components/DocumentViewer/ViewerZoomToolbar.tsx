import { useTranslation } from 'react-i18next'
/**
 * ViewerZoomToolbar — small floating zoom-control buttons shared by the
 * PDF and image viewers. Mirrors the "100%" button styling in the
 * Relationship Map (MapCanvas.tsx).
 *
 *   - "100%" — visible when zoom !== 1; snaps back to native 1.0 scale.
 *   - "To Fit" — visible when an `onFit` callback is provided; lets the
 *     user re-fit the document to the available area. The two buttons
 *     work as a pair so the user can flip between actual size and a
 *     comfortable "fit" view at any time.
 */
interface Props {
  zoom: number
  onZoomChange: (next: number) => void
  /** Provide to enable the "To Fit" button. The viewer decides what
   *  "fit" means (fit-to-window for images, fit-to-width for PDFs, etc). */
  onFit?: () => void
  /** Optional tolerance below which the 100% button is hidden. Useful
   *  when a fit-to-window default lands very close to (but not exactly) 1. */
  epsilon?: number
}

const buttonStyle: React.CSSProperties = {
  fontSize: 10,
  padding: '3px 8px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border-color)',
  background: 'var(--bg-panel)',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  opacity: 0.85
}

export function ViewerZoomToolbar({ zoom, onZoomChange, onFit, epsilon = 0.001 }: Props) {
  const { t } = useTranslation()
  const showReset = Math.abs(zoom - 1) >= epsilon
  if (!showReset && !onFit) return null
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {showReset && (
        <button
          onClick={() => onZoomChange(1)}
          title={t('viewer.resetZoomTitle')}
          style={buttonStyle}
        >
          100%
        </button>
      )}
      {onFit && (
        <button
          onClick={onFit}
          title={t('viewer.fitWindow')}
          style={buttonStyle}
        >
          {t('viewer.toFit')}
        </button>
      )}
    </div>
  )
}
