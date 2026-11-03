import { describe, it, expect } from 'vitest'
import { executeQuery } from '../../src/renderer/utils/query-engine'
import { countWords, queryPassageTexts, sentenceCondition, wordCondition, wordFilter } from '../../src/renderer/components/Analysis/word-counts'
import type { AnalysisInitData, Code, CodeCondition, PlainTextSelection, Query, TextSource } from '../../src/renderer/models/types'

// Word tools counting in query results: the passages they read
// (queryPassageTexts) and the searches they run (Query.within).

const codes = [{ guid: 'A', name: 'A', children: [] }, { guid: 'B', name: 'B', children: [] }] as unknown as Code[]

let n = 0
function sel(code: string, start: number, end: number, extra: Partial<PlainTextSelection> = {}): PlainTextSelection {
  n++
  return { guid: `s${n}`, startPosition: start, endPosition: end, codings: [{ guid: `c${n}`, codeGuid: code }], ...extra } as PlainTextSelection
}

//               0         10        20        30        40        50
const text1 = 'Cows eat grass. Sheep eat grass too. Goats eat everything.'
const text2 = 'Cows sleep. Sheep eat hay.'

const doc1 = { guid: 'd1', name: 'One.txt', plainTextContent: text1, selections: [sel('A', 0, 15), sel('B', 16, 36)] } as unknown as TextSource
const doc2 = { guid: 'd2', name: 'Two.txt', plainTextContent: text2, selections: [sel('A', 0, 26)] } as unknown as TextSource
const sources = [doc1, doc2]

const codeA: Query = { documentFilter: {}, codeCondition: { type: 'code', codeGuid: 'A' } }
const codeAInDoc1: Query = { documentFilter: { sourceGuids: ['d1'] }, codeCondition: { type: 'code', codeGuid: 'A' } }
const codeB: Query = { documentFilter: {}, codeCondition: { type: 'code', codeGuid: 'B' } }

function run(cond: CodeCondition, within?: Query[]) {
  return executeQuery({ documentFilter: {}, codeCondition: cond, within }, sources, {}, codes, [])
}

function data(): AnalysisInitData {
  return {
    toolType: 'word-frequencies',
    theme: '',
    sources: [{ guid: 'd1', name: 'One.txt', sourceType: 'text' }, { guid: 'd2', name: 'Two.txt', sourceType: 'text' }],
    folders: [],
    codes: [],
    tags: [],
    categories: [],
    sourceContents: { d1: text1, d2: text2 },
    sourceSelections: { d1: doc1.selections, d2: doc2.selections },
    tagMembers: {}
  } as unknown as AnalysisInitData
}

describe('Query.within', () => {
  it('keeps only the text matches inside the queries’ results', () => {
    const results = run(wordCondition('eat'), [codeA])
    expect(results.map((r) => [r.sourceGuid, r.startPosition])).toEqual([['d1', 5], ['d2', 18]])
  })

  it('runs each query with its own documents', () => {
    expect(run(wordCondition('eat'), [codeAInDoc1]).map((r) => r.sourceGuid)).toEqual(['d1'])
  })

  it('combines several queries’ results', () => {
    expect(run(wordCondition('grass'), [codeA, codeB]).map((r) => r.startPosition)).toEqual([9, 26])
  })

  it('finds nothing when no query is left', () => {
    expect(run(wordCondition('eat'), [])).toEqual([])
  })

  it('limits both words of a same-sentence search', () => {
    // "Goats eat everything." is outside every result.
    expect(run(sentenceCondition('eat', 'goats')).length).toBe(1)
    expect(run(sentenceCondition('eat', 'goats'), [codeA, codeB])).toEqual([])
    expect(run(sentenceCondition('sheep', 'grass'), [codeB]).map((r) => r.matchedText)).toEqual(['Sheep eat grass too.'])
  })

  it('works with overlap results in survey cells', () => {
    const cell = (respondentId: string) => ({ surveyCell: { respondentId, questionId: 'q1' } })
    //            0         10        20        30
    const answer = 'Rent is high and placements are unpaid.'
    const survey = {
      guid: 'srv', name: 'Survey.csv', plainTextContent: 'raw,csv',
      // A coded 0–27, B coded 8–39: they overlap on "high and placements".
      selections: [sel('A', 0, 27, cell('r1')), sel('B', 8, 39, cell('r1'))],
      formatData: { rawCsv: '', survey: { questions: [{ id: 'q1', text: 'Why?' }], respondents: [{ id: 'r1', answers: { q1: answer } }] } }
    } as unknown as TextSource
    const overlap: Query = { documentFilter: {}, codeCondition: { type: 'overlap', condition1: { type: 'code', codeGuid: 'A' }, condition2: { type: 'code', codeGuid: 'B' } } }
    const exec = (q: Query) => executeQuery(q, [survey], {}, codes, [])
    const [result] = exec(overlap)
    expect(result.surveyCell).toEqual({ respondentId: 'r1', questionId: 'q1' })
    expect(exec({ documentFilter: {}, codeCondition: wordCondition('placements'), within: [overlap] })).toHaveLength(1)
    expect(exec({ documentFilter: {}, codeCondition: wordCondition('unpaid'), within: [overlap] })).toEqual([])
  })

  it('leaves queries without it unchanged', () => {
    expect(run(wordCondition('eat'))).toHaveLength(4)
  })
})

describe('queryPassageTexts', () => {
  const runQuery = (q: Query) => executeQuery(q, sources, {}, codes, [])

  it('reads each result’s text', () => {
    const texts = queryPassageTexts(data(), runQuery(codeA)).passages.map((p) => p.text)
    expect(texts).toEqual(['Cows eat grass.', 'Cows sleep. Sheep eat hay.'])
  })

  it('counts overlapping results once', () => {
    const both = [...runQuery(codeA), ...runQuery(codeA)]
    const freq = countWords(queryPassageTexts(data(), both).passages.map((p) => p.text), wordFilter('', ''))
    expect(freq.get('cows')).toBe(2)
  })

  it('leaves out box results and reports how many there were', () => {
    const d = data()
    const box = sel('A', 0, 0, { pdfRegion: { pageNumber: 1, x: 0, y: 0, width: 1, height: 1 } } as Partial<PlainTextSelection>)
    d.sourceSelections = { ...d.sourceSelections, d1: [...doc1.selections, box] }
    const results = [...runQuery(codeAInDoc1), { ...runQuery(codeAInDoc1)[0], selectionGuid: box.guid }]
    const { passages, boxCount } = queryPassageTexts(d, results)
    expect(boxCount).toBe(1)
    expect(passages.map((p) => p.text)).toEqual(['Cows eat grass.'])
  })
})
