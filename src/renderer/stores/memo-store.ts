import { create } from 'zustand'
import type { Memo, MemoType } from '../models/types'
import { generateGuid } from '../utils/guid'
import { useProjectStore } from './project-store'
import { makeHmrSafe } from './hmr-preserve'
import { adjustRange, adjustOffset, type TextEdit } from '../utils/text-edit-offsets'
import { noteBulkReset } from './empty-save-guard'

interface MemoState {
  memos: Memo[]

  setMemos: (memos: Memo[]) => void
  addMemo: (type: MemoType, title: string, opts?: Partial<Memo>) => string
  /** Insert a fully-formed memo (from a draft that was built but not yet persisted) */
  addMemoFromDraft: (memo: Memo) => void
  updateMemo: (memo: Memo) => void
  removeMemo: (guid: string) => void
  findMemo: (guid: string) => Memo | undefined
  getMemosForSource: (sourceGuid: string) => Memo[]
  getContentMemosForSource: (sourceGuid: string) => Memo[]
  /** Re-anchor a source's content memos after an in-place transcript edit. */
  adjustContentMemosForEdit: (sourceGuid: string, edit: TextEdit) => void
  changeMemoType: (guid: string, newType: MemoType, opts?: Partial<Memo>) => void
  clearAll: () => void
}

export const useMemoStore = create<MemoState>((set, get) => ({
  memos: [],

  setMemos: (memos) => set({ memos }),

  addMemo: (type, title, opts) => {
    const guid = generateGuid()
    const now = new Date().toISOString()
    const memo: Memo = {
      guid,
      type,
      title,
      content: '',
      createdDateTime: now,
      ...opts
    }
    set((state) => ({ memos: [...state.memos, memo] }))
    useProjectStore.getState().markDirty()
    return guid
  },

  addMemoFromDraft: (memo) => {
    set((state) => ({ memos: [...state.memos, memo] }))
    useProjectStore.getState().markDirty()
  },

  updateMemo: (memo) => {
    set((state) => ({
      memos: state.memos.map((m) =>
        m.guid === memo.guid ? { ...memo, modifiedDateTime: new Date().toISOString() } : m
      )
    }))
    useProjectStore.getState().markDirty()
  },

  removeMemo: (guid) => {
    set((state) => ({ memos: state.memos.filter((m) => m.guid !== guid) }))
    // Strip the memo from any relationship map that references it so
    // canvas memo boxes and attached-memo badges disappear with the
    // memo. The lazy require avoids a circular import with the map
    // store (which doesn't touch the memo store today but might).
    import('./relationship-map-store').then(({ useRelationshipMapStore }) => {
      useRelationshipMapStore.getState().detachMemo(guid)
    }).catch(() => { /* ignore — tests or ssr may not have this */ })
    useProjectStore.getState().markDirty()
  },

  findMemo: (guid) => get().memos.find((m) => m.guid === guid),

  getMemosForSource: (sourceGuid) =>
    get().memos.filter(
      (m) =>
        (m.type === 'document' && m.sourceGuids?.includes(sourceGuid)) ||
        (m.type === 'content' && m.sourceGuid === sourceGuid)
    ),

  getContentMemosForSource: (sourceGuid) =>
    get().memos.filter((m) => m.type === 'content' && m.sourceGuid === sourceGuid),

  /** Shift this source's content memos for an in-place transcript edit so they
   *  keep pointing at the same passage. PDF-region memos are anchored to a
   *  rectangle and left alone. A memo whose passage was wholly deleted is kept
   *  (it may hold the user's notes) and collapsed to an anchor at the edit
   *  point rather than discarded. */
  adjustContentMemosForEdit: (sourceGuid, edit) => {
    let changed = false
    const memos = get().memos.map((m) => {
      if (m.type !== 'content' || m.sourceGuid !== sourceGuid || m.pdfRegion) return m
      if (m.startPosition === undefined || m.endPosition === undefined) return m
      const next = adjustRange(m.startPosition, m.endPosition, edit)
      const start = next ? next.start : adjustOffset(m.startPosition, edit, 'start')
      const end = next ? next.end : start
      if (start === m.startPosition && end === m.endPosition) return m
      changed = true
      return { ...m, startPosition: start, endPosition: end }
    })
    if (changed) {
      set({ memos })
      useProjectStore.getState().markDirty()
    }
  },

  changeMemoType: (guid, newType, opts) => {
    set((state) => ({
      memos: state.memos.map((m) => {
        if (m.guid !== guid) return m
        const updated: Memo = {
          ...m,
          type: newType,
          modifiedDateTime: new Date().toISOString(),
          ...opts
        }
        // Clear type-specific fields when changing type
        if (newType === 'project') {
          delete updated.sourceGuids
          delete updated.sourceGuid
          delete updated.startPosition
          delete updated.endPosition
          delete updated.analysisGuid
        }
        return updated
      })
    }))
    useProjectStore.getState().markDirty()
  },

  clearAll: () => {
    noteBulkReset()
    set({ memos: [] })
  }
}))

makeHmrSafe('memoStore', useMemoStore)
