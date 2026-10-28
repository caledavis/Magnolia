import { describe, it, expect, beforeEach, vi } from 'vitest'

// Whether a document is split, and where its divider sits, is remembered
// with the document's reading position; each half keeps its own position.

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v)
})

async function freshModules() {
  vi.resetModules()
  const split = await import('../../src/renderer/utils/split-view')
  const positions = await import('../../src/renderer/stores/view-position-store')
  const { useProjectStore } = await import('../../src/renderer/stores/project-store')
  useProjectStore.setState({ filePath: '/projects/a.qdpx' })
  return { ...split, ...positions }
}

beforeEach(() => storage.clear())

describe('split view', () => {
  it('remembers the divider across a restart, and forgets it when unsplit', async () => {
    const before = await freshModules()
    expect(before.getSplitRatio('doc')).toBeNull()
    before.setSplitRatio('doc', 0.3)
    before.flushViewPositions()

    const after = await freshModules()
    expect(after.getSplitRatio('doc')).toBe(0.3)
    after.setSplitRatio('doc', null)
    expect(after.getSplitRatio('doc')).toBeNull()
  })

  it('keeps both halves usable', async () => {
    const s = await freshModules()
    s.setSplitRatio('doc', 0.99)
    expect(s.getSplitRatio('doc')).toBe(1 - s.MIN_SPLIT_RATIO)
    s.setSplitRatio('doc', 0)
    expect(s.getSplitRatio('doc')).toBe(s.MIN_SPLIT_RATIO)
  })

  it('remembers each half’s position separately, the top half as before', async () => {
    const s = await freshModules()
    expect(s.paneScrollKey('doc', 'primary')).toBe('doc')
    s.setViewPosition(s.paneScrollKey('doc', 'primary'), 10, 100)
    s.setViewPosition(s.paneScrollKey('doc', 'secondary'), 90, 100)
    expect(s.getViewPosition('doc')).toBe(0.1)
    expect(s.getViewPosition(s.paneScrollKey('doc', 'secondary'))).toBe(0.9)
  })
})
