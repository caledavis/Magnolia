/**
 * The AI Assistance Viewer: every change an AI app on this computer
 * (Claude Desktop…) has proposed, for the user to approve or reject, listed
 * as they arrive. Nothing the AI suggests reaches the project any other
 * way (see utils/ai/apply.ts). It's also where a project is let be used
 * by AI apps (it opens to ask when one first does), and stopped.
 *
 * Each proposal shows what it would do, in context (a coding's passage
 * with the text around it, a link to it in its document), and the AI's
 * reason. Proposals can be decided one by one, a code at a time, or all
 * together; approved ones are made at once, so one Undo takes them back.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAiStore, type AiProposal, type ProposalStatus } from '../../stores/ai-store'
import { useCodeStore } from '../../stores/code-store'
import { useDocumentStore } from '../../stores/document-store'
import { approve, deny, withDependents, withRequirements } from '../../utils/ai/apply'
import { documentText } from '../../utils/ai/tools'
import { buildCellText } from '../../utils/survey/cell-text'
import { usePreferencesStore } from '../../stores/preferences-store'
import { PREFERENCES_TAB_ID } from '../../utils/tab-ids'
import { requestPreferencesCategory } from '../Preferences/PreferencesWindow'
import type { Code, SurveyFormatData } from '../../models/types'
import { Icon, faSparkles, faCheck, faXmark, faPlus } from '../Icon'
import { SegmentedControl } from '../Analysis/SegmentedControl'
import { announce } from '../../utils/keyboard-access'
import { PALETTE_ICON_CLASS } from '../../utils/icon-tint'

type Filter = 'pending' | 'approved' | 'denied'
type ReviewView = 'focused' | 'list'
const VIEW_KEY = 'magnolia-ai-review-view'

const FILTERS: { id: Filter; statuses: ProposalStatus[] }[] = [
  { id: 'pending', statuses: ['pending'] },
  { id: 'approved', statuses: ['approved'] },
  { id: 'denied', statuses: ['denied', 'failed'] }
]

export function AiReviewTab({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const proposals = useAiStore((s) => s.proposals)
  const appsAllowed = useAiStore((s) => s.appsAllowed)
  const appRequest = useAiStore((s) => s.appRequest)
  const appsEnabled = usePreferencesStore((s) => s.aiAppsEnabled)
  const [filter, setFilter] = useState<Filter>('pending')
  // To Review as the focused list (one at a time) or a plain list;
  // remembered.
  const [view, setView] = useState<ReviewView>(() => {
    try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'focused' } catch { return 'focused' }
  })
  const chooseView = (v: ReviewView) => {
    setView(v)
    try { localStorage.setItem(VIEW_KEY, v) } catch { /* not kept */ }
  }

  const shown = useMemo(() => {
    const statuses = FILTERS.find((f) => f.id === filter)!.statuses
    return proposals.filter((p) => statuses.includes(p.status))
  }, [proposals, filter])

  const count = (f: Filter) => proposals.filter((p) => FILTERS.find((x) => x.id === f)!.statuses.includes(p.status)).length
  const pendingShown = shown.filter((p) => p.status === 'pending')

  const doApprove = (ids: string[]) => {
    if (!ids.length) return
    const { applied, failed } = approve(ids)
    announce(failed ? t('ai.review.appliedSome', { count: applied, failed }) : t('ai.review.applied', { count: applied }))
  }
  const doReject = (ids: string[]) => {
    if (!ids.length) return
    const all = withDependents(ids, useAiStore.getState().proposals)
    deny(ids)
    announce(t('ai.review.denied', { count: all.length }))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ padding: '14px 20px 6px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)', flex: 1, minWidth: 0 }}>
          <Icon icon={faSparkles} className="analysis-header-icon" style={{ fontSize: 16 }} />
          {t('ai.review.title')}
        </h2>
        {appsEnabled && appsAllowed && (
          <button type="button" className="secondary" onClick={() => useAiStore.getState().allowApps(false)}>{t('ai.pane.stopApps')}</button>
        )}
        <button className="secondary" onClick={onClose}>{t('common.close')}</button>
      </div>


      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '8px 20px 16px', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {!appsEnabled ? (
            <Banner>
              <span style={{ flex: 1 }}>{t('ai.review.appsOff')}</span>
              <button type="button" onClick={openSettings}>{t('ai.pane.openSettings')}</button>
            </Banner>
          ) : !appsAllowed ? (
            <Banner strong>
              <div style={{ flex: 1 }}>
                <strong style={{ color: 'var(--text-primary)' }}>{appRequest ? t('ai.pane.appAsks', { name: appRequest }) : t('ai.pane.appsTitle')}</strong>
                <p style={{ margin: '4px 0 0' }}>{t('ai.pane.responsibility')}</p>
              </div>
              {appRequest && <button type="button" className="secondary" onClick={() => useAiStore.getState().setAppRequest(null)}>{t('ai.pane.notNow')}</button>}
              <button type="button" onClick={() => useAiStore.getState().allowApps(true)}>{t('ai.pane.allowApps')}</button>
            </Banner>
          ) : null}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
            <SegmentedControl
              label={t('ai.review.show')}
              value={filter}
              onChange={setFilter}
              options={FILTERS.map((f) => ({ value: f.id, label: t(`ai.review.filter.${f.id}`, { count: count(f.id) }) }))}
            />
            {filter === 'pending' && (
              <SegmentedControl
                label={t('analysis.view')}
                value={view}
                onChange={chooseView}
                options={[{ value: 'focused', label: t('ai.review.viewFocused') }, { value: 'list', label: t('ai.review.viewList') }]}
              />
            )}
            <span style={{ flex: 1 }} />
            {filter === 'pending' && pendingShown.length > 0 && (
              <>
                <button className="secondary" onClick={() => doReject(pendingShown.map((p) => p.id))}>{t('ai.review.denyAll')}</button>
                <button onClick={() => doApprove(pendingShown.map((p) => p.id))}>{t('ai.review.approveAll')}</button>
              </>
            )}
          </div>

          {shown.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--text-muted)', fontSize: 12.5, lineHeight: 1.6 }}>
              <Icon icon={faSparkles} className={PALETTE_ICON_CLASS} style={{ width: 28, height: 28, opacity: 0.8 }} />
              <p style={{ margin: '10px auto 0', maxWidth: 420 }}>{t(`ai.review.empty.${filter}`)}</p>
            </div>
          ) : (
            filter === 'pending' && view === 'focused'
              ? <Barrel items={shown} onApprove={(id) => doApprove([id])} onReject={(id) => doReject([id])} />
              : filter === 'pending'
              ? <PendingList items={shown} onApprove={(id) => doApprove([id])} onReject={(id) => doReject([id])} />
              : <DecidedList items={shown} />
          )}
        </div>
      </div>
    </div>
  )
}

function openSettings() {
  requestPreferencesCategory('ai-assistance')
  useDocumentStore.getState().openToolTab(PREFERENCES_TAB_ID)
}

/** A notice across the top of the Viewer. */
function Banner({ children, strong }: { children: React.ReactNode; strong?: boolean }) {
  return (
    <div role={strong ? 'alert' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '0 0 12px', padding: '12px 14px', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
      {children}
    </div>
  )
}

/** A passage with the text around it. */
function Context({ sourceGuid, start, end, cell, color }: { sourceGuid: string; start: number; end: number; cell?: { respondentId: string; questionId: string }; color?: string }) {
  const source = useDocumentStore((s) => s.sources.find((x) => x.guid === sourceGuid))
  const content = useDocumentStore((s) => s.sourceContents[sourceGuid])
  const text = useMemo(() => {
    if (!source) return ''
    if (cell) {
      const r = (source.formatData as SurveyFormatData | undefined)?.survey.respondents.find((x) => x.id === cell.respondentId)
      return r ? buildCellText(r.answers[cell.questionId]) : ''
    }
    return content ?? documentText(sourceGuid)
  }, [source, content, cell, sourceGuid])
  const chars = useMemo(() => Array.from(text), [text])
  const before = chars.slice(Math.max(0, start - 120), start).join('')
  const passage = chars.slice(start, end).join('')
  const after = chars.slice(end, end + 120).join('')
  return (
    <blockquote style={{ margin: '8px 0 0', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border-color)', fontSize: 12.5, lineHeight: 1.7, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      <span style={{ color: 'var(--text-secondary)' }}>{start > 120 ? '…' : ''}{before}</span>
      {/* The passage: tinted and underlined in its code's colour, so it
          stands out from the text around it. */}
      <mark style={{
        background: `color-mix(in srgb, ${color ?? 'var(--accent)'} 22%, transparent)`,
        boxShadow: `inset 0 -2px 0 ${color ?? 'var(--accent)'}`,
        color: 'var(--text-primary)', fontWeight: 500, borderRadius: 2, padding: '1px 0'
      }}>{passage}</mark>
      <span style={{ color: 'var(--text-secondary)' }}>{after}{end + 120 < chars.length ? '…' : ''}</span>
    </blockquote>
  )
}

/** Where a code is in the tree: its parents, then it (the last part bold). */
function CodePath({ parts, color }: { parts: string[]; color?: string }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, maxWidth: '100%' }}>
      {color && <span aria-hidden style={{ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0 }} />}
      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
        {parts.slice(0, -1).map((name, i) => (
          <span key={i} style={{ color: 'var(--text-secondary)' }}>{name}<span style={{ margin: '0 4px' }}>/</span></span>
        ))}
        <strong>{parts[parts.length - 1]}</strong>
      </span>
    </span>
  )
}

/** A code on two lines, for the List view: its parents above (if it has
 *  any), and the code itself, with its pip, below. */
function CodeStack({ parts, color }: { parts: string[]; color?: string }) {
  const parents = parts.slice(0, -1)
  const one: React.CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
  return (
    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, lineHeight: 1.35 }}>
      {parents.length > 0 && <span style={{ ...one, color: 'var(--text-secondary)', fontSize: 11.5 }}>{parents.join(' / ')}</span>}
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
        {color && <span aria-hidden style={{ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0, alignSelf: 'center' }} />}
        {/* The code itself, whole (wrapping if it must). */}
        <strong style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{parts[parts.length - 1]}</strong>
      </span>
    </span>
  )
}

/** Its children fade away when `show` turns false (and are then gone),
 *  instead of vanishing at once. */
function FadeOut({ show, children }: { show: boolean; children: React.ReactNode }) {
  const last = useRef<React.ReactNode>(children)
  if (show) last.current = children
  const [kept, setKept] = useState(show)
  useEffect(() => {
    if (show) { setKept(true); return }
    const timer = setTimeout(() => setKept(false), FADE_MS)
    return () => clearTimeout(timer)
  }, [show])
  if (!show && !kept) return null
  return <span className={show ? 'ai-fade' : 'ai-fade out'} style={{ display: 'inline-flex', flexShrink: 0 }}>{show ? children : last.current}</span>
}

/** How long a fade away takes (as in the styles). */
const FADE_MS = 420

/** `items`, with those just taken out kept a moment longer (marked
 *  leaving), where they were, so they can fade away. */
function useLeaving(items: AiProposal[]): { p: AiProposal; leaving: boolean }[] {
  const [gone, setGone] = useState<{ p: AiProposal; index: number }[]>([])
  const before = useRef(items)
  useLayoutEffect(() => {
    const now = new Set(items.map((p) => p.id))
    const removed = before.current.map((p, index) => ({ p, index })).filter((x) => !now.has(x.p.id))
    before.current = items
    if (!removed.length) return
    setGone((g) => [...g, ...removed])
    setTimeout(() => setGone((g) => g.filter((x) => !removed.some((r) => r.p.id === x.p.id))), FADE_MS)
  }, [items])
  const out = items.map((p) => ({ p, leaving: false }))
  for (const g of [...gone].sort((a, b) => a.index - b.index)) {
    if (!out.some((x) => x.p.id === g.p.id)) out.splice(Math.min(g.index, out.length), 0, { p: g.p, leaving: true })
  }
  return out
}

const visuallyHidden: React.CSSProperties = { position: 'absolute', width: 1, height: 1, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 }

/** Up to two lines of a passage or description, then "…". */
const twoLines: React.CSSProperties = { minWidth: 0, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', lineHeight: 1.4 }

/** A code's names from the top of the tree down to it. */
function pathOf(codes: Code[], guid: string): Code[] | null {
  for (const c of codes) {
    if (c.guid === guid) return [c]
    const below = pathOf(c.children, guid)
    if (below) return [c, ...below]
  }
  return null
}

/** A code's path and colour, by guid or by a proposed code's reference. */
function useCodeInfo() {
  const proposals = useAiStore((s) => s.proposals)
  const created = useAiStore((s) => s.createdCodes)
  const codes = useCodeStore((s) => s.codes)
  const { t } = useTranslation()
  const proposed = (ref: string) => {
    const q = proposals.find((x) => x.change.type === 'newCode' && x.change.ref === ref)
    return q?.change.type === 'newCode' ? q.change : undefined
  }
  const path = (guid?: string, ref?: string): string[] => {
    const g = guid ?? (ref ? created[ref] : undefined)
    const found = g ? pathOf(codes, g) : null
    if (found) return found.map((x) => x.name)
    if (guid) return [t('ai.review.missingCode')]
    const c = ref ? proposed(ref) : undefined
    return c ? [...path(c.parentGuid, c.parentRef), c.name] : ref ? [ref] : []
  }
  const colour = (guid?: string, ref?: string): string | undefined => {
    const g = guid ?? (ref ? created[ref] : undefined)
    const found = g ? pathOf(codes, g)?.at(-1)?.color : undefined
    return found ?? (ref ? proposed(ref)?.color : undefined)
  }
  return { path, colour }
}

/** A short form of a passage, for its row. */
function excerpt(text: string, max = 90): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1).trimEnd() + '…' : one
}

/** A label: gold for a new code, blue for a new coding, red for a change
 *  to a code. */
function Chip({ children, tone, plus }: { children: React.ReactNode; tone?: 'new' | 'coding' | 'change'; plus?: boolean }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', whiteSpace: 'nowrap',
      color: 'var(--text-primary)', borderRadius: 4, padding: '1px 6px',
      background: tone === 'new' ? 'color-mix(in srgb, var(--rb-gold) 30%, var(--bg-panel))'
        : tone === 'coding' ? 'color-mix(in srgb, var(--rb-blue) 24%, var(--bg-panel))'
        : tone === 'change' ? 'color-mix(in srgb, var(--rb-coral) 26%, var(--bg-panel))'
        : 'var(--bg-tertiary)'
    }}>
      {/* Only where one thing comes with another (a new code with a coding). */}
      {plus && <Icon icon={faPlus} style={{ width: 11, height: 11 }} />}
      {children}
    </span>
  )
}

/** Approved / Rejected / Not made: the colour in the icon, the word in
 *  plain text (coloured small text doesn't contrast enough everywhere). */
function Status({ p }: { p: AiProposal }) {
  const { t } = useTranslation()
  const colour = p.status === 'approved' ? 'var(--success)' : p.status === 'failed' ? 'var(--danger)' : 'var(--text-muted)'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
      <Icon icon={p.status === 'approved' ? faCheck : faXmark} style={{ color: colour, width: 13, height: 13 }} />
      {t(`ai.review.status.${p.status}`)}
    </span>
  )
}

/** How many proposals show above and below the current one. */
const AROUND = 3

/**
 * The proposals to review, one at a time: the current one in the middle,
 * in full, and those either side faint, so that moving reads as scrolling
 * through cards. ↑ ↓ (or the wheel) move; R or Enter approves, E or Delete
 * rejects, and the next one moves up. A listbox whose one option is the
 * current proposal; the buttons are beneath it (not inside an option).
 */
function Barrel({ items, onApprove, onReject }: { items: AiProposal[]; onApprove: (id: string) => void; onReject: (id: string) => void }) {
  const { t } = useTranslation()
  const [index, setIndex] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const n = items.length
  const at = Math.min(index, n - 1)
  const current = items[at]
  const pending = current?.status === 'pending'
  // Space above the first card and below the last, so either can come to
  // the middle.
  const [pad, setPad] = useState(0)

  const cards = () => [...(ref.current?.querySelectorAll<HTMLElement>('[data-proposal]') ?? [])]
  const smooth = () => !matchMedia('(prefers-reduced-motion: reduce)').matches
  /** Bring card `i` to the middle. */
  const bring = (i: number, animate = true) => {
    const el = cards()[i]
    const box = ref.current
    if (!el || !box) return
    box.scrollTo({ top: el.offsetTop + el.offsetHeight / 2 - box.clientHeight / 2, behavior: animate && smooth() ? 'smooth' : 'auto' })
  }

  // As it scrolls: the card nearest the middle is the current one, and
  // the others fade by how far they are from it.
  const frame = useRef(0)
  // Where a key or click sent it: the current one is that one at once (not
  // each card the scroll passes on the way).
  const target = useRef<number | null>(null)
  const follow = () => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      const box = ref.current
      if (!box) return
      const mid = box.scrollTop + box.clientHeight / 2
      let nearest = 0
      let best = Infinity
      cards().forEach((el, i) => {
        const d = Math.abs(el.offsetTop + el.offsetHeight / 2 - mid)
        if (d < best) { best = d; nearest = i }
        const away = Math.max(0, d - el.offsetHeight / 2) / 120
        el.style.opacity = String(d < 4 ? 1 : Math.max(0.08, 1 - 0.25 - away * 0.5))
      })
      if (target.current !== null) {
        if (nearest !== target.current) return
        target.current = null
      }
      setIndex(nearest)
    })
  }

  useLayoutEffect(() => {
    const box = ref.current
    if (!box) return
    const size = () => { setPad(Math.max(0, box.clientHeight / 2 - 80)); follow() }
    size()
    const ro = new ResizeObserver(size)
    ro.observe(box)
    box.focus()
    return () => { ro.disconnect(); cancelAnimationFrame(frame.current) }
    // Once, on showing: follow reads the list as it is each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // After a decision the list is shorter: the next one takes the place.
  useLayoutEffect(() => {
    bring(Math.min(index, n - 1), false)
    follow()
    // Only when the list's length or padding changes (not as it scrolls).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, pad])

  const go = (i: number) => {
    const to = Math.max(0, Math.min(n - 1, i))
    target.current = to
    setIndex(to)
    bring(to)
  }
  const decide = (yes: boolean) => {
    if (!pending) return
    if (yes) onApprove(current.id)
    else onReject(current.id)
    ref.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const k = e.key
    if (k === 'ArrowUp') go(at - 1)
    else if (k === 'ArrowDown') go(at + 1)
    else if (k === 'Home') go(0)
    else if (k === 'End') go(n - 1)
    else if (k === 'PageUp') go(at - AROUND)
    else if (k === 'PageDown') go(at + AROUND)
    // Approve and reject by two keys beside each other for the left hand
    // (R and E, by position, so the same keys on any layout), the other
    // hand on the arrows; or Enter and Delete.
    else if (k === 'Enter' || e.code === 'KeyR') decide(true)
    else if (k === 'Delete' || k === 'Backspace' || e.code === 'KeyE') decide(false)
    else return
    e.preventDefault()
  }

  const kbd: React.CSSProperties = { fontFamily: 'inherit', fontSize: 10.5, padding: '0 5px', marginInlineStart: 6, borderRadius: 4, border: '1px solid currentColor', opacity: 0.85 }
  const c = current?.change

  return (
    <div
      // A click anywhere here (a card, the space beside it, a button) leaves
      // the keyboard with the list: on macOS a click doesn't move it, so
      // E and R would go elsewhere.
      onMouseDown={() => setTimeout(() => ref.current?.focus({ preventScroll: true }))}
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: 12 }}
    >
      <div
        ref={ref}
        role="listbox"
        tabIndex={0}
        aria-label={t('ai.review.listLabel')}
        aria-activedescendant={current ? `ai-proposal-${current.id}` : undefined}
        onKeyDown={onKeyDown}
        onScroll={follow}
        // Scrolls smoothly, and settles on a card (scroll-snap).
        className="ai-barrel"
        // The width of the Viewer, so it scrolls wherever the pointer is
        // (the cards are centred in it, with room for their shadow).
        style={{ flex: 1, minHeight: 0, width: '100%', position: 'relative', outline: 'none', overflowY: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '0 30px', boxSizing: 'border-box' }}
      >
        <div aria-hidden style={{ flexShrink: 0, height: pad }} />
        {items.map((p, i) => (
          <BarrelItem
            key={p.id}
            p={p}
            current={i === at}
            position={t('ai.review.position', { n: at + 1, count: n })}
            onClick={() => go(i)}
          />
        ))}
        <div aria-hidden style={{ flexShrink: 0, height: pad }} />
      </div>
      {/* The current one's actions (beneath the list, not inside it). */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', maxWidth: 760, marginTop: 10, fontSize: 11.5, color: 'var(--text-secondary)' }}>
        <span>{t('ai.review.keysMove')}</span>
        <span style={{ flex: 1 }} />
        {c?.type === 'addCoding' && (
          <button type="button" className="secondary" onClick={() => useDocumentStore.getState().viewDocumentAt(c.sourceGuid, c.start, c.end)}>{t('ai.review.showInDocument')}</button>
        )}
        {pending && (
          <>
            <button type="button" className="secondary" onClick={() => decide(false)}>{t('ai.review.deny')}<kbd style={kbd}>{t('ai.review.keyReject')}</kbd></button>
            <button type="button" onClick={() => decide(true)}>{t('ai.review.approve')}<kbd style={kbd}>{t('ai.review.keyApprove')}</kbd></button>
          </>
        )}
      </div>
    </div>
  )
}

/** Changes to review, as a plain list: a line each, with ✕ and ✓, that
 *  opens to show the passage and the reason. */
function PendingList({ items, onApprove, onReject }: { items: AiProposal[]; onApprove: (id: string) => void; onReject: (id: string) => void }) {
  const { t } = useTranslation()
  // The highlighted row, moved by ↑ ↓ (as in Focused): R or Enter approves
  // it, E or Delete rejects it, Space opens or closes it.
  const [active, setActive] = useState(0)
  const [openId, setOpenId] = useState<string | null>(null)
  const ref = useRef<HTMLUListElement>(null)
  // Rows just decided (or rejected with their new code) fade away.
  const rows = useLeaving(items)
  const n = items.length
  const at = Math.min(active, n - 1)
  const show = (i: number) => {
    const to = Math.max(0, Math.min(n - 1, i))
    setActive(to)
    const el = ref.current?.querySelectorAll<HTMLElement>('li[data-proposal]')[to]
    el?.scrollIntoView({ block: 'nearest' })
    if (el) announce(el.innerText.replace(/\s+/g, ' ').trim())
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    // Keys typed on a row's own buttons do what the button does.
    if ((e.target as HTMLElement).closest('button') && (e.key === 'Enter' || e.key === ' ')) return
    const p = items[at]
    const k = e.key
    if (k === 'ArrowUp') show(at - 1)
    else if (k === 'ArrowDown') show(at + 1)
    else if (k === 'Home') show(0)
    else if (k === 'End') show(n - 1)
    else if (p && (k === 'Enter' || e.code === 'KeyR')) onApprove(p.id)
    else if (p && (k === 'Delete' || k === 'Backspace' || e.code === 'KeyE')) onReject(p.id)
    else if (p && k === ' ') setOpenId((id) => (id === p.id ? null : p.id))
    else return
    e.preventDefault()
  }
  useEffect(() => { ref.current?.focus() }, [])
  // The colour behind the list (the theme's), for its pinned key row, so
  // rows don't show through it as they scroll under.
  const [behind, setBehind] = useState('transparent')
  const theme = usePreferencesStore((st) => st.theme)
  useLayoutEffect(() => {
    for (let el = ref.current?.parentElement; el; el = el.parentElement) {
      const bg = getComputedStyle(el).backgroundColor
      if (bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg)) { setBehind(bg); return }
    }
  }, [theme])

  return (
    <>
      {/* Above the list, so it's seen however long the list is. */}
      <p style={{ margin: '12px 0 0', fontSize: 11.5, color: 'var(--text-secondary)' }}>
        {t('ai.review.keysList', { approve: t('ai.review.keyApprove'), reject: t('ai.review.keyReject') })}
      </p>
      <ul
        ref={ref}
        tabIndex={0}
        aria-label={t('ai.review.listLabel')}
        onKeyDown={onKeyDown}
        // A click on a row or its buttons leaves the keyboard with the list
        // (on macOS a click doesn't move it), and selects that row.
        onMouseDown={(e) => {
          const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-proposal]')
          const i = li ? [...(ref.current?.querySelectorAll('li[data-proposal]') ?? [])].indexOf(li) : -1
          if (i >= 0) setActive(i)
          setTimeout(() => ref.current?.focus({ preventScroll: true }))
        }}
        className="ai-list"
        style={listGrid}
      >
        {/* The keys, over the buttons they press (as on Focused's). */}
        <li aria-hidden style={{ ...row, position: 'sticky', top: -4, zIndex: 1, padding: '0 13px 0 17px', background: behind }}>
          <span style={{ gridColumn: 5, display: 'flex', gap: 6 }}>
            {[t('ai.review.keyReject'), t('ai.review.keyApprove')].map((k) => (
              <span key={k} style={{ width: 26, display: 'grid', placeItems: 'center' }}>
                <kbd style={{ fontFamily: 'inherit', fontSize: 10.5, padding: '0 5px', borderRadius: 4, border: '1px solid currentColor', color: 'var(--text-secondary)' }}>{k}</kbd>
              </span>
            ))}
          </span>
        </li>
        {rows.map(({ p, leaving }) => {
          const i = items.indexOf(p)
          return (
            <PendingLine
              key={p.id}
              p={p}
              leaving={leaving}
              active={!leaving && i === at}
              open={openId === p.id}
              onToggle={() => { setActive(i); setOpenId((id) => (id === p.id ? null : p.id)) }}
              onApprove={() => onApprove(p.id)}
              onReject={() => onReject(p.id)}
            />
          )
        })}
      </ul>
    </>
  )
}

/** The lists as one grid, so their columns line up from row to row:
 *  label, code, passage or change, document, and the buttons or status.
 *  Each row is a subgrid of it. */
const listGrid: React.CSSProperties = {
  // Room on every side for the highlighted row's outline (the list clips
  // what's outside it).
  listStyle: 'none', margin: '10px -4px 0', padding: 4, overflowY: 'auto', minHeight: 0,
  // The document's column is capped (titles can be very long: they'd
  // squeeze the code and passage to nothing), and those two never
  // collapse.
  display: 'grid', gridTemplateColumns: 'max-content minmax(180px, 1.4fr) minmax(170px, 1.15fr) fit-content(130px) max-content',
  columnGap: 16, rowGap: 8, alignContent: 'start'
}
const row: React.CSSProperties = { gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: 'subgrid', alignItems: 'center' }
const cell: React.CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

const iconButton: React.CSSProperties = {
  display: 'grid', placeItems: 'center', width: 26, height: 24, padding: 0,
  borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--bg-panel)', cursor: 'pointer'
}

/** A label's colour, by the kind of proposal. */
function toneOf(p: AiProposal, isNew: boolean): 'new' | 'coding' | 'change' | undefined {
  if (isNew) return 'new'
  if (p.change.type === 'addCoding') return 'coding'
  if (p.change.type === 'editCode') return 'change'
  return undefined
}

/** A proposal's label, by kind: gold for a new code, blue for a new
 *  coding, red for a change to a code, grey for a removal. */
function KindLabel({ p, s }: { p: AiProposal; s: { kind: string; isNew: boolean } }) {
  return <Chip tone={toneOf(p, s.isNew)}>{s.kind}</Chip>
}

function PendingLine({ p, leaving, active, open, onToggle, onApprove, onReject }: { p: AiProposal; leaving: boolean; active: boolean; open: boolean; onToggle: () => void; onApprove: () => void; onReject: () => void }) {
  const { t } = useTranslation()
  const proposals = useAiStore((s) => s.proposals)
  const sources = useDocumentStore((s) => s.sources)
  const s = useSummary(p)
  const c = p.change
  const needs = withRequirements([p.id], proposals).filter((id) => id !== p.id)
  const sel = c.type === 'removeCoding' ? sources.find((x) => x.guid === c.sourceGuid)?.selections.find((x) => x.guid === c.selectionGuid) : undefined
  // Leaving: it folds from its own height, so those below slide up at once.
  const li = useRef<HTMLLIElement>(null)
  useLayoutEffect(() => {
    if (leaving && li.current) li.current.style.setProperty('--ai-h', `${li.current.offsetHeight}px`)
  }, [leaving])
  return (
    <li
      ref={li}
      data-proposal={leaving ? undefined : p.id}
      data-active={active ? '' : undefined}
      className={leaving ? 'ai-leaving' : undefined}
      aria-hidden={leaving || undefined}
      style={{ ...row, minHeight: 64, boxSizing: 'border-box', borderRadius: 8, padding: '12px 12px 12px 16px', border: `1px solid ${s.isNew ? 'color-mix(in srgb, var(--rb-gold) 60%, var(--border-color))' : 'var(--border-color)'}`, background: 'var(--bg-panel)', fontSize: 12.5 }}>
      <button
        type="button"
        aria-expanded={open}
        tabIndex={-1}
        onClick={onToggle}
        style={{ gridColumn: '1 / 5', display: 'grid', gridTemplateColumns: 'subgrid', alignItems: 'center', minWidth: 0, padding: 0, border: 'none', background: 'none', textAlign: 'start', cursor: 'pointer', color: 'var(--text-primary)', fontSize: 12.5 }}
      >
        {/* Its label; under it, for a coding whose code is only proposed,
            the gold New code (approving it adds the code too). */}
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
          <KindLabel p={p} s={s} />
          <FadeOut show={needs.length > 0}>
            <span title={t('ai.review.alsoApproves', { count: needs.length || 1 })} style={{ display: 'inline-flex' }}>
              <Chip tone="new" plus>{t('ai.review.kind.newCode')}</Chip>
              <span style={visuallyHidden}>{t('ai.review.alsoApproves', { count: needs.length || 1 })}</span>
            </span>
          </FadeOut>
        </span>
        <CodeStack parts={s.parts} color={s.color} />
        <span style={twoLines}>{excerpt(s.text, 320)}</span>
        <span title={s.doc || undefined} style={{ ...cell, color: 'var(--text-secondary)', fontSize: 12 }}>{s.doc}</span>
      </button>
      <span style={{ gridColumn: 5, display: 'flex', gap: 6 }}>
        <button type="button" aria-label={t('ai.review.deny')} title={t('ai.review.deny')} onClick={onReject} style={iconButton}>
          <Icon icon={faXmark} style={{ width: 13, height: 13, color: 'var(--text-secondary)' }} />
        </button>
        <button type="button" aria-label={t('ai.review.approve')} title={t('ai.review.approve')} onClick={onApprove} style={{ ...iconButton, background: 'var(--accent)', borderColor: 'var(--accent)' }}>
          <Icon icon={faCheck} style={{ width: 13, height: 13, color: '#fff' }} />
        </button>
      </span>
      <div className={open ? 'ai-barrel-details' : 'ai-barrel-details closed'} style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateRows: open ? '1fr' : '0fr' }}>
        <div style={{ overflow: 'hidden', minHeight: 0, paddingBottom: open ? 4 : 0 }}>
          {c.type === 'addCoding' && <Context sourceGuid={c.sourceGuid} start={c.start} end={c.end} cell={c.surveyCell} color={s.color} />}
          {c.type === 'removeCoding' && sel && <Context sourceGuid={c.sourceGuid} start={sel.startPosition} end={sel.endPosition} cell={sel.surveyCell} color={s.color} />}
          {(c.type === 'newCode' || c.type === 'editCode') && s.text && <p style={{ margin: '8px 0 0', fontSize: 12.5, lineHeight: 1.55 }}>{s.text}</p>}
          {p.reason && <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t('ai.review.reason', { reason: p.reason })}</p>}
          {c.type === 'addCoding' && (
            <button type="button" onClick={() => useDocumentStore.getState().viewDocumentAt(c.sourceGuid, c.start, c.end)} style={{ marginTop: 6, padding: 0, border: 'none', background: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 11.5 }}>{t('ai.review.showInDocument')}</button>
          )}
        </div>
      </div>
    </li>
  )
}

/** Approved or rejected changes: a line each, newest first. */
function DecidedList({ items }: { items: AiProposal[] }) {
  const { t } = useTranslation()
  return (
    <ul aria-label={t('ai.review.listLabel')} style={listGrid}>
      {[...items].reverse().map((p) => <DecidedLine key={p.id} p={p} />)}
    </ul>
  )
}

function DecidedLine({ p }: { p: AiProposal }) {
  const s = useSummary(p)
  return (
    <li data-proposal={p.id} style={{ ...row, minHeight: 64, boxSizing: 'border-box', padding: '12px 16px', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-panel)', fontSize: 12.5 }}>
      <span><KindLabel p={p} s={s} /></span>
      <CodeStack parts={s.parts} color={s.color} />
      <span style={twoLines}>{excerpt(s.text, 320)}</span>
      <span title={s.doc || undefined} style={{ ...cell, color: 'var(--text-secondary)', fontSize: 12 }}>{s.doc}</span>
      <span><Status p={p} /></span>
    </li>
  )
}

/** What a proposal is about, in a line: the code and the passage or change. */
function useSummary(p: AiProposal) {
  const { t } = useTranslation()
  const { path, colour } = useCodeInfo()
  const sources = useDocumentStore((s) => s.sources)
  const c = p.change
  const docName = (guid: string) => (sources.find((s) => s.guid === guid)?.name ?? t('ai.review.missingDocument')).replace(/\.[a-z0-9]{2,4}$/i, '')
  if (c.type === 'newCode') {
    return { kind: t('ai.review.kind.newCode'), isNew: p.status !== 'approved', parts: [...path(c.parentGuid, c.parentRef), c.name], color: c.color, text: c.description ?? '', doc: '' }
  }
  if (c.type === 'editCode') {
    const what = [
      c.name ? t('ai.review.rename', { name: c.name }) : '',
      c.description !== undefined ? `${t('ai.review.describe')}: ${c.description || t('ai.review.noDescription')}` : '',
      c.move ? (c.move.parentGuid || c.move.parentRef ? t('ai.review.moveUnder', { name: path(c.move.parentGuid, c.move.parentRef).join(' / ') }) : t('ai.review.moveTop')) : ''
    ].filter(Boolean).join(' · ')
    return { kind: t('ai.review.kind.editCode'), isNew: false, parts: path(c.codeGuid), color: colour(c.codeGuid), text: what, doc: '' }
  }
  const codeRef = c.type === 'addCoding' ? c.codeRef : undefined
  return {
    kind: c.type === 'addCoding' ? t('ai.review.kind.coding') : t('ai.review.kind.removal'),
    isNew: false,
    parts: path(c.codeGuid, codeRef),
    color: colour(c.codeGuid, codeRef),
    text: c.text,
    doc: docName(c.sourceGuid)
  }
}

/**
 * One proposal in the list, in full. The one in the middle is at full
 * strength, raised; the others fade the further away they are, so that
 * moving through the list reads as scrolling through cards.
 */
function BarrelItem({ p, current, position, onClick }: { p: AiProposal; current: boolean; position: string; onClick: () => void }) {
  const { t } = useTranslation()
  const proposals = useAiStore((s) => s.proposals)
  const sources = useDocumentStore((s) => s.sources)
  const s = useSummary(p)
  const c = p.change
  const needs = p.status === 'pending' ? withRequirements([p.id], proposals).filter((id) => id !== p.id) : []
  const sel = c.type === 'removeCoding' ? sources.find((x) => x.guid === c.sourceGuid)?.selections.find((x) => x.guid === c.selectionGuid) : undefined

  return (
    <div
      id={current ? `ai-proposal-${p.id}` : undefined}
      // Only the current one is an option: the faint ones either side are
      // a preview, for the eye (a screen reader reads the current one, and
      // where it is, as ↑ ↓ move).
      role={current ? 'option' : undefined}
      aria-selected={current ? true : undefined}
      aria-hidden={current ? undefined : true}
      data-current={current ? '' : undefined}
      data-proposal={p.id}
      onClick={current ? undefined : onClick}
      className="ai-barrel-item"
      style={{
        flexShrink: 0, width: '100%', maxWidth: 760, boxSizing: 'border-box', borderRadius: 12, background: 'var(--bg-panel)', cursor: current ? 'default' : 'pointer',
        padding: '14px 18px',
        border: `1px solid ${s.isNew ? 'color-mix(in srgb, var(--rb-gold) 60%, var(--border-color))' : 'var(--border-color)'}`,
        boxShadow: current ? '0 6px 24px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.08)' : 'none'
        // (Its fade, by its distance from the middle, is set as the list
        // scrolls: see Barrel.)
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, fontSize: 14, flexWrap: 'wrap' }}>
        {/* Its label; under it, for a coding whose code is only proposed,
            the gold + New code (approving it adds the code too). */}
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
          <Chip tone={toneOf(p, s.isNew)}>{s.kind}</Chip>
          {needs.length > 0 && (
            <span title={t('ai.review.alsoApproves', { count: needs.length })} style={{ display: 'inline-flex' }}>
              <Chip tone="new" plus>{t('ai.review.kind.newCode')}</Chip>
              <span style={visuallyHidden}>{t('ai.review.alsoApproves', { count: needs.length })}</span>
            </span>
          )}
        </span>
        <CodePath parts={s.parts} color={s.color} />
        {s.doc && <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>· {s.doc}</span>}
        <span style={{ marginInlineStart: 'auto', flexShrink: 0, fontSize: 11.5, color: 'var(--text-secondary)' }}>
          {current ? position : p.status !== 'pending' ? <Status p={p} /> : null}
        </span>
      </div>
      {c.type === 'addCoding' && <Context sourceGuid={c.sourceGuid} start={c.start} end={c.end} cell={c.surveyCell} color={s.color} />}
      {c.type === 'removeCoding' && sel && <Context sourceGuid={c.sourceGuid} start={sel.startPosition} end={sel.endPosition} cell={sel.surveyCell} color={s.color} />}
      {(c.type === 'newCode' || c.type === 'editCode') && s.text && <p style={{ margin: '10px 0 0', fontSize: 13, lineHeight: 1.55, color: 'var(--text-primary)' }}>{s.text}</p>}
      {p.reason && <p style={{ margin: '10px 0 0', fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t('ai.review.reason', { reason: p.reason })}</p>}
      {p.status === 'failed' && (
        <p style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '6px 0 0', fontSize: 12, color: 'var(--text-secondary)' }}>
          <Icon icon={faXmark} style={{ color: 'var(--danger)', width: 13, height: 13, flexShrink: 0 }} />
          {t('ai.review.failed', { why: p.failure ?? '' })}
        </p>
      )}
    </div>
  )
}
