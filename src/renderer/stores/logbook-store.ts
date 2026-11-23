import { create } from 'zustand'
import type { LogbookEntry } from '../models/types'
import { generateGuid } from '../utils/guid'
import { useProjectStore } from './project-store'
import { noteBulkReset } from './empty-save-guard'

interface LogbookState {
  entries: LogbookEntry[]

  setEntries: (entries: LogbookEntry[]) => void
  addEntry: (title: string, content: string) => string
  updateEntry: (guid: string, title: string, content: string) => void
  removeEntry: (guid: string) => void
  clearAll: () => void
}

export const useLogbookStore = create<LogbookState>((set) => ({
  entries: [],

  setEntries: (entries) => set({ entries }),

  addEntry: (title, content) => {
    const guid = generateGuid()
    const now = new Date().toISOString()
    const entry: LogbookEntry = {
      guid,
      title,
      content,
      createdDateTime: now
    }
    set((state) => ({ entries: [entry, ...state.entries] }))
    useProjectStore.getState().markDirty()
    return guid
  },

  updateEntry: (guid, title, content) => {
    set((state) => ({
      entries: state.entries.map((e) =>
        e.guid === guid
          ? { ...e, title, content, modifiedDateTime: new Date().toISOString() }
          : e
      )
    }))
    useProjectStore.getState().markDirty()
  },

  removeEntry: (guid) => {
    set((state) => ({
      entries: state.entries.filter((e) => e.guid !== guid)
    }))
    useProjectStore.getState().markDirty()
  },

  clearAll: () => {
    noteBulkReset()
    set({ entries: [] })
  }
}))
