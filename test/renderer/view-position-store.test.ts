import { describe, it, expect, beforeEach, vi } from 'vitest'

// Reading positions persist per project in web storage. Each test loads a
// fresh copy of the store module so its in-memory cache starts empty and
// positions have to come back from storage, as after a restart.

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v)
})

async function freshStores() {
  vi.resetModules()
  const positions = await import('../../src/renderer/stores/view-position-store')
  const { useProjectStore } = await import('../../src/renderer/stores/project-store')
  const open = (filePath: string | null) => useProjectStore.setState({ filePath })
  return { ...positions, open }
}

beforeEach(() => storage.clear())

describe('view positions', () => {
  it('survive a restart as a fraction of the scroll height', async () => {
    const before = await freshStores()
    before.open('/projects/a.qdpx')
    before.setViewPosition('doc', 1500, 6000)
    before.flushViewPositions()

    const after = await freshStores()
    after.open('/projects/a.qdpx')
    expect(after.getViewPosition('doc')).toBe(0.25)
  })

  it('keep string settings apart from positions', async () => {
    const s = await freshStores()
    s.open('/projects/a.qdpx')
    s.setViewSetting('survey|view', '{"mode":"respondent","childId":"7"}')
    s.setViewPosition('survey|respondent|7', 40, 100)
    s.flushViewPositions()

    const after = await freshStores()
    after.open('/projects/a.qdpx')
    expect(after.getViewSetting('survey|view')).toBe('{"mode":"respondent","childId":"7"}')
    expect(after.getViewPosition('survey|view')).toBeUndefined()
    expect(after.getViewSetting('survey|respondent|7')).toBeUndefined()
    expect(after.getViewPosition('survey|respondent|7')).toBe(0.4)
  })

  it('are kept separately for each project', async () => {
    const s = await freshStores()
    s.open('/projects/a.qdpx')
    s.setViewPosition('doc', 50, 100)
    s.open('/projects/b.qdpx')
    expect(s.getViewPosition('doc')).toBeUndefined()
    s.setViewPosition('doc', 10, 100)
    s.flushViewPositions()

    const after = await freshStores()
    after.open('/projects/a.qdpx')
    expect(after.getViewPosition('doc')).toBe(0.5)
    after.open('/projects/b.qdpx')
    expect(after.getViewPosition('doc')).toBe(0.1)
  })

  it('are written after a short delay without an explicit flush', async () => {
    vi.useFakeTimers()
    try {
      const s = await freshStores()
      s.open('/projects/a.qdpx')
      s.setViewPosition('doc', 30, 100)
      expect(storage.size).toBe(0)
      vi.advanceTimersByTime(1000)
      expect(JSON.parse(storage.get('magnolia.viewPositions:/projects/a.qdpx')!)).toEqual({ doc: 0.3 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('are not written for a project without a file, and ignore empty documents', async () => {
    const s = await freshStores()
    s.open(null)
    s.setViewPosition('doc', 20, 100)
    s.setViewPosition('empty', 0, 0)
    s.flushViewPositions()
    expect(storage.size).toBe(0)
    expect(s.getViewPosition('doc')).toBe(0.2)
    expect(s.getViewPosition('empty')).toBeUndefined()
  })

  it('start fresh when storage holds something unreadable', async () => {
    storage.set('magnolia.viewPositions:/projects/a.qdpx', 'not json')
    const s = await freshStores()
    s.open('/projects/a.qdpx')
    expect(s.getViewPosition('doc')).toBeUndefined()
  })
})
