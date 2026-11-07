import { Icon, faExclamationTriangle } from '../Icon'
import { useProjectStore } from '../../stores/project-store'
import { usePreferencesStore } from '../../stores/preferences-store'
import { useTranslation } from 'react-i18next'
import { formatDateTime } from '../../i18n'

/** Toolbar checkout-lock alert. Checkout itself is now automatic (first
 *  edit auto-claims the lock — see App.tsx's dirty-transition effect) and
 *  enforced at the point of each mutating control (see
 *  useCheckoutLockedBy in project-store.ts), so there's no manual Check
 *  Out/Check In toggle anymore. This renders nothing unless someone ELSE
 *  currently holds the lock — i.e. the local user does not have control,
 *  whether because they opened onto an already-locked project or because
 *  it was taken from them mid-edit. Click reopens the same Take Over /
 *  Create a Copy / Cancel choice as App.tsx's shared CheckoutConflictDialog
 *  (triggered via promptCheckoutConflict, same as every other locked
 *  control) rather than owning a separate dialog instance here. */
export function CheckOutButton(): JSX.Element | null {
  const { t } = useTranslation()
  const marker = useProjectStore((s) => s.checkoutMarker)
  const promptCheckoutConflict = useProjectStore((s) => s.promptCheckoutConflict)
  const userName = usePreferencesStore((s) => s.userName)

  const lockedByOther = !!marker && marker.userName !== userName.trim()
  if (!lockedByOther) return null

  const title = t('toolbar.lockedTitle', { name: marker!.userName, time: formatDateTime(marker!.checkedOutAt) })

  return (
    <div className="app-toolbar-pill checkout-pill checkout-pill--other" style={{ display: 'flex', alignItems: 'center' }}>
      <button
        className="app-toolbar-btn checkout-btn checkout-btn--other"
        title={title}
        aria-label={title}
        onClick={() => promptCheckoutConflict()}
        style={{
          display: 'flex',
          border: 'none',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--danger)',
          color: '#fff',
          lineHeight: 1,
          transition: 'background 0.12s, color 0.12s'
        }}
      >
        <Icon icon={faExclamationTriangle} />
        <span className="toolbar-label" style={{ whiteSpace: 'nowrap' }}>{t('toolbar.locked')}</span>
      </button>
    </div>
  )
}
