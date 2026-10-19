import { describe, it, expect } from 'vitest'
import { executeQuery } from '../../src/renderer/utils/query-engine'
import type { CodeCondition, PlainTextSelection, TextSource, Code } from '../../src/renderer/models/types'

// Spatial operators over PDF/image box selections. Boxes carry a 0–0 char
// range, so comparing them by offsets silently dropped every overlap and
// made every box "inside"/"before" every other box in the document.

const A = 'code-a'
const B = 'code-b'
const codes = [
  { guid: A, name: 'A', children: [] },
  { guid: B, name: 'B', children: [] }
] as unknown as Code[]

let n = 0
function box(code: string, page: number, x: number, y: number, width: number, height: number): PlainTextSelection {
  n++
  return {
    guid: `box-${n}`,
    startPosition: 0,
    endPosition: 0,
    pdfRegion: { page, x, y, width, height },
    codings: [{ guid: `c-${n}`, codeGuid: code }]
  } as PlainTextSelection
}
function text(code: string, start: number, end: number): PlainTextSelection {
  n++
  return { guid: `txt-${n}`, startPosition: start, endPosition: end, codings: [{ guid: `c-${n}`, codeGuid: code }] } as PlainTextSelection
}

function run(type: 'overlap' | 'inside' | 'outside' | 'before' | 'followedBy', selections: PlainTextSelection[]) {
  const source = { guid: 'src', name: 'Doc', plainTextContent: 'x'.repeat(200), selections } as unknown as TextSource
  const codeCondition = {
    type,
    condition1: { type: 'code', codeGuid: A },
    condition2: { type: 'code', codeGuid: B }
  } as CodeCondition
  return executeQuery({ documentFilter: {}, codeCondition } as never, [source], {}, codes, [])
}

describe('spatial queries over box selections', () => {
  it('overlap finds boxes whose rectangles intersect on the same page', () => {
    const a = box(A, 1, 100, 100, 200, 50)
    const results = run('overlap', [a, box(B, 1, 100, 100, 200, 50)])
    expect(results).toHaveLength(1)
    expect(results[0].selectionGuid).toBe(a.guid)
  })

  it('overlap ignores boxes on different pages or with disjoint rectangles', () => {
    expect(run('overlap', [box(A, 1, 100, 100, 200, 50), box(B, 2, 100, 100, 200, 50)])).toHaveLength(0)
    expect(run('overlap', [box(A, 1, 100, 100, 200, 50), box(B, 1, 100, 300, 200, 50)])).toHaveLength(0)
    // Touching edges is not an overlap
    expect(run('overlap', [box(A, 1, 100, 100, 200, 50), box(B, 1, 100, 150, 200, 50)])).toHaveLength(0)
  })

  it('overlap never matches a box against a text range', () => {
    expect(run('overlap', [box(A, 1, 0, 0, 500, 500), text(B, 0, 50)])).toHaveLength(0)
  })

  it('overlap still works for text ranges alongside boxes', () => {
    const results = run('overlap', [text(A, 0, 20), text(B, 10, 30), box(A, 1, 0, 0, 10, 10)])
    expect(results).toHaveLength(1)
    expect([results[0].startPosition, results[0].endPosition]).toEqual([10, 20])
  })

  it('inside requires containment on the same page', () => {
    expect(run('inside', [box(A, 1, 120, 110, 50, 20), box(B, 1, 100, 100, 200, 50)])).toHaveLength(1)
    expect(run('inside', [box(A, 1, 120, 110, 50, 20), box(B, 2, 100, 100, 200, 50)])).toHaveLength(0)
    expect(run('inside', [box(A, 1, 120, 110, 50, 20), box(B, 1, 400, 400, 50, 50)])).toHaveLength(0)
  })

  it('outside excludes boxes that overlap a condition-2 box', () => {
    expect(run('outside', [box(A, 1, 100, 100, 200, 50), box(B, 1, 150, 120, 20, 20)])).toHaveLength(0)
    expect(run('outside', [box(A, 1, 100, 100, 200, 50), box(B, 3, 150, 120, 20, 20)])).toHaveLength(1)
  })

  it('before / followed by use page then vertical reading order', () => {
    const top = () => box(A, 1, 100, 100, 200, 50)
    const below = () => box(B, 1, 100, 300, 200, 50)
    const nextPage = () => box(B, 2, 100, 10, 200, 50)
    expect(run('before', [top(), below()])).toHaveLength(1)
    expect(run('before', [top(), nextPage()])).toHaveLength(1)
    expect(run('before', [box(A, 2, 100, 10, 200, 50), box(B, 1, 100, 300, 200, 50)])).toHaveLength(0)
    expect(run('followedBy', [box(A, 2, 100, 10, 200, 50), box(B, 1, 100, 300, 200, 50)])).toHaveLength(1)
    expect(run('followedBy', [top(), below()])).toHaveLength(0)
  })
})
