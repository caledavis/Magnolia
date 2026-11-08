import { Trans, useTranslation } from 'react-i18next'
import { formatDateTime } from '../i18n'
import type { CheckoutMarker } from '../models/types'

function formatWhen(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : formatDateTime(d)
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
  const { t } = useTranslation()
  return (
    <div className="modal-overlay" onClick={onDismiss}>
      <div className="modal" style={{ width: 460, maxWidth: '90vw' }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>{t('stealBack.title')}</h2>
        <p style={{ margin: '0 0 8px', color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)', lineHeight: 1.5 }}>
          <Trans i18nKey="stealBack.hasControl" values={{ name: marker.userName, when: formatWhen(marker.checkedOutAt) }} components={{ b: <strong /> }} />
        </p>
        <div style={{ margin: '0 0 16px', color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)', lineHeight: 1.5 }}>
          <p style={{ margin: '0 0 4px' }}>{t('stealBack.youCan')}</p>
          <ul style={{ margin: 0, paddingInlineStart: 20 }}>
            <li><Trans i18nKey="stealBack.optionTakeControl" values={{ name: marker.userName }} components={{ b: <strong /> }} /></li>
            <li><Trans i18nKey="stealBack.optionCopy" components={{ b: <strong /> }} /></li>
          </ul>
        </div>
        {/* Neutral styling on every action, same reasoning as
            CheckoutConflictDialog — no default nudges the user toward
            overriding someone else's in-progress work. */}
        <div className="modal-actions">
          <button className="secondary" onClick={onDismiss}>{t('common.cancel')}</button>
          <button className="secondary" onClick={onWorkOnCopy}>{t('checkout.createCopy')}</button>
          <button className="secondary" onClick={onStealBack}>{t('stealBack.takeControl')}</button>
        </div>
      </div>
    </div>
  )
}
