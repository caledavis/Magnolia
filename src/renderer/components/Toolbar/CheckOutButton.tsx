import { useEffect, useState } from 'react'
import { Icon, faClockArrowRight, faClockArrowLeft } from '../Icon'
import { useProjectStore } from '../../stores/project-store'
import { usePreferencesStore } from '../../stores/preferences-store'
import { useDocumentStore } from '../../stores/document-store'
import { requestPreferencesCategory } from '../Preferences/PreferencesWindow'
import { PREFERENCES_TAB_ID } from '../../utils/tab-ids'
import { CheckoutConflictDialog } from '../CheckoutConflictDialog'

type Status = 'none' | 'mine' | 'other'

/** Rest-state background/color per status. `display: 'flex'` must stay set
 *  here even though .app-toolbar-btn's !important block overrides
 *  flex-direction/align-items/gap/padding/height ("compact button row",
 *  global.css) — that block never sets `display` itself, so without this
 *  the button isn't a flex container at all and those overrides become
 *  inert (every other toolbar button sets this inline for the same
 *  reason). Hover is a real CSS :hover rule scoped by the
 *  checkout-btn--<status> class (see global.css) rather than the
 *  onMouseEnter/onMouseLeave pattern used elsewhere in App.tsx, since
 *  this button's rest background is itself dynamic. */
function checkoutBtnStyle(status: Status): React.CSSProperties {
  const background = status === 'mine' ? 'var(--accent)' : status === 'other' ? 'var(--danger)' : 'transparent'
  const color = status === 'none' ? 'var(--text-secondary)' : '#fff'
  return {
    display: 'flex',
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    background,
    color,
    lineHeight: 1,
    transition: 'background 0.12s, color 0.12s'
  }
}

/** Toolbar Check Out / Check In toggle. Icon direction encodes lock state
 *  (clock-arrow-right = available/checked out by someone, clock-arrow-left
 *  = checked out by you — click to check back in), color encodes who
 *  (accent = you, danger = someone else). Disabled until the project has
 *  been saved to a real file, since there's nothing to lock before then. */
export function CheckOutButton(): JSX.Element {
  const filePath = useProjectStore((s) => s.filePath)
  const marker = useProjectStore((s) => s.checkoutMarker)
  const setCheckoutMarker = useProjectStore((s) => s.setCheckoutMarker)
  const userName = usePreferencesStore((s) => s.userName)
  const prefsLoaded = usePreferencesStore((s) => s.loaded)
  const loadPrefs = usePreferencesStore((s) => s.load)
  const [confirming, setConfirming] = useState(false)

  // Preferences are loaded lazily, on-demand, by whichever component needs
  // them first (see AudioDocumentViewer/VideoDocumentViewer) — without this,
  // userName would stay at its empty default all session unless Preferences
  // or a media viewer happened to load it first.
  useEffect(() => {
    if (!prefsLoaded) loadPrefs()
  }, [prefsLoaded, loadPrefs])

  const myName = userName.trim()
  const status: Status = !marker ? 'none' : marker.userName === myName ? 'mine' : 'other'
  const disabled = !filePath

  const promptForName = (): void => {
    requestPreferencesCategory('general')
    useDocumentStore.getState().openToolTab(PREFERENCES_TAB_ID)
  }

  const doCheckOut = async (): Promise<void> => {
    if (!filePath || !myName) return
    try {
      const result = await window.api.checkOutProject(filePath, myName)
      setCheckoutMarker(result)
    } catch (err) {
      console.error('[check-out] failed:', err)
    }
  }

  const handleClick = (): void => {
    if (disabled || !filePath) return
    if (status === 'mine') {
      window.api.checkInProject(filePath).catch((err) => console.error('[check-in] failed:', err))
      setCheckoutMarker(null)
      return
    }
    if (status === 'other') {
      setConfirming(true)
      return
    }
    if (!myName) {
      promptForName()
      return
    }
    doCheckOut()
  }

  const title =
    status === 'mine'
      ? 'Check in to allow others to now work on this project'
      : status === 'other'
        ? `Checked out by ${marker!.userName} since ${new Date(marker!.checkedOutAt).toLocaleString()} — click to check out anyway`
        : 'Check out to prevent others from working on this project'

  return (
    <>
      {/* Wrapper reserves layout width for the WIDER of the two labels
          ("Check Out") via an invisible ghost, so toggling to the shorter
          "Check In" changes only the real button's own width — never this
          wrapper's — which is what stops the scrollable-middle button
          group (centered via margin: 0 auto) from recentering/jumping
          when this button's label changes. The real button is absolutely
          positioned within it, right-aligned, so it can still shrink to
          its own natural width. Chromium excludes <button> from an
          ancestor's drag region automatically, but the ghost is a plain
          <span> — not a button — so it stays part of the toolbar's
          draggable background, and so does any space the ghost reserves
          that the (narrower) real button doesn't currently fill. */}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', height: '100%' }}>
        <span aria-hidden="true" className="app-toolbar-btn" style={{ visibility: 'hidden', pointerEvents: 'none', display: 'flex' }}>
          <Icon icon={faClockArrowRight} />
          <span className="toolbar-label" style={{ whiteSpace: 'nowrap' }}>Check Out</span>
        </span>
        <button
          className={`app-toolbar-btn checkout-btn checkout-btn--${status}`}
          title={title}
          aria-label={title}
          disabled={disabled}
          onClick={handleClick}
          style={{
            ...checkoutBtnStyle(status),
            // top: 0 would pin this to the wrapper's top edge, not center
            // it — .app-toolbar-btn's height: 28px !important overrides
            // any height set here, so the wrapper (sized by the ghost,
            // itself also 28px but laid out via normal flow + align-items:
            // center) ends up taller than this absolutely-positioned
            // button. Center it explicitly instead.
            position: 'absolute',
            top: '50%',
            right: 0,
            transform: 'translateY(-50%)',
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.4 : 1
          }}
        >
          <Icon icon={status === 'mine' ? faClockArrowLeft : faClockArrowRight} />
          <span className="toolbar-label" style={{ whiteSpace: 'nowrap' }}>
            {status === 'mine' ? 'Check In' : 'Check Out'}
          </span>
        </button>
      </div>
      {confirming && marker && (
        <CheckoutConflictDialog
          marker={marker}
          onDismiss={() => setConfirming(false)}
          onOverride={async () => {
            setConfirming(false)
            await doCheckOut()
          }}
        />
      )}
    </>
  )
}
