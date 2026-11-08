/**
 * Ribbon — an Office-style tabbed toolbar, shown when Preferences →
 * Appearance → Toolbar Style is "Ribbon". Adapted from the ribbon in
 * labiia_quali (https://github.com/cardososampaio/labiia_quali_magnolia,
 * EUPL-1.2), a fork of Magnolia.
 *
 * The tab strip sits in the toolbar row (beside the project name, clear
 * of the traffic lights) and the active tab's groups of large buttons
 * sit in a strip below it, so the ribbon costs one extra row, not two.
 * Each button is a flat glyph in the app's four-colour icon palette, so a
 * tool looks the same here as in the Analyses panel and its tab.
 *
 * Double-clicking a tab (or the chevron) collapses the ribbon to its tab
 * strip; the choice is remembered on this computer. While collapsed,
 * clicking a tab shows its buttons over the panels until you click a
 * button or anywhere else.
 *
 * A button is at least 76px wide, and wider when its label needs it: as
 * wide as the label's widest line when it's wrapped onto two lines as
 * evenly as its word breaks allow (see twoLineWidth). So a long word in
 * any language ("Woordfrequenties") widens its button instead of running
 * into the next one, and no label takes a third line. When that makes
 * the tab too wide for the window, labels that are one long word go back
 * to 76px and are hyphenated in the interface language (data-tight
 * "words"), and if it's still too wide, every label does ("all"). If
 * even that doesn't fit (a narrow window, or a tab with many buttons),
 * the buttons scroll sideways, between chevrons like the Icons and Text
 * toolbar's that fade in while there's more that way; clicking one
 * scrolls a page.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon, faChevronUp, faChevronDown, faChevronsLeft, faChevronsRight, type IconComponent } from '../Icon'
import { PALETTE_ICON_CLASS } from '../../utils/icon-tint'
import { useTranslation } from 'react-i18next'

export interface RibbonButtonDef {
  id: string
  label: string
  icon?: IconComponent
  /** Drawn in place of `icon`, for a glyph that isn't a Lucide icon
   *  (the Magnolia logo). */
  glyph?: React.ReactNode
  onClick: () => void
  title?: string
  /** Dimmed with an explanation, e.g. while someone else has the project
   *  checked out. The click still runs, so the action can explain itself. */
  disabledReason?: string
  /** Toggle buttons (panels) show their on state. */
  pressed?: boolean
  /** A small dot on the tile, e.g. "a new version is available". */
  badge?: boolean
  iconStyle?: React.CSSProperties
}

export interface RibbonGroupDef {
  label: string
  buttons: RibbonButtonDef[]
}

export interface RibbonTabDef {
  id: string
  label: string
  groups: RibbonGroupDef[]
}

const COLLAPSED_KEY = 'magnolia.ribbonCollapsed'
const TAB_KEY = 'magnolia.ribbonTab'

function readStored(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function writeStored(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* keep the session value */ }
}

/** The ribbon's state, shared by the tab strip and the button strip,
 *  which App renders in different rows. */
export function useRibbon(tabs: RibbonTabDef[]) {
  const [activeId, setActiveId] = useState(() => readStored(TAB_KEY) ?? tabs[0].id)
  const [collapsed, setCollapsed] = useState(() => readStored(COLLAPSED_KEY) === '1')
  const [peek, setPeek] = useState(false)

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      writeStored(COLLAPSED_KEY, c ? '0' : '1')
      return !c
    })
    setPeek(false)
  }, [])

  const selectTab = useCallback((id: string) => {
    setActiveId(id)
    writeStored(TAB_KEY, id)
    setPeek((p) => (collapsed ? !(p && id === activeId) : false))
  }, [collapsed, activeId])

  // A peeking ribbon closes on a click anywhere outside it.
  useEffect(() => {
    if (!peek) return
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.('.ribbon-tabs, .ribbon-body')) setPeek(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPeek(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [peek])

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]
  return { tabs, active, collapsed, peek, selectTab, toggleCollapsed, endPeek: () => setPeek(false) }
}

type RibbonState = ReturnType<typeof useRibbon>

export function RibbonTabs({ ribbon }: { ribbon: RibbonState }) {
  const { t } = useTranslation()
  const { tabs, active, collapsed, peek, selectTab, toggleCollapsed } = ribbon
  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const next = (index + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length
    selectTab(tabs[next].id)
    const strip = (e.currentTarget as HTMLElement).parentElement
    strip?.querySelectorAll<HTMLButtonElement>('.ribbon-tab')[next]?.focus()
  }
  return (
    <div className={`ribbon-tabs${collapsed && !peek ? ' ribbon-collapsed' : ''}`} role="tablist" aria-label={t('toolbar.label')}>
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          className="ribbon-tab"
          aria-selected={tab.id === active.id}
          tabIndex={tab.id === active.id ? 0 : -1}
          onClick={() => selectTab(tab.id)}
          onDoubleClick={toggleCollapsed}
          onKeyDown={(e) => onKeyDown(e, index)}
        >
          {tab.label}
        </button>
      ))}
      <button
        type="button"
        className="ribbon-collapse"
        onClick={toggleCollapsed}
        title={collapsed ? t('toolbar.showRibbon') : t('toolbar.hideRibbon')}
        aria-label={collapsed ? t('toolbar.showRibbon') : t('toolbar.hideRibbon')}
      >
        <Icon icon={collapsed ? faChevronDown : faChevronUp} />
      </button>
    </div>
  )
}

/** Fit the ribbon's buttons to the window: narrow them in stages while
 *  they're wider than it (data-tight, above), then let them scroll, with
 *  the chevrons shown while there's more on their side. Checked again on
 *  every resize, scroll and tab. */
function useRibbonFit(active: RibbonTabDef, shown: boolean) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)
  const [canLeft, setCanLeft] = useState(false)
  const [canRight, setCanRight] = useState(false)

  const updateChevrons = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanLeft(el.scrollLeft > 1)
    setCanRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1)
  }, [])

  useLayoutEffect(() => {
    const body = bodyRef.current
    const scroller = scrollRef.current
    if (!body || !scroller) return
    const fit = (): void => {
      // Room inside the body's padding, whether or not the chevrons are
      // taking some of it now.
      const style = getComputedStyle(body)
      const room = body.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const fits = (): boolean => scroller.scrollWidth <= room + 1
      body.removeAttribute('data-tight')
      for (const stage of ['words', 'all']) {
        if (fits()) break
        body.setAttribute('data-tight', stage)
      }
      setOverflow(!fits())
      updateChevrons()
    }
    fit()
    // The window (the body) and the groups, which change size when their
    // labels do (another language) or buttons come and go.
    // Refit on the next frame: fitting resizes the groups, which would
    // otherwise notify this observer again within the same frame.
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(fit)
    })
    observer.observe(body)
    for (const group of scroller.children) observer.observe(group)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [active.id, active.groups.length, shown, updateChevrons])

  // A new tab starts scrolled to its first button.
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollLeft = 0
  }, [active.id])

  // The chevrons take room when they appear, so recheck which show then.
  useLayoutEffect(updateChevrons, [overflow, updateChevrons])

  const scrollPage = (direction: 1 | -1): void => {
    const el = scrollRef.current
    el?.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: 'smooth' })
  }
  return { bodyRef, scrollRef, overflow, canLeft, canRight, updateChevrons, scrollPage }
}

/** A chevron beside the scrolling buttons, for mouse users without a
 *  sideways scroll. Hidden from keyboards and screen readers, which reach
 *  every button by Tab (and the focused button scrolls into view). */
function ScrollChevron({ side, shown, onClick }: { side: 'left' | 'right'; shown: boolean; onClick: () => void }) {
  return (
    <button type="button" className="ribbon-scroll-hint" data-shown={shown || undefined} tabIndex={-1} aria-hidden onClick={onClick}>
      <Icon icon={side === 'left' ? faChevronsLeft : faChevronsRight} />
    </button>
  )
}

export function RibbonBody({ ribbon }: { ribbon: RibbonState }) {
  const { active, collapsed, peek, endPeek } = ribbon
  const fit = useRibbonFit(active, !collapsed || peek)
  if (collapsed && !peek) return null
  const body = (
    <div ref={fit.bodyRef} className="ribbon-body" role="tabpanel" aria-label={active.label}>
      {fit.overflow && <ScrollChevron side="left" shown={fit.canLeft} onClick={() => fit.scrollPage(-1)} />}
      <div ref={fit.scrollRef} className="ribbon-scroll" onScroll={fit.updateChevrons}>
        {active.groups.map((group) => (
          <div key={group.label} className="ribbon-group" role="group" aria-label={group.label}>
            <div className="ribbon-group-buttons">
              {group.buttons.map((b) => <RibbonButton key={b.id} def={b} onDone={endPeek} />)}
            </div>
            <div className="ribbon-group-label">{group.label}</div>
          </div>
        ))}
      </div>
      {fit.overflow && <ScrollChevron side="right" shown={fit.canRight} onClick={() => fit.scrollPage(1)} />}
    </div>
  )
  // Peeking from a collapsed ribbon: float over the panels below.
  return peek ? <div className="ribbon-peek-host">{body}</div> : body
}

/** The narrowest width at which `text` fits on at most two lines, given
 *  `measure` (a run of text's width). Lines break after spaces and
 *  hyphens, as the browser breaks them, and never inside a word. */
export function twoLineWidth(text: string, measure: (s: string) => number): number {
  const parts = text.trim().split(/(?<=[\s-])/)
  let best = measure(text.trim())
  for (let i = 1; i < parts.length; i++) {
    const first = measure(parts.slice(0, i).join('').trimEnd())
    const second = measure(parts.slice(i).join(''))
    best = Math.min(best, Math.max(first, second))
  }
  return best
}

/** `label`'s two-line width in ems of its own font size, so it holds in
 *  the compact ribbon's smaller type too. Measured with a hidden copy of
 *  the label, so it's in exactly the font the label is drawn in. */
function labelWidthEm(label: HTMLElement): number | null {
  const probe = document.createElement('span')
  probe.className = label.className
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;min-width:0;min-height:0'
  label.parentElement?.appendChild(probe)
  const measure = (s: string): number => { probe.textContent = s; return probe.getBoundingClientRect().width }
  const px = twoLineWidth(label.textContent ?? '', measure)
  const size = parseFloat(getComputedStyle(probe).fontSize)
  probe.remove()
  // A hair extra, so rounding never pushes the last word onto a new line.
  return size > 0 && px > 0 ? px / size + 0.05 : null
}

function RibbonButton({ def, onDone }: { def: RibbonButtonDef; onDone: () => void }) {
  const labelRef = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const el = labelRef.current
    if (!el) return
    const em = labelWidthEm(el)
    el.style.minWidth = em ? `${em.toFixed(3)}em` : ''
    // A label with nowhere to break but inside its word.
    el.toggleAttribute('data-one-word', !/[\s-]/.test(def.label.trim()))
  }, [def.label])
  return (
    <button
      type="button"
      className="ribbon-btn"
      aria-pressed={def.pressed}
      aria-disabled={def.disabledReason ? true : undefined}
      title={def.disabledReason ?? def.title ?? def.label}
      onClick={() => {
        def.onClick()
        onDone()
      }}
    >
      <span className="ribbon-tile">
        {def.glyph ?? (def.icon && <Icon icon={def.icon} className={PALETTE_ICON_CLASS} style={def.iconStyle} />)}
        {def.badge && <span className="ribbon-badge" aria-hidden />}
      </span>
      <span ref={labelRef} className="ribbon-label">{def.label}</span>
    </button>
  )
}
