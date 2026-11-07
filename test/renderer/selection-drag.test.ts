import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type React from 'react'
import {
  SELECTION_DRAG_MIME,
  isSelectionDrag,
  onSelectionDrop,
  requestSelectionDrop,
  startSelectionDrag
} from '../../src/renderer/utils/selection-drag'

/** A drag event with a working dataTransfer. */
function dragEvent(): React.DragEvent {
  const data = new Map<string, string>()
  return {
    dataTransfer: {
      effectAllowed: 'all',
      get types() { return [...data.keys()] },
      setData: (type: string, value: string) => { data.set(type, value) },
      getData: (type: string) => data.get(type) ?? ''
    }
  } as unknown as React.DragEvent
}

beforeEach(() => {
  // The tests run in Node: give them a window to send events on.
  vi.stubGlobal('window', new EventTarget())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('selection drags', () => {
  it('carries the document and the selected text, as a copy', () => {
    const e = dragEvent()
    startSelectionDrag(e, 'doc-1', 'some words')
    expect(isSelectionDrag(e)).toBe(true)
    expect(e.dataTransfer.getData(SELECTION_DRAG_MIME)).toBe('doc-1')
    expect(e.dataTransfer.getData('text/plain')).toBe('some words')
    expect(e.dataTransfer.effectAllowed).toBe('copy')
  })

  it('is not a selection drag without the handle', () => {
    expect(isSelectionDrag(dragEvent())).toBe(false)
  })

  it('codes the selection in the document it was dragged from, and no other', () => {
    const fromDoc1: string[] = []
    const fromDoc2: string[] = []
    const stop1 = onSelectionDrop('doc-1', { code: (g) => fromDoc1.push(g), quote: () => fromDoc1.push('quote') })
    const stop2 = onSelectionDrop('doc-2', { code: (g) => fromDoc2.push(g), quote: () => fromDoc2.push('quote') })

    const e = dragEvent()
    startSelectionDrag(e, 'doc-1', 'some words')
    requestSelectionDrop(e, { kind: 'code', codeGuids: ['code-a', 'code-b'] })

    expect(fromDoc1).toEqual(['code-a', 'code-b'])
    expect(fromDoc2).toEqual([])
    stop1()
    stop2()
  })

  it('quotes the selection once, in the document it was dragged from', () => {
    const fromDoc1: string[] = []
    const fromDoc2: string[] = []
    const stop1 = onSelectionDrop('doc-1', { code: (g) => fromDoc1.push(g), quote: () => fromDoc1.push('quote') })
    const stop2 = onSelectionDrop('doc-2', { code: (g) => fromDoc2.push(g), quote: () => fromDoc2.push('quote') })

    const e = dragEvent()
    startSelectionDrag(e, 'doc-1', 'some words')
    requestSelectionDrop(e, { kind: 'quote' })

    expect(fromDoc1).toEqual(['quote'])
    expect(fromDoc2).toEqual([])
    stop1()
    stop2()
  })

  it('stops handling drops once the viewer stops listening', () => {
    const applied: string[] = []
    const stop = onSelectionDrop('doc-1', { code: (g) => applied.push(g), quote: () => applied.push('quote') })
    stop()

    const e = dragEvent()
    startSelectionDrag(e, 'doc-1', 'some words')
    requestSelectionDrop(e, { kind: 'code', codeGuids: ['code-a'] })
    requestSelectionDrop(e, { kind: 'quote' })
    expect(applied).toEqual([])
  })

  it('does nothing for a drop that is not a selection drag', () => {
    const applied: string[] = []
    const stop = onSelectionDrop('doc-1', { code: (g) => applied.push(g), quote: () => applied.push('quote') })
    requestSelectionDrop(dragEvent(), { kind: 'code', codeGuids: ['code-a'] })
    requestSelectionDrop(dragEvent(), { kind: 'quote' })
    expect(applied).toEqual([])
    stop()
  })
})
