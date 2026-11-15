import { describe, it, expect } from 'vitest'
import { codeFrequencyInSource, sizeEstimated } from '../../src/renderer/components/Analysis/analysis-helpers'
import type { AnalysisInitData, PlainTextSelection } from '../../src/renderer/models/types'

// Code Frequencies: % of a source covered by a code.

const sel = (start: number, end: number, extra: Partial<PlainTextSelection> = {}): PlainTextSelection =>
  ({ guid: `s${start}-${end}`, startPosition: start, endPosition: end, codings: [{ guid: `c${start}`, codeGuid: 'x' }], ...extra }) as PlainTextSelection

function data(source: AnalysisInitData['sources'][number], sels: PlainTextSelection[], content: string, extra: Partial<AnalysisInitData> = {}): AnalysisInitData {
  return { sources: [source], sourceSelections: { [source.guid]: sels }, sourceContents: { [source.guid]: content }, ...extra } as unknown as AnalysisInitData
}

// Four lines of 9 characters + newline; line i starts at 10·i s.
const TRANSCRIPT = ['aaaaaaaaa', 'bbbbbbbbb', 'ccccccccc', 'ddddddddd'].join('\n')
const LINE_TIMES = { '0': 0, '1': 10, '2': 20, '3': 30 }

describe('code frequencies', () => {
  it('audio: a transcript coding counts for the lines it spans, as % of duration', () => {
    // Part of line 1 → 10–20 s of a 40 s recording.
    const d = data({ guid: 'a', name: 'Rec', sourceType: 'audio', duration: 40, lineTimes: LINE_TIMES }, [sel(12, 15)], TRANSCRIPT)
    expect(codeFrequencyInSource(d, 'a', 'x')).toBeCloseTo(25)
  })

  it('audio with no transcript timing: % of transcript characters', () => {
    const d = data({ guid: 'a', name: 'Rec', sourceType: 'audio', duration: 40 }, [sel(0, 13)], TRANSCRIPT)
    expect(codeFrequencyInSource(d, 'a', 'x')).toBeCloseTo((13 / 39) * 100)
  })

  it('video: timeline codings by their own time ranges', () => {
    const d = data({ guid: 'v', name: 'Clip', sourceType: 'video', duration: 40, lineTimes: LINE_TIMES },
      [sel(10, 29, { timeRange: { startTime: 12, endTime: 22 } })], TRANSCRIPT)
    expect(codeFrequencyInSource(d, 'v', 'x')).toBeCloseTo(25)
  })

  it('video with no recorded duration: estimated from the latest moment coded, and noted', () => {
    const d = data({ guid: 'v', name: 'Clip', sourceType: 'video', duration: 0, lineTimes: LINE_TIMES },
      [sel(10, 19, { timeRange: { startTime: 10, endTime: 20 } }), sel(0, 0, { guid: 't', timeRange: { startTime: 30, endTime: 40 } })], TRANSCRIPT)
    // 10–20 s and 30–40 s of an estimated 40 s.
    expect(codeFrequencyInSource(d, 'v', 'x')).toBeCloseTo(50)
    expect(sizeEstimated(d, 'v')).toBe(true)
  })

  it('a transcript coding on the last line runs to the end of the recording', () => {
    // Line 3 starts at 30 s; the recording is 40 s.
    const d = data({ guid: 'a', name: 'Rec', sourceType: 'audio', duration: 40, lineTimes: LINE_TIMES }, [sel(31, 35)], TRANSCRIPT)
    expect(codeFrequencyInSource(d, 'a', 'x')).toBeCloseTo(25)
  })

  it('image: the share of its area inside the code’s boxes, overlaps once', () => {
    const box = (g: string, x: number, y: number, w: number, h: number) =>
      sel(0, 0, { guid: g, pdfRegion: { page: 1, x, y, width: w, height: h } })
    const d = data({ guid: 'i', name: 'Photo', sourceType: 'image' }, [box('b1', 0, 0, 50, 100), box('b2', 25, 0, 50, 100)], '',
      { pageSizes: { i: { p1: { w: 200, h: 100 } } } } as Partial<AnalysisInitData>)
    // 0–75 × 100 of 200 × 100.
    expect(codeFrequencyInSource(d, 'i', 'x')).toBeCloseTo(37.5)
    expect(sizeEstimated(d, 'i')).toBe(false)
  })

  it('image whose size can’t be read: estimated from its boxes, and noted', () => {
    const d = data({ guid: 'i', name: 'Photo', sourceType: 'image' }, [
      sel(0, 0, { guid: 'b1', pdfRegion: { page: 1, x: 0, y: 0, width: 50, height: 100 } }),
      { guid: 'b2', startPosition: 0, endPosition: 0, pdfRegion: { page: 1, x: 50, y: 0, width: 50, height: 100 }, codings: [{ guid: 'o', codeGuid: 'other' }] } as PlainTextSelection
    ], '')
    expect(codeFrequencyInSource(d, 'i', 'x')).toBeCloseTo(50)
    expect(sizeEstimated(d, 'i')).toBe(true)
  })

  it('PDF: boxes by the area of all its pages; text and boxes averaged', () => {
    const sizes = { pageSizes: { p: { p1: { w: 100, h: 100 }, p2: { w: 100, h: 100 } } } } as Partial<AnalysisInitData>
    const box = sel(0, 0, { guid: 'b', pdfRegion: { page: 2, x: 0, y: 0, width: 100, height: 50 } })
    const boxesOnly = data({ guid: 'p', name: 'Paper', sourceType: 'pdf' }, [box], 'x'.repeat(100), sizes)
    // Half of page 2 = a quarter of the PDF's area.
    expect(codeFrequencyInSource(boxesOnly, 'p', 'x')).toBeCloseTo(25)
    const both = data({ guid: 'p', name: 'Paper', sourceType: 'pdf' }, [box, sel(0, 50)], 'x'.repeat(100), sizes)
    // (25% of the area + 50% of the text) ÷ 2.
    expect(codeFrequencyInSource(both, 'p', 'x')).toBeCloseTo(37.5)
  })

  it('never passes 100% for codings past the end', () => {
    const text = data({ guid: 't', name: 'Doc', sourceType: 'text' }, [sel(0, 500)], 'x'.repeat(100))
    expect(codeFrequencyInSource(text, 't', 'x')).toBeCloseTo(100)
    const av = data({ guid: 'a', name: 'Rec', sourceType: 'audio', duration: 40 }, [sel(0, 0, { timeRange: { startTime: 30, endTime: 90 } })], '')
    expect(codeFrequencyInSource(av, 'a', 'x')).toBeCloseTo(25)
  })

  it('survey: a coding past the end of its cell counts only within the cell', () => {
    const cell = { respondentId: 'r1', questionId: 'q1' }
    const d = data({ guid: 's', name: 'Survey', sourceType: 'survey' }, [sel(0, 50, { surveyCell: cell })], '', {
      surveyCodableCells: { s: [{ ...cell, text: 'x'.repeat(10) }, { respondentId: 'r2', questionId: 'q1', text: 'y'.repeat(10) }] }
    } as Partial<AnalysisInitData>)
    expect(codeFrequencyInSource(d, 's', 'x')).toBeCloseTo(50)
  })
})
