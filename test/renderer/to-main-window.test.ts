import { describe, it, expect, vi, beforeEach } from 'vitest'

// The Codebook, Logbook and Memos windows tag what they send the main window
// with the project they were opened for, so the main window can drop
// messages meant for a project that's no longer open.

const emitTo = vi.hoisted(() => vi.fn((_target: string, _event: string, _payload?: unknown) => Promise.resolve()))
vi.mock('@tauri-apps/api/event', () => ({ emitTo }))

const { noteWindowProject, sendCodebookUpdate, sendLogbookUpdate, sendMemosWindowAction } = await import('../../src/renderer/components/to-main-window')

describe('messages to the main window', () => {
  beforeEach(() => emitTo.mockClear())

  it('carry the project from the init data', () => {
    noteWindowProject({ theme: 'light', projectPath: '/p/one.qdpx' })
    sendCodebookUpdate('rename-code', 'c1', 'Fees')
    sendLogbookUpdate('remove-entry', 'e1')
    sendMemosWindowAction('delete', ['m1'])
    expect(emitTo.mock.calls).toEqual([
      ['main', 'codebook-update', { action: 'rename-code', args: ['c1', 'Fees'], projectPath: '/p/one.qdpx' }],
      ['main', 'logbook-update', { action: 'remove-entry', args: ['e1'], projectPath: '/p/one.qdpx' }],
      ['main', 'memos-window-action', { action: 'delete', args: [['m1']], projectPath: '/p/one.qdpx' }]
    ])
  })

  it('follow the project when the init data is sent again', () => {
    noteWindowProject({ projectPath: '/p/one.qdpx' })
    noteWindowProject({ projectPath: '/p/two.qdpx' })
    sendLogbookUpdate('remove-entry', 'e1')
    expect(emitTo).toHaveBeenCalledWith('main', 'logbook-update', expect.objectContaining({ projectPath: '/p/two.qdpx' }))
  })
})
