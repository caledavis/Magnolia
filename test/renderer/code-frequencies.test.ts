import { describe, it, expect } from 'vitest'
import { codeFrequencyInSource } from '../../src/renderer/components/Analysis/analysis-helpers'
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

  it('video with no recorded duration: % of transcript characters', () => {
    const d = data({ guid: 'v', name: 'Clip', sourceType: 'video', duration: 0, lineTimes: LINE_TIMES },
      [sel(10, 19, { timeRange: { startTime: 10, endTime: 20 } })], TRANSCRIPT)
    expect(codeFrequencyInSource(d, 'v', 'x')).toBeCloseTo((9 / 39) * 100)
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
