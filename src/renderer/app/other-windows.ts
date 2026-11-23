/**
 * What the main window sends the other windows (the Codebook, the Memos
 * window, memo editors), and the checks they share, outside any component.
 */
import type { CodebookInitData } from '../models/types'
import { useProjectStore } from '../stores/project-store'
import { usePreferencesStore } from '../stores/preferences-store'
import { useDocumentStore } from '../stores/document-store'
import { useCodeStore } from '../stores/code-store'
import { useQueryStore } from '../stores/query-store'
import { useMemoStore } from '../stores/memo-store'
import { useRelationshipMapStore } from '../stores/relationship-map-store'
import { memoPlacer, type MemoPlace } from '../utils/memo-places'
import type { Memo, MemoEditInitData, MemosWindowData } from '../models/types'

/** Send the Codebook window the current codes and their coded-segment
 *  counts (counted as the Codes pane counts them), opening it if it
 *  isn't open. `renameGuid` asks it to start renaming that code. */
export function sendCodebookData(renameGuid?: string): void {
  const codeCounts: Record<string, number> = {}
  for (const source of useDocumentStore.getState().sources) {
    for (const sel of source.selections) {
      for (const coding of sel.codings) codeCounts[coding.codeGuid] = (codeCounts[coding.codeGuid] || 0) + 1
    }
  }
  const initData: CodebookInitData = {
    codes: useCodeStore.getState().codes,
    codeCounts,
    renameGuid,
    theme: document.documentElement.getAttribute('data-theme') || ''
  }
  window.api.openCodebookWindow(initData)
}

/** Who has the project checked out, when it isn't this user: the same
 *  test as useCheckoutLockedBy, outside a component. */
export function checkoutLockedByNow(): string | null {
  const marker = useProjectStore.getState().checkoutMarker
  if (!marker) return null
  return marker.userName !== usePreferencesStore.getState().userName.trim() ? marker.userName : null
}

/** What the Memos window shows: every memo, where each is attached, and
 *  whether edits are locked by someone else's checkout. */
export function memosWindowData(): MemosWindowData {
  const memos = useMemoStore.getState().memos
  const place = memoPlacer({
    sources: useDocumentStore.getState().sources,
    contents: useDocumentStore.getState().sourceContents,
    savedQueries: useQueryStore.getState().savedQueries,
    savedAnalyses: useProjectStore.getState().savedAnalyses ?? []
  })
  const places: Record<string, MemoPlace> = {}
  for (const m of memos) places[m.guid] = place(m)
  return { memos, places, lockedBy: checkoutLockedByNow(), theme: document.documentElement.getAttribute('data-theme') || '' }
}

/** Removes a memo, and its boxes on any relationship map. */
export function deleteMemoEverywhere(guid: string): void {
  useMemoStore.getState().removeMemo(guid)
  const rmStore = useRelationshipMapStore.getState()
  for (const m of Object.values(rmStore.maps)) {
    const nextElements = m.elements.filter((el) => !(el.kind === 'memo' && el.entityGuid === guid))
    if (nextElements.length !== m.elements.length) rmStore.setElements(m.guid, nextElements)
  }
}

/** Opens a memo in its own edit window; `isNew` for a draft that is only
 *  created when saved. */
export function openMemoEditor(memo: Memo, isNew = false): void {
  const initData: MemoEditInitData = {
    memo,
    theme: document.documentElement.getAttribute('data-theme') || '',
    ...(isNew ? { isNew: true } : {})
  }
  window.api.openMemoEditWindow(initData)
}

