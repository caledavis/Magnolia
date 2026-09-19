import { create } from 'zustand'
import { diffProjects, type MergeDiff } from '../utils/project-diff'
import { useDocumentStore } from './document-store'
import { useProjectStore } from './project-store'
import { useCodeStore } from './code-store'
import { useTagStore } from './tag-store'
import { useQueryStore } from './query-store'
import { useLogbookStore } from './logbook-store'
import { useMemoStore } from './memo-store'
import { useQuoteStore } from './quote-store'
import type { Project } from '../models/types'

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
  | 'savedQueries' | 'folders' | 'users' | 'savedAnalyses' | 'documentText'

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

  openCompare: (filePath: string) => Promise<void>
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
    folders: new Set(), users: new Set(), savedAnalyses: new Set(), documentText: new Set()
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

  openCompare: async (filePath: string) => {
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
      set({
        comparisonFilePath: filePath,
        comparisonEditedBy: editorInfo?.lastEditedBy ?? null,
        comparisonProject: project,
        diff,
        loading: false,
        approved: emptyApproved(),
        codingsApproved: new Set()
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
    codingsApproved: new Set()
  })
}))
