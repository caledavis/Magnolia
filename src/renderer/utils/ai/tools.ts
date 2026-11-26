/**
 * What the AI can do in a project: read it (the list of documents and
 * codes, a document's text, a search, a code's passages), and propose
 * changes to codes and codings. It can't change anything: a proposal goes
 * to the AI Assistance Viewer, where the user approves or denies it.
 *
 * The AI refers to things by short references this chat hands out (D3 for a
 * document, C5 for a code, P12 for a passage, N1 for a code it proposed),
 * kept with the chat, so it never has to copy a long id exactly, and its
 * answers can cite passages ([P12]) that the chat turns into links.
 *
 * Offsets are code points, as everywhere in Magnolia.
 */
import type { AiToolSpec, Code, PlainTextSelection, SurveyFormatData, TextSource } from '../../models/types'
import { useDocumentStore } from '../../stores/document-store'
import { useCodeStore } from '../../stores/code-store'
import { flattenCodesWithDepth } from '../code-tree'
import { buildCellText } from '../survey/cell-text'
import { textForSelection } from '../query-engine'

/** A passage a chat has shown the AI (cited as [P12]). */
export interface PassageRef {
  sourceGuid: string
  start: number
  end: number
  surveyCell?: { respondentId: string; questionId: string }
  /** When it's a coded passage: the coding, so it can be proposed for removal. */
  selectionGuid?: string
  codingGuid?: string
  codeGuid?: string
}

/** The references a chat has handed out. */
export interface ChatRefs {
  documents: Record<string, string>
  codes: Record<string, string>
  passages: Record<string, PassageRef>
  /** N1… : proposals of new codes. */
  newCodes: Record<string, string>
}

export const emptyRefs = (): ChatRefs => ({ documents: {}, codes: {}, passages: {}, newCodes: {} })

export type AiChange =
  | { type: 'newCode'; ref: string; name: string; description?: string; parentGuid?: string; parentRef?: string }
  | { type: 'editCode'; codeGuid: string; name?: string; description?: string; move?: { parentGuid?: string; parentRef?: string } }
  | { type: 'addCoding'; sourceGuid: string; start: number; end: number; surveyCell?: { respondentId: string; questionId: string }; codeGuid?: string; codeRef?: string; text: string }
  | { type: 'removeCoding'; sourceGuid: string; selectionGuid: string; codingGuid: string; codeGuid: string; text: string }

/** What a tool did: its answer for the AI, a line for the chat, and any
 *  proposals it made. */
export interface ToolOutcome {
  content: string
  isError?: boolean
  /** For the chat: what was read or proposed, in the user's terms. */
  activity: { key: string; vars?: Record<string, string | number> }
  proposals?: { change: AiChange; reason: string }[]
}

/** How much of a document one read returns, in code points. */
export const READ_CHUNK = 12000
const MAX_MATCHES = 40
const MAX_PASSAGES = 60
const PASSAGE_CHARS = 600

const str = { type: 'string' } as const
const int = { type: 'integer' } as const

export const TOOL_SPECS: AiToolSpec[] = [
  {
    name: 'list_documents',
    description: 'List the project\'s documents: each one\'s reference (D1…), name, kind and length in characters. Pictures and recordings without a transcript have no text to read.',
    schema: { type: 'object', properties: {} }
  },
  {
    name: 'list_codes',
    description: 'List the project\'s codes as a tree: each one\'s reference (C1…), name, description and how many passages it codes.',
    schema: { type: 'object', properties: {} }
  },
  {
    name: 'read_document',
    description: `Read a document's text, ${READ_CHUNK} characters at a time (use "from" to read on). For a survey, read its answers instead: all of them, or one respondent's, or one question's.`,
    schema: {
      type: 'object',
      properties: {
        document: { ...str, description: 'Its reference, e.g. D3.' },
        from: { ...int, description: 'Character offset to start at (default 0).' },
        respondent: { ...str, description: 'Survey only: a respondent id.' },
        question: { ...str, description: 'Survey only: a question id.' }
      },
      required: ['document']
    }
  },
  {
    name: 'search_text',
    description: 'Find words or a phrase in the documents (not case-sensitive). Each match is a passage reference (P1…) with its context, which you can cite.',
    schema: {
      type: 'object',
      properties: {
        text: str,
        document: { ...str, description: 'Only this document (a reference); default all.' },
        whole_word: { type: 'boolean' }
      },
      required: ['text']
    }
  },
  {
    name: 'coded_passages',
    description: 'The passages a code is applied to, each as a passage reference (P1…) with its document and text.',
    schema: { type: 'object', properties: { code: { ...str, description: 'A code reference, e.g. C2.' } }, required: ['code'] }
  },
  {
    name: 'propose_new_code',
    description: 'Propose a new code. It is NOT created: the user reviews it. Returns a reference (N1…) you can use as the code of proposed codings, or as the parent of other proposed codes.',
    schema: {
      type: 'object',
      properties: {
        name: str,
        description: { ...str, description: 'What the code means and when to apply it.' },
        parent: { ...str, description: 'A code (C…) or proposed code (N…) to put it under; omit for the top level.' },
        reason: { ...str, description: 'Why, in a sentence, for the user.' }
      },
      required: ['name', 'reason']
    }
  },
  {
    name: 'propose_code_change',
    description: 'Propose renaming an existing code, changing its description, or moving it under another code (parent "none" for the top level). The user reviews it.',
    schema: {
      type: 'object',
      properties: {
        code: { ...str, description: 'A code reference (C…).' },
        name: str,
        description: str,
        parent: { ...str, description: 'C…, N…, or "none".' },
        reason: str
      },
      required: ['code', 'reason']
    }
  },
  {
    name: 'propose_coding',
    description: 'Propose applying a code to a passage. Quote the passage exactly as it is in the document (copy it from what you read); the user reviews it.',
    schema: {
      type: 'object',
      properties: {
        document: { ...str, description: 'A document reference (D…).' },
        quote: { ...str, description: 'The passage, exactly as in the document.' },
        code: { ...str, description: 'A code (C…) or proposed code (N…).' },
        occurrence: { ...int, description: 'If the quote appears more than once, which one (1 = first).' },
        respondent: { ...str, description: 'Survey only: the respondent id.' },
        question: { ...str, description: 'Survey only: the question id.' },
        reason: str
      },
      required: ['document', 'quote', 'code', 'reason']
    }
  },
  {
    name: 'propose_remove_coding',
    description: 'Propose removing a code from a passage, given as a passage reference from coded_passages. The user reviews it.',
    schema: { type: 'object', properties: { passage: { ...str, description: 'A passage reference (P…) from coded_passages.' }, reason: str }, required: ['passage', 'reason'] }
  }
]

// ─── The project, as the AI sees it ──────────────────────────────────

function sources(): TextSource[] {
  return useDocumentStore.getState().sources
}

function survey(source: TextSource) {
  return source.sourceType === 'survey' ? (source.formatData as SurveyFormatData | undefined)?.survey : undefined
}

/** A document's text (not a survey's: its cells are read one by one). */
export function documentText(guid: string): string {
  return useDocumentStore.getState().sourceContents[guid] ?? ''
}

/** A survey cell's text. */
function cellText(source: TextSource, respondentId: string, questionId: string): string {
  const r = survey(source)?.respondents.find((x) => x.id === respondentId)
  return r ? buildCellText(r.answers[questionId]) : ''
}

/** The text a passage is in: the document's, or its survey cell's. */
function containerText(source: TextSource, cell?: { respondentId: string; questionId: string }): string {
  return cell ? cellText(source, cell.respondentId, cell.questionId) : documentText(source.guid)
}

function hasText(source: TextSource): boolean {
  if (source.sourceType === 'survey') return true
  if (source.sourceType === 'image') return false
  return documentText(source.guid).length > 0
}

/** The chat's reference for a thing, handed out on first mention. */
function refFor(map: Record<string, string>, prefix: string, guid: string): string {
  for (const [ref, g] of Object.entries(map)) if (g === guid) return ref
  const ref = `${prefix}${Object.keys(map).length + 1}`
  map[ref] = guid
  return ref
}

function passageRef(refs: ChatRefs, p: PassageRef): string {
  const ref = `P${Object.keys(refs.passages).length + 1}`
  refs.passages[ref] = p
  return ref
}

const norm = (r: unknown) => String(r ?? '').trim().toUpperCase()

function findDocument(refs: ChatRefs, ref: unknown): TextSource | null {
  const guid = refs.documents[norm(ref)]
  return (guid && sources().find((s) => s.guid === guid)) || null
}

function findCode(refs: ChatRefs, ref: unknown): Code | null {
  const guid = refs.codes[norm(ref)]
  return (guid && useCodeStore.getState().findCode(guid)) || null
}

const cps = (s: string) => Array.from(s)

/** Text before and after a range, for context. */
function inContext(chars: string[], start: number, end: number, around = 80): string {
  const before = chars.slice(Math.max(0, start - around), start).join('')
  const after = chars.slice(end, end + around).join('')
  return `${start > around ? '…' : ''}${before}[${chars.slice(start, end).join('')}]${after}${end + around < chars.length ? '…' : ''}`.replace(/\s+/g, ' ')
}

/** Where a quote is in a text: exactly, else ignoring differences in
 *  spacing and case. Code-point ranges. */
export function locateQuote(text: string, quote: string): { start: number; end: number }[] {
  const q = quote.trim()
  if (!q) return []
  const hits: { start: number; end: number }[] = []
  // Exact.
  let from = 0
  for (;;) {
    const i = text.indexOf(q, from)
    if (i < 0) break
    const start = codepointIndex(text, i)
    hits.push({ start, end: start + cps(q).length })
    from = i + q.length
  }
  if (hits.length) return hits
  // Loosely: any run of spaces matches any other, case aside.
  const chars = cps(text)
  const lower = chars.map((c) => c.toLowerCase())
  const words = cps(q.toLowerCase()).join('').split(/\s+/).filter(Boolean)
  if (!words.length) return []
  // Match word by word over the code points, skipping spaces between.
  for (let s = 0; s < lower.length; s++) {
    let i = s
    let ok = true
    for (let w = 0; w < words.length && ok; w++) {
      if (w > 0) {
        if (!/\s/.test(lower[i] ?? '')) { ok = false; break }
        while (i < lower.length && /\s/.test(lower[i])) i++
      }
      for (const ch of cps(words[w])) {
        if (lower[i] !== ch) { ok = false; break }
        i++
      }
    }
    if (ok) {
      hits.push({ start: s, end: i })
      s = i - 1
    }
  }
  return hits
}

/** The code-point index of a UTF-16 index. */
function codepointIndex(text: string, utf16: number): number {
  return cps(text.slice(0, utf16)).length
}

function codingsOf(codeGuid: string): { source: TextSource; selection: PlainTextSelection; codingGuid: string }[] {
  const out: { source: TextSource; selection: PlainTextSelection; codingGuid: string }[] = []
  for (const source of sources()) {
    for (const selection of source.selections) {
      const c = selection.codings.find((x) => x.codeGuid === codeGuid)
      if (c) out.push({ source, selection, codingGuid: c.guid })
    }
  }
  return out
}

function kindOf(s: TextSource): string {
  return s.sourceType ?? 'text'
}

// ─── The tools ───────────────────────────────────────────────────────

type Input = Record<string, unknown>

/** Run one tool. `refs` is updated with any references handed out. */
export function runTool(name: string, input: Input, refs: ChatRefs): ToolOutcome {
  try {
    switch (name) {
      case 'list_documents': return listDocuments(refs)
      case 'list_codes': return listCodes(refs)
      case 'read_document': return readDocument(input, refs)
      case 'search_text': return searchText(input, refs)
      case 'coded_passages': return codedPassages(input, refs)
      case 'propose_new_code': return proposeNewCode(input, refs)
      case 'propose_code_change': return proposeCodeChange(input, refs)
      case 'propose_coding': return proposeCoding(input, refs)
      case 'propose_remove_coding': return proposeRemoveCoding(input, refs)
      default: return fail(`There is no tool called ${name}.`, 'ai.activity.unknownTool', { name })
    }
  } catch (err) {
    return fail(`The tool failed: ${err instanceof Error ? err.message : String(err)}`, 'ai.activity.failed', { name })
  }
}

function fail(content: string, key = 'ai.activity.problem', vars?: Record<string, string | number>): ToolOutcome {
  return { content, isError: true, activity: { key, vars } }
}

function listDocuments(refs: ChatRefs): ToolOutcome {
  const lines = sources().map((s) => {
    const ref = refFor(refs.documents, 'D', s.guid)
    const sv = survey(s)
    const size = sv
      ? `survey: ${sv.respondents.length} respondents, ${sv.questions.length} questions`
      : hasText(s) ? `${cps(documentText(s.guid)).length} characters` : 'no text'
    return `${ref} | ${s.name} | ${kindOf(s)} | ${size}`
  })
  return {
    content: lines.length ? lines.join('\n') : 'The project has no documents.',
    activity: { key: 'ai.activity.listDocuments', vars: { count: lines.length } }
  }
}

function listCodes(refs: ChatRefs): ToolOutcome {
  const counts = new Map<string, number>()
  for (const s of sources()) for (const sel of s.selections) for (const c of sel.codings) counts.set(c.codeGuid, (counts.get(c.codeGuid) ?? 0) + 1)
  const rows = flattenCodesWithDepth(useCodeStore.getState().codes)
  const lines = rows.map(({ code, depth }) => {
    const ref = refFor(refs.codes, 'C', code.guid)
    const desc = code.description?.trim() ? ` — ${code.description.trim().replace(/\s+/g, ' ').slice(0, 300)}` : ''
    return `${'  '.repeat(depth)}${ref} ${code.name}${desc} (${counts.get(code.guid) ?? 0} passages)`
  })
  return {
    content: lines.length ? lines.join('\n') : 'The project has no codes yet.',
    activity: { key: 'ai.activity.listCodes', vars: { count: lines.length } }
  }
}

function readDocument(input: Input, refs: ChatRefs): ToolOutcome {
  const source = findDocument(refs, input.document)
  if (!source) return fail(`No document ${String(input.document)}: use list_documents for the references.`)
  const sv = survey(source)
  if (sv) {
    const respondents = input.respondent ? sv.respondents.filter((r) => r.id === String(input.respondent)) : sv.respondents
    const questions = input.question ? sv.questions.filter((q) => q.id === String(input.question)) : sv.questions
    if (!respondents.length || !questions.length) return fail('No such respondent or question in this survey.')
    const out: string[] = [`Questions: ${questions.map((q) => `${q.id} = ${q.text}`).join(' | ')}`]
    let size = 0
    let shown = 0
    for (const r of respondents) {
      for (const q of questions) {
        const text = buildCellText(r.answers[q.id])
        if (!text.trim()) continue
        const line = `respondent ${r.id} (${r.displayName}) × question ${q.id}: ${text}`
        size += line.length
        if (size > READ_CHUNK * 2) {
          out.push(`… more answers: read one respondent or question at a time.`)
          return { content: out.join('\n'), activity: { key: 'ai.activity.readSurvey', vars: { name: source.name, count: shown } } }
        }
        out.push(line)
        shown++
      }
    }
    return { content: out.join('\n'), activity: { key: 'ai.activity.readSurvey', vars: { name: source.name, count: shown } } }
  }
  if (!hasText(source)) return fail(`${source.name} has no text to read (a picture, or a recording without a transcript).`)
  const chars = cps(documentText(source.guid))
  const from = Math.max(0, Math.min(chars.length, Math.floor(Number(input.from) || 0)))
  const to = Math.min(chars.length, from + READ_CHUNK)
  const more = to < chars.length ? `\n[Characters ${from}–${to} of ${chars.length}; read on with from=${to}.]` : `\n[Characters ${from}–${to} of ${chars.length}: the end.]`
  return {
    content: chars.slice(from, to).join('') + more,
    activity: { key: 'ai.activity.read', vars: { name: source.name, from, to, total: chars.length } }
  }
}

function searchText(input: Input, refs: ChatRefs): ToolOutcome {
  const needle = String(input.text ?? '').trim()
  if (!needle) return fail('Nothing to search for.')
  const only = input.document ? findDocument(refs, input.document) : null
  if (input.document && !only) return fail(`No document ${String(input.document)}.`)
  const whole = !!input.whole_word
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  const re = new RegExp(whole ? `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])` : escaped, 'giu')
  const lines: string[] = []
  let total = 0
  const scan = (source: TextSource, text: string, cell?: { respondentId: string; questionId: string }) => {
    if (!text) return
    for (const m of text.matchAll(re)) {
      total++
      if (lines.length >= MAX_MATCHES) continue
      const start = codepointIndex(text, m.index!)
      const end = start + cps(m[0]).length
      const ref = passageRef(refs, { sourceGuid: source.guid, start, end, surveyCell: cell })
      const where = cell ? `${source.name}, respondent ${cell.respondentId} × question ${cell.questionId}` : source.name
      lines.push(`${ref} · ${refFor(refs.documents, 'D', source.guid)} ${where}: ${inContext(cps(text), start, end)}`)
    }
  }
  for (const source of only ? [only] : sources()) {
    const sv = survey(source)
    if (sv) {
      for (const r of sv.respondents) for (const q of sv.questions) scan(source, buildCellText(r.answers[q.id]), { respondentId: r.id, questionId: q.id })
    } else if (hasText(source)) {
      scan(source, documentText(source.guid))
    }
  }
  const tail = total > lines.length ? `\n[${total} matches; the first ${lines.length} shown.]` : ''
  return {
    content: lines.length ? lines.join('\n') + tail : `No matches for "${needle}".`,
    activity: { key: 'ai.activity.search', vars: { text: needle, count: total } }
  }
}

function codedPassages(input: Input, refs: ChatRefs): ToolOutcome {
  const code = findCode(refs, input.code)
  if (!code) return fail(`No code ${String(input.code)}: use list_codes for the references.`)
  const all = codingsOf(code.guid)
  const lines = all.slice(0, MAX_PASSAGES).map(({ source, selection, codingGuid }) => {
    const ref = passageRef(refs, {
      sourceGuid: source.guid, start: selection.startPosition, end: selection.endPosition,
      surveyCell: selection.surveyCell, selectionGuid: selection.guid, codingGuid, codeGuid: code.guid
    })
    const container = textForSelection(source, selection, documentText(source.guid))
    let text = cps(container).slice(selection.startPosition, selection.endPosition).join('')
    if (!text && selection.pdfRegion) text = '(an area of a page or picture)'
    if (!text && selection.timeRange) text = `(a stretch of the recording, ${selection.timeRange.startTime.toFixed(1)}–${selection.timeRange.endTime.toFixed(1)} s)`
    if (cps(text).length > PASSAGE_CHARS) text = cps(text).slice(0, PASSAGE_CHARS).join('') + '…'
    return `${ref} · ${refFor(refs.documents, 'D', source.guid)} ${source.name}: ${text.replace(/\s+/g, ' ')}`
  })
  const tail = all.length > lines.length ? `\n[${all.length} passages; the first ${lines.length} shown.]` : ''
  return {
    content: lines.length ? lines.join('\n') + tail : `${code.name} isn't applied to any passage yet.`,
    activity: { key: 'ai.activity.codedPassages', vars: { name: code.name, count: all.length } }
  }
}

/** A parent given as C…, N… or "none". */
function parentOf(refs: ChatRefs, ref: unknown): { parentGuid?: string; parentRef?: string } | 'none' | null {
  const r = norm(ref)
  if (r === 'NONE' || r === '') return 'none'
  if (refs.newCodes[r] !== undefined) return { parentRef: r }
  const code = findCode(refs, r)
  return code ? { parentGuid: code.guid } : null
}

function proposeNewCode(input: Input, refs: ChatRefs): ToolOutcome {
  const name = String(input.name ?? '').trim()
  if (!name) return fail('A new code needs a name.')
  let parent: { parentGuid?: string; parentRef?: string } = {}
  if (input.parent !== undefined && input.parent !== null && norm(input.parent) !== 'NONE') {
    const p = parentOf(refs, input.parent)
    if (!p || p === 'none') return fail(`No code ${String(input.parent)} to put it under.`)
    parent = p
  }
  const ref = `N${Object.keys(refs.newCodes).length + 1}`
  refs.newCodes[ref] = name
  const description = typeof input.description === 'string' && input.description.trim() ? input.description.trim() : undefined
  return {
    content: `Proposed as ${ref} (not created until the user approves it). Use ${ref} as the code of proposed codings.`,
    activity: { key: 'ai.activity.proposedCode', vars: { name } },
    proposals: [{ change: { type: 'newCode', ref, name, description, ...parent }, reason: String(input.reason ?? '') }]
  }
}

function proposeCodeChange(input: Input, refs: ChatRefs): ToolOutcome {
  const code = findCode(refs, input.code)
  if (!code) return fail(`No code ${String(input.code)}.`)
  const change: Extract<AiChange, { type: 'editCode' }> = { type: 'editCode', codeGuid: code.guid }
  if (typeof input.name === 'string' && input.name.trim() && input.name.trim() !== code.name) change.name = input.name.trim()
  if (typeof input.description === 'string' && input.description.trim() !== (code.description ?? '').trim()) change.description = input.description.trim()
  if (input.parent !== undefined && input.parent !== null) {
    const p = parentOf(refs, input.parent)
    if (!p) return fail(`No code ${String(input.parent)} to move it under.`)
    if (p !== 'none' && p.parentGuid === code.guid) return fail('A code can\'t go under itself.')
    change.move = p === 'none' ? {} : p
  }
  if (!change.name && change.description === undefined && !change.move) return fail('That changes nothing about the code.')
  return {
    content: 'Proposed; the user will review it.',
    activity: { key: 'ai.activity.proposedChange', vars: { name: code.name } },
    proposals: [{ change, reason: String(input.reason ?? '') }]
  }
}

function proposeCoding(input: Input, refs: ChatRefs): ToolOutcome {
  const source = findDocument(refs, input.document)
  if (!source) return fail(`No document ${String(input.document)}.`)
  const codeRef = norm(input.code)
  const newCode = refs.newCodes[codeRef] !== undefined
  const code = newCode ? null : findCode(refs, codeRef)
  if (!newCode && !code) return fail(`No code ${String(input.code)}: give a C… or N… reference.`)
  let cell: { respondentId: string; questionId: string } | undefined
  if (survey(source)) {
    if (!input.respondent || !input.question) return fail('For a survey, give the respondent and question the quote is in.')
    cell = { respondentId: String(input.respondent), questionId: String(input.question) }
  }
  const text = containerText(source, cell)
  if (!text) return fail(`${source.name} has no text there to code.`)
  const hits = locateQuote(text, String(input.quote ?? ''))
  if (!hits.length) return fail('That quote isn\'t in the document. Copy it exactly from what you read (read_document or search_text).')
  const n = Math.max(1, Math.floor(Number(input.occurrence) || 1))
  if (n > hits.length) return fail(`The quote appears ${hits.length} time(s), not ${n}.`)
  const hit = hits[n - 1]
  const exact = cps(text).slice(hit.start, hit.end).join('')
  const already = !newCode && source.selections.some((s) =>
    s.startPosition === hit.start && s.endPosition === hit.end &&
    (s.surveyCell?.respondentId ?? '') === (cell?.respondentId ?? '') && (s.surveyCell?.questionId ?? '') === (cell?.questionId ?? '') &&
    s.codings.some((c) => c.codeGuid === code!.guid))
  if (already) return fail('That passage already has that code.')
  const note = hits.length > 1 && !input.occurrence ? ` (The quote appears ${hits.length} times; this is the first. Give "occurrence" for another.)` : ''
  return {
    content: `Proposed; the user will review it.${note}`,
    activity: { key: 'ai.activity.proposedCoding', vars: { code: newCode ? refs.newCodes[codeRef] : code!.name, name: source.name } },
    proposals: [{
      change: { type: 'addCoding', sourceGuid: source.guid, start: hit.start, end: hit.end, surveyCell: cell, ...(newCode ? { codeRef } : { codeGuid: code!.guid }), text: exact },
      reason: String(input.reason ?? '')
    }]
  }
}

function proposeRemoveCoding(input: Input, refs: ChatRefs): ToolOutcome {
  const p = refs.passages[norm(input.passage)]
  if (!p?.codingGuid || !p.selectionGuid || !p.codeGuid) return fail('Give a passage reference from coded_passages.')
  const source = sources().find((s) => s.guid === p.sourceGuid)
  const selection = source?.selections.find((s) => s.guid === p.selectionGuid)
  if (!source || !selection?.codings.some((c) => c.guid === p.codingGuid)) return fail('That coding isn\'t in the project any more.')
  const text = cps(textForSelection(source, selection, documentText(source.guid))).slice(selection.startPosition, selection.endPosition).join('')
  const code = useCodeStore.getState().findCode(p.codeGuid)
  return {
    content: 'Proposed; the user will review it.',
    activity: { key: 'ai.activity.proposedRemoval', vars: { code: code?.name ?? '', name: source.name } },
    proposals: [{ change: { type: 'removeCoding', sourceGuid: source.guid, selectionGuid: selection.guid, codingGuid: p.codingGuid, codeGuid: p.codeGuid, text }, reason: String(input.reason ?? '') }]
  }
}
