// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MemoEditInitData } from '../../src/renderer/models/types'

// The memo edit window keeps the user's unsaved edits when the memo is
// opened again, asks before closing with unsaved changes, and tags what it
// sends the main window with the project it was opened for.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const tauri = vi.hoisted(() => ({
  emitTo: vi.fn((_target: string, _event: string, _payload?: unknown) => Promise.resolve()),
  destroy: vi.fn(() => Promise.resolve()),
  closeHandler: null as null | ((e: { preventDefault: () => void }) => void)
}))
vi.mock('@tauri-apps/api/event', () => ({ emitTo: tauri.emitTo }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    destroy: tauri.destroy,
    onCloseRequested: (h: (e: { preventDefault: () => void }) => void) => {
      tauri.closeHandler = h
      return Promise.resolve(() => { tauri.closeHandler = null })
    }
  })
}))
// Like the real (tiptap) editor, this one takes its value only when made.
vi.mock('../../src/renderer/components/MarkdownEditor', async () => {
  const { createElement: h } = await import('react')
  return {
    MarkdownEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) =>
      h('textarea', { 'data-testid': 'body', defaultValue: value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) })
  }
})

const { MemoEditWindow } = await import('../../src/renderer/components/Memos/MemoEditWindow')

const init = (content: string): MemoEditInitData & { projectPath: string } => ({
  memo: { guid: 'm1', type: 'project', title: 'Notes', content, createdDateTime: '2026-01-01T00:00:00Z' } as MemoEditInitData['memo'],
  theme: 'light',
  projectPath: '/p/one.qdpx'
})

let resend: ((d: MemoEditInitData) => void) | null = null
let root: Root
let host: HTMLDivElement

async function open(content = 'saved body') {
  ;(window as unknown as { api: unknown }).api = {
    platform: 'linux',
    getMemoEditData: () => Promise.resolve(init(content)),
    onMemoEditData: (cb: (d: MemoEditInitData) => void) => { resend = cb; return () => { resend = null } },
    askConfirm: () => Promise.resolve(true)
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(createElement(MemoEditWindow)) })
}

const body = () => host.querySelector<HTMLTextAreaElement>('[data-testid="body"]')!
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label)!
// A button in the "unsaved changes" dialog.
const dialogButton = (label: string) => [...host.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent === label) as HTMLButtonElement

function type(text: string) {
  const ta = body()
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(ta, text)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function requestClose() {
  const e = { prevented: false, preventDefault() { this.prevented = true } }
  act(() => tauri.closeHandler!(e))
  return e.prevented
}

const sent = (event: string) => tauri.emitTo.mock.calls.filter((c) => c[1] === event).map((c) => c[2])

describe('memo edit window', () => {
  beforeEach(() => {
    tauri.emitTo.mockClear()
    tauri.destroy.mockClear()
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('keeps unsaved edits when the memo is opened again, and saves them', async () => {
    await open()
    type('my edits')
    act(() => resend!(init('saved body')))
    expect(body().value).toBe('my edits')
    await act(async () => { button('common.save').click() })
    expect(sent('memo-update')).toEqual([expect.objectContaining({ guid: 'm1', content: 'my edits', projectPath: '/p/one.qdpx' })])
  })

  it('shows a body sent again while there are no unsaved edits', async () => {
    await open()
    act(() => resend!(init('changed elsewhere')))
    expect(body().value).toBe('changed elsewhere')
  })

  it('closes without asking when nothing is unsaved', async () => {
    await open()
    expect(requestClose()).toBe(false)
    expect(host.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('asks before closing with unsaved changes; Cancel keeps it open and tells the main window', async () => {
    await open()
    type('my edits')
    expect(requestClose()).toBe(true)
    expect(host.querySelector('[role="alertdialog"]')).not.toBeNull()
    act(() => dialogButton('common.cancel').click())
    expect(host.querySelector('[role="alertdialog"]')).toBeNull()
    expect(tauri.destroy).not.toHaveBeenCalled()
    expect(tauri.emitTo).toHaveBeenCalledWith('main', 'memo-close-cancelled', { guid: 'm1', projectPath: '/p/one.qdpx' })
  })

  it('Discard closes without saving', async () => {
    await open()
    type('my edits')
    requestClose()
    act(() => dialogButton('common.discard').click())
    expect(tauri.destroy).toHaveBeenCalled()
    expect(sent('memo-update')).toEqual([])
  })

  it('Save saves, then closes', async () => {
    await open()
    type('my edits')
    requestClose()
    await act(async () => { dialogButton('common.save').click() })
    expect(sent('memo-update')).toEqual([expect.objectContaining({ content: 'my edits' })])
    expect(tauri.destroy).toHaveBeenCalled()
  })

  it('tags a delete with the project', async () => {
    await open()
    await act(async () => { button('common.delete').click() })
    expect(tauri.emitTo).toHaveBeenCalledWith('main', 'memo-delete', { guid: 'm1', projectPath: '/p/one.qdpx' })
    expect(tauri.destroy).toHaveBeenCalled()
  })
})
