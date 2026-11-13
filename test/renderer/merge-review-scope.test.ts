/** Select All in one section of the merge review (Folders, or Notebooks)
 *  leaves what's ticked in the other section alone. */
import { describe, expect, it } from 'vitest'
import { useMergeReviewStore } from '../../src/renderer/stores/merge-review-store'

describe('Select All within a section', () => {
  it('only touches the guids that section shows', () => {
    const store = useMergeReviewStore.getState()
    store.reset()
    store.toggle('folders', 'notebook-1')
    store.selectAll('folders', ['folder-1', 'folder-2'], ['folder-1', 'folder-2', 'folder-3'])
    expect([...useMergeReviewStore.getState().approved.folders].sort()).toEqual(['folder-1', 'folder-2', 'notebook-1'])
    store.selectAll('folders', [], ['folder-1', 'folder-2', 'folder-3'])
    expect([...useMergeReviewStore.getState().approved.folders]).toEqual(['notebook-1'])
  })
})
