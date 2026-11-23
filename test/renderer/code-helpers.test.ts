import { describe, expect, it } from 'vitest'
import { codeGuidsFromJson, draggedCodeGuids, draggedCodes, isCodeDrag } from '../../src/renderer/utils/code-drag'
import { flattenCodes, flattenCodesWithDepth } from '../../src/renderer/utils/code-tree'
import type { Code } from '../../src/renderer/models/types'

/** A drop event's DataTransfer, as far as these helpers read it. */
function drop(data: Record<string, string>): { dataTransfer: DataTransfer } {
  return { dataTransfer: { types: Object.keys(data), getData: (t: string) => data[t] ?? '' } as unknown as DataTransfer }
}

describe('code drags', () => {
  it('prefers the multi-selection, then the single code', () => {
    const e = drop({ 'application/x-magnolia-codes': '[{"guid":"A"},{"guid":"B"}]', 'application/x-magnolia-code': '{"guid":"A"}' })
    expect(draggedCodeGuids(e)).toEqual(['A', 'B'])
    expect(draggedCodeGuids(drop({ 'application/x-magnolia-code': '{"guid":"C","name":"Cee"}' }))).toEqual(['C'])
    expect(draggedCodes<{ guid: string; name: string }>(drop({ 'application/x-magnolia-code': '{"guid":"C","name":"Cee"}' }))[0].name).toBe('Cee')
  })

  it('yields nothing for other drags or malformed data', () => {
    expect(draggedCodeGuids(drop({ 'text/plain': 'hi' }))).toEqual([])
    expect(draggedCodeGuids(drop({ 'application/x-magnolia-codes': 'not json' }))).toEqual([])
    expect(draggedCodeGuids(drop({ 'application/x-magnolia-codes': '{"guid":"A"}' }))).toEqual([])
    expect(draggedCodeGuids(drop({ 'application/x-magnolia-codes': '[{"name":"no guid"},{"guid":"B"}]' }))).toEqual(['B'])
    expect(codeGuidsFromJson('[{"guid":"X"}]')).toEqual(['X'])
    expect(codeGuidsFromJson('oops')).toEqual([])
  })

  it('recognises a code drag by its types', () => {
    expect(isCodeDrag(drop({ 'application/x-magnolia-code': '' }))).toBe(true)
    expect(isCodeDrag(drop({ 'application/x-magnolia-codes': '' }))).toBe(true)
    expect(isCodeDrag(drop({ Files: '' }))).toBe(false)
  })
})

describe('code trees', () => {
  const code = (guid: string, children: Code[] = []): Code => ({ guid, name: guid, isCodable: true, children } as Code)
  const tree = [code('A', [code('A1', [code('A1a')]), code('A2')]), code('B')]
  it('flattens depth first', () => {
    expect(flattenCodes(tree).map((c) => c.guid)).toEqual(['A', 'A1', 'A1a', 'A2', 'B'])
    expect(flattenCodesWithDepth(tree).map((x) => `${x.code.guid}:${x.depth}`)).toEqual(['A:0', 'A1:1', 'A1a:2', 'A2:1', 'B:0'])
  })
})
