import { describe, it, expect, vi } from 'vitest'
import { useMergeReviewStore } from '../../src/renderer/stores/merge-review-store'

// Comparing with one file and then another: whichever is read last, the
// comparison shown is the one asked for last.

const project = (name: string) => ({
  name, origin: 'x', users: [], codes: [], sources: [], sets: [], notes: [], sourceContents: {}, filePath: name
})

describe('openCompare', () => {
  it('keeps the latest comparison when an earlier one finishes after it', async () => {
    const pending = new Map<string, (v: unknown) => void>()
    vi.stubGlobal('window', {
      api: {
        readQdpxForCompare: (filePath: string) => new Promise((resolve) => pending.set(filePath, resolve)),
        readCompareBinary: vi.fn()
      }
    })
    const first = useMergeReviewStore.getState().openCompare('/a.qdpx')
    const second = useMergeReviewStore.getState().openCompare('/b.qdpx')
    pending.get('/b.qdpx')!(project('b'))
    await second
    pending.get('/a.qdpx')!(project('a'))
    await first
    expect(useMergeReviewStore.getState().comparisonFilePath).toBe('/b.qdpx')
    expect(useMergeReviewStore.getState().loading).toBe(false)
    vi.unstubAllGlobals()
  })
})
