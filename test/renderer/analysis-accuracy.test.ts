import { describe, it, expect } from 'vitest'
import {
  countCoOccurrences,
  codeRowTotal,
  columnScopedData,
  columnData,
  resultsInColumn,
  resultRowTotal
} from '../../src/renderer/components/Analysis/analysis-helpers'
import { countWords, wordFilter, sourceTexts } from '../../src/renderer/components/Analysis/word-counts'
import { executeQuery } from '../../src/renderer/utils/query-engine'
import type { AnalysisInitData, PlainTextSelection } from '../../src/renderer/models/types'

const coded = (guid: string, code: string, extra: Partial<PlainTextSelection>): PlainTextSelection =>
  ({ guid, startPosition: 0, endPosition: 0, codings: [{ guid: `${guid}-c`, codeGuid: code }], ...extra }) as PlainTextSelection
const box = (guid: string, code: string, page: number, x: number, y = 0) =>
  coded(guid, code, { pdfRegion: { page, x, y, width: 50, height: 50 } })

describe('Code Co-Occurrences', () => {
  const count = (sels: PlainTextSelection[]) =>
    countCoOccurrences({ sourceSelections: { d: sels } } as unknown as AnalysisInitData, ['d'], 'A', 'B')

  it('counts boxes that overlap on the same page, as the overlap query does', () => {
    expect(count([box('1', 'A', 1, 0), box('2', 'B', 1, 25)])).toBe(1)
  })

  it('does not count boxes on different pages, or that only touch', () => {
    expect(count([box('1', 'A', 1, 0), box('2', 'B', 2, 0)])).toBe(0)
    expect(count([box('1', 'A', 1, 0), box('2', 'B', 1, 50)])).toBe(0)
  })

  it('never compares a box with a text selection', () => {
    expect(count([box('1', 'A', 1, 0), coded('2', 'B', { startPosition: 0, endPosition: 10 })])).toBe(0)
  })
})

describe('word counts', () => {
  it('keeps one-character words in scripts written without spaces', () => {
    const zh = countWords(['我们的学生没有钱。'], wordFilter('', ''))
    expect(zh.get('钱')).toBe(1)
    expect(zh.get('学生')).toBe(1)
  })

  it('still leaves out single letters in other scripts', () => {
    const en = countWords(['I have a book'], wordFilter('', ''))
    expect(en.has('a')).toBe(false)
    expect(en.has('i')).toBe(false)
    expect(en.get('book')).toBe(1)
  })
})

// A survey with two respondents; only r1 is tagged "Mature". Plus a
// document tagged both "Mature" and "Online".
function grouped(): AnalysisInitData {
  return {
    sources: [
      { guid: 'doc', name: 'Interview', sourceType: 'text' },
      { guid: 'sv', name: 'Survey', sourceType: 'survey' }
    ],
    sourceContents: { doc: 'some interview text' },
    sourceSelections: {
      doc: [coded('d1', 'A', { startPosition: 0, endPosition: 4 })],
      sv: [
        coded('s1', 'A', { startPosition: 0, endPosition: 3, surveyCell: { respondentId: 'r1', questionId: 'q' } }),
        coded('s2', 'A', { startPosition: 0, endPosition: 3, surveyCell: { respondentId: 'r2', questionId: 'q' } })
      ]
    },
    surveyCodableCells: { sv: [{ respondentId: 'r1', questionId: 'q', text: 'cheap rent' }, { respondentId: 'r2', questionId: 'q', text: 'long commute' }] },
    tagMembers: { mature: ['doc'], online: ['doc'] },
    respondentTagMembers: { mature: [{ sourceGuid: 'sv', id: 'r1' }] },
    questionTagMembers: {}
  } as unknown as AnalysisInitData
}
const matureCol = { id: 'tag:mature', label: 'Mature', sourceGuids: ['doc', 'sv'], tagScopeGuids: ['mature'] }
const onlineCol = { id: 'tag:online', label: 'Online', sourceGuids: ['doc'], tagScopeGuids: ['online'] }

describe('grouped columns', () => {
  it('a row total counts a document in two of the groups once', () => {
    const data = grouped()
    const cols = [matureCol, onlineCol]
    // The interview's one coding is in both columns; the survey adds r1's.
    expect(codeRowTotal(cols, columnScopedData(cols, data), data, 'A')).toBe(2)
  })

  it('a tag column holds only the survey cells the tag covers', () => {
    const data = grouped()
    const results = [
      { sourceGuid: 'doc', startPosition: 0, endPosition: 4 },
      { sourceGuid: 'sv', startPosition: 0, endPosition: 3, surveyCell: { respondentId: 'r1', questionId: 'q' } },
      { sourceGuid: 'sv', startPosition: 0, endPosition: 3, surveyCell: { respondentId: 'r2', questionId: 'q' } }
    ]
    expect(resultsInColumn(results, matureCol, data)).toHaveLength(2)
    expect(resultRowTotal(results, [matureCol, onlineCol], data)).toBe(2)
  })

  it('a tag series counts the words of the survey cells the tag covers', () => {
    const data = grouped()
    const words = countWords(sourceTexts(columnData(matureCol, data), 'sv'), wordFilter('', ''))
    expect(words.get('rent')).toBe(1)
    expect(words.has('commute')).toBe(false)
  })
})

describe('co-occurrence in recordings', () => {
  // Lines start at 0, 10, 19; timed 0 s, 10 s, 20 s; the recording is 30 s.
  const TRANSCRIPT = 'line zero\nline one\nline two'
  const LINE_TIMES = { '0': 0, '1': 10, '2': 20 }
  const onTimeline = (g: string, code: string, from: number, to: number, start = 0, end = 0) =>
    coded(g, code, { startPosition: start, endPosition: end, timeRange: { startTime: from, endTime: to } })
  const onTranscript = (g: string, code: string, start: number, end: number, from: number, to: number) =>
    coded(g, code, { startPosition: start, endPosition: end, timeRange: { startTime: from, endTime: to } })
  const count = (sels: PlainTextSelection[]) => countCoOccurrences({
    sources: [{ guid: 'v', name: 'Clip', sourceType: 'video', duration: 30, lineTimes: LINE_TIMES }],
    sourceContents: { v: TRANSCRIPT },
    sourceSelections: { v: sels }
  } as unknown as AnalysisInitData, ['v'], 'A', 'B')

  it('timeline codings that overlap in time co-occur', () => {
    expect(count([onTimeline('1', 'A', 2, 6), onTimeline('2', 'B', 5, 9)])).toBe(1)
  })

  it('timeline codings in the same line but at different times do not', () => {
    // Both cover line zero's text, but 1–3 s and 6–8 s don't meet.
    expect(count([onTimeline('1', 'A', 1, 3, 0, 10), onTimeline('2', 'B', 6, 8, 0, 10)])).toBe(0)
  })

  it('a timeline coding co-occurs with a transcript coding of the same moment', () => {
    // "line one" on the transcript is 10–20 s.
    expect(count([onTimeline('1', 'A', 12, 14), onTranscript('2', 'B', 10, 18, 10, 20)])).toBe(1)
    expect(count([onTimeline('1', 'A', 22, 24), onTranscript('2', 'B', 10, 18, 10, 20)])).toBe(0)
  })

  it('transcript codings still compare by their characters', () => {
    expect(count([onTranscript('1', 'A', 10, 13, 10, 20), onTranscript('2', 'B', 14, 18, 10, 20)])).toBe(0)
  })

  it('the overlap query finds the same moments', () => {
    const results = executeQuery(
      { documentFilter: {}, codeCondition: { type: 'overlap', condition1: { type: 'code', codeGuid: 'A' }, condition2: { type: 'code', codeGuid: 'B' } } } as never,
      [{ guid: 'v', name: 'Clip', sourceType: 'video', formatData: { duration: 30, lineTimes: LINE_TIMES }, selections: [onTimeline('1', 'A', 12, 22), onTimeline('2', 'B', 15, 25)] }] as never,
      { v: TRANSCRIPT }, [{ guid: 'A', name: 'A', children: [] }, { guid: 'B', name: 'B', children: [] }] as never, []
    )
    expect(results).toHaveLength(1)
    expect(results[0].timeRange).toEqual({ startTime: 15, endTime: 22 })
    expect(results[0].matchedText).toBe('line two')
  })
})
