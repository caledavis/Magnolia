/**
 * An empty project may be saved over its file only when the user emptied
 * it: not after a wholesale reset of the stores that no load, new project
 * or save has since squared with the file.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { emptySaveAllowed, noteBulkReset, noteStateMatchesFile } from '../../src/renderer/stores/empty-save-guard'
import { useDocumentStore } from '../../src/renderer/stores/document-store'
import { useCodeStore } from '../../src/renderer/stores/code-store'
import { useMemoStore } from '../../src/renderer/stores/memo-store'
import { useQuoteStore } from '../../src/renderer/stores/quote-store'
import { useTagStore } from '../../src/renderer/stores/tag-store'
import { useQueryStore } from '../../src/renderer/stores/query-store'
import { useLogbookStore } from '../../src/renderer/stores/logbook-store'

describe('empty-save guard', () => {
  beforeEach(() => noteStateMatchesFile())

  it('allows an empty save after ordinary edits', () => {
    const ds = useDocumentStore.getState()
    const guid = ds.addSource('a.txt', 'text')
    useDocumentStore.getState().removeSource(guid)
    expect(useDocumentStore.getState().sources).toHaveLength(0)
    expect(emptySaveAllowed()).toBe(true)
  })

  it('refuses after any store is reset wholesale, until the state matches the file again', () => {
    for (const reset of [
      () => useDocumentStore.getState().clearAll(),
      () => useCodeStore.getState().clearAll(),
      () => useMemoStore.getState().clearAll(),
      () => useQuoteStore.getState().clearAll(),
      () => useTagStore.getState().clearAll(),
      () => useQueryStore.getState().clearAll(),
      () => useLogbookStore.getState().clearAll(),
      noteBulkReset
    ]) {
      noteStateMatchesFile()
      reset()
      expect(emptySaveAllowed()).toBe(false)
      noteStateMatchesFile()
      expect(emptySaveAllowed()).toBe(true)
    }
  })
})
