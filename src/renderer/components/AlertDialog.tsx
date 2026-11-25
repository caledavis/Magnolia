/**
 * The standard alert: a dialog like "This project is in use" (heading,
 * text, the neutral secondary buttons), and its reminder in the toolbar's
 * top-right corner, a pill like "Locked", that stays while the situation
 * does and reopens the dialog when clicked.
 */
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Icon, faExclamationTriangle } from './Icon'

export function AlertDialog({
  title,
  children,
  actions,
  onClose,
  width = 460
}: {
  title: string
  children: ReactNode
  /** The buttons, in order; the last has the focus when it opens. */
  actions: ReactNode
  onClose: () => void
  width?: number
}): JSX.Element {
  const titleId = useId()
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const buttons = boxRef.current?.querySelectorAll<HTMLButtonElement>('.modal-actions button')
    buttons?.[buttons.length - 1]?.focus()
  }, [])
  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <div
        ref={boxRef}
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ width, maxWidth: '90vw' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>{title}</h2>
        <div style={{ margin: '0 0 16px', color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)', lineHeight: 1.5 }}>
          {children}
        </div>
        <div className="modal-actions">{actions}</div>
      </div>
    </div>
  )
}

/** A red pill in the toolbar's top-right corner, like "Locked". */
export function AlertPill({ label, title, onClick }: { label: string; title: string; onClick: () => void }): JSX.Element {
  return (
    <div className="app-toolbar-pill checkout-pill checkout-pill--other" style={{ display: 'flex', alignItems: 'center' }}>
      <button
        className="app-toolbar-btn checkout-btn checkout-btn--other"
        title={title}
        aria-label={`${label}: ${title}`}
        onClick={onClick}
        style={{
          display: 'flex',
          gap: 6,
          border: 'none',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--danger)',
          color: '#fff',
          lineHeight: 1,
          transition: 'background 0.12s, color 0.12s'
        }}
      >
        <Icon icon={faExclamationTriangle} />
        <span className="toolbar-label" style={{ whiteSpace: 'nowrap' }}>{label}</span>
      </button>
    </div>
  )
}
