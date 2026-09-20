/**
 * HelpPopover — single "?" toolbar button bundling the Licence &
 * attributions dialog, the online user manual, and a Donate link into
 * one popover, in place of the three separate toolbar buttons those
 * used to be. Frees up toolbar space and groups "about Magnolia"
 * actions the same way AnalysisPopover groups analysis tools.
 *
 * Structurally a sibling of AnalysisPopover/StudioPopover: owns its
 * own open/closed state, closes on outside-click + Escape + row-click
 * + toolbar scroll, and portals the panel to document.body with
 * `position: fixed` computed from the button's getBoundingClientRect
 * — see AnalysisPopover's header comment for why (the button lives
 * inside the horizontally-scrolling toolbar track, which clips a plain
 * absolutely-positioned child).
 */
import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Icon, faCircleQuestion, faScale, faFileAlt, faHeart, type IconComponent } from '../Icon'

/** GitHub Sponsors page for funding Magnolia's development — same link
 *  as Preferences → Support Magnolia and the Welcome screen's ♥. */
const SPONSOR_URL = 'https://github.com/sponsors/caledavis'
const MANUAL_URL = 'https://caledavis.github.io/Magnolia/'

interface Props {
  onShowLicence: () => void
}

interface HelpRow {
  icon: IconComponent
  name: string
  description: string
  action: () => void
}

// Matches the CSS .help-popover width — kept in sync manually since
// the portaled panel needs the number in JS to compute/clamp its position.
const POPOVER_W = 480
const EDGE_PAD = 8

export function HelpPopover({ onShowLicence }: Props) {
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

  const rows: HelpRow[] = [
    {
      icon: faScale,
      name: 'Licence & Attributions',
      description: "Magnolia's licence (EUPL-1.2) and credits for bundled libraries.",
      action: onShowLicence
    },
    {
      icon: faFileAlt,
      name: 'Manual',
      description: "Open Magnolia's user manual in your browser.",
      action: () => window.open(MANUAL_URL, '_blank')
    },
    {
      icon: faHeart,
      name: 'Donate',
      description: 'Magnolia is free to use, but costs me money to make. If it is useful, please consider donating to cover my costs.',
      action: () => window.open(SPONSOR_URL, '_blank')
    }
  ]

  const handleSelect = (action: () => void) => {
    action()
    setOpen(false)
  }

  return (
    <div className="analysis-popover-anchor">
      <button
        ref={buttonRef}
        type="button"
        className="app-toolbar-btn"
        title="Help"
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
          color: 'var(--text-secondary)',
          cursor: 'pointer',
          lineHeight: 1,
          transition: 'background 0.12s, color 0.12s'
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--bg-tertiary)'
          e.currentTarget.style.color = 'var(--text-primary)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent'
          e.currentTarget.style.color = 'var(--text-secondary)'
        }}
      >
        <Icon icon={faCircleQuestion} style={{ fontSize: 20 }} />
        <span className="toolbar-label" style={{ fontSize: 9, whiteSpace: 'nowrap', fontWeight: 400 }}>Help</span>
      </button>

      {open && pos && createPortal(
        <div
          ref={popoverRef}
          className="analysis-popover help-popover"
          role="menu"
          style={{ position: 'fixed', top: pos.top, left: pos.left, transform: 'none', zIndex: 10000 }}
        >
          <div className="analysis-popover-arrow" style={{ left: pos.arrowLeft, transform: 'rotate(45deg)' }} />
          <div className="analysis-popover-title">Help</div>
          <div className="help-popover-grid">
            {rows.map((row) => (
              <button
                key={row.name}
                type="button"
                role="menuitem"
                className="analysis-popover-tile"
                onClick={() => handleSelect(row.action)}
              >
                <Icon icon={row.icon} style={{ fontSize: 14 }} />
                <div className="analysis-popover-tile-name">{row.name}</div>
                <div className="analysis-popover-tile-desc">{row.description}</div>
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
