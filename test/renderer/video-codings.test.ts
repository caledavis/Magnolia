import { describe, it, expect, beforeEach } from 'vitest'
import { useDocumentStore } from '../../src/renderer/stores/document-store'
import type { TextSource } from '../../src/renderer/models/types'

// A video coding's startPosition / endPosition are code-point offsets into
// its transcript, like every other coding — never line numbers (which a
// save would read as characters, losing the coding's place and time).

// Lines start at 0, 10, 19, 28, 39.
const TEXT = 'line zero\nline one\nline two\nline three\nline four'
const LINE_TIMES = { '0': 0, '1': 10, '2': 20, '3': 30, '4': 40 }
const video = (selections: TextSource['selections'] = []): TextSource => ({
  guid: 'v', name: 'Clip', sourceType: 'video', formatData: { lineTimes: LINE_TIMES }, selections
})
const sel = (guid: string) => useDocumentStore.getState().sources[0].selections.find((s) => s.guid === guid)!

beforeEach(() => {
  useDocumentStore.setState({ sources: [video()], sourceContents: { v: TEXT } })
})

describe('video codings', () => {
  it('a timeline coding anchors to the text of the lines its time covers', () => {
    const g = useDocumentStore.getState().addTimeRangeSelection('v', 12, 37)
    // Lines timed 20 and 30 fall in 12–37: lines 2–3.
    expect([sel(g).startPosition, sel(g).endPosition]).toEqual([19, 38])
    expect(sel(g).timeRange).toEqual({ startTime: 12, endTime: 37 })
  })

  it('a timeline coding with no transcript timing has no text span yet', () => {
    useDocumentStore.setState({ sources: [{ ...video(), formatData: {} }] })
    const g = useDocumentStore.getState().addTimeRangeSelection('v', 12, 37)
    expect([sel(g).startPosition, sel(g).endPosition]).toEqual([0, 0])
  })

  it('new line times move a timeline coding’s text and keep its time', () => {
    const g = useDocumentStore.getState().addTimeRangeSelection('v', 12, 37)
    // Line 1 is now at 15 s, so 12–37 covers lines 1–3.
    useDocumentStore.getState().updateLineTimes('v', { ...LINE_TIMES, '1': 15 })
    expect([sel(g).startPosition, sel(g).endPosition]).toEqual([10, 38])
    expect(sel(g).timeRange).toEqual({ startTime: 12, endTime: 37 })
  })

  it('new line times keep a transcript coding’s text and move its time', () => {
    // Coded on the text: part of line 2, so 20–30 s.
    const g = useDocumentStore.getState().addSelection('v', 21, 25, 'x')
    expect(sel(g).timeRange).toEqual({ startTime: 20, endTime: 30 })
    useDocumentStore.getState().updateLineTimes('v', { ...LINE_TIMES, '2': 22 })
    expect([sel(g).startPosition, sel(g).endPosition]).toEqual([21, 25])
    expect(sel(g).timeRange).toEqual({ startTime: 22, endTime: 30 })
  })
})
