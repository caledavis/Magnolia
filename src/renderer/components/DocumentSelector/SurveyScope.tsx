/**
 * Choosing a survey's questions and respondents inside the Document
 * Selector. Each survey in the Selected Documents list gets two lines,
 * "All questions" and "All respondents"; clicking one opens a checklist.
 * Dragging a question or respondent from the Document Browser onto the
 * selector chooses it too.
 *
 * A survey with no entries in a scope keeps all of its questions (or
 * respondents); with entries, it's limited to them, and an entry of
 * NONE_CHOSEN alone means none of them. Other documents are never
 * affected. This is the query engine's questionScope / respondentScope
 * (see survey-cell-scope.ts), which needs nothing special for "none": a
 * survey listed with no real ids simply has no cells in scope.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SurveyEntityRef } from '../../models/types'
import { useTranslation } from 'react-i18next'
import { t } from '../../i18n'

export type SurveyScopeKind = 'questions' | 'respondents'

/** The id that stands for "none of them" (no real question or respondent
 *  has it). */
export const NONE_CHOSEN = '\u0000none'

/** The ids chosen for one survey; empty means all of them. */
export function chosenIds(scope: SurveyEntityRef[] | undefined, surveyGuid: string): Set<string> {
  return new Set((scope ?? []).filter((r) => r.sourceGuid === surveyGuid).map((r) => r.id))
}

/** Replace one survey's entries in a scope. Empty `ids` means all;
 *  [NONE_CHOSEN] means none. */
export function withSurveyIds(scope: SurveyEntityRef[] | undefined, surveyGuid: string, ids: string[]): SurveyEntityRef[] {
  return [...(scope ?? []).filter((r) => r.sourceGuid !== surveyGuid), ...ids.map((id) => ({ sourceGuid: surveyGuid, id }))]
}

/** Add one question or respondent to its survey's choices (which stops
 *  the survey counting none of them). */
export function withSurveyEntity(scope: SurveyEntityRef[] | undefined, ref: SurveyEntityRef): SurveyEntityRef[] {
  const rest = (scope ?? []).filter((r) => !(r.sourceGuid === ref.sourceGuid && (r.id === ref.id || r.id === NONE_CHOSEN)))
  return [...rest, ref]
}

/** The real entries of a scope, for counting (leaves out NONE_CHOSEN). */
export function chosenEntries(scope: SurveyEntityRef[] | undefined): SurveyEntityRef[] {
  return (scope ?? []).filter((r) => r.id !== NONE_CHOSEN)
}

/** A question or respondent dragged from the Document Browser. */
export function parseSurveyEntityDrop(e: React.DragEvent): { kind: SurveyScopeKind; ref: SurveyEntityRef } | null {
  const raw = e.dataTransfer.getData('application/json')
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as { kind?: string; entityGuid?: string; surveyGuid?: string }
    if (!p.surveyGuid || !p.entityGuid) return null
    if (p.kind === 'survey-question') return { kind: 'questions', ref: { sourceGuid: p.surveyGuid, id: p.entityGuid } }
    if (p.kind === 'survey-respondent') return { kind: 'respondents', ref: { sourceGuid: p.surveyGuid, id: p.entityGuid } }
  } catch { /* not ours */ }
  return null
}

/** True while a drag might be a question or respondent (the payload can
 *  only be read on drop). */
export function mayBeSurveyEntityDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes('application/json')
}

// Each phrase has a key per kind (scope.<phrase>.questions/.respondents):
// "all", "no" and so on agree with the noun's gender in some languages.

/** "All questions", "No questions", or "2 of 14 questions", for one
 *  survey's choices. */
export function scopeSummary(kind: SurveyScopeKind, chosen: Set<string>, ids: string[]): string {
  if (chosen.size === 0) return t(`scope.all.${kind}`)
  const n = ids.filter((id) => chosen.has(id)).length
  if (n === 0) return t(`scope.none.${kind}`)
  if (n === ids.length) return t(`scope.all.${kind}`)
  return t(`scope.nOf.${kind}`, { n, count: ids.length })
}

const CHECKLIST_W = 300

/** One survey's line in the Selected Documents list, with its checklist. */
export function SurveyScopeLine({ kind, surveyName, labels, chosen, onChange, narrowedByTags }: {
  kind: SurveyScopeKind
  surveyName: string
  /** A tag in the selection already narrows this survey's questions (or
   *  respondents), so "All" would be misleading when none are chosen. */
  narrowedByTags?: boolean
  /** Every question (or respondent) in the survey: id → text, in order. */
  labels: Record<string, string>
  chosen: Set<string>
  /** The chosen ids; empty for all, [NONE_CHOSEN] for none. */
  onChange: (ids: string[]) => void
}) {
  const { t } = useTranslation()
  const ids = useMemo(() => Object.keys(labels), [labels])
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const all = chosen.size === 0
  const summary = all && narrowedByTags
    ? t(`scope.choose.${kind}`)
    : scopeSummary(kind, chosen, ids)
  if (ids.length === 0) return null
  return (
    <>
      <div
        onClick={(e) => setAnchor(anchor ? null : (e.currentTarget as HTMLElement).getBoundingClientRect())}
        title={t(`scope.chooseTitle.${kind}`, { survey: surveyName })}
        style={{ padding: '1px 6px 0 16px', fontSize: 9, color: all ? 'var(--text-muted)' : 'var(--accent)', cursor: 'pointer', fontWeight: all ? 400 : 600 }}
      >
        {summary} ▾
      </div>
      {anchor && (
        <Checklist
          kind={kind}
          surveyName={surveyName}
          labels={labels}
          ids={ids}
          chosen={chosen}
          onChange={onChange}
          anchor={anchor}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  )
}

function Checklist({ kind, surveyName, labels, ids, chosen, onChange, anchor, onClose }: {
  kind: SurveyScopeKind
  surveyName: string
  labels: Record<string, string>
  ids: string[]
  chosen: Set<string>
  onChange: (ids: string[]) => void
  anchor: DOMRect
  onClose: () => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const [search, setSearch] = useState('')
  const [pos, setPos] = useState({ left: anchor.right - CHECKLIST_W, top: anchor.bottom + 4 })
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(chosen.size === 0 ? ids : ids.filter((id) => chosen.has(id))))

  // Keep the checklist on screen.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.max(8, Math.min(anchor.right - CHECKLIST_W, window.innerWidth - CHECKLIST_W - 8)),
      top: anchor.bottom + 4 + r.height > window.innerHeight - 8 ? Math.max(8, anchor.top - 4 - r.height) : anchor.bottom + 4
    })
  }, [anchor])

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const tick = (next: Set<string>) => {
    setTicked(next)
    onChange(next.size === ids.length ? [] : next.size === 0 ? [NONE_CHOSEN] : ids.filter((x) => next.has(x)))
  }
  const toggle = (id: string) => {
    const next = new Set(ticked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    tick(next)
  }

  const q = search.trim().toLowerCase()
  const shown = q ? ids.filter((id) => (labels[id] ?? '').toLowerCase().includes(q)) : ids

  return (
    <div
      ref={ref}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed', left: pos.left, top: pos.top, width: CHECKLIST_W, zIndex: 1000,
        background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)',
        // Matches .context-menu.
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.08), 0 4px 12px rgba(0, 0, 0, 0.10)', padding: 8, fontSize: 11
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span style={{ fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={surveyName}>
          {t(`scope.inSurvey.${kind}`, { survey: surveyName })}
        </span>
        <span style={{ color: 'var(--text-muted)', fontSize: 10, flexShrink: 0 }}>{t('scope.tickedOf', { n: ticked.size, count: ids.length })}</span>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <button className="secondary" style={{ fontSize: 10, padding: '2px 8px' }} disabled={ticked.size === ids.length} onClick={() => tick(new Set(ids))}>
          {t('merge.selectAll')}
        </button>
        <button className="secondary" style={{ fontSize: 10, padding: '2px 8px' }} disabled={ticked.size === 0} onClick={() => tick(new Set())}>
          {t('merge.deselectAll')}
        </button>
      </div>
      {ids.length > 8 && (
        <input
          autoFocus
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t(`scope.find.${kind}`)}
          style={{ width: '100%', marginBottom: 6, fontSize: 11 }}
        />
      )}
      <div style={{ maxHeight: 260, overflowY: 'auto' }}>
        {shown.map((id) => (
          <label key={id} title={labels[id]} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', cursor: 'pointer' }}>
            <input type="checkbox" checked={ticked.has(id)} onChange={() => toggle(id)} style={{ margin: 0, flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{labels[id] || id}</span>
          </label>
        ))}
        {shown.length === 0 && <div style={{ color: 'var(--text-muted)', padding: '4px 0' }}>{t(`scope.noMatch.${kind}`)}</div>}
      </div>
      <div style={{ fontSize: 10, color: ticked.size === 0 ? 'var(--text-secondary)' : 'var(--text-muted)', marginTop: 6 }}>
        {ticked.size === 0 ? t(`scope.noneIncluded.${kind}`) : t('scope.othersUnaffected')}
      </div>
    </div>
  )
}
