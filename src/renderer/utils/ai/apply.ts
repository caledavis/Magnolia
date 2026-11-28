/**
 * Approving and denying the AI's proposals (the AI Assistance Viewer).
 *
 * Approved changes are made together, so one Undo takes them all back (the
 * undo history groups changes made at once). Codings are recorded as made
 * by an AI coder, a user of the project named for the model ("AI (claude-
 * sonnet-5-5)"), which the project file keeps as the standard's coder of
 * each coding; and each approval is noted in the Logbook: what was
 * approved, the model, and what the user had asked.
 *
 * Proposals depend on each other: a coding with a proposed new code needs
 * the code, and a new code under a proposed one needs its parent.
 * Approving one approves what it needs; denying one denies what needs it.
 */
import i18n from 'i18next'
import { useAiStore, type AiProposal } from '../../stores/ai-store'
import { useCodeStore } from '../../stores/code-store'
import { useDocumentStore } from '../../stores/document-store'
import { useLogbookStore } from '../../stores/logbook-store'
import { useProjectStore } from '../../stores/project-store'
import { usePreferencesStore } from '../../stores/preferences-store'
import { codeColourPresetsFor } from '../code-colours'
import { generateGuid } from '../guid'
import { codepointSlice } from '../unicode'
import type { SurveyFormatData, TextSource } from '../../models/types'
import { buildCellText } from '../survey/cell-text'
import { documentText } from './tools'
import { onUndoRestore } from '../../stores/undo-store'

const t = (key: string, vars?: Record<string, unknown>) => i18n.t(key, vars) as string

/** The proposal that proposed new code `ref`. */
function newCodeProposal(all: AiProposal[], ref: string): AiProposal | undefined {
  return all.find((p) => p.change.type === 'newCode' && p.change.ref === ref)
}

/** The new code a proposal needs, if it needs one. */
function needs(p: AiProposal): string | undefined {
  const c = p.change
  if (c.type === 'addCoding') return c.codeRef
  if (c.type === 'newCode') return c.parentRef
  if (c.type === 'editCode') return c.move?.parentRef
  return undefined
}

/** `ids` and everything they need that's still to be decided. */
export function withRequirements(ids: string[], all: AiProposal[]): string[] {
  const out = new Set(ids)
  const queue = [...ids]
  while (queue.length) {
    const id = queue.pop()
    const p = all.find((x) => x.id === id)
    const ref = p && needs(p)
    if (!p || !ref) continue
    const parent = newCodeProposal(all, ref)
    if (parent && parent.status === 'pending' && !out.has(parent.id)) {
      out.add(parent.id)
      queue.push(parent.id)
    }
  }
  return [...out]
}

/** `ids` and everything that needs them that's still to be decided. */
export function withDependents(ids: string[], all: AiProposal[]): string[] {
  const out = new Set(ids)
  const queue = [...ids]
  while (queue.length) {
    const id = queue.pop()
    const p = all.find((x) => x.id === id)
    if (!p || p.change.type !== 'newCode') continue
    const ref = p.change.ref
    for (const d of all) {
      if (d.status === 'pending' && needs(d) === ref && !out.has(d.id)) {
        out.add(d.id)
        queue.push(d.id)
      }
    }
  }
  return [...out]
}

export function deny(ids: string[]): void {
  const store = useAiStore.getState()
  const all = withDependents(ids, store.proposals)
  const now = new Date().toISOString()
  store.setProposals((ps) => ps.map((p) => (all.includes(p.id) && p.status === 'pending' ? { ...p, status: 'denied', decidedAt: now } : p)))
}

/** The project's coder for a model, added if it isn't there yet. */
function aiCoder(model: string): string {
  const name = `AI (${model.split(' · ').pop() || model})`
  const project = useProjectStore.getState()
  const found = project.users.find((u) => u.name === name)
  if (found) return found.guid
  const guid = generateGuid()
  useProjectStore.setState({ users: [...project.users, { guid, name }] })
  return guid
}

function textAt(source: TextSource, start: number, end: number, cell?: { respondentId: string; questionId: string }): string {
  let container = documentText(source.guid)
  if (cell) {
    const r = (source.formatData as SurveyFormatData | undefined)?.survey.respondents.find((x) => x.id === cell.respondentId)
    container = r ? buildCellText(r.answers[cell.questionId]) : ''
  }
  return Array.from(container).slice(start, end).join('')
}

/** A line for the Logbook about one change. */
function describe(p: AiProposal, codeName: (guid?: string, ref?: string) => string): string {
  const c = p.change
  const doc = (guid: string) => useDocumentStore.getState().sources.find((s) => s.guid === guid)?.name ?? ''
  const quote = (s: string) => (s.length > 120 ? s.slice(0, 117) + '…' : s).replace(/\s+/g, ' ')
  switch (c.type) {
    case 'newCode': return t('ai.log.newCode', { name: c.name })
    case 'editCode': return t('ai.log.editCode', { name: codeName(c.codeGuid) })
    case 'addCoding': return t('ai.log.addCoding', { code: codeName(c.codeGuid, c.codeRef), document: doc(c.sourceGuid), quote: quote(c.text) })
    case 'removeCoding': return t('ai.log.removeCoding', { code: codeName(c.codeGuid), document: doc(c.sourceGuid), quote: quote(c.text) })
  }
}

/** Approve proposals (and what they need). Returns how many were made,
 *  and how many couldn't be (the project had changed). */
export function approve(ids: string[]): { applied: number; failed: number } {
  const ai = useAiStore.getState()
  const chosen = withRequirements(ids, ai.proposals)
    .map((id) => ai.proposals.find((p) => p.id === id)!)
    .filter((p) => p && p.status === 'pending')
  // New codes first, parents before children; then the rest.
  const order: AiProposal[] = []
  const pendingCodes = chosen.filter((p) => p.change.type === 'newCode')
  const placed = new Set<string>()
  while (pendingCodes.length) {
    const i = pendingCodes.findIndex((p) => {
      const parentRef = (p.change as { parentRef?: string }).parentRef
      return !parentRef || placed.has(parentRef) || !chosen.some((q) => q.change.type === 'newCode' && q.change.ref === parentRef)
    })
    const next = pendingCodes.splice(i < 0 ? 0 : i, 1)[0]
    order.push(next)
    placed.add((next.change as { ref: string }).ref)
  }
  order.push(...chosen.filter((p) => p.change.type === 'editCode'), ...chosen.filter((p) => p.change.type === 'addCoding'), ...chosen.filter((p) => p.change.type === 'removeCoding'))

  const codes = useCodeStore.getState()
  const docs = useDocumentStore.getState()
  const created = { ...ai.createdCodes }
  const resolve = (guid?: string, ref?: string): string | undefined =>
    guid ?? (ref ? created[ref] : undefined)
  const codeName = (guid?: string, ref?: string) => codes.findCode(guid ?? '')?.name ?? (ref ? ref : '')
  const results = new Map<string, { status: 'approved' | 'failed'; failure?: string }>()
  const palette = codeColourPresetsFor(usePreferencesStore.getState())

  for (const p of order) {
    const c = p.change
    const ok = () => results.set(p.id, { status: 'approved' })
    const failed = (why: string) => results.set(p.id, { status: 'failed', failure: why })
    if (c.type === 'newCode') {
      const parentGuid = resolve(c.parentGuid, c.parentRef)
      if ((c.parentGuid || c.parentRef) && (!parentGuid || !codes.findCode(parentGuid))) { failed(t('ai.fail.noParent')); continue }
      const parent = parentGuid ? codes.findCode(parentGuid) : undefined
      const colour = c.color || parent?.color || palette[codes.flatCodes().length % palette.length]
      const guid = useCodeStore.getState().addCode(c.name, colour, parentGuid)
      if (c.description) useCodeStore.getState().setCodeDescription(guid, c.description)
      created[c.ref] = guid
      ok()
    } else if (c.type === 'editCode') {
      if (!codes.findCode(c.codeGuid)) { failed(t('ai.fail.noCode')); continue }
      if (c.move) {
        const parentGuid = resolve(c.move.parentGuid, c.move.parentRef)
        if ((c.move.parentGuid || c.move.parentRef) && !parentGuid) { failed(t('ai.fail.noParent')); continue }
        useCodeStore.getState().moveCode(c.codeGuid, parentGuid ?? null)
      }
      if (c.name) useCodeStore.getState().renameCode(c.codeGuid, c.name)
      if (c.description !== undefined) useCodeStore.getState().setCodeDescription(c.codeGuid, c.description)
      ok()
    } else if (c.type === 'addCoding') {
      const codeGuid = resolve(c.codeGuid, c.codeRef)
      const source = useDocumentStore.getState().sources.find((s) => s.guid === c.sourceGuid)
      if (!codeGuid || !useCodeStore.getState().findCode(codeGuid)) { failed(t('ai.fail.noCode')); continue }
      if (!source) { failed(t('ai.fail.noDocument')); continue }
      if (textAt(source, c.start, c.end, c.surveyCell) !== c.text) { failed(t('ai.fail.textChanged')); continue }
      const coder = aiCoder(p.model)
      const same = source.selections.find((s) =>
        s.startPosition === c.start && s.endPosition === c.end && !s.pdfRegion &&
        (s.surveyCell?.respondentId ?? '') === (c.surveyCell?.respondentId ?? '') &&
        (s.surveyCell?.questionId ?? '') === (c.surveyCell?.questionId ?? ''))
      // Named by its first 80 characters, counted whole: cutting by UTF-16
      // unit could split an emoji in two.
      const selectionGuid = same?.guid ?? docs.addSelection(c.sourceGuid, c.start, c.end, codepointSlice(c.text, 0, 80), undefined, c.surveyCell, coder)
      useDocumentStore.getState().addCodingToSelection(c.sourceGuid, selectionGuid, codeGuid, coder)
      ok()
    } else {
      const source = useDocumentStore.getState().sources.find((s) => s.guid === c.sourceGuid)
      const sel = source?.selections.find((s) => s.guid === c.selectionGuid)
      if (!sel?.codings.some((x) => x.guid === c.codingGuid)) { failed(t('ai.fail.codingGone')); continue }
      // The passage goes with its last code, as when the user removes it.
      if (sel.codings.length === 1) useDocumentStore.getState().removeSelection(c.sourceGuid, c.selectionGuid)
      else useDocumentStore.getState().removeCoding(c.sourceGuid, c.selectionGuid, c.codingGuid)
      ok()
    }
  }

  const now = new Date().toISOString()
  for (const [key, guid] of Object.entries(created)) if (ai.createdCodes[key] !== guid) useAiStore.getState().setCreatedCode(key, guid)
  useAiStore.getState().setProposals((ps) => ps.map((p) => {
    const r = results.get(p.id)
    return r ? { ...p, status: r.status, failure: r.failure, decidedAt: now, undone: undefined } : p
  }))

  const applied = order.filter((p) => results.get(p.id)?.status === 'approved')
  if (applied.length) {
    const lines = applied.map((p) => `- ${describe(p, codeName)}${p.reason ? ` — ${p.reason}` : ''}`)
    const models = [...new Set(applied.map((p) => p.model))].join(', ')
    useLogbookStore.getState().addEntry(
      t('ai.log.title', { count: applied.length }),
      `${t('ai.log.proposedBy', { model: models })}\n\n${lines.join('\n')}`
    )
  }
  useProjectStore.getState().markDirty()
  return { applied: applied.length, failed: order.length - applied.length }
}

/** Whether an approved change is in the project as it now is. */
function inProject(p: AiProposal, created: Record<string, string>): boolean {
  const c = p.change
  const codes = useCodeStore.getState()
  const sources = useDocumentStore.getState().sources
  switch (c.type) {
    case 'newCode': {
      const guid = created[c.ref]
      return !!guid && !!codes.findCode(guid)
    }
    case 'editCode': {
      const code = codes.findCode(c.codeGuid)
      if (!code) return false
      if (c.name && code.name !== c.name) return false
      if (c.description !== undefined && (code.description ?? '') !== c.description) return false
      return true
    }
    case 'addCoding': {
      const codeGuid = c.codeGuid ?? (c.codeRef ? created[c.codeRef] : undefined)
      const source = sources.find((s) => s.guid === c.sourceGuid)
      return !!codeGuid && !!source?.selections.some((s) =>
        s.startPosition === c.start && s.endPosition === c.end &&
        (s.surveyCell?.respondentId ?? '') === (c.surveyCell?.respondentId ?? '') &&
        s.codings.some((x) => x.codeGuid === codeGuid))
    }
    case 'removeCoding':
      return !sources.find((s) => s.guid === c.sourceGuid)?.selections.find((s) => s.guid === c.selectionGuid)?.codings.some((x) => x.guid === c.codingGuid)
  }
}

/** After Undo or Redo: an approved change Undo took back is to be reviewed
 *  again (and approving it makes it anew); one Redo brought back is
 *  approved again. */
export function reconcileWithProject(): void {
  const ai = useAiStore.getState()
  let changed = false
  const next = ai.proposals.map((p) => {
    if (p.status === 'approved' && !inProject(p, ai.createdCodes)) {
      changed = true
      return { ...p, status: 'pending' as const, decidedAt: undefined, undone: true }
    }
    if (p.status === 'pending' && p.undone && inProject(p, ai.createdCodes)) {
      changed = true
      return { ...p, status: 'approved' as const, undone: undefined, decidedAt: new Date().toISOString() }
    }
    return p
  })
  if (changed) ai.setProposals(() => next)
}

onUndoRestore(reconcileWithProject)
