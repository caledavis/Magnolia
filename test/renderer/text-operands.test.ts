import { describe, it, expect } from 'vitest'
import { executeQuery } from '../../src/renderer/utils/query-engine'
import type { Code, CodeCondition, PlainTextSelection, TextSource } from '../../src/renderer/models/types'

// A word as an operand of Overlap, Inside, Outside, Before or Followed By
// stands for the places the word occurs — not for any coded passage that
// happens to contain it (Same Sentence already works this way).

const codes = [{ guid: 'A', name: 'A', children: [] }, { guid: 'B', name: 'B', children: [] }] as unknown as Code[]

let n = 0
function sel(code: string, start: number, end: number): PlainTextSelection {
  n++
  return { guid: `s${n}`, startPosition: start, endPosition: end, codings: [{ guid: `c${n}`, codeGuid: code }] } as PlainTextSelection
}

//              0   4     10    17
const text = 'The cattle graze. Sheep sleep.'

function run(cond: CodeCondition, selections: PlainTextSelection[]) {
  const source = { guid: 'doc', name: 'Doc.txt', plainTextContent: text, selections } as unknown as TextSource
  return executeQuery({ documentFilter: {}, codeCondition: cond }, [source], {}, codes, []).map((r) => r.matchedText)
}

const word = (searchText: string): CodeCondition => ({ type: 'text', searchText })
const code = (codeGuid: string): CodeCondition => ({ type: 'code', codeGuid })

describe('a word as a spatial operand', () => {
  it('Overlap: only where the word itself overlaps', () => {
    // B contains "cattle" and overlaps A, but the word doesn't reach A.
    const results = run({ type: 'overlap', condition1: word('cattle'), condition2: code('A') }, [sel('B', 0, 17), sel('A', 11, 30)])
    expect(results).toEqual([])
  })

  it('Inside: the word, not the passage containing it', () => {
    const results = run({ type: 'inside', condition1: word('cattle'), condition2: code('A') }, [sel('B', 0, 17), sel('A', 0, 30)])
    expect(results).toEqual(['cattle'])
  })

  it('Outside: the word, not the passage containing it', () => {
    const results = run({ type: 'outside', condition1: word('cattle'), condition2: code('A') }, [sel('B', 0, 10), sel('A', 11, 30)])
    expect(results).toEqual(['cattle'])
  })

  it('Before: the word, not the passage containing it', () => {
    const results = run({ type: 'before', condition1: word('cattle'), condition2: code('A') }, [sel('B', 0, 10), sel('A', 11, 30)])
    expect(results).toEqual(['cattle'])
  })

  it('Followed by: the word, not the passage containing it', () => {
    const results = run({ type: 'followedBy', condition1: word('sheep'), condition2: code('A') }, [sel('A', 0, 10), sel('B', 18, 30)])
    expect(results).toEqual(['Sheep'])
  })

  it('as the second operand too', () => {
    // A is inside B, which contains "cattle", but not inside the word.
    const results = run({ type: 'inside', condition1: code('A'), condition2: word('cattle') }, [sel('B', 0, 17), sel('A', 11, 16)])
    expect(results).toEqual([])
  })

  it('still counts a coded passage that is exactly the word', () => {
    const results = run({ type: 'inside', condition1: word('cattle'), condition2: code('A') }, [sel('B', 4, 10), sel('A', 0, 30)])
    expect(results).toEqual(['cattle'])
  })

  it('keeps a word combined with a code meaning coded passages containing it', () => {
    const operand: CodeCondition = { type: 'and', conditions: [code('B'), word('cattle')] }
    const results = run({ type: 'inside', condition1: operand, condition2: code('A') }, [sel('B', 0, 17), sel('A', 0, 30)])
    expect(results).toEqual(['The cattle graze.'])
  })
})
