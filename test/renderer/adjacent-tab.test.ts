import { describe, it, expect } from 'vitest'
import { useDocumentStore } from '../../src/renderer/stores/document-store'

describe('showAdjacentTab', () => {
  const show = (tabs: string[], viewed: string | null, step: 1 | -1) => {
    useDocumentStore.setState({ openTabs: tabs, viewedDocumentGuid: viewed })
    useDocumentStore.getState().showAdjacentTab(step)
    return useDocumentStore.getState().viewedDocumentGuid
  }

  it('moves to the next or previous tab, wrapping round', () => {
    expect(show(['a', 'b', 'c'], 'a', 1)).toBe('b')
    expect(show(['a', 'b', 'c'], 'c', 1)).toBe('a')
    expect(show(['a', 'b', 'c'], 'a', -1)).toBe('c')
  })

  it('starts from an end when no tab is shown, and does nothing with none open', () => {
    expect(show(['a', 'b'], null, 1)).toBe('a')
    expect(show(['a', 'b'], null, -1)).toBe('b')
    expect(show([], null, 1)).toBe(null)
  })
})
