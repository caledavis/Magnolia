import type { CheckoutMarker } from '../models/types'

function formatWhen(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

/**
 * Shown whenever someone else holds the checkout lock: (a) the moment a
 * project opened from disk turns out to already be checked out by someone
 * else — read/edit access is never blocked, so `onWorkOnCopy` is offered
 * here too, letting the user route around the conflict immediately instead
 * of editing at their own risk — or (b) as a narrower confirm dialog, when
 * the user explicitly clicks Check Out on a project someone else holds
 * (only `onOverride` passed, no `onWorkOnCopy` — see CheckOutButton).
 */
export function CheckoutConflictDialog({
  marker,
  onDismiss,
  onOverride,
  onWorkOnCopy
}: {
  marker: CheckoutMarker
  onDismiss: () => void
  onOverride: () => void
  /** Omit to fall back to the narrower Cancel/Check-Out-Anyway dialog
   *  (CheckOutButton's click-triggered conflict, which has no "just
   *  opened, still fully editable" framing to offer a copy against). */
  onWorkOnCopy?: () => void
}): JSX.Element {
  return (
    <div className="modal-overlay" onClick={onDismiss}>
      <div className="modal" style={{ width: onWorkOnCopy ? 460 : 420, maxWidth: '90vw' }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>
          {onWorkOnCopy ? 'This project is checked out' : 'Check out anyway?'}
        </h2>
        <p style={{ margin: onWorkOnCopy ? '0 0 8px' : '0 0 16px', color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)', lineHeight: 1.5 }}>
          Checked out by <strong>{marker.userName}</strong> since {formatWhen(marker.checkedOutAt)}.
          {!onWorkOnCopy && " Checking it out now will replace their checkout marker with yours. If they're still editing, saving could overwrite each other's changes."}
        </p>
        {onWorkOnCopy && (
          <div style={{ margin: '0 0 16px', color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)', lineHeight: 1.5 }}>
            <p style={{ margin: '0 0 4px' }}>You can:</p>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              <li><strong>Check out anyway</strong> if you are sure {marker.userName} has stopped working on the file; or</li>
              <li><strong>Create a copy</strong> so you can merge your version and {marker.userName}'s version into one later.</li>
            </ul>
          </div>
        )}
        {/* All three actions use the neutral "secondary" style —
            deliberately no primary/accent button here. Whichever one
            reads as "the" default risks nudging the user toward
            overriding someone else's checkout when Cancel or Create a
            Copy may be the safer choice. */}
        <div className="modal-actions">
          <button className="secondary" onClick={onDismiss}>Cancel</button>
          {onWorkOnCopy && <button className="secondary" onClick={onWorkOnCopy}>Create a Copy</button>}
          <button className="secondary" onClick={onOverride}>Check Out Anyway</button>
        </div>
      </div>
    </div>
  )
}
