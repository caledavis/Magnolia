/**
 * analysis-tabs-store — per-tabId ephemeral state for analysis & query-builder
 * tool tabs that live inside the Document Viewer.
 *
 * One instance per tab id. Holds:
 *   - toolType (so the inline renderer knows which tool to mount)
 *   - savedAnalysisGuid? (set when this tab is backed by a SavedAnalysis;
 *     absent for ad-hoc runs)
 *   - title (the text shown on the tab — "Tool Name (n)" for ad-hoc, the
 *     saved name once saved/loaded)
 *   - config (the most recent serialised tool config; for ad-hoc tabs this
 *     is what gets persisted into magnolia-tabs.json so the tab rehydrates
 *     on next project open)
 *   - poppedOut (true while the tool is open in its own BrowserWindow; the
 *     tab is hidden in that case so we don't double-render)
 *
 * `perToolCounters` records the next ad-hoc number per tool ("Code
 * Frequencies (3)" → counter is 3 after the user opens it). Persisted with
 * the project so re-opening doesn't reset numbering and collide with old
 * tab labels the user remembers.
 *
 * clearAll() runs on every project switch so a tab from project A never
 * survives into project B (mirrors the relationship-map-store fix in
 * commit 6d35b5d).
 */
import { create } from 'zustand'
import { useProjectStore } from './project-store'
import { makeHmrSafe } from './hmr-preserve'

export type ToolKind =
  | 'code-cooccurrences'
  | 'codes-in-documents'
  | 'framework-matrix'
  | 'results-in-documents'
  | 'code-frequencies'
  | 'code-orders'
  | 'word-frequencies'
  | 'reports'
  | 'query-builder'

export interface AnalysisTabInstance {
  toolType: ToolKind
  /** Set when the tab is backed by a SavedAnalysis (instanceId == saved guid). */
  savedAnalysisGuid?: string
  title: string
  /** Last config the tool reported (or seeded from a SavedAnalysis on open).
   *  Persisted so an ad-hoc tab survives project save → reopen. */
  config: any
  /** True while the tool is open in its own popped-out BrowserWindow. */
  poppedOut: boolean
  /** True when the tool has unsaved edits relative to its last save (or
   *  to the empty defaults for never-saved tools). Drives the unsaved-
   *  changes marker on the tab strip and the confirm-on-close dialog.
   *  Transient — never persisted to disk. */
  dirty?: boolean
}

interface AnalysisTabsState {
  instances: Record<string, AnalysisTabInstance>
  /** Ad-hoc counter per tool. Saved analyses don't consume it. */
  perToolCounters: Record<string, number>

  add: (tabId: string, inst: AnalysisTabInstance) => void
  setConfig: (tabId: string, config: any) => void
  setTitle: (tabId: string, title: string) => void
  setSavedGuid: (tabId: string, savedGuid: string | undefined) => void
  setPoppedOut: (tabId: string, poppedOut: boolean) => void
  setDirty: (tabId: string, dirty: boolean) => void
  remove: (tabId: string) => void
  /** Increment and return the next number for `toolType`. */
  nextCounter: (toolType: ToolKind) => number
  /** Bulk-load on project open (does not markDirty). */
  hydrate: (
    instances: Record<string, AnalysisTabInstance>,
    counters: Record<string, number>
  ) => void
  /** Project-switch cleanup. */
  clearAll: () => void
}

export const useAnalysisTabsStore = create<AnalysisTabsState>((set, get) => ({
  instances: {},
  perToolCounters: {},

  add: (tabId, inst) => {
    set((state) => ({ instances: { ...state.instances, [tabId]: inst } }))
    useProjectStore.getState().markDirty()
  },

  setConfig: (tabId, config) => {
    const cur = get().instances[tabId]
    if (!cur) return
    set((state) => ({ instances: { ...state.instances, [tabId]: { ...cur, config } } }))
    useProjectStore.getState().markDirty()
  },

  setTitle: (tabId, title) => {
    const cur = get().instances[tabId]
    if (!cur) return
    set((state) => ({ instances: { ...state.instances, [tabId]: { ...cur, title } } }))
    useProjectStore.getState().markDirty()
  },

  setSavedGuid: (tabId, savedAnalysisGuid) => {
    const cur = get().instances[tabId]
    if (!cur) return
    set((state) => ({
      instances: { ...state.instances, [tabId]: { ...cur, savedAnalysisGuid } }
    }))
    useProjectStore.getState().markDirty()
  },

  setPoppedOut: (tabId, poppedOut) => {
    const cur = get().instances[tabId]
    if (!cur) return
    set((state) => ({
      instances: { ...state.instances, [tabId]: { ...cur, poppedOut } }
    }))
    // poppedOut is transient UI state; don't markDirty.
  },

  setDirty: (tabId, dirty) => {
    const cur = get().instances[tabId]
    if (!cur || cur.dirty === dirty) return
    set((state) => ({
      instances: { ...state.instances, [tabId]: { ...cur, dirty } }
    }))
    // dirty is transient UI state; don't markDirty.
  },

  remove: (tabId) => {
    set((state) => {
      const { [tabId]: _, ...rest } = state.instances
      return { instances: rest }
    })
    useProjectStore.getState().markDirty()
  },

  nextCounter: (toolType) => {
    const cur = get().perToolCounters[toolType] ?? 0
    const next = cur + 1
    set((state) => ({
      perToolCounters: { ...state.perToolCounters, [toolType]: next }
    }))
    useProjectStore.getState().markDirty()
    return next
  },

  hydrate: (instances, counters) => {
    // Tabs saved while Framework Matrix was called Summary Matrix.
    const migrated = Object.fromEntries(Object.entries(instances).map(([id, inst]) =>
      [id, (inst.toolType as string) === 'summary-matrix' ? { ...inst, toolType: 'framework-matrix' as const } : inst]
    ))
    set({ instances: migrated, perToolCounters: { ...counters } })
  },

  clearAll: () => set({ instances: {}, perToolCounters: {} })
}))

makeHmrSafe('analysisTabsStore', useAnalysisTabsStore)
