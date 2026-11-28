import { describe, it, expect, beforeEach, vi } from 'vitest'
import { saveMemoFromWindow } from '../../src/renderer/app/window-messages'
import { fromOpenProject } from '../../src/renderer/app/window-project'
import { useMemoStore } from '../../src/renderer/stores/memo-store'
import { useProjectStore } from '../../src/renderer/stores/project-store'
import type { Memo } from '../../src/renderer/models/types'

// What the main window does with a memo edit window's Save, and with any
// message from a window left open from a project that's no longer open.

const showMessage = vi.fn()
vi.stubGlobal('window', { api: { showMessage } })

const memo = (extra: Partial<Memo> = {}): Memo =>
  ({ guid: 'm1', type: 'document', title: 'Old', content: 'old', createdDateTime: '2026-01-01', sourceGuid: 's1', startPosition: 10, endPosition: 20, ...extra }) as Memo

const load = (filePath: string) =>
  useProjectStore.getState().loadProject({ name: 'P', origin: 'x', users: [], filePath })

beforeEach(() => {
  showMessage.mockClear()
  load('/projects/a.qdpx')
  useMemoStore.setState({ memos: [] })
})

describe("a memo window's Save", () => {
  it('takes only the title and text, keeping where the memo is now anchored', () => {
    // The window opened when the memo was at 10–20; an edit to the
    // transcript has since moved it to 15–25.
    useMemoStore.setState({ memos: [memo({ startPosition: 15, endPosition: 25 })] })
    saveMemoFromWindow({ ...memo(), title: 'New', content: 'new' }, { projectPath: '/projects/a.qdpx' })
    const saved = useMemoStore.getState().memos[0]
    expect([saved.title, saved.content, saved.startPosition, saved.endPosition]).toEqual(['New', 'new', 15, 25])
  })

  it("adds a new memo without the window's markers", () => {
    saveMemoFromWindow({ ...memo(), _isNew: true, projectPath: '/projects/a.qdpx' } as Memo, { projectPath: '/projects/a.qdpx' })
    const saved = useMemoStore.getState().memos[0] as Memo & { projectPath?: string; _isNew?: boolean }
    expect(saved.guid).toBe('m1')
    expect('projectPath' in saved).toBe(false)
    expect('_isNew' in saved).toBe(false)
  })

  it("doesn't add a memo from a project that's no longer open, and says why", () => {
    load('/projects/b.qdpx')
    expect(saveMemoFromWindow({ ...memo(), _isNew: true }, { projectPath: '/projects/a.qdpx' })).toBe(false)
    expect(useMemoStore.getState().memos).toEqual([])
    expect(showMessage).toHaveBeenCalledTimes(1)
  })
})

describe('fromOpenProject', () => {
  it("accepts the open project's file, and its file before a Save As", () => {
    useProjectStore.getState().setFilePath('/projects/a copy.qdpx')
    expect(fromOpenProject({ projectPath: '/projects/a.qdpx' })).toBe(true)
    expect(fromOpenProject({ projectPath: '/projects/a copy.qdpx' })).toBe(true)
  })

  it('takes a message that names no project as for the open one', () => {
    load('/projects/b.qdpx')
    expect(fromOpenProject({})).toBe(true)
  })

  it('refuses another project, telling the person once for a burst', () => {
    load('/projects/b.qdpx')
    // Well after the earlier test's notice.
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
    expect(fromOpenProject({ projectPath: '/projects/a.qdpx' })).toBe(false)
    expect(fromOpenProject({ projectPath: '/projects/a.qdpx' })).toBe(false)
    expect(showMessage).toHaveBeenCalledTimes(1)
    later.mockRestore()
  })
})
