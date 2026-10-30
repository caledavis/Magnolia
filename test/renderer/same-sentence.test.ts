import { describe, it, expect } from 'vitest'
import { executeQuery, validateCondition } from '../../src/renderer/utils/query-engine'
import { sentenceSpans } from '../../src/renderer/utils/sentences'
import { sentenceCondition, sentencesOf, wordAssociations, wordCondition, wordFilter } from '../../src/renderer/components/Analysis/word-counts'
import type { Code, CodeCondition, PlainTextSelection, TextSource } from '../../src/renderer/models/types'

const codes = [{ guid: 'A', name: 'A', children: [] }, { guid: 'B', name: 'B', children: [] }] as unknown as Code[]

let n = 0
function sel(code: string, start: number, end: number, extra: Partial<PlainTextSelection> = {}): PlainTextSelection {
  n++
  return { guid: `s${n}`, startPosition: start, endPosition: end, codings: [{ guid: `c${n}`, codeGuid: code }], ...extra } as PlainTextSelection
}

function run(content: string, cond: CodeCondition, selections: PlainTextSelection[] = []) {
  const source = { guid: 'doc', name: 'Doc.txt', plainTextContent: content, selections } as unknown as TextSource
  return executeQuery({ documentFilter: {}, codeCondition: cond }, [source], {}, codes, [])
}

describe('sentenceSpans', () => {
  it('finds the same sentences as the word tools, in codepoints', () => {
    const text = '🐄 Cows moo.  Sheep? Yes!\n\nGoats\n'
    const spans = sentenceSpans(text)
    const cps = Array.from(text)
    expect(spans.map((s) => cps.slice(s.start, s.end).join(''))).toEqual(sentencesOf(text))
    expect(sentencesOf(text)).toEqual(['🐄 Cows moo.', 'Sheep?', 'Yes!', 'Goats'])
  })
})

describe('Same sentence', () => {
  const text = 'Students trust teachers. Teachers earn trust slowly. Lunch is late.\nTrust matters to teachers.'

  it('returns each sentence containing both words', () => {
    const results = run(text, sentenceCondition('trust', 'teachers'))
    expect(results.map((r) => r.matchedText)).toEqual([
      'Students trust teachers.',
      'Teachers earn trust slowly.',
      'Trust matters to teachers.'
    ])
  })

  it('finds as many sentences as Associations counts together', () => {
    const row = wordAssociations([text], 'trust', wordFilter('', ''), 1).rows.find((r) => r.word === 'teachers')!
    expect(run(text, sentenceCondition('trust', 'teachers'))).toHaveLength(row.together)
  })

  it('does not let a coded passage that contains a word claim other sentences', () => {
    // The whole text is coded, so the coded passage "contains" both words;
    // only "Lunch is late." must not come back for trust + lunch.
    const results = run(text, sentenceCondition('trust', 'lunch'), [sel('A', 0, 100)])
    expect(results).toEqual([])
  })

  it('compares codes too, giving every sentence a selection touches', () => {
    //                 0           12            26
    const content = 'Cows graze. Sheep sleep. Goats climb.'
    const cond: CodeCondition = { type: 'sameSentence', condition1: { type: 'code', codeGuid: 'A' }, condition2: { type: 'code', codeGuid: 'B' } }
    const results = run(content, cond, [sel('A', 0, 18), sel('B', 12, 17), sel('B', 25, 30)])
    expect(results.map((r) => r.matchedText)).toEqual(['Sheep sleep.'])
    expect(results[0].matchedCodes.map((c) => c.guid).sort()).toEqual(['A', 'B'])
  })

  it('limits both words to coded passages when given codes', () => {
    //                0                        25
    const content = 'Students trust teachers. Teachers earn trust slowly.'
    const results = run(content, sentenceCondition('trust', 'teachers', { codeGuids: ['A'], includeSubcodes: false }), [sel('A', 25, 52)])
    expect(results.map((r) => r.matchedText)).toEqual(['Teachers earn trust slowly.'])
  })

  it('works within survey cells', () => {
    const source = {
      guid: 'srv', name: 'Survey.csv', plainTextContent: 'raw,csv', selections: [],
      formatData: {
        rawCsv: '',
        survey: {
          questions: [{ id: 'q1', text: 'Why?' }],
          respondents: [
            { id: 'r1', answers: { q1: 'I trust teachers. Lunch is late.' } },
            { id: 'r2', answers: { q1: 'Trust is rare. Teachers leave.' } }
          ]
        }
      }
    } as unknown as TextSource
    const results = executeQuery({ documentFilter: {}, codeCondition: sentenceCondition('trust', 'teachers') }, [source], {}, codes, [])
    expect(results.map((r) => [r.surveyCell?.respondentId, r.matchedText])).toEqual([['r1', 'I trust teachers.']])
  })

  it('must connect straight to the result', () => {
    const same = sentenceCondition('trust', 'teachers')
    expect(validateCondition(same)).toBeNull()
    expect(validateCondition({ type: 'not', condition: same })).toMatch(/Same sentence/)
    expect(validateCondition({ type: 'inside', condition1: same, condition2: { type: 'code', codeGuid: 'A' } })).toMatch(/Same sentence/)
    expect(validateCondition({ type: 'or', conditions: [same, wordCondition('lunch')] })).toMatch(/Same sentence/)
  })
})
