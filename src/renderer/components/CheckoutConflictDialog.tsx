import type { CheckoutMarker } from '../models/types'

function formatWhen(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

/**
 * Shown either (a) informationally, when a project opened from disk is
 * already checked out by someone else — read access is never blocked, this
 * is purely a heads-up — or (b) as a confirm dialog, when the current user
 * clicks Check Out on a project someone else holds (pass `onOverride`).
 */
export function CheckoutConflictDialog({
  marker,
  onDismiss,
  onOverride
}: {
  marker: CheckoutMarker
  onDismiss: () => void
  onOverride?: () => void
}): JSX.Element {
  return (
    <div className="modal-overlay" onClick={onDismiss}>
      <div className="modal" style={{ width: 420, maxWidth: '90vw' }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>
          {onOverride ? 'Check out anyway?' : 'This project is checked out'}
        </h2>
        <p style={{ margin: '0 0 16px', color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)', lineHeight: 1.5 }}>
          Checked out by <strong>{marker.userName}</strong> since {formatWhen(marker.checkedOutAt)}.
          {onOverride
            ? " Checking it out now will replace their checkout marker with yours. If they're still editing, saving could overwrite each other's changes."
            : ' You can open and view this project, but editing and saving it while someone else has it checked out risks overwriting their changes.'}
        </p>
        <div className="modal-actions">
          {onOverride ? (
            <>
              <button className="secondary" onClick={onDismiss}>Cancel</button>
              <button onClick={onOverride}>Check Out Anyway</button>
            </>
          ) : (
            <button onClick={onDismiss}>OK</button>
          )}
        </div>
      </div>
    </div>
  )
}
