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
import { formatDateTime } from '../../i18n'
import { usePreferencesStore } from '../../stores/preferences-store'
import { PREFERENCES_TAB_ID } from '../../utils/tab-ids'
import { requestPreferencesCategory } from '../Preferences/PreferencesWindow'
import type { Code, SurveyFormatData } from '../../models/types'
import type { AiChange } from '../../utils/ai/tools'
import { Icon, faSparkles } from '../Icon'
import { SegmentedControl } from '../Analysis/SegmentedControl'
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
  const sessions = useAiStore((s) => s.sessions)
  const appsAllowed = useAiStore((s) => s.appsAllowed)
  const appRequest = useAiStore((s) => s.appRequest)
  const appsEnabled = usePreferencesStore((s) => s.aiAppsEnabled)
  const [filter, setFilter] = useState<Filter>('pending')
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState('')

  const shown = useMemo(() => {
    const statuses = FILTERS.find((f) => f.id === filter)!.statuses
    return proposals.filter((p) => statuses.includes(p.status))
  }, [proposals, filter])
  // By chat, newest first; within a chat, in the order proposed.
  const groups = useMemo(() => {
    const byChat = new Map<string, AiProposal[]>()
    for (const p of shown) byChat.set(p.chatId, [...(byChat.get(p.chatId) ?? []), p])
    return [...byChat.entries()].sort((a, b) => b[1][0].createdAt.localeCompare(a[1][0].createdAt))
  }, [shown])
  const count = (f: Filter) => proposals.filter((p) => FILTERS.find((x) => x.id === f)!.statuses.includes(p.status)).length
  const pendingShown = shown.filter((p) => p.status === 'pending')
  const chosenPending = pendingShown.filter((p) => chosen.has(p.id)).map((p) => p.id)

  const doApprove = (ids: string[]) => {
    if (!ids.length) return
    const { applied, failed } = approve(ids)
    setChosen(new Set())
    setMessage(failed ? t('ai.review.appliedSome', { count: applied, failed }) : t('ai.review.applied', { count: applied }))
  }
  const doReject = (ids: string[]) => {
    if (!ids.length) return
    const all = withDependents(ids, useAiStore.getState().proposals)
    deny(ids)
    setChosen(new Set())
    setMessage(t('ai.review.denied', { count: all.length }))
  }
  const toggle = (id: string) => setChosen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const sessionLabel = (id: string) => {
    const s = sessions.find((x) => x.id === id)
    return s ? t('ai.review.session', { app: s.app, time: formatDateTime(s.createdAt) }) : t('ai.review.deletedChat')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-primary)' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 24px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-panel)' }}>
        <span aria-hidden style={{ display: 'grid', placeItems: 'center', width: 34, height: 34, borderRadius: 8, background: 'color-mix(in srgb, var(--rb-gold) 16%, transparent)', flexShrink: 0 }}>
          <Icon icon={faSparkles} className={PALETTE_ICON_CLASS} style={{ width: 18, height: 18 }} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{t('ai.review.title')}</h2>
          <p style={{ margin: '2px 0 0', fontSize: 11.5, color: 'var(--text-muted)' }}>{t('ai.review.subtitle')}</p>
        </div>
        {appsEnabled && appsAllowed && (
          <button type="button" className="secondary" onClick={() => useAiStore.getState().allowApps(false)}>{t('ai.pane.stopApps')}</button>
        )}
        <button className="secondary" onClick={onClose}>{t('common.close')}</button>
      </header>

      {!appsEnabled ? (
        <Banner>
          <span style={{ flex: 1 }}>{t('ai.review.appsOff')}</span>
          <button type="button" onClick={openSettings}>{t('ai.pane.openSettings')}</button>
        </Banner>
      ) : !appsAllowed ? (
        <Banner strong>
          <div style={{ flex: 1 }}>
            <strong style={{ color: 'var(--text-primary)' }}>{appRequest ? t('ai.pane.appAsks', { name: appRequest }) : t('ai.pane.appsTitle')}</strong>
            <p style={{ margin: '4px 0 0' }}>{t('ai.pane.appsConsent')}</p>
            <p style={{ margin: '4px 0 0' }}>{t('ai.pane.consentReview')}</p>
          </div>
          {appRequest && <button type="button" className="secondary" onClick={() => useAiStore.getState().setAppRequest(null)}>{t('ai.pane.notNow')}</button>}
          <button type="button" onClick={() => useAiStore.getState().allowApps(true)}>{t('ai.pane.allowApps')}</button>
        </Banner>
      ) : null}

      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ maxWidth: 860, margin: '0 auto', padding: '16px 24px 32px' }}>
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
          <div role="status" aria-live="polite" style={{ minHeight: 18, padding: '4px 2px', fontSize: 12, color: 'var(--text-secondary)' }}>{message}</div>

          {groups.length === 0 && (
            <div style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--text-muted)', fontSize: 12.5, lineHeight: 1.6 }}>
              <Icon icon={faSparkles} className={PALETTE_ICON_CLASS} style={{ width: 28, height: 28, opacity: 0.8 }} />
              <p style={{ margin: '10px auto 0', maxWidth: 420 }}>{t(`ai.review.empty.${filter}`)}</p>
            </div>
          )}
          {groups.map(([chatId, items]) => (
            <section key={chatId} style={{ marginTop: 14 }}>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-muted)', margin: '0 0 8px' }}>
                <span>{sessionLabel(chatId)}</span>
                <span style={{ flex: 1, height: 1, background: 'var(--border-color)' }} />
                <span style={{ fontWeight: 400 }}>{items.length}</span>
              </h3>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {items.map((p) => (
                  <ProposalCard
                    key={p.id}
                    p={p}
                    chosen={chosen.has(p.id)}
                    onToggle={() => toggle(p.id)}
                    onApprove={() => doApprove([p.id])}
                    onReject={() => doReject([p.id])}
                  />
                ))}
              </ul>
            </section>
          ))}
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
    <div role={strong ? 'alert' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 24px', borderBottom: '1px solid var(--border-color)', background: strong ? 'color-mix(in srgb, var(--rb-gold) 10%, var(--bg-panel))' : 'var(--bg-secondary)', fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
      {children}
    </div>
  )
}

/** A passage with the text around it. */
function Context({ sourceGuid, start, end, cell }: { sourceGuid: string; start: number; end: number; cell?: { respondentId: string; questionId: string } }) {
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
    <blockquote style={{ margin: '8px 0 0', padding: '8px 12px', borderRadius: 6, background: 'var(--bg-secondary)', fontSize: 12.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      <span style={{ color: 'var(--text-muted)' }}>{start > 120 ? '…' : ''}{before}</span>
      <mark style={{ background: 'var(--selection-bg)', color: 'inherit' }}>{passage}</mark>
      <span style={{ color: 'var(--text-muted)' }}>{after}{end + 120 < chars.length ? '…' : ''}</span>
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

const KIND_COLOUR: Record<AiChange['type'], string> = {
  newCode: 'var(--rb-gold)',
  editCode: 'var(--rb-blue)',
  addCoding: 'var(--rb-blue)',
  removeCoding: 'var(--rb-coral)'
}

function ProposalCard({ p, chosen, onToggle, onApprove, onReject }: { p: AiProposal; chosen: boolean; onToggle: () => void; onApprove: () => void; onReject: () => void }) {
  const { t } = useTranslation()
  const proposals = useAiStore((s) => s.proposals)
  const created = useAiStore((s) => s.createdCodes)
  const codes = useCodeStore((s) => s.codes)
  const sources = useDocumentStore((s) => s.sources)
  const c = p.change
  const docName = (guid: string) => sources.find((s) => s.guid === guid)?.name ?? t('ai.review.missingDocument')
  /** A code's path, by guid, or by a proposed code's reference. */
  const path = (guid?: string, ref?: string): string[] => {
    if (guid) return pathOf(codes, guid)?.map((x) => x.name) ?? [t('ai.review.missingCode')]
    if (!ref) return []
    const made = created[`${p.chatId}:${ref}`]
    if (made && pathOf(codes, made)) return pathOf(codes, made)!.map((x) => x.name)
    const proposal = proposals.find((x) => x.chatId === p.chatId && x.change.type === 'newCode' && x.change.ref === ref)
    if (!proposal || proposal.change.type !== 'newCode') return [ref]
    return [...path(proposal.change.parentGuid, proposal.change.parentRef), proposal.change.name]
  }
  const colourOf = (guid?: string, ref?: string) => {
    const g = guid ?? (ref ? created[`${p.chatId}:${ref}`] : undefined)
    return (g && pathOf(codes, g)?.at(-1)?.color) || undefined
  }
  const needs = p.status === 'pending' ? withRequirements([p.id], proposals).filter((id) => id !== p.id) : []
  const open = (sourceGuid: string, start: number, end: number) => useDocumentStore.getState().viewDocumentAt(sourceGuid, start, end)
  const pending = p.status === 'pending'

  let kind: string
  let title: React.ReactNode
  let body: React.ReactNode = null
  let accent = KIND_COLOUR[c.type]
  if (c.type === 'newCode') {
    kind = t('ai.review.kind.newCode')
    title = <CodePath parts={[...path(c.parentGuid, c.parentRef), c.name]} color={colourOf(c.parentGuid, c.parentRef)} />
    if (c.description) body = <p style={{ margin: '6px 0 0', fontSize: 12.5, color: 'var(--text-secondary)' }}>{c.description}</p>
  } else if (c.type === 'editCode') {
    kind = t('ai.review.kind.editCode')
    title = <CodePath parts={path(c.codeGuid)} color={colourOf(c.codeGuid)} />
    body = (
      <ul style={{ margin: '6px 0 0', paddingInlineStart: 18, fontSize: 12.5, color: 'var(--text-secondary)' }}>
        {c.name && <li>{t('ai.review.rename', { name: c.name })}</li>}
        {c.description !== undefined && <li>{t('ai.review.describe')}: <em>{c.description || t('ai.review.noDescription')}</em></li>}
        {c.move && <li>{c.move.parentGuid || c.move.parentRef ? t('ai.review.moveUnder', { name: path(c.move.parentGuid, c.move.parentRef).join(' / ') }) : t('ai.review.moveTop')}</li>}
      </ul>
    )
  } else if (c.type === 'addCoding') {
    kind = t('ai.review.kind.coding')
    const colour = colourOf(c.codeGuid, c.codeRef)
    if (colour) accent = colour
    title = <><CodePath parts={path(c.codeGuid, c.codeRef)} color={colour} /> <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>· {docName(c.sourceGuid)}</span></>
    body = <Context sourceGuid={c.sourceGuid} start={c.start} end={c.end} cell={c.surveyCell} />
  } else {
    kind = t('ai.review.kind.removal')
    title = <><CodePath parts={path(c.codeGuid)} color={colourOf(c.codeGuid)} /> <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>· {docName(c.sourceGuid)}</span></>
    const sel = sources.find((s) => s.guid === c.sourceGuid)?.selections.find((s) => s.guid === c.selectionGuid)
    body = sel ? <Context sourceGuid={c.sourceGuid} start={sel.startPosition} end={sel.endPosition} cell={sel.surveyCell} /> : <p style={{ fontSize: 12.5 }}>“{c.text}”</p>
  }
  const at = c.type === 'addCoding' ? { g: c.sourceGuid, s: c.start, e: c.end } : null
  const statusColour = p.status === 'approved' ? 'var(--success)' : p.status === 'failed' ? 'var(--danger)' : 'var(--text-muted)'

  return (
    <li style={{
      position: 'relative', display: 'flex', gap: 12, padding: '12px 14px 12px 16px', borderRadius: 8,
      background: 'var(--bg-panel)', border: '1px solid var(--border-color)', boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
      borderInlineStart: `3px solid ${accent}`, opacity: pending ? 1 : 0.78
    }}>
      {pending && <input type="checkbox" checked={chosen} onChange={onToggle} aria-label={t('ai.review.choose')} style={{ marginTop: 2 }} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
          <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-secondary)', background: 'var(--bg-tertiary)', borderRadius: 4, padding: '1px 6px' }}>{kind}</span>
          {title}
        </div>
        {body}
        {p.reason && (
          <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t('ai.review.reason', { reason: p.reason })}</p>
        )}
        {needs.length > 0 && <p style={{ margin: '4px 0 0', fontSize: 11.5, color: 'var(--text-muted)' }}>{t('ai.review.alsoApproves', { count: needs.length })}</p>}
        {p.status === 'failed' && <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--danger)' }}>{t('ai.review.failed', { why: p.failure ?? '' })}</p>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, fontSize: 11, color: 'var(--text-muted)' }}>
          <span>{p.model}</span>
          {at && <button type="button" onClick={() => open(at.g, at.s, at.e)} style={{ padding: 0, border: 'none', background: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 11 }}>{t('ai.review.showInDocument')}</button>}
          <span style={{ flex: 1 }} />
          {pending ? (
            <>
              <button className="secondary" onClick={onReject}>{t('ai.review.deny')}</button>
              <button onClick={onApprove}>{t('ai.review.approve')}</button>
            </>
          ) : (
            <span style={{ fontWeight: 600, color: statusColour }}>{t(`ai.review.status.${p.status}`)}</span>
          )}
        </div>
      </div>
    </li>
  )
}
