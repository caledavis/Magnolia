/**
 * StudioPopover — single "Studio" toolbar button that opens a
 * checklist popover for showing/hiding the main-window workspace
 * panels (Documents / Codes / Queries / Memos / Quotes / Analyses).
 *
 * This is the cross-platform home for what the native View menu does
 * on macOS. Windows and Linux run a frameless window with custom
 * window controls, so the native menu bar — and therefore the only
 * way to reopen a panel after closing it — is unreachable there. The
 * Studio popover gives every platform an in-window equivalent (and a
 * faster one on macOS too), mirroring the View menu's six panel
 * toggles exactly.
 *
 * Structurally a sibling of AnalysisPopover: it owns its open/closed
 * state, closes on outside-click + Escape, reuses the shared
 * .analysis-popover container chrome, and portals the panel to
 * document.body with `position: fixed` computed from the button's
 * getBoundingClientRect — see AnalysisPopover's header comment for why
 * (the button lives inside the horizontally-scrolling toolbar track,
 * which clips a plain absolutely-positioned child). The rows stay open
 * on click so users can toggle several panels in one visit; visibility
 * state is owned by the host (App.tsx) and flows in via `panels`.
 */
import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Icon, faAppWindow, faCheck } from '../Icon'
import { PANE_ICONS, type PaneIconId } from '../../utils/pane-icons'
import { PALETTE_ICON_CLASS } from '../../utils/icon-tint'
import { useTranslation } from 'react-i18next'

export interface StudioPanelToggle {
  /** Stable key the host switches on in `onToggle`; also picks the
   *  row's icon from PANE_ICONS. */
  id: PaneIconId
  label: string
  visible: boolean
}

interface Props {
  panels: StudioPanelToggle[]
  onToggle: (id: string) => void
}

// Matches the CSS .studio-popover width — kept in sync manually since
// the portaled panel needs the number in JS to compute/clamp its position.
const POPOVER_W = 220
const EDGE_PAD = 8

export function StudioPopover({ panels, onToggle }: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; arrowLeft: number } | null>(null)

  // Close on outside-click + Escape. Only attached while open so the
  // listeners stay off until needed.
  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (popoverRef.current?.contains(target)) return
      if (buttonRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // Compute the portaled popover's fixed-position coordinates from the
  // button whenever it opens, centred under the button and clamped so
  // it can't run off the window edge. Also closes on scroll/resize —
  // the position is a one-shot snapshot, and the toolbar's horizontal
  // scroll (or a window resize) would otherwise leave it pointing at
  // empty space instead of the button.
  useEffect(() => {
    if (!open || !buttonRef.current) {
      setPos(null)
      return
    }
    const button = buttonRef.current
    const update = () => {
      const rect = button.getBoundingClientRect()
      const desiredLeft = rect.left + rect.width / 2 - POPOVER_W / 2
      const left = Math.max(EDGE_PAD, Math.min(desiredLeft, window.innerWidth - POPOVER_W - EDGE_PAD))
      setPos({
        left,
        top: rect.bottom + 22,
        arrowLeft: rect.left + rect.width / 2 - left
      })
    }
    update()
    const scrollHost = button.closest('.app-toolbar-scroll')
    const onDismiss = () => setOpen(false)
    scrollHost?.addEventListener('scroll', onDismiss)
    window.addEventListener('resize', onDismiss)
    return () => {
      scrollHost?.removeEventListener('scroll', onDismiss)
      window.removeEventListener('resize', onDismiss)
    }
  }, [open])

  return (
    <div className="analysis-popover-anchor">
      <button
        ref={buttonRef}
        type="button"
        className="app-toolbar-btn"
        title={t('toolbar.studioTitle')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 3,
          padding: '4px 12px',
          border: 'none',
          borderRadius: 'var(--radius-sm)',
          background: 'transparent',
          cursor: 'pointer',
          lineHeight: 1,
          transition: 'background 0.12s'
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--bg-tertiary)';
          (e.currentTarget.querySelector('.toolbar-label') as HTMLElement).style.color = 'var(--text-primary)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          (e.currentTarget.querySelector('.toolbar-label') as HTMLElement).style.color = 'var(--text-secondary)'
        }}
      >
        <Icon icon={faAppWindow} style={{ fontSize: 20 }} />
        <span className="toolbar-label" style={{ fontSize: 9, whiteSpace: 'nowrap', fontWeight: 400, color: 'var(--text-secondary)', transition: 'color 0.12s' }}>{t('toolbar.studio')}</span>
      </button>

      {open && pos && createPortal(
        <div
          ref={popoverRef}
          className="analysis-popover studio-popover"
          role="menu"
          style={{ position: 'fixed', top: pos.top, left: pos.left, transform: 'none', zIndex: 10000 }}
        >
          <div className="analysis-popover-arrow" style={{ left: pos.arrowLeft, transform: 'rotate(45deg)' }} />
          <div className="analysis-popover-title">{t('toolbar.panels')}</div>
          <div className="studio-popover-list">
            {panels.map((panel) => (
              <button
                key={panel.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={panel.visible}
                className="studio-popover-row"
                onClick={() => onToggle(panel.id)}
              >
                <span className="studio-popover-check" aria-hidden>
                  {panel.visible && <Icon icon={faCheck} style={{ fontSize: 13 }} />}
                </span>
                <Icon icon={PANE_ICONS[panel.id]} className={PALETTE_ICON_CLASS} style={{ fontSize: 14, flexShrink: 0 }} />
                <span className="studio-popover-row-name">{panel.label}</span>
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
