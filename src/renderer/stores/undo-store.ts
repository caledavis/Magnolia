import { create } from 'zustand'
import { useDocumentStore } from './document-store'
import { useCodeStore } from './code-store'
import { useTagStore } from './tag-store'
import { useQueryStore } from './query-store'
import { useQuoteStore } from './quote-store'

interface Snapshot {
  document: any
  code: any
  tag: any
  quote: any
  query: any
}

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
      results: qs.results,
      isActive: qs.isActive
    },
    quote: {
      quotes: useQuoteStore.getState().quotes
    }
  }
}

function restoreSnapshot(snapshot: Snapshot): void {
  useDocumentStore.setState(snapshot.document)
  useCodeStore.setState(snapshot.code)
  useTagStore.setState(snapshot.tag)
  useQueryStore.setState(snapshot.query)
  if (snapshot.quote) useQuoteStore.setState(snapshot.quote)
}

export const useUndoStore = create<UndoState>((set, get) => ({
  undoStack: [],
  redoStack: [],
  maxHistory: 50,
  _restoring: false,

  undo: () => {
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

/** The values a snapshot captures, in a fixed order. */
function snapshotValues(s: Snapshot): unknown[] {
  return [
    s.document.sources, s.document.sourceContents, s.document.folders, s.document.sourceFolder,
    s.code.codes,
    s.tag.tags, s.tag.categories,
    s.query.savedQueries, s.query.currentQuery, s.query.results, s.query.isActive,
    s.quote.quotes
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
  debounceTimer = setTimeout(() => {
    if (pendingPreviousSnapshot) {
      const s = useUndoStore.getState()
      useUndoStore.setState({
        undoStack: [...s.undoStack.slice(-(s.maxHistory - 1)), pendingPreviousSnapshot],
        redoStack: []
      })
      pendingPreviousSnapshot = null
    }
  }, 500)
}

useDocumentStore.subscribe(onStoreChange)
useCodeStore.subscribe(onStoreChange)
useTagStore.subscribe(onStoreChange)
useQueryStore.subscribe(onStoreChange)
useQuoteStore.subscribe(onStoreChange)
