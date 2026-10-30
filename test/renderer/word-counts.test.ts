import { describe, it, expect } from 'vitest'
import {
  countPhrases,
  countWords,
  sentencesOf,
  wordAssociations,
  codedPassageTexts,
  codeSet,
  sourceTexts,
  wordCondition,
  wordFilter
} from '../../src/renderer/components/Analysis/word-counts'
import { executeQuery } from '../../src/renderer/utils/query-engine'
import type { AnalysisInitData, Code, PlainTextSelection, TextSource } from '../../src/renderer/models/types'

const A = 'code-a'
const B = 'code-b'
const A1 = 'code-a1'

let n = 0
function sel(codes: string[], start: number, end: number, extra: Partial<PlainTextSelection> = {}): PlainTextSelection {
  n++
  return {
    guid: `sel-${n}`,
    startPosition: start,
    endPosition: end,
    codings: codes.map((codeGuid, i) => ({ guid: `c-${n}-${i}`, codeGuid })),
    ...extra
  } as PlainTextSelection
}

function data(over: Partial<AnalysisInitData>): AnalysisInitData {
  return {
    toolType: 'word-frequencies',
    theme: '',
    sources: [],
    folders: [],
    codes: [
      { guid: A, name: 'A', isCodable: true },
      { guid: A1, name: 'A1', isCodable: true, parentGuid: A },
      { guid: B, name: 'B', isCodable: true }
    ],
    tags: [],
    categories: [],
    sourceContents: {},
    sourceSelections: {},
    tagMembers: {},
    ...over
  } as AnalysisInitData
}

const all = wordFilter('', '')
const texts = (c: { passages: { text: string }[] }) => c.passages.map((p) => p.text)

describe('codedPassageTexts', () => {
  const text = 'cows eat grass. sheep eat grass too.'
  //            0    5   9      16    22  26     33

  it('reads the coded passages of a document', () => {
    const d = data({
      sources: [{ guid: 'doc', name: 'Doc.txt', sourceType: 'text' }],
      sourceContents: { doc: text },
      sourceSelections: { doc: [sel([A], 0, 15), sel([B], 16, 36)] }
    })
    expect(texts(codedPassageTexts(d, ['doc'], new Set([A])))).toEqual(['cows eat grass.'])
    expect(texts(codedPassageTexts(d, ['doc'], new Set([B])))).toEqual(['sheep eat grass too.'])
  })

  it('counts text coded twice, or with two of the codes, once', () => {
    const d = data({
      sources: [{ guid: 'doc', name: 'Doc.txt', sourceType: 'text' }],
      sourceContents: { doc: text },
      sourceSelections: { doc: [sel([A, B], 0, 15), sel([A], 5, 22), sel([B], 9, 14)] }
    })
    const freq = countWords(texts(codedPassageTexts(d, ['doc'], new Set([A, B]))), all)
    expect(freq.get('grass')).toBe(1)
    expect(freq.get('eat')).toBe(1)
    expect(freq.get('sheep')).toBe(1)
  })

  it('leaves out box codings and reports how many there were', () => {
    const d = data({
      sources: [{ guid: 'pdf', name: 'Doc.pdf', sourceType: 'pdf' }],
      sourceContents: { pdf: text },
      sourceSelections: {
        pdf: [sel([A], 0, 0, { pdfRegion: { page: 1, x: 0, y: 0, width: 10, height: 10 } }), sel([A], 0, 4)]
      }
    })
    expect(codedPassageTexts(d, ['pdf'], new Set([A]))).toEqual({ passages: [{ sourceGuid: 'pdf', text: 'cows' }], boxCount: 1 })
  })

  it('reads survey passages from their own cell', () => {
    const d = data({
      sources: [{ guid: 'srv', name: 'Survey.csv', sourceType: 'survey' }],
      sourceContents: { srv: 'id,q1\nr1,raw csv text' },
      surveyCodableCells: {
        srv: [
          { respondentId: 'r1', questionId: 'q1', text: 'I like the library' },
          { respondentId: 'r2', questionId: 'q1', text: 'Parking is awful' }
        ]
      },
      sourceSelections: {
        srv: [
          sel([A], 7, 18, { surveyCell: { respondentId: 'r1', questionId: 'q1' } }),
          sel([A], 0, 7, { surveyCell: { respondentId: 'r2', questionId: 'q1' } })
        ]
      }
    })
    expect(texts(codedPassageTexts(d, ['srv'], new Set([A]))).sort()).toEqual(['Parking', 'the library'])
  })

  it('slices by codepoint, not UTF-16 unit', () => {
    const d = data({
      sources: [{ guid: 'doc', name: 'Doc.txt', sourceType: 'text' }],
      sourceContents: { doc: '🐄 cows moo' },
      sourceSelections: { doc: [sel([A], 2, 6)] }
    })
    expect(texts(codedPassageTexts(d, ['doc'], new Set([A])))).toEqual(['cows'])
  })

  it('strips formatting syntax from markdown passages', () => {
    const d = data({
      sources: [{ guid: 'md', name: 'Notes.md', sourceType: 'markdown' }],
      sourceContents: { md: 'the **bold** claim' },
      sourceSelections: { md: [sel([A], 4, 12)] }
    })
    expect(texts(codedPassageTexts(d, ['md'], new Set([A])))).toEqual(['bold'])
  })
})

describe('sourceTexts', () => {
  it("reads a survey's open-ended answers, not its CSV", () => {
    const d = data({
      sources: [{ guid: 'srv', name: 'Survey.csv', sourceType: 'survey' }],
      sourceContents: { srv: 'id,q1\nr1,header junk' },
      surveyCodableCells: { srv: [{ respondentId: 'r1', questionId: 'q1', text: 'Great teachers' }] }
    })
    expect(sourceTexts(d, 'srv')).toEqual(['Great teachers'])
  })
})

describe('codeSet', () => {
  it('adds subcodes only when asked', () => {
    const codes = data({}).codes
    expect([...codeSet(codes, A, false)]).toEqual([A])
    expect([...codeSet(codes, A, true)].sort()).toEqual([A, A1].sort())
  })
})

describe('countWords', () => {
  it('honours the include and exclude lists', () => {
    expect([...countWords(['The cows and the sheep'], wordFilter('', 'the, and')).keys()]).toEqual(['cows', 'sheep'])
    expect([...countWords(['The cows and the sheep'], wordFilter('sheep', '')).keys()]).toEqual(['sheep'])
  })
})

describe('wordCondition', () => {
  const content = 'grass is green. the grass grows.'
  //               0     6  9      16  20    26
  const codes = [
    { guid: A, name: 'A', children: [{ guid: A1, name: 'A1', children: [] }] },
    { guid: B, name: 'B', children: [] }
  ] as unknown as Code[]

  function run(selections: PlainTextSelection[], cond: ReturnType<typeof wordCondition>) {
    const source = { guid: 'doc', name: 'Doc.txt', plainTextContent: content, selections } as unknown as TextSource
    return executeQuery({ documentFilter: {}, codeCondition: cond }, [source], {}, codes, [])
  }

  it('finds the word everywhere without codes', () => {
    expect(run([], wordCondition('grass'))).toHaveLength(2)
  })

  it('finds the word only inside the codes’ passages', () => {
    const results = run([sel([B], 16, 32)], wordCondition('grass', { codeGuids: [B], includeSubcodes: false }))
    expect(results).toHaveLength(1)
    expect(results[0].startPosition).toBe(20)
  })

  it('includes subcodes, and any of several codes', () => {
    const sels = [sel([A1], 0, 15), sel([B], 16, 32)]
    expect(run(sels, wordCondition('grass', { codeGuids: [A], includeSubcodes: false }))).toHaveLength(0)
    expect(run(sels, wordCondition('grass', { codeGuids: [A], includeSubcodes: true }))).toHaveLength(1)
    expect(run(sels, wordCondition('grass', { codeGuids: [A, B], includeSubcodes: true }))).toHaveLength(2)
  })
})

describe('countPhrases', () => {
  const stop = wordFilter('', 'the, of, a, and, in, is')

  it('counts phrases that do not start or end with an excluded word', () => {
    const rows = countPhrases(['Quality of life matters. The quality of life is poor.'], 3, stop, 1)
    // "life is poor" stays: only the ends are checked.
    expect(rows).toEqual([{ phrase: 'quality of life', count: 2 }, { phrase: 'life is poor', count: 1 }])
    expect(countPhrases(['Quality of life matters.'], 2, stop, 1)).toEqual([{ phrase: 'life matters', count: 1 }])
  })

  it('never joins words across punctuation, line breaks or double spaces', () => {
    expect(countPhrases(['mental, health', 'mental\nhealth', 'mental  health', 'well-being'], 2, wordFilter('', ''), 1)).toEqual([])
  })

  it('keeps inner apostrophes and ignores words touching digits', () => {
    expect(countPhrases(['they don\u2019t know', 'covid19 vaccine rollout'], 2, wordFilter('', ''), 1).map((r) => r.phrase).sort())
      .toEqual(['don\u2019t know', 'they don\u2019t', 'vaccine rollout'])
  })

  it('applies the include list and the minimum count', () => {
    const texts = ['mental health care', 'mental health care', 'school meals']
    expect(countPhrases(texts, 2, wordFilter('care', ''), 1)).toEqual([{ phrase: 'health care', count: 2 }])
    expect(countPhrases(texts, 2, wordFilter('', ''), 2).map((r) => r.phrase)).toEqual(['health care', 'mental health'])
  })

  it('finds each phrase again with a text search', () => {
    const content = 'Mental health care is stretched. Mental health care needs funding.'
    const source = { guid: 'doc', name: 'Doc.txt', plainTextContent: content, selections: [] } as unknown as TextSource
    for (const { phrase, count } of countPhrases([content], 2, stop, 1)) {
      const hits = executeQuery({ documentFilter: {}, codeCondition: wordCondition(phrase) }, [source], {}, [], [])
      expect(hits, phrase).toHaveLength(count)
    }
  })
})

describe('wordAssociations', () => {
  const texts = [
    'Students trust teachers. Students like lunch.',
    'Teachers earn trust slowly. Lunch is late.\nTrust matters to teachers.',
    'Parking is awful. Parking costs money.'
  ]

  it('splits sentences at end punctuation and line breaks', () => {
    expect(sentencesOf('One. Two? Three!\nFour')).toEqual(['One.', 'Two?', 'Three!', 'Four'])
  })

  it('ranks words that share sentences with the focus word', () => {
    const result = wordAssociations(texts, 'Trust', wordFilter('', 'is, to'), 1)
    expect(result.sentences).toBe(7)
    expect(result.focusSentences).toBe(3)
    expect(result.rows[0].word).toBe('teachers')
    expect(result.rows[0].together).toBe(3)
    expect(result.rows[0].share).toBe(1)
    // Only words seen with "trust" more often than chance are kept.
    expect(result.rows.map((r) => r.word)).not.toContain('parking')
    expect(result.rows.map((r) => r.word)).not.toContain('lunch')
  })

  it('computes G\u00B2 for the 2\u00D72 table', () => {
    // 3 of 7 sentences have "trust"; all 3 contain "teachers", which
    // appears nowhere else: a=3, b=0, c=0, d=4.
    const g2 = 2 * (3 * Math.log(3 / (9 / 7)) + 4 * Math.log(4 / (16 / 7)))
    const row = wordAssociations(texts, 'trust', wordFilter('', ''), 1).rows.find((r) => r.word === 'teachers')!
    expect(row.g2).toBeCloseTo(g2, 10)
  })

  it('applies the minimum co-occurrence', () => {
    expect(wordAssociations(texts, 'trust', wordFilter('', ''), 3).rows.map((r) => r.word)).toEqual(['teachers'])
  })
})
