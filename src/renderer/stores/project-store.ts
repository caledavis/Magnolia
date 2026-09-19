import { create } from 'zustand'
import type { User, SavedAnalysis, CheckoutMarker } from '../models/types'
import { generateGuid } from '../utils/guid'
import { makeHmrSafe } from './hmr-preserve'

/** Strip directory and .qdpx extension from a file path. */
function deriveNameFromPath(filePath: string): string {
  const base = filePath.split(/[/\\]/).pop() ?? filePath
  return base.replace(/\.qdpx$/i, '')
}

interface ProjectState {
  name: string
  origin: string
  /** Free-text project description (markdown). */
  description?: string
  users: User[]
  creatingUserGUID?: string
  creationDateTime?: string
  modifyingUserGUID?: string
  modifiedDateTime?: string
  filePath: string | null
  isDirty: boolean
  savedAnalyses?: SavedAnalysis[]
  /** Check-out lock state read from the currently-open .qdpx, or set
   *  locally after a check-out/check-in action. Lives outside the
   *  persisted Project fields — set separately by the loader, mirroring
   *  how missingBinaries is handled. */
  checkoutMarker: CheckoutMarker | null

  createNewProject: () => void
  loadProject: (data: {
    name: string
    origin: string
    description?: string
    users: User[]
    creatingUserGUID?: string
    creationDateTime?: string
    modifyingUserGUID?: string
    modifiedDateTime?: string
    filePath?: string
    savedAnalyses?: SavedAnalysis[]
  }) => void
  setFilePath: (path: string) => void
  markDirty: () => void
  markClean: () => void
  setName: (name: string) => void
  setDescription: (description: string) => void
  setSavedAnalyses: (analyses: SavedAnalysis[]) => void
  setCheckoutMarker: (marker: CheckoutMarker | null) => void
  /** Bulk-replace the users list — additive-only in practice (there's no
   *  per-field user editor), added for the merge feature to bring in
   *  users from a second project. */
  setUsers: (users: User[]) => void
}

const defaultUserGuid = generateGuid()

export const useProjectStore = create<ProjectState>((set) => ({
  name: 'Untitled Project',
  origin: `Magnolia ${__APP_VERSION__}`,
  description: undefined,
  users: [{ guid: defaultUserGuid, name: 'User' }],
  creatingUserGUID: defaultUserGuid,
  creationDateTime: new Date().toISOString(),
  filePath: null,
  isDirty: false,
  savedAnalyses: [],
  checkoutMarker: null,

  createNewProject: () => {
    const userGuid = generateGuid()
    set({
      name: 'Untitled Project',
      origin: `Magnolia ${__APP_VERSION__}`,
      description: undefined,
      users: [{ guid: userGuid, name: 'User' }],
      creatingUserGUID: userGuid,
      creationDateTime: new Date().toISOString(),
      modifyingUserGUID: undefined,
      modifiedDateTime: undefined,
      filePath: null,
      isDirty: false,
      savedAnalyses: [],
      checkoutMarker: null
    })
  },

  loadProject: (data) =>
    set({
      name: data.name && data.name.trim() ? data.name : (data.filePath ? deriveNameFromPath(data.filePath) : 'Untitled Project'),
      origin: data.origin,
      description: data.description,
      users: data.users,
      creatingUserGUID: data.creatingUserGUID,
      creationDateTime: data.creationDateTime,
      modifyingUserGUID: data.modifyingUserGUID,
      modifiedDateTime: data.modifiedDateTime,
      filePath: data.filePath ?? null,
      isDirty: false,
      savedAnalyses: data.savedAnalyses ?? []
    }),

  setFilePath: (path) =>
    set((state) => ({
      filePath: path,
      name: !state.name || state.name === 'Untitled Project' ? deriveNameFromPath(path) : state.name
    })),
  markDirty: () => set({ isDirty: true }),
  markClean: () => set({ isDirty: false }),
  setName: (name) => set({ name, isDirty: true }),
  setDescription: (description) => set({ description, isDirty: true }),
  setSavedAnalyses: (analyses) => set({ savedAnalyses: analyses, isDirty: true }),
  setCheckoutMarker: (marker) => set({ checkoutMarker: marker }),
  setUsers: (users) => set({ users, isDirty: true })
}))

makeHmrSafe('projectStore', useProjectStore)
