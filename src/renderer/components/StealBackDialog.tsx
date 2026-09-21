import type { CheckoutMarker } from '../models/types'

function formatWhen(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

/**
 * Shown when a save is refused because someone else now holds the
 * checkout lock — they stole it (or won an auto-checkout race) while this
 * window was mid-edit on what's now a stale copy. Unlike the up-front
 * CheckoutConflictDialog (shown at open, before there's anything of the
 * local user's to lose), this always has real unsaved local edits behind
 * it, so "Steal Back" deliberately never reloads/discards them — it hands
 * off to the Merge tool instead, comparing the other person's now-saved
 * disk version against these in-memory edits, so nothing is silently
 * destroyed on either side.
 */
export function StealBackDialog({
  marker,
  onDismiss,
  onStealBack,
  onWorkOnCopy
}: {
  marker: CheckoutMarker
  onDismiss: () => void
  /** Re-takes the lock (steal) and opens Merge comparing the current disk
   *  version (their saved changes) against this window's unsaved edits —
   *  never a blind reload. */
  onStealBack: () => void
  /** Preserves this window's unsaved edits as a separate file, same
   *  "Create a Copy" pattern as CheckoutConflictDialog. */
  onWorkOnCopy: () => void
}): JSX.Element {
  return (
    <div className="modal-overlay" onClick={onDismiss}>
      <div className="modal" style={{ width: 460, maxWidth: '90vw' }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>Can't save — the project changed hands</h2>
        <p style={{ margin: '0 0 8px', color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)', lineHeight: 1.5 }}>
          <strong>{marker.userName}</strong> has control of this project since {formatWhen(marker.checkedOutAt)}. Your changes since then haven't been saved.
        </p>
        <div style={{ margin: '0 0 16px', color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)', lineHeight: 1.5 }}>
          <p style={{ margin: '0 0 4px' }}>You can:</p>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            <li><strong>Take control</strong> — take control of the project back and open the Merge tool to reconcile your unsaved changes with {marker.userName}'s saved ones; or</li>
            <li><strong>Create a copy</strong> so your changes aren't lost, and merge the two later.</li>
          </ul>
        </div>
        {/* Neutral styling on every action, same reasoning as
            CheckoutConflictDialog — no default nudges the user toward
            overriding someone else's in-progress work. */}
        <div className="modal-actions">
          <button className="secondary" onClick={onDismiss}>Cancel</button>
          <button className="secondary" onClick={onWorkOnCopy}>Create a Copy</button>
          <button className="secondary" onClick={onStealBack}>Take Control</button>
        </div>
      </div>
    </div>
  )
}
