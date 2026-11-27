/**
 * Deciding an AI Assistance coding in its document: opened from the AI
 * Assistance Viewer (a click on a coding), the document shows the passage
 * highlighted (TextDocumentPane keeps it so until it's decided), and this
 * bar floats over it with what's proposed and Reject (E) / Approve (R).
 * Deciding, or Back to review (Escape), returns to the Viewer.
 */
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAiStore, type AiProposal } from '../../stores/ai-store'
import { useAiReviewStore } from '../../stores/ai-review-store'
import { useDocumentStore } from '../../stores/document-store'
import { useCodeStore } from '../../stores/code-store'
import { approve, deny, withRequirements } from '../../utils/ai/apply'
import { AI_REVIEW_TAB_ID } from '../../utils/tab-ids'
import { Icon, faCheck, faXmark } from '../Icon'

/** Open a coding proposal in its document, to decide it there. */
export function reviewInDocument(p: AiProposal): void {
  const c = p.change
  let target: { sourceGuid: string; start: number; end: number; surveyCell?: { respondentId: string; questionId: string } } | null = null
  if (c.type === 'addCoding') target = { sourceGuid: c.sourceGuid, start: c.start, end: c.end, surveyCell: c.surveyCell }
  if (c.type === 'removeCoding') {
    const sel = useDocumentStore.getState().sources.find((s) => s.guid === c.sourceGuid)?.selections.find((s) => s.guid === c.selectionGuid)
    if (sel) target = { sourceGuid: c.sourceGuid, start: sel.startPosition, end: sel.endPosition, surveyCell: sel.surveyCell }
  }
  if (!target) return
  useAiReviewStore.getState().setReviewing({ proposalId: p.id, ...target })
  useDocumentStore.getState().viewDocumentAt(target.sourceGuid, target.start, target.end)
}

function backToReview() {
  useAiReviewStore.getState().setReviewing(null)
  useDocumentStore.getState().openToolTab(AI_REVIEW_TAB_ID)
}

/** Whether a key press is someone typing (not a shortcut). */
function typing(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
}

export function AiReviewBar() {
  const { t } = useTranslation()
  const reviewing = useAiReviewStore((s) => s.reviewing)
  const proposals = useAiStore((s) => s.proposals)
  const viewed = useDocumentStore((s) => s.viewedDocumentGuid)
  const findCode = useCodeStore((s) => s.findCode)
  useCodeStore((s) => s.codes)
  const p = reviewing ? proposals.find((x) => x.id === reviewing.proposalId) : undefined
  const shown = !!reviewing && !!p && p.status === 'pending' && viewed === reviewing.sourceGuid

  // Decided elsewhere (or gone): nothing left to review here.
  useEffect(() => {
    if (reviewing && (!p || p.status !== 'pending')) useAiReviewStore.getState().setReviewing(null)
  }, [reviewing, p])

  const decide = (yes: boolean) => {
    if (!p) return
    if (yes) approve([p.id])
    else deny([p.id])
    backToReview()
  }

  // E rejects, R approves (by position, as in the Viewer); Escape goes
  // back. Not while typing.
  useEffect(() => {
    if (!shown) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e)) return
      if (e.code === 'KeyR') decide(true)
      else if (e.code === 'KeyE') decide(false)
      else if (e.key === 'Escape') backToReview()
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  if (!shown || !p) return null
  const c = p.change
  const needs = withRequirements([p.id], proposals).filter((id) => id !== p.id)
  const codeGuid = c.type === 'addCoding' || c.type === 'removeCoding' ? c.codeGuid : undefined
  const codeRef = c.type === 'addCoding' ? c.codeRef : undefined
  const proposedCode = codeRef ? proposals.find((x) => x.change.type === 'newCode' && x.change.ref === codeRef)?.change : undefined
  const created = codeRef ? useAiStore.getState().createdCodes[codeRef] : undefined
  const code = findCode(codeGuid ?? created ?? '')
  const name = code?.name ?? (proposedCode?.type === 'newCode' ? proposedCode.name : '')
  const color = code?.color ?? (proposedCode?.type === 'newCode' ? proposedCode.color : undefined)
  const kbd: React.CSSProperties = { fontFamily: 'inherit', fontSize: 10.5, padding: '0 5px', marginInlineStart: 6, borderRadius: 4, border: '1px solid currentColor', opacity: 0.85 }
  const chip = (text: string, bg: string, plus = false) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', whiteSpace: 'nowrap', color: 'var(--text-primary)', borderRadius: 4, padding: '1px 6px', background: bg }}>
      {plus && <span aria-hidden>+</span>}
      {text}
    </span>
  )

  return (
    <div
      role="region"
      aria-label={t('ai.review.title')}
      style={{
        position: 'absolute', zIndex: 20, insetInline: 0, bottom: 20, display: 'flex', justifyContent: 'center', pointerEvents: 'none'
      }}
    >
      <div style={{
        pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', maxWidth: 'calc(100% - 40px)',
        borderRadius: 12, background: 'var(--bg-panel)', border: '1px solid var(--border-color)',
        boxShadow: '0 8px 28px rgba(0, 0, 0, 0.18), 0 1px 3px rgba(0, 0, 0, 0.1)', fontSize: 13
      }}>
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
          {c.type === 'addCoding'
            ? chip(t('ai.review.kind.coding'), 'color-mix(in srgb, var(--rb-blue) 24%, var(--bg-panel))')
            : chip(t('ai.review.kind.removal'), 'var(--bg-tertiary)')}
          {needs.length > 0 && (
            <span title={t('ai.review.alsoApproves', { count: needs.length })}>
              {chip(t('ai.review.kind.newCode'), 'color-mix(in srgb, var(--rb-gold) 30%, var(--bg-panel))', true)}
            </span>
          )}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {color && <span aria-hidden style={{ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0 }} />}
          <strong style={{ overflowWrap: 'anywhere' }}>{name}</strong>
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" className="secondary" onClick={backToReview}>{t('ai.review.back')}</button>
        <button type="button" className="secondary" onClick={() => decide(false)}>
          <Icon icon={faXmark} style={{ width: 13, height: 13, marginInlineEnd: 4 }} />{t('ai.review.deny')}<kbd style={kbd}>{t('ai.review.keyReject')}</kbd>
        </button>
        <button type="button" onClick={() => decide(true)}>
          <Icon icon={faCheck} style={{ width: 13, height: 13, marginInlineEnd: 4 }} />{t('ai.review.approve')}<kbd style={kbd}>{t('ai.review.keyApprove')}</kbd>
        </button>
      </div>
    </div>
  )
}
