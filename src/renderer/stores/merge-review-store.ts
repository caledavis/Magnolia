import { create } from 'zustand'
import { diffProjects, type MergeDiff } from '../utils/project-diff'
import { dedupeIdenticalSources, type ReadMineBinaryFn } from '../utils/project-diff-apply'
import { useDocumentStore } from './document-store'
import { useProjectStore } from './project-store'
import { useCodeStore } from './code-store'
import { useTagStore } from './tag-store'
import { useQueryStore } from './query-store'
import { useLogbookStore } from './logbook-store'
import { useMemoStore } from './memo-store'
import { useQuoteStore } from './quote-store'
import type { Project } from '../models/types'

/** Dispatches to whichever of the app's existing per-type read IPCs
 *  matches a source's sourceType — they're all thin wrappers around the
 *  same active-project handle resolver, so any one works; dispatching
 *  just keeps this self-documenting. Used only to fetch bytes for the
 *  identical-document check below, never to display anything. */
const readMineBinary: ReadMineBinaryFn = async (handle, sourceType) => {
  switch (sourceType) {
    case 'pdf': return window.api.readPdfFile(handle)
    case 'audio': return window.api.readAudioFile(handle)
    case 'image': return window.api.readImageFile(handle)
    case 'video': return window.api.readVideoFile(handle)
    default: return null
  }
}

/** Assembles the currently-open project from every store that owns a
 *  piece of it, for the merge diff — a standalone equivalent of App.tsx's
 *  collectProject(), but without tabState/notes (both explicitly out of
 *  scope for merge: tabState is UI-only, notes is a dead field nothing
 *  populates). Reads via .getState() rather than hooks since this runs
 *  from a store action, not a component render. */
export function collectCurrentProject(): Project {
  const projectStore = useProjectStore.getState()
  const codeStore = useCodeStore.getState()
  const documentStore = useDocumentStore.getState()
  const tagStore = useTagStore.getState()
  const queryStore = useQueryStore.getState()
  const logbookStore = useLogbookStore.getState()
  const memoStore = useMemoStore.getState()
  return {
    name: projectStore.name,
    origin: projectStore.origin,
    description: projectStore.description,
    creatingUserGUID: projectStore.creatingUserGUID,
    creationDateTime: projectStore.creationDateTime,
    modifyingUserGUID: projectStore.modifyingUserGUID,
    modifiedDateTime: projectStore.modifiedDateTime,
    users: projectStore.users,
    codes: codeStore.codes,
    sources: documentStore.sources,
    sets: tagStore.tags,
    notes: [],
    tagCategories: tagStore.categories,
    savedQueries: queryStore.savedQueries,
    logbookEntries: logbookStore.entries,
    memos: memoStore.memos,
    quotes: useQuoteStore.getState().quotes,
    savedAnalyses: projectStore.savedAnalyses,
    folders: documentStore.folders,
    sourceFolder: documentStore.sourceFolder
  }
}

/** Flat categories checked off by item guid. Coding sub-items (which live
 *  nested inside diff.codings[i].onlyMine/onlyTheirs, or as a coarse
 *  per-document choice) are tracked in one combined `codings` set using
 *  prefixed keys, parsed back apart when building the ApplyPlan — see
 *  MergeReviewWindow.tsx's buildApplyPlan(). */
export type FlatCategory =
  | 'codes' | 'tags' | 'tagCategories' | 'memos' | 'quotes' | 'logbookEntries'
  | 'savedQueries' | 'folders' | 'savedAnalyses' | 'documentText' | 'sources'

interface MergeReviewState {
  comparisonFilePath: string | null
  comparisonEditedBy: string | null
  /** Theirs' full project — kept around (not just the diff) so the
   *  codings preview can look up a code that only exists on theirs' side
   *  (an added code the user hasn't approved yet has no entry in the
   *  live codeStore). */
  comparisonProject: Project | null
  diff: MergeDiff | null
  loading: boolean
  error: string | null
  approved: Record<FlatCategory, Set<string>>
  codingsApproved: Set<string>
  /** True when this compare came from Steal Back (App.tsx's
   *  handleStealBack) rather than the ordinary "Compare with a second
   *  file" merge (handleMergeProject). Both diff the same two projects the
   *  same way, but what "mine" MEANS differs: in a steal-back reconcile,
   *  "mine" is this window's own not-yet-saved edits against the SAME
   *  file's latest saved revision, not an independent parallel file — an
   *  "onlyMine" item is uncommitted work-in-progress that belongs in the
   *  outcome by default, not a symmetric "keep or discard?" choice the
   *  way it is in a normal compare. MergeReviewWindow reads this to swap
   *  the "onlyMine" bucket's label/framing accordingly — see
   *  bucketLabel(). */
  reconciling: boolean

  openCompare: (filePath: string, opts?: { reconciling?: boolean }) => Promise<void>
  toggle: (category: FlatCategory, guid: string) => void
  toggleCoding: (key: string) => void
  /** Marks every given guid as approved for one category — used by the
   *  review screen's "Select All" button, scoped to whichever category is
   *  currently active. */
  selectAll: (category: FlatCategory, guids: string[]) => void
  selectAllCodings: (keys: string[]) => void
  reset: () => void
}

function emptyApproved(): Record<FlatCategory, Set<string>> {
  return {
    codes: new Set(), tags: new Set(), tagCategories: new Set(), memos: new Set(),
    quotes: new Set(), logbookEntries: new Set(), savedQueries: new Set(),
    folders: new Set(), savedAnalyses: new Set(), documentText: new Set(),
    sources: new Set()
  }
}

export const useMergeReviewStore = create<MergeReviewState>((set, get) => ({
  comparisonFilePath: null,
  comparisonEditedBy: null,
  comparisonProject: null,
  diff: null,
  loading: false,
  error: null,
  approved: emptyApproved(),
  codingsApproved: new Set(),
  reconciling: false,

  openCompare: async (filePath, opts) => {
    set({ loading: true, error: null })
    try {
      const data = await window.api.readQdpxForCompare(filePath)
      const { sourceContents, filePath: _fp, editorInfo, ...project } = data
      const mine = collectCurrentProject()
      const mineSourceContents = useDocumentStore.getState().sourceContents
      const diff = diffProjects(
        { project: mine, sourceContents: mineSourceContents },
        { project, sourceContents, editedBy: editorInfo?.lastEditedBy }
      )
      // A document independently imported into both projects gets a
      // different guid each time, so diffProjects' guid-keyed bucketing
      // sees it as two unrelated adds (onlyMine AND onlyTheirs) even
      // though it's the same file — drop those pairs before the user
      // ever sees them listed as something to review.
      diff.sources = await dedupeIdenticalSources(
        diff.sources, mineSourceContents, sourceContents, filePath, readMineBinary, window.api.readCompareBinary
      )
      set({
        comparisonFilePath: filePath,
        comparisonEditedBy: editorInfo?.lastEditedBy ?? null,
        comparisonProject: project,
        diff,
        loading: false,
        approved: emptyApproved(),
        codingsApproved: new Set(),
        reconciling: !!opts?.reconciling
      })
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  toggle: (category, guid) => {
    set((s) => {
      const next = new Set(s.approved[category])
      if (next.has(guid)) next.delete(guid)
      else next.add(guid)
      return { approved: { ...s.approved, [category]: next } }
    })
  },

  toggleCoding: (key) => {
    set((s) => {
      const next = new Set(s.codingsApproved)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return { codingsApproved: next }
    })
  },

  selectAll: (category, guids) => {
    set((s) => ({ approved: { ...s.approved, [category]: new Set(guids) } }))
  },

  selectAllCodings: (keys) => {
    set({ codingsApproved: new Set(keys) })
  },

  reset: () => set({
    comparisonFilePath: null,
    comparisonEditedBy: null,
    comparisonProject: null,
    diff: null,
    loading: false,
    error: null,
    approved: emptyApproved(),
    codingsApproved: new Set(),
    reconciling: false
  })
}))
