/**
 * AI Assistance in a project: whether it's on (and for which service), the
 * chats, and the changes the AI has proposed. Saved in the project, in
 * Magnolia's own magnolia-ai.json (the standard has no place for it).
 *
 * A chat runs here: each turn goes to the user's AI service through
 * src-tauri/src/ai.rs; the AI's requests to read the project are answered
 * by utils/ai/tools.ts, which is also where its proposals come from. A
 * proposal changes nothing until the user approves it in the AI Assistance
 * Viewer (see utils/ai/apply.ts).
 */
import { create } from 'zustand'
import type { AiEvent, AiMessage, AiToolCall } from '../models/types'
import { generateGuid } from '../utils/guid'
import { useProjectStore } from './project-store'
import { usePreferencesStore } from './preferences-store'
import { makeHmrSafe } from './hmr-preserve'
import { TOOL_SPECS, emptyRefs, runTool, type AiChange, type ChatRefs } from '../utils/ai/tools'
import { systemPrompt } from '../utils/ai/prompt'
import { originOf, providerName } from '../utils/ai/providers'

/** One entry in a chat, as shown and as sent again with the next turn. */
export type ChatItem =
  | { kind: 'user'; id: string; text: string; at: string }
  | { kind: 'assistant'; id: string; text: string; toolCalls?: AiToolCall[]; at: string }
  | { kind: 'tool'; id: string; results: { id: string; content: string; isError?: boolean; activity: { key: string; vars?: Record<string, string | number> }; proposalIds?: string[] }[] }
  | { kind: 'error'; id: string; error: { code: string; detail: string } }

export interface AiChat {
  id: string
  title: string
  createdAt: string
  /** The service and model it was held with, e.g. "Anthropic (Claude) · claude-sonnet-5-5". */
  model: string
  items: ChatItem[]
  refs: ChatRefs
}

export type ProposalStatus = 'pending' | 'approved' | 'denied' | 'failed'

export interface AiProposal {
  id: string
  chatId: string
  change: AiChange
  reason: string
  status: ProposalStatus
  /** Why it couldn't be applied (the text it was for has changed…). */
  failure?: string
  createdAt: string
  decidedAt?: string
  /** The model that proposed it. */
  model: string
  /** What the user had asked. */
  request: string
  /** Approved, then taken back by Undo (so Redo approves it again). */
  undone?: boolean
}

/** What's saved with the project. */
export interface ProjectAi {
  /** The service (its address's origin) the user agreed to send this
   *  project's data to; unset while AI Assistance is off here. */
  enabledFor?: string
  chats: AiChat[]
  proposals: AiProposal[]
  /** New codes approved, by their chat's reference: `${chatId}:${N1}` → guid. */
  createdCodes: Record<string, string>
}

interface AiState extends ProjectAi {
  activeChatId: string | null
  /** The turn under way: its request, and the reply so far. */
  running: { chatId: string; requestId: string; text: string } | null

  setProjectAi: (data: Partial<ProjectAi> | undefined) => void
  projectAi: () => ProjectAi
  enable: (origin: string) => void
  disable: () => void
  newChat: () => void
  selectChat: (id: string) => void
  deleteChat: (id: string) => void
  send: (text: string) => Promise<void>
  stop: () => void
  setProposals: (update: (p: AiProposal[]) => AiProposal[]) => void
  setCreatedCode: (key: string, guid: string) => void
  clearAll: () => void
}

/** Turns in one reply (reading, then answering) before Magnolia stops it. */
const MAX_STEPS = 24
/** A tool's answer kept in the saved chat (a document read can be long). */
const SAVED_RESULT_CHARS = 2000

const EMPTY: ProjectAi = { enabledFor: undefined, chats: [], proposals: [], createdCodes: {} }

// One listener for every turn's events.
const waiting = new Map<string, (e: AiEvent) => void>()
let listening = false
function listen() {
  if (listening || typeof window === 'undefined' || !window.api?.onAiEvent) return
  listening = true
  window.api.onAiEvent((e) => waiting.get(e.requestId)?.(e))
}

/** The chat as the model sees it. */
function toMessages(items: ChatItem[]): AiMessage[] {
  const out: AiMessage[] = []
  for (const it of items) {
    if (it.kind === 'user') out.push({ role: 'user', text: it.text })
    else if (it.kind === 'assistant') out.push({ role: 'assistant', text: it.text, toolCalls: it.toolCalls })
    else if (it.kind === 'tool') out.push({ role: 'tool', results: it.results.map((r) => ({ id: r.id, content: r.content, isError: r.isError })) })
  }
  // A reply cut off before its tools answered (stopped, or failed) would
  // leave calls without results, which providers refuse: drop them.
  for (let i = 0; i < out.length; i++) {
    const m = out[i]
    if (m.role === 'assistant' && m.toolCalls?.length && out[i + 1]?.role !== 'tool') {
      out[i] = { role: 'assistant', text: m.text || '…' }
    }
  }
  return out
}

function chatTitle(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > 60 ? one.slice(0, 57) + '…' : one
}

export const useAiStore = create<AiState>((set, get) => ({
  ...EMPTY,
  activeChatId: null,
  running: null,

  setProjectAi: (data) => {
    get().stop()
    const chats = data?.chats ?? []
    set({
      enabledFor: data?.enabledFor,
      chats,
      proposals: data?.proposals ?? [],
      createdCodes: data?.createdCodes ?? {},
      activeChatId: chats[0]?.id ?? null,
      running: null
    })
  },

  projectAi: () => {
    const { enabledFor, chats, proposals, createdCodes } = get()
    const trim = (c: AiChat): AiChat => ({
      ...c,
      items: c.items.map((it) => it.kind !== 'tool' ? it : {
        ...it,
        results: it.results.map((r) => r.content.length <= SAVED_RESULT_CHARS ? r : { ...r, content: r.content.slice(0, SAVED_RESULT_CHARS) + '\n[… shortened when the project was saved; read it again if needed.]' })
      })
    })
    return { enabledFor, chats: chats.map(trim), proposals, createdCodes }
  },

  enable: (origin) => {
    set({ enabledFor: origin })
    useProjectStore.getState().markDirty()
  },

  disable: () => {
    get().stop()
    set({ enabledFor: undefined })
    useProjectStore.getState().markDirty()
  },

  newChat: () => {
    if (get().running) return
    set({ activeChatId: null })
  },

  selectChat: (id) => {
    if (get().running) return
    set({ activeChatId: id })
  },

  deleteChat: (id) => {
    if (get().running?.chatId === id) get().stop()
    set((s) => ({
      chats: s.chats.filter((c) => c.id !== id),
      // Its undecided proposals go with it; decided ones stay, as a record.
      proposals: s.proposals.filter((p) => p.chatId !== id || p.status !== 'pending'),
      activeChatId: s.activeChatId === id ? null : s.activeChatId
    }))
    useProjectStore.getState().markDirty()
  },

  send: async (text) => {
    const provider = usePreferencesStore.getState().aiProvider
    const state = get()
    if (!provider || state.running || !text.trim()) return
    if (state.enabledFor !== originOf(provider.baseUrl)) return
    listen()
    const model = `${providerName(provider)} · ${provider.model}`
    let chat = state.chats.find((c) => c.id === state.activeChatId)
    if (!chat) {
      chat = { id: generateGuid(), title: chatTitle(text), createdAt: new Date().toISOString(), model, items: [], refs: emptyRefs() }
      set((s) => ({ chats: [chat!, ...s.chats], activeChatId: chat!.id }))
    }
    const chatId = chat.id
    const update = (fn: (c: AiChat) => AiChat) =>
      set((s) => ({ chats: s.chats.map((c) => (c.id === chatId ? fn(c) : c)) }))
    const push = (item: ChatItem) => update((c) => ({ ...c, items: [...c.items, item] }))
    push({ kind: 'user', id: generateGuid(), text: text.trim(), at: new Date().toISOString() })
    useProjectStore.getState().markDirty()

    const call = { kind: provider.kind, baseUrl: provider.baseUrl, model: provider.model }
    for (let step = 0; step < MAX_STEPS; step++) {
      const requestId = generateGuid()
      set({ running: { chatId, requestId, text: '' } })
      const current = get().chats.find((c) => c.id === chatId)
      if (!current) break
      const event = await new Promise<AiEvent>((resolve) => {
        waiting.set(requestId, (e) => {
          if (e.type === 'text') {
            set((s) => (s.running?.requestId === requestId ? { running: { ...s.running, text: s.running.text + e.text } } : {}))
          } else {
            waiting.delete(requestId)
            resolve(e)
          }
        })
        window.api.aiChat(requestId, call, systemPrompt(), toMessages(current.items), TOOL_SPECS).catch((error) => {
          waiting.delete(requestId)
          resolve({ type: 'error', requestId, error: typeof error === 'object' && error && 'code' in error ? error : { code: 'provider', detail: String(error) } })
        })
      })
      // Stopped (or the project changed) meanwhile.
      if (get().running?.requestId !== requestId) return
      if (event.type === 'error') {
        // Whatever had come in stays, then the error.
        const partial = get().running?.text ?? ''
        if (partial) push({ kind: 'assistant', id: generateGuid(), text: partial, at: new Date().toISOString() })
        if (event.error.code !== 'cancelled') push({ kind: 'error', id: generateGuid(), error: event.error })
        break
      }
      if (event.type !== 'done') break
      const { text: reply, toolCalls } = event.message
      push({ kind: 'assistant', id: generateGuid(), text: reply, toolCalls: toolCalls.length ? toolCalls : undefined, at: new Date().toISOString() })
      if (!toolCalls.length) break
      // Its requests: answered from the project; proposals noted.
      const refs = structuredClone(get().chats.find((c) => c.id === chatId)!.refs)
      const results: Extract<ChatItem, { kind: 'tool' }>['results'] = []
      const proposals: AiProposal[] = []
      for (const tc of toolCalls) {
        if (tc.malformed !== undefined) {
          results.push({ id: tc.id, content: 'The request was cut off (its arguments are not complete JSON). Send it again.', isError: true, activity: { key: 'ai.activity.cutOff' } })
          continue
        }
        const outcome = runTool(tc.name, tc.input ?? {}, refs)
        const ids: string[] = []
        for (const p of outcome.proposals ?? []) {
          const id = generateGuid()
          ids.push(id)
          proposals.push({ id, chatId, change: p.change, reason: p.reason, status: 'pending', createdAt: new Date().toISOString(), model, request: text.trim() })
        }
        results.push({ id: tc.id, content: outcome.content, isError: outcome.isError, activity: outcome.activity, proposalIds: ids.length ? ids : undefined })
      }
      update((c) => ({ ...c, refs }))
      if (proposals.length) set((s) => ({ proposals: [...s.proposals, ...proposals] }))
      push({ kind: 'tool', id: generateGuid(), results })
      if (step === MAX_STEPS - 1) push({ kind: 'error', id: generateGuid(), error: { code: 'tooManySteps', detail: '' } })
    }
    set({ running: null })
    useProjectStore.getState().markDirty()
  },

  stop: () => {
    const r = get().running
    if (!r) return
    set({ running: null })
    waiting.delete(r.requestId)
    if (r.text) {
      set((s) => ({ chats: s.chats.map((c) => c.id === r.chatId ? { ...c, items: [...c.items, { kind: 'assistant', id: generateGuid(), text: r.text, at: new Date().toISOString() }] } : c) }))
    }
    void window.api.aiCancel(r.requestId).catch(() => {})
  },

  setProposals: (update) => {
    set((s) => ({ proposals: update(s.proposals) }))
    useProjectStore.getState().markDirty()
  },

  setCreatedCode: (key, guid) => set((s) => ({ createdCodes: { ...s.createdCodes, [key]: guid } })),

  clearAll: () => {
    get().stop()
    set({ ...EMPTY, activeChatId: null, running: null })
  }
}))

makeHmrSafe('ai', useAiStore)
