import { create } from 'zustand'
import { useDocumentStore } from './document-store'
import { useCodeStore } from './code-store'
import { useTagStore } from './tag-store'
import { useQueryStore } from './query-store'
import { useQuoteStore } from './quote-store'
import { useAiStore, type AiProposal } from './ai-store'
import { useProjectStore } from './project-store'

type StateOf<S extends { getState: () => unknown }> = ReturnType<S['getState']>

/** What undo puts back: the project's data in each store (not what's on
 *  screen, like which document is being viewed). */
interface Snapshot {
  document: Pick<StateOf<typeof useDocumentStore>, 'sources' | 'sourceContents' | 'folders' | 'sourceFolder'>
  code: Pick<StateOf<typeof useCodeStore>, 'codes'>
  tag: Pick<StateOf<typeof useTagStore>, 'tags' | 'categories'>
  quote: Pick<StateOf<typeof useQuoteStore>, 'quotes'>
  // Not the query's results: they're worked out from the rest, and only
  // arrive a moment after a change, which could make them an Undo step of
  // their own. After an undo or redo the query is run again instead.
  query: Pick<StateOf<typeof useQueryStore>, 'savedQueries' | 'currentQuery' | 'isActive'>
  // AI Assistance's decisions (approving and rejecting), so Undo brings a
  // proposal back to review. Only the decisions: a proposal arriving from
  // an AI app isn't an Undo step (Undo never takes away one not yet seen).
  ai: { decisions: string; proposals: AiProposal[]; createdCodes: Record<string, string> }
}

/** What's been decided, as a value that changes only when a decision does. */
const decisionsOf = (() => {
  const cache = new WeakMap<AiProposal[], string>()
  return (proposals: AiProposal[]): string => {
    let d = cache.get(proposals)
    if (d === undefined) {
      d = proposals.filter((p) => p.status !== 'pending').map((p) => `${p.id}:${p.status}`).join('|')
      cache.set(proposals, d)
    }
    return d
  }
})()

interface UndoState {
  undoStack: Snapshot[]
  redoStack: Snapshot[]
  maxHistory: number
  _restoring: boolean
  undo: () => void
  redo: () => void
  canUndo: () => boolean
  canRedo: () => boolean
  clearHistory: () => void
}

function takeSnapshot(): Snapshot {
  const ds = useDocumentStore.getState()
  const cs = useCodeStore.getState()
  const ts = useTagStore.getState()
  const qs = useQueryStore.getState()
  return {
    document: {
      sources: ds.sources,
      sourceContents: ds.sourceContents,
      folders: ds.folders,
      sourceFolder: ds.sourceFolder
      // Note: selectedDocumentGuids and viewedDocumentGuid excluded — undo
      // should not change which document the user is looking at.
    },
    code: {
      codes: cs.codes
    },
    tag: {
      tags: ts.tags,
      categories: ts.categories
    },
    query: {
      savedQueries: qs.savedQueries,
      currentQuery: qs.currentQuery,
      isActive: qs.isActive
    },
    quote: {
      quotes: useQuoteStore.getState().quotes
    },
    ai: (() => {
      const ai = useAiStore.getState()
      return { decisions: decisionsOf(ai.proposals), proposals: ai.proposals, createdCodes: ai.createdCodes }
    })()
  }
}

function restoreSnapshot(snapshot: Snapshot): void {
  useDocumentStore.setState(snapshot.document)
  useCodeStore.setState(snapshot.code)
  useTagStore.setState(snapshot.tag)
  useQueryStore.setState(snapshot.query)
  if (snapshot.quote) useQuoteStore.setState(snapshot.quote)
  // The decisions as they were; proposals that have arrived since stay.
  if (snapshot.ai) {
    const was = new Map(snapshot.ai.proposals.map((p) => [p.id, p]))
    const ai = useAiStore.getState()
    useAiStore.setState({
      proposals: ai.proposals.map((p) => {
        const then = was.get(p.id)
        return then ? { ...p, status: then.status, decidedAt: then.decidedAt, failure: then.failure, undone: undefined } : p
      }),
      createdCodes: snapshot.ai.createdCodes
    })
    useProjectStore.getState().markDirty()
  }
  // The query's results, for the project as it now is.
  if (snapshot.query.isActive) useQueryStore.getState().runQuery()
  else useQueryStore.setState({ results: [], isLoading: false })
  for (const fn of restoreListeners) fn()
}

const restoreListeners = new Set<() => void>()
/** Called after each Undo and Redo (e.g. AI Assistance re-checks which of
 *  its approved changes are in the project). */
export function onUndoRestore(fn: () => void): () => void {
  restoreListeners.add(fn)
  return () => { restoreListeners.delete(fn) }
}

export const useUndoStore = create<UndoState>((set, get) => ({
  undoStack: [],
  redoStack: [],
  maxHistory: 50,
  _restoring: false,

  undo: () => {
    flushPendingStep()
    const { undoStack } = get()
    if (undoStack.length === 0) return
    const current = takeSnapshot()
    const prev = undoStack[undoStack.length - 1]
    set({
      undoStack: undoStack.slice(0, -1),
      redoStack: [...get().redoStack, current],
      _restoring: true
    })
    restoreSnapshot(prev)
    // Update the saved "previous" snapshot to the restored state
    lastSnapshot = prev
    set({ _restoring: false })
  },

  redo: () => {
    flushPendingStep()
    const { redoStack } = get()
    if (redoStack.length === 0) return
    const current = takeSnapshot()
    const next = redoStack[redoStack.length - 1]
    set({
      redoStack: redoStack.slice(0, -1),
      undoStack: [...get().undoStack, current],
      _restoring: true
    })
    restoreSnapshot(next)
    lastSnapshot = next
    set({ _restoring: false })
  },

  canUndo: () => get().undoStack.length > 0,
  canRedo: () => get().redoStack.length > 0,

  clearHistory: () => set({ undoStack: [], redoStack: [] })
}))

// Auto-capture: detect store changes and push the *previous* state onto the undo stack.
// A debounce batches rapid sequential changes (e.g. typing a code name) into one undo step.
//
// Snapshots hold references, not copies. Every store updates immutably (a
// changed slice gets a new object; an unchanged one keeps its reference),
// so comparing references detects exactly the slices that changed — and a
// held snapshot can't be altered by later edits. This used to JSON-stringify
// the whole project (all document text included) on EVERY store change,
// costing hundreds of ms per edit on a large project and making anything
// that updates a store per frame — e.g. dragging a Query Builder node —
// stutter.
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let lastSnapshot: Snapshot | null = null
let pendingPreviousSnapshot: Snapshot | null = null

/** Pushes the step still waiting out its debounce, now. Undo and Redo do
 *  this first: otherwise Undo straight after an edit stepped back past it
 *  to the edit before (the edit wasn't a step yet), and when the timer
 *  fired it pushed a stale step and emptied Redo. */
function flushPendingStep(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = null
  if (!pendingPreviousSnapshot) return
  const s = useUndoStore.getState()
  useUndoStore.setState({
    undoStack: [...s.undoStack.slice(-(s.maxHistory - 1)), pendingPreviousSnapshot],
    redoStack: []
  })
  pendingPreviousSnapshot = null
}

/**
 * A project has been opened or created: Undo starts from it. Without this
 * the history began before the project loaded, so enough Undos stepped
 * back past the loading itself, to an empty project (or the one open
 * before), which the next save wrote over the file.
 */
export function startUndoAfresh(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = null
  pendingPreviousSnapshot = null
  lastSnapshot = takeSnapshot()
  useUndoStore.setState({ undoStack: [], redoStack: [] })
}

/** The values a snapshot captures, in a fixed order. */
function snapshotValues(s: Snapshot): unknown[] {
  return [
    s.document.sources, s.document.sourceContents, s.document.folders, s.document.sourceFolder,
    s.code.codes,
    s.tag.tags, s.tag.categories,
    s.query.savedQueries, s.query.currentQuery, s.query.isActive,
    s.quote.quotes,
    s.ai.decisions, s.ai.createdCodes
  ]
}

function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  const av = snapshotValues(a)
  const bv = snapshotValues(b)
  return av.every((v, i) => v === bv[i])
}

function onStoreChange() {
  const store = useUndoStore.getState()
  if (store._restoring) return

  const currentSnap = takeSnapshot()

  if (lastSnapshot === null) {
    // First time: just record the initial state
    lastSnapshot = currentSnap
    return
  }

  // Unrelated state (selection, loading flags, …) changed — nothing to undo.
  if (sameSnapshot(currentSnap, lastSnapshot)) return

  // State changed — save the previous snapshot as the undo point.
  // Use debounce: if changes keep coming within 300ms, keep updating the "current"
  // but only push the "previous" once.
  if (pendingPreviousSnapshot === null) {
    pendingPreviousSnapshot = lastSnapshot
  }
  lastSnapshot = currentSnap

  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(flushPendingStep, 500)
}

useDocumentStore.subscribe(onStoreChange)
useCodeStore.subscribe(onStoreChange)
useTagStore.subscribe(onStoreChange)
useQueryStore.subscribe(onStoreChange)
useQuoteStore.subscribe(onStoreChange)
useAiStore.subscribe(onStoreChange)
