/**
 * AI Assistance in a project: whether AI apps on this computer (Claude
 * Desktop and others, through Magnolia's connector, src-tauri/src/mcp.rs)
 * may use it, a record of each app session's requests, and the changes
 * they proposed. Saved in the project, in Magnolia's own magnolia-ai.json
 * (the standard has no place for it).
 *
 * The requests are answered in utils/ai/apps.ts with the tools in
 * utils/ai/tools.ts. A proposal changes nothing until the user approves it
 * in the AI Assistance Viewer (see utils/ai/apply.ts).
 */
import { create } from 'zustand'
import { useProjectStore } from './project-store'
import { makeHmrSafe } from './hmr-preserve'
import type { AiChange, ChatRefs } from '../utils/ai/tools'

/** One request an app made, as listed in the pane. */
export interface SessionItem {
  id: string
  content: string
  isError?: boolean
  activity: { key: string; vars?: Record<string, string | number> }
  proposalIds?: string[]
  at: string
}

/** One app's session with the project (a connection from it). */
export interface AiSession {
  id: string
  /** The app, e.g. "Claude Desktop". */
  app: string
  createdAt: string
  items: SessionItem[]
  /** The references handed out in this session (D3, C5, P12, N1…). */
  refs: ChatRefs
}

export type ProposalStatus = 'pending' | 'approved' | 'denied' | 'failed'

export interface AiProposal {
  id: string
  /** The session that proposed it. */
  chatId: string
  change: AiChange
  reason: string
  status: ProposalStatus
  /** Why it couldn't be applied (the text it was for has changed…). */
  failure?: string
  createdAt: string
  decidedAt?: string
  /** The app that proposed it. */
  model: string
  /** Approved, then taken back by Undo (so Redo approves it again). */
  undone?: boolean
}

/** What's saved with the project. */
export interface ProjectAi {
  /** Whether AI apps on this computer may use it. */
  appsAllowed?: boolean
  sessions: AiSession[]
  proposals: AiProposal[]
  /** New codes approved, by their session's reference: `${sessionId}:${N1}` → guid. */
  createdCodes: Record<string, string>
}

interface AiState extends ProjectAi {
  /** The session shown in the pane. */
  activeSessionId: string | null
  /** An app asked to use the project before it was allowed (its name). */
  appRequest: string | null

  setProjectAi: (data: Partial<ProjectAi> | undefined) => void
  projectAi: () => ProjectAi
  allowApps: (allowed: boolean) => void
  setAppRequest: (name: string | null) => void
  selectSession: (id: string) => void
  setProposals: (update: (p: AiProposal[]) => AiProposal[]) => void
  setCreatedCode: (key: string, guid: string) => void
  clearAll: () => void
}

/** A request's answer kept in the saved record (a document read is long). */
const SAVED_RESULT_CHARS = 2000

const EMPTY: ProjectAi = { appsAllowed: undefined, sessions: [], proposals: [], createdCodes: {} }

export const useAiStore = create<AiState>((set, get) => ({
  ...EMPTY,
  activeSessionId: null,
  appRequest: null,

  setProjectAi: (data) => {
    const sessions = data?.sessions ?? []
    set({
      appsAllowed: data?.appsAllowed,
      sessions,
      proposals: data?.proposals ?? [],
      createdCodes: data?.createdCodes ?? {},
      activeSessionId: sessions[0]?.id ?? null,
      appRequest: null
    })
  },

  projectAi: () => {
    const { appsAllowed, sessions, proposals, createdCodes } = get()
    const trim = (s: AiSession): AiSession => ({
      ...s,
      items: s.items.map((it) => (it.content.length <= SAVED_RESULT_CHARS ? it : { ...it, content: it.content.slice(0, SAVED_RESULT_CHARS) + '\n[…]' }))
    })
    return { appsAllowed, sessions: sessions.map(trim), proposals, createdCodes }
  },

  allowApps: (allowed) => {
    set({ appsAllowed: allowed || undefined, appRequest: null })
    useProjectStore.getState().markDirty()
  },

  setAppRequest: (name) => set({ appRequest: name }),

  selectSession: (id) => set({ activeSessionId: id }),

  setProposals: (update) => {
    set((s) => ({ proposals: update(s.proposals) }))
    useProjectStore.getState().markDirty()
  },

  setCreatedCode: (key, guid) => set((s) => ({ createdCodes: { ...s.createdCodes, [key]: guid } })),

  clearAll: () => set({ ...EMPTY, activeSessionId: null, appRequest: null })
}))

makeHmrSafe('ai', useAiStore)
