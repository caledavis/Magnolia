import { Trans, useTranslation } from 'react-i18next'
import { formatDateTime } from '../i18n'
import type { CheckoutMarker } from '../models/types'

function formatWhen(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : formatDateTime(d)
}

/**
 * Shown whenever someone else holds the checkout lock: (a) the moment a
 * project opened from disk turns out to already be held by someone else,
 * or a local edit's own auto-checkout attempt lost the race — the editor
 * goes read-only for as long as this stands, so `onWorkOnCopy` is offered
 * here too as the way to keep working without waiting on the lock — or
 * (b) as a narrower confirm dialog, when the user explicitly clicks Check
 * Out on a project someone else holds (only `onOverride` passed, no
 * `onWorkOnCopy` — see CheckOutButton).
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
  /** Omit to fall back to the narrower Cancel/Take-Over-Anyway dialog
   *  (CheckOutButton's click-triggered conflict, which has no "just
   *  opened, still fully editable" framing to offer a copy against). */
  onWorkOnCopy?: () => void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="modal-overlay" onClick={onDismiss}>
      <div className="modal" style={{ width: onWorkOnCopy ? 460 : 420, maxWidth: '90vw' }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>
          {onWorkOnCopy ? t('checkout.inUse') : t('checkout.takeControlQuestion')}
        </h2>
        <p style={{ margin: onWorkOnCopy ? '0 0 8px' : '0 0 16px', color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)', lineHeight: 1.5 }}>
          <Trans i18nKey="checkout.workingSince" values={{ name: marker.userName, when: formatWhen(marker.checkedOutAt) }} components={{ b: <strong /> }} />
          {!onWorkOnCopy && <> {t('checkout.takeOverWarning')}</>}
        </p>
        {onWorkOnCopy && (
          <div style={{ margin: '0 0 16px', color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)', lineHeight: 1.5 }}>
            <p style={{ margin: '0 0 4px' }}>{t('checkout.viewOnly')}</p>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              <li><Trans i18nKey="checkout.optionTakeControl" values={{ name: marker.userName }} components={{ b: <strong /> }} /></li>
              <li><Trans i18nKey="checkout.optionCopy" values={{ name: marker.userName }} components={{ b: <strong /> }} /></li>
            </ul>
          </div>
        )}
        {/* All three actions use the neutral "secondary" style —
            deliberately no primary/accent button here. Whichever one
            reads as "the" default risks nudging the user toward
            overriding someone else's lock when Cancel or Create a
            Copy may be the safer choice. */}
        <div className="modal-actions">
          <button className="secondary" onClick={onDismiss}>{t('common.cancel')}</button>
          {onWorkOnCopy && <button className="secondary" onClick={onWorkOnCopy}>{t('checkout.createCopy')}</button>}
          <button className="secondary" onClick={onOverride}>{t('checkout.takeControlAnyway')}</button>
        </div>
      </div>
    </div>
  )
}
