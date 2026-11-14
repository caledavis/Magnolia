import { describe, it, expect } from 'vitest'
import { executeQuery } from '../../src/renderer/utils/query-engine'
import type { CodeCondition, PlainTextSelection, TextSource, Code } from '../../src/renderer/models/types'

// Video codings: startPosition / endPosition are code-point offsets into the
// transcript (exact for codings made on the text, the covered lines for
// codings made on the timeline); a timeline coding with no span (0–0) holds
// no text.

const A = 'code-a'
const B = 'code-b'
const codes = [
  { guid: A, name: 'A', children: [] },
  { guid: B, name: 'B', children: [] }
] as unknown as Code[]

// Lines start at 0, 19, 38 ("Second one. Third." is two sentences).
const TRANSCRIPT = 'First line of talk\nSecond one. Third.\nLast line here'
const LINE_TIMES = { '0': 0, '1': 10, '2': 20 }

let n = 0
function coding(code: string, start: number, end: number, from: number, to: number): PlainTextSelection {
  n++
  return {
    guid: `v-${n}`, startPosition: start, endPosition: end, timeRange: { startTime: from, endTime: to },
    codings: [{ guid: `c-${n}`, codeGuid: code }]
  } as PlainTextSelection
}

function run(codeCondition: CodeCondition, selections: PlainTextSelection[]) {
  const source = { guid: 'v', name: 'Clip', sourceType: 'video', formatData: { lineTimes: LINE_TIMES }, selections } as unknown as TextSource
  return executeQuery({ documentFilter: {}, codeCondition } as never, [source], { v: TRANSCRIPT }, codes, [])
}
const code = (guid: string) => ({ type: 'code', codeGuid: guid }) as CodeCondition

describe('queries over video codings', () => {
  it('a coding made on the transcript shows exactly the text coded', () => {
    const [r] = run(code(A), [coding(A, 25, 29, 10, 20)])
    expect(r.matchedText).toBe(' one')
  })

  it('a coding made on the timeline shows the lines it covers', () => {
    const [r] = run(code(A), [coding(A, 19, 37, 10, 20)])
    expect(r.matchedText).toBe('Second one. Third.')
  })

  it('a timeline coding with no span reads the lines its time covers', () => {
    const [r] = run(code(A), [coding(A, 0, 0, 10, 20)])
    expect(r.matchedText).toBe('Second one. Third.')
  })

  it('codings in the same sentence are found in a transcript', () => {
    const results = run({ type: 'sameSentence', condition1: code(A), condition2: code(B) } as unknown as CodeCondition, [
      coding(A, 19, 23, 10, 20),
      coding(B, 26, 29, 10, 20)
    ])
    expect(results.map((r) => r.matchedText)).toEqual(['Second one.'])
  })
})
