/**
 * AI Assistance in a project: whether AI apps on this computer (Claude
 * Desktop and others, through Magnolia's connector, src-tauri/src/mcp.rs)
 * may use it, the references the apps are given, and the changes they
 * proposed. Saved in the project, in Magnolia's own magnolia-ai.json
 * (the standard has no place for it).
 *
 * The requests are answered in utils/ai/apps.ts with the tools in
 * utils/ai/tools.ts. A proposal changes nothing until the user approves it
 * in the AI Assistance Viewer (see utils/ai/apply.ts).
 */
import { create } from 'zustand'
import { useProjectStore } from './project-store'
import { makeHmrSafe } from './hmr-preserve'
import { emptyRefs, type AiChange, type ChatRefs } from '../utils/ai/tools'

/** One app's session with the project (a connection from it). */
export interface AiSession {
  id: string
  /** The app, e.g. "Claude Desktop". */
  app: string
  createdAt: string
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
  /** The references handed out (D3, C5, P12, N1…): the project's, not a
   *  session's, so they mean the same thing however many connections an
   *  app makes (Claude Desktop starts the connector more than once). */
  refs: ChatRefs
  proposals: AiProposal[]
  /** New codes approved, by their reference (N1…) → guid. */
  createdCodes: Record<string, string>
}

interface AiState extends ProjectAi {
  /** An app asked to use the project before it was allowed (its name). */
  appRequest: string | null

  setProjectAi: (data: Partial<ProjectAi> | undefined) => void
  projectAi: () => ProjectAi
  allowApps: (allowed: boolean) => void
  setAppRequest: (name: string | null) => void
  setProposals: (update: (p: AiProposal[]) => AiProposal[]) => void
  setCreatedCode: (key: string, guid: string) => void
  clearAll: () => void
}

const EMPTY: ProjectAi = { appsAllowed: undefined, sessions: [], refs: emptyRefs(), proposals: [], createdCodes: {} }

/** Passages kept in the saved references (the newest): a long-used
 *  project would otherwise collect every search result ever given. */
const KEPT_PASSAGES = 2000

export const useAiStore = create<AiState>((set, get) => ({
  ...EMPTY,
  appRequest: null,

  setProjectAi: (data) => {
    const sessions = data?.sessions ?? []
    set({
      appsAllowed: data?.appsAllowed,
      sessions,
      refs: data?.refs ?? emptyRefs(),
      proposals: data?.proposals ?? [],
      createdCodes: data?.createdCodes ?? {},
      appRequest: null
    })
  },

  projectAi: () => {
    const { appsAllowed, sessions, refs, proposals, createdCodes } = get()
    const passages = Object.entries(refs.passages)
    const kept = passages.length <= KEPT_PASSAGES ? refs : { ...refs, passages: Object.fromEntries(passages.slice(-KEPT_PASSAGES)) }
    return { appsAllowed, sessions, refs: kept, proposals, createdCodes }
  },

  allowApps: (allowed) => {
    set({ appsAllowed: allowed || undefined, appRequest: null })
    useProjectStore.getState().markDirty()
  },

  setAppRequest: (name) => set({ appRequest: name }),

  setProposals: (update) => {
    set((s) => ({ proposals: update(s.proposals) }))
    useProjectStore.getState().markDirty()
  },

  setCreatedCode: (key, guid) => set((s) => ({ createdCodes: { ...s.createdCodes, [key]: guid } })),

  clearAll: () => set({ ...EMPTY, refs: emptyRefs(), appRequest: null })
}))

makeHmrSafe('ai', useAiStore)
