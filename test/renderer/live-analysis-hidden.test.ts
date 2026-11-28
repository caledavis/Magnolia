// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { useLiveAnalysisData, ToolTabShowingContext, type LiveAnalysisData } from '../../src/renderer/components/Analysis/use-live-analysis-data'
import { useDocumentStore } from '../../src/renderer/stores/document-store'
import type { TextSource } from '../../src/renderer/models/types'

// An analysis tool in a hidden tab stays mounted (to keep its state) but
// must not follow every store change: it holds the data it last showed and
// catches up when shown again.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const doc = (guid: string): TextSource =>
  ({ guid, name: guid, sourceType: 'text', selections: [] }) as unknown as TextSource

let renders = 0
let last: LiveAnalysisData | null = null
function Tool() {
  renders++
  last = useLiveAnalysisData()
  return null
}

function mount(showing: boolean) {
  const root = createRoot(document.createElement('div'))
  const render = (s: boolean) => act(() => {
    root.render(createElement(ToolTabShowingContext.Provider, { value: s }, createElement(Tool)))
  })
  render(showing)
  return { show: render, unmount: () => act(() => root.unmount()) }
}

describe('live analysis data in hidden tool tabs', () => {
  beforeEach(() => {
    renders = 0
    last = null
    useDocumentStore.setState({ sources: [doc('a')], sourceContents: { a: 'one' } })
  })

  it('follows the stores while showing', () => {
    const t = mount(true)
    act(() => useDocumentStore.setState({ sources: [doc('a'), doc('b')], sourceContents: { a: 'two' } }))
    expect(last!.sources.map((s) => s.guid)).toEqual(['a', 'b'])
    expect(last!.sourceContents).toEqual({ a: 'two' })
    t.unmount()
  })

  it('holds its data, without re-rendering, while hidden, and catches up when shown', () => {
    const t = mount(true)
    t.show(false)
    const before = renders
    const held = last
    act(() => useDocumentStore.setState({ sources: [doc('a'), doc('b')], sourceContents: { a: 'two' } }))
    expect(renders).toBe(before)
    expect(last).toBe(held)
    t.show(true)
    expect(last!.sources.map((s) => s.guid)).toEqual(['a', 'b'])
    expect(last!.sourceContents).toEqual({ a: 'two' })
    t.unmount()
  })

  it('reads the stores when first mounted hidden', () => {
    const t = mount(false)
    expect(last!.sources.map((s) => s.guid)).toEqual(['a'])
    t.unmount()
  })
})
