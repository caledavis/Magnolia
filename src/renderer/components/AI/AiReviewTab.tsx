/**
 * The AI Assistance Viewer: every change an AI app on this computer
 * (Claude Desktop…) has proposed, for the user to approve or reject, listed
 * as they arrive. Nothing the AI suggests reaches the project any other
 * way (see utils/ai/apply.ts). It's also where a project is let be used
 * by AI apps (it opens to ask when one first does), and stopped.
 *
 * Each proposal shows what it would do, in context (a coding's passage
 * with the text around it, a link to it in its document), and the AI's
 * reason. Proposals can be decided one by one, or chosen and decided
 * together; approved ones are made at once, so one Undo takes them back.
 */
import { useMemo, useState } from 'react'
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
import { Icon, faSparkles, faCheck, faXmark, faChevronDown, faChevronRight } from '../Icon'
import { SegmentedControl } from '../Analysis/SegmentedControl'
import { announce } from '../../utils/keyboard-access'
import { PALETTE_ICON_CLASS } from '../../utils/icon-tint'

type Filter = 'pending' | 'approved' | 'denied'

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
  const [chosen, setChosen] = useState<Set<string>>(new Set())

  const shown = useMemo(() => {
    const statuses = FILTERS.find((f) => f.id === filter)!.statuses
    return proposals.filter((p) => statuses.includes(p.status))
  }, [proposals, filter])
  // By code (a proposed code with the codings that need it), in the
  // order first proposed.
  const createdCodes = useAiStore((s) => s.createdCodes)
  const groups = useMemo(() => {
    const byKey = new Map<string, AiProposal[]>()
    for (const p of shown) {
      const k = groupKey(p, createdCodes)
      byKey.set(k, [...(byKey.get(k) ?? []), p])
    }
    return [...byKey.entries()]
  }, [shown, createdCodes])
  const count = (f: Filter) => proposals.filter((p) => FILTERS.find((x) => x.id === f)!.statuses.includes(p.status)).length
  const pendingShown = shown.filter((p) => p.status === 'pending')
  const chosenPending = pendingShown.filter((p) => chosen.has(p.id)).map((p) => p.id)

  const doApprove = (ids: string[]) => {
    if (!ids.length) return
    const { applied, failed } = approve(ids)
    setChosen(new Set())
    announce(failed ? t('ai.review.appliedSome', { count: applied, failed }) : t('ai.review.applied', { count: applied }))
  }
  const doReject = (ids: string[]) => {
    if (!ids.length) return
    const all = withDependents(ids, useAiStore.getState().proposals)
    deny(ids)
    setChosen(new Set())
    announce(t('ai.review.denied', { count: all.length }))
  }
  const toggle = (id: string) => setChosen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

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


      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ padding: '8px 20px 32px' }}>
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
              onChange={(f) => { setFilter(f); setChosen(new Set()) }}
              options={FILTERS.map((f) => ({ value: f.id, label: t(`ai.review.filter.${f.id}`, { count: count(f.id) }) }))}
            />
            <span style={{ flex: 1 }} />
            {filter === 'pending' && pendingShown.length > 0 && (
              <>
                <button className="secondary" onClick={() => doReject(chosenPending.length ? chosenPending : pendingShown.map((p) => p.id))}>
                  {chosenPending.length ? t('ai.review.denyChosen', { count: chosenPending.length }) : t('ai.review.denyAll')}
                </button>
                <button onClick={() => doApprove(chosenPending.length ? chosenPending : pendingShown.map((p) => p.id))}>
                  {chosenPending.length ? t('ai.review.approveChosen', { count: chosenPending.length }) : t('ai.review.approveAll')}
                </button>
              </>
            )}
          </div>

          {groups.length === 0 && (
            <div style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--text-muted)', fontSize: 12.5, lineHeight: 1.6 }}>
              <Icon icon={faSparkles} className={PALETTE_ICON_CLASS} style={{ width: 28, height: 28, opacity: 0.8 }} />
              <p style={{ margin: '10px auto 0', maxWidth: 420 }}>{t(`ai.review.empty.${filter}`)}</p>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
            {groups.map(([key, items]) => (
              <CodeBlock
                key={key}
                groupKey={key}
                items={items}
                chosen={chosen}
                onToggle={toggle}
                onApprove={doApprove}
                onReject={doReject}
              />
            ))}
          </div>
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
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap' }}>
      {color && <span aria-hidden style={{ width: 9, height: 9, borderRadius: '50%', background: color, flexShrink: 0 }} />}
      <span>
        {parts.slice(0, -1).map((name, i) => (
          <span key={i} style={{ color: 'var(--text-muted)' }}>{name}<span style={{ margin: '0 4px' }}>/</span></span>
        ))}
        <strong>{parts[parts.length - 1]}</strong>
      </span>
    </span>
  )
}

/** A code's names from the top of the tree down to it. */
function pathOf(codes: Code[], guid: string): Code[] | null {
  for (const c of codes) {
    if (c.guid === guid) return [c]
    const below = pathOf(c.children, guid)
    if (below) return [c, ...below]
  }
  return null
}

/** Which code a proposal is about: its block in the Viewer. */
function groupKey(p: AiProposal, created: Record<string, string>): string {
  const c = p.change
  const byRef = (ref: string) => (created[ref] ? `code:${created[ref]}` : `ref:${ref}`)
  if (c.type === 'newCode') return byRef(c.ref)
  if (c.type === 'addCoding') return c.codeGuid ? `code:${c.codeGuid}` : byRef(c.codeRef!)
  return `code:${c.codeGuid}`
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

/** How many of a block's rows show before "N more". */
const ROWS_SHOWN = 5

const iconButton: React.CSSProperties = {
  display: 'grid', placeItems: 'center', width: 26, height: 24, padding: 0,
  borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--bg-panel)', cursor: 'pointer'
}

/** One code: the proposed code (or the existing one) and the changes
 *  proposed for it, a row each. */
function CodeBlock({ groupKey: key, items, chosen, onToggle, onApprove, onReject }: {
  groupKey: string; items: AiProposal[]; chosen: Set<string>
  onToggle: (id: string) => void; onApprove: (ids: string[]) => void; onReject: (ids: string[]) => void
}) {
  const { t } = useTranslation()
  const { path, colour } = useCodeInfo()
  const [showAll, setShowAll] = useState(false)
  const head = items.find((p) => p.change.type === 'newCode')
  const rows = items.filter((p) => p !== head)
  const guid = key.startsWith('code:') ? key.slice(5) : undefined
  const ref = key.startsWith('ref:') ? key.slice(4) : head?.change.type === 'newCode' ? head.change.ref : undefined
  const parts = head?.change.type === 'newCode' ? [...path(head.change.parentGuid, head.change.parentRef), head.change.name] : path(guid, ref)
  const color = head?.change.type === 'newCode' ? head.change.color ?? colour(guid, ref) : colour(guid, ref)
  const pending = items.filter((p) => p.status === 'pending')
  const visible = showAll ? rows : rows.slice(0, ROWS_SHOWN)

  return (
    <section
      aria-label={parts.join(' / ')}
      style={{ borderRadius: 8, border: '1px solid var(--border-color)', borderInlineStart: `3px solid ${color ?? 'var(--border-color)'}`, background: 'var(--bg-panel)', overflow: 'hidden' }}
    >
      <div data-proposal={head?.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', flexWrap: 'wrap' }}>
        {head?.status === 'pending' && <input type="checkbox" checked={chosen.has(head.id)} onChange={() => onToggle(head.id)} aria-label={t('ai.review.choose')} />}
        <span style={{ fontSize: 13 }}><CodePath parts={parts} color={color} /></span>
        {head && <Chip>{t('ai.review.kind.newCode')}</Chip>}
        {head && head.status !== 'pending' && <Status p={head} />}
        <span style={{ flex: 1 }} />
        {pending.length > 1 && (
          <button type="button" className="secondary" onClick={() => onReject(pending.map((p) => p.id))}>{t('ai.review.denyAll')}</button>
        )}
        {head?.status === 'pending' && pending.length === 1 && (
          <button type="button" className="secondary" onClick={() => onReject([head.id])}>{t('ai.review.deny')}</button>
        )}
        {pending.length > 0 && (head || pending.length > 1) && (
          <button type="button" onClick={() => onApprove(pending.map((p) => p.id))}>
            {pending.length > 1 ? t('ai.review.approveChosen', { count: pending.length }) : t('ai.review.approve')}
          </button>
        )}
      </div>
      {head?.change.type === 'newCode' && (head.change.description || head.reason) && (
        <div style={{ padding: '0 12px 8px', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {head.change.description && <p style={{ margin: 0 }}>{head.change.description}</p>}
          {head.reason && <p style={{ margin: head.change.description ? '2px 0 0' : 0, color: 'var(--text-muted)' }}>{t('ai.review.reason', { reason: head.reason })}</p>}
        </div>
      )}
      {rows.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, borderTop: '1px solid var(--border-color)' }}>
          {visible.map((p) => (
            <Row key={p.id} p={p} color={color} chosen={chosen.has(p.id)} onToggle={() => onToggle(p.id)} onApprove={() => onApprove([p.id])} onReject={() => onReject([p.id])} />
          ))}
        </ul>
      )}
      {rows.length > ROWS_SHOWN && (
        <button type="button" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll} style={{ display: 'block', width: '100%', textAlign: 'start', padding: '6px 12px', border: 'none', borderTop: '1px solid var(--border-color)', background: 'none', color: 'var(--accent)', fontSize: 12, cursor: 'pointer' }}>
          {showAll ? t('ai.review.fewer') : t('ai.review.more', { count: rows.length - ROWS_SHOWN })}
        </button>
      )}
    </section>
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-secondary)', background: 'var(--bg-tertiary)', borderRadius: 4, padding: '1px 6px' }}>{children}</span>
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

/** One change to a code: a line that opens to show it in context. */
function Row({ p, color, chosen, onToggle, onApprove, onReject }: { p: AiProposal; color?: string; chosen: boolean; onToggle: () => void; onApprove: () => void; onReject: () => void }) {
  const { t } = useTranslation()
  const { path } = useCodeInfo()
  const proposals = useAiStore((s) => s.proposals)
  const sources = useDocumentStore((s) => s.sources)
  const [open, setOpen] = useState(false)
  const c = p.change
  const pending = p.status === 'pending'
  const docName = (guid: string) => (sources.find((s) => s.guid === guid)?.name ?? t('ai.review.missingDocument')).replace(/\.[a-z0-9]{2,4}$/i, '')
  const needs = pending ? withRequirements([p.id], proposals).filter((id) => id !== p.id) : []

  let line: React.ReactNode
  let detail: React.ReactNode = null
  if (c.type === 'addCoding' || c.type === 'removeCoding') {
    const sel = c.type === 'removeCoding' ? sources.find((s) => s.guid === c.sourceGuid)?.selections.find((s) => s.guid === c.selectionGuid) : undefined
    line = (
      <>
        {c.type === 'removeCoding' && <Chip>{t('ai.review.kind.removal')}</Chip>}
        <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{docName(c.sourceGuid)}</span>
        <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>“{excerpt(c.text)}”</span>
      </>
    )
    detail = c.type === 'addCoding'
      ? <Context sourceGuid={c.sourceGuid} start={c.start} end={c.end} cell={c.surveyCell} color={color} />
      : sel ? <Context sourceGuid={c.sourceGuid} start={sel.startPosition} end={sel.endPosition} cell={sel.surveyCell} color={color} /> : null
  } else if (c.type === 'editCode') {
    const what = [
      c.name ? t('ai.review.rename', { name: c.name }) : '',
      c.description !== undefined ? `${t('ai.review.describe')}: ${c.description || t('ai.review.noDescription')}` : '',
      c.move ? (c.move.parentGuid || c.move.parentRef ? t('ai.review.moveUnder', { name: path(c.move.parentGuid, c.move.parentRef).join(' / ') }) : t('ai.review.moveTop')) : ''
    ].filter(Boolean).join(' · ')
    line = <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{what}</span>
  }
  const at = c.type === 'addCoding' ? c : null

  return (
    <li data-proposal={p.id} style={{ borderTop: '1px solid var(--border-color)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', fontSize: 12.5 }}>
        {pending && <input type="checkbox" checked={chosen} onChange={onToggle} aria-label={t('ai.review.choose')} />}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, padding: 0, border: 'none', background: 'none', textAlign: 'start', cursor: 'pointer', color: 'var(--text-primary)', fontSize: 12.5 }}
        >
          <Icon icon={open ? faChevronDown : faChevronRight} style={{ width: 12, height: 12, flexShrink: 0, color: 'var(--text-muted)' }} />
          {line}
        </button>
        {pending ? (
          <>
            <button type="button" aria-label={t('ai.review.deny')} title={t('ai.review.deny')} onClick={onReject} style={iconButton}>
              <Icon icon={faXmark} style={{ width: 13, height: 13, color: 'var(--text-secondary)' }} />
            </button>
            <button type="button" aria-label={t('ai.review.approve')} title={t('ai.review.approve')} onClick={onApprove} style={{ ...iconButton, background: 'var(--accent)', borderColor: 'var(--accent)' }}>
              <Icon icon={faCheck} style={{ width: 13, height: 13, color: '#fff' }} />
            </button>
          </>
        ) : (
          <Status p={p} />
        )}
      </div>
      {open && (
        <div style={{ padding: '0 12px 10px 42px' }}>
          {detail}
          {p.reason && <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t('ai.review.reason', { reason: p.reason })}</p>}
          {needs.length > 0 && <p style={{ margin: '4px 0 0', fontSize: 11.5, color: 'var(--text-muted)' }}>{t('ai.review.alsoApproves', { count: needs.length })}</p>}
          {p.status === 'failed' && (
            <p style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '4px 0 0', fontSize: 12, color: 'var(--text-secondary)' }}>
              <Icon icon={faXmark} style={{ color: 'var(--danger)', width: 13, height: 13, flexShrink: 0 }} />
              {t('ai.review.failed', { why: p.failure ?? '' })}
            </p>
          )}
          <div style={{ display: 'flex', gap: 10, marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
            <span>{p.model}</span>
            {at && <button type="button" onClick={() => useDocumentStore.getState().viewDocumentAt(at.sourceGuid, at.start, at.end)} style={{ padding: 0, border: 'none', background: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 11 }}>{t('ai.review.showInDocument')}</button>}
          </div>
        </div>
      )}
    </li>
  )
}
