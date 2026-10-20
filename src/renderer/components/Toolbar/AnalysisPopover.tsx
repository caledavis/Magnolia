/**
 * AnalysisPopover — single "Analysis ▾" toolbar button that opens a
 * tile-grid popover listing every analysis tool. Replaces the previous
 * row of seven inline analysis-tool buttons (Codes in Docs / Results
 * in Docs / Co-Occurrences / Code Freq. / Code Orders / Word Freq. /
 * Relationships) so the top toolbar can give its remaining slots to
 * tools the user reaches for daily.
 *
 * The button is a controlled-style internal-state component: it
 * tracks open/closed itself, closes on outside-click + Escape + Escape
 * + tile-click + toolbar scroll, and calls `onSelect(toolType)` so the
 * host (App.tsx) routes to the right `openAnalysis(...)` flow.
 *
 * The popover panel itself is portaled to document.body and positioned
 * with `position: fixed` from the trigger button's own
 * getBoundingClientRect — it can't be a plain CSS-anchored absolute
 * child of the button here, because the button lives inside the
 * horizontally-scrolling toolbar track (.app-toolbar-scroll, GitHub
 * issue #15), which clips vertical overflow to enable that scrolling.
 * An absolutely-positioned popover nested inside would get clipped
 * invisible the moment it extended past the 54px toolbar height.
 */
import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Icon, faLightbulb, type IconComponent } from '../Icon'
import type { AnalysisToolType } from '../../models/types'
import { TOOL_REGISTRY } from '../../utils/tool-registry'

/** Tools the popover surfaces, in the order they appear in the grid.
 *  Query Builder is intentionally NOT in this list — it stays on the
 *  top toolbar as a primary action. */
const ANALYSIS_TOOL_ORDER: AnalysisToolType[] = [
  'codes-in-documents',
  'framework-matrix',
  'results-in-documents',
  'code-cooccurrences',
  'code-orders',
  'code-frequencies',
  'word-frequencies',
  'relationship-map',
  'reports'
]

// Matches the CSS .analysis-popover width — kept in sync manually since
// the portaled panel needs the number in JS to compute/clamp its position.
const POPOVER_W = 540
const EDGE_PAD = 8

interface Props {
  onSelect: (toolType: AnalysisToolType) => void
}

export function AnalysisPopover({ onSelect }: Props) {
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

  const handleSelect = (toolType: AnalysisToolType) => {
    onSelect(toolType)
    setOpen(false)
  }

  return (
    <div className="analysis-popover-anchor">
      <button
        ref={buttonRef}
        type="button"
        className="app-toolbar-btn"
        title="Analysis tools"
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
        <Icon icon={faLightbulb} style={{ fontSize: 20 }} />
        <span className="toolbar-label" style={{ fontSize: 9, whiteSpace: 'nowrap', fontWeight: 400, color: 'var(--text-secondary)', transition: 'color 0.12s' }}>Analyse</span>
      </button>

      {open && pos && createPortal(
        <div
          ref={popoverRef}
          className="analysis-popover"
          role="menu"
          style={{ position: 'fixed', top: pos.top, left: pos.left, transform: 'none', zIndex: 10000 }}
        >
          <div className="analysis-popover-arrow" style={{ left: pos.arrowLeft, transform: 'rotate(45deg)' }} />
          <div className="analysis-popover-title">Analysis tools</div>
          <div className="analysis-popover-grid">
            {ANALYSIS_TOOL_ORDER.map((toolType) => {
              const def = TOOL_REGISTRY[toolType]
              if (!def) return null
              const ToolIcon: IconComponent = def.icon
              return (
                <button
                  key={toolType}
                  type="button"
                  role="menuitem"
                  className="analysis-popover-tile"
                  onClick={() => handleSelect(toolType)}
                >
                  <Icon icon={ToolIcon} style={{ fontSize: 14 }} />
                  <div className="analysis-popover-tile-name">{def.label}</div>
                  {def.description && (
                    <div className="analysis-popover-tile-desc">{def.description}</div>
                  )}
                </button>
              )
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
