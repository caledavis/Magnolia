import { create } from 'zustand'
import type { User, SavedAnalysis, CheckoutMarker } from '../models/types'
import { generateGuid } from '../utils/guid'
import { makeHmrSafe } from './hmr-preserve'
import { usePreferencesStore } from './preferences-store'

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
  /** Drives CheckoutConflictDialog (App.tsx). Set whenever the user tries
   *  to do something that needs the lock while someone else holds it —
   *  either discovered at open time, lost in an auto-checkout race, or
   *  clicked into from any mutating control app-wide (see
   *  promptCheckoutConflict below). Distinct from checkoutMarker, which
   *  tracks who actually holds the lock right now; this is just "should
   *  the dialog be showing." */
  checkoutConflictMarker: CheckoutMarker | null

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
  /** Open CheckoutConflictDialog. Pass an explicit marker when the caller
   *  already has one at hand (an open-time read, a lost check-out race);
   *  omit it to just use whoever checkoutMarker currently says holds the
   *  lock — the common case for a mutating control's onClick intercepting
   *  its own click. No-ops if nobody currently holds the lock (nothing to
   *  show a conflict about — the marker arg is trusted as of when the
   *  caller read it, but the implicit form always reflects this instant). */
  promptCheckoutConflict: (marker?: CheckoutMarker | null) => void
  dismissCheckoutConflict: () => void
}

const defaultUserGuid = generateGuid()

export const useProjectStore = create<ProjectState>((set, get) => ({
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
  checkoutConflictMarker: null,

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
      checkoutMarker: null,
      checkoutConflictMarker: null
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
  // Enforced lock: while someone else's checkoutMarker is on the project,
  // refuse to flip dirty at all — every store's mutation methods call this
  // right after mutating their own state, so this is the one funnel point
  // that can stop an edit-while-locked from ever reaching autosave/save.
  // The store the caller mutated still shows the edit in the UI (nothing
  // here un-mutates it), but since isDirty never flips, the autosave
  // effect never fires and a manual Save no-ops on an unchanged project —
  // it just never reaches disk; once the user takes over (or the lock
  // frees up) the next markDirty call succeeds and picks up everything
  // that accumulated in the meantime, so nothing already typed is lost.
  //
  // The primary defense is each panel disabling/intercepting its own
  // mutating controls via useCheckoutLockedBy (reading/browsing stays
  // live either way) — but that only covers controls someone remembered
  // to wire up. Dismissing the conflict dialog (Cancel) only clears
  // checkoutConflictMarker, not checkoutMarker itself, so the lock is
  // still in effect afterward — yet without this, a control that wasn't
  // individually gated (a rich-text editor, an inline rename field, a
  // panel added later) would let the user quietly keep "editing" with no
  // sign anything was wrong. So this is also the universal backstop:
  // ANY blocked mutation re-prompts the same Take Over / Create a Copy /
  // Cancel dialog, regardless of which control triggered it.
  // Reads via get()/set() at the top level rather than set((state) => ...)
  // deliberately: promptCheckoutConflict() below is itself a set() call,
  // and nesting a set() inside another set()'s updater is a real zustand
  // hazard — the outer updater's stale returned snapshot would win the
  // Object.assign merge and silently clobber the inner call's update.
  markDirty: () => {
    const marker = get().checkoutMarker
    if (marker) {
      const myName = usePreferencesStore.getState().userName.trim()
      if (marker.userName !== myName) {
        get().promptCheckoutConflict()
        return
      }
    }
    set({ isDirty: true })
  },
  markClean: () => set({ isDirty: false }),
  setName: (name) => set({ name, isDirty: true }),
  setDescription: (description) => set({ description, isDirty: true }),
  setSavedAnalyses: (analyses) => set({ savedAnalyses: analyses, isDirty: true }),
  setCheckoutMarker: (marker) => set({ checkoutMarker: marker }),
  promptCheckoutConflict: (marker) =>
    set((state) => {
      const target = marker !== undefined ? marker : state.checkoutMarker
      return target ? { checkoutConflictMarker: target } : state
    }),
  dismissCheckoutConflict: () => set({ checkoutConflictMarker: null })
}))

makeHmrSafe('projectStore', useProjectStore)

/** Name of whoever holds the checkout lock, if it isn't the local user —
 *  null when unlocked or when the local user is the holder. The single
 *  source of truth panel components read to disable their own mutating
 *  controls (add/delete/rename/etc.) while leaving reading/browsing live;
 *  see markDirty's comment above for the data-level backstop this pairs
 *  with. Centralized here so every panel computes the same answer instead
 *  of re-deriving it (and drifting) in each component. */
export function useCheckoutLockedBy(): string | null {
  const marker = useProjectStore((s) => s.checkoutMarker)
  const userName = usePreferencesStore((s) => s.userName)
  if (!marker) return null
  return marker.userName !== userName.trim() ? marker.userName : null
}

/** Standard tooltip/title text for a control disabled by useCheckoutLockedBy. */
export function checkoutLockedTitle(lockedBy: string): string {
  return `${lockedBy} is working on this file — take over or create a copy to edit`
}
