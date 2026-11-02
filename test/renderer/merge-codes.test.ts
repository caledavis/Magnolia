import { describe, it, expect, beforeEach } from 'vitest'
import { useCodeStore } from '../../src/renderer/stores/code-store'
import { useDocumentStore } from '../../src/renderer/stores/document-store'
import { useUndoStore } from '../../src/renderer/stores/undo-store'
import type { Code } from '../../src/renderer/models/types'

// Merging codes in the Code Browser: the merged code's segments are recoded
// with the target, and its subcodes are either moved under the target or
// merged into it as well.

const code = (guid: string, children: Code[] = []): Code =>
  ({ guid, name: guid, isCodable: true, children }) as Code

/** One source whose selections are coded with the given code guids. */
function setCodings(...perSelection: string[][]): void {
  useDocumentStore.setState({
    sources: [
      {
        guid: 'doc',
        name: 'Doc',
        type: 'text',
        selections: perSelection.map((codes, i) => ({
          guid: `sel${i}`,
          startPosition: i * 10,
          endPosition: i * 10 + 5,
          codings: codes.map((c, j) => ({ guid: `c${i}-${j}`, codeGuid: c }))
        }))
      }
    ] as any
  })
}

const codingsOf = (i: number): string[] =>
  (useDocumentStore.getState().sources[0] as any).selections[i].codings.map((c: any) => c.codeGuid)

const tree = (codes: Code[] = useCodeStore.getState().codes): unknown =>
  codes.map((c) => (c.children.length ? { [c.guid]: tree(c.children) } : c.guid))

beforeEach(() => {
  // A (with subcodes A1, which has A1a, and A2) and B, both top level.
  useCodeStore.setState({
    codes: [code('A', [code('A1', [code('A1a')]), code('A2')]), code('B')]
  })
  setCodings(['A'], ['A1'], ['A1a'], ['B'])
})

describe('merging codes', () => {
  it('recodes the merged code and moves its subcodes under the target', () => {
    useCodeStore.getState().mergeIntoCode('A', 'B', 'move')
    expect(tree()).toEqual([{ B: [{ A1: ['A1a'] }, 'A2'] }])
    expect(codingsOf(0)).toEqual(['B'])
    expect(codingsOf(1)).toEqual(['A1'])
    expect(codingsOf(2)).toEqual(['A1a'])
  })

  it('moves subcodes by default', () => {
    useCodeStore.getState().mergeIntoCode('A', 'B')
    expect(tree()).toEqual([{ B: [{ A1: ['A1a'] }, 'A2'] }])
  })

  it('merges every subcode into the target when asked', () => {
    useCodeStore.getState().mergeIntoCode('A', 'B', 'merge')
    expect(tree()).toEqual(['B'])
    expect([codingsOf(0), codingsOf(1), codingsOf(2), codingsOf(3)]).toEqual([['B'], ['B'], ['B'], ['B']])
  })

  it('keeps one coding when a passage had both codes', () => {
    setCodings(['A', 'B', 'X'], ['B', 'A1'])
    useCodeStore.getState().mergeIntoCode('A', 'B', 'merge')
    expect(codingsOf(0)).toEqual(['B', 'X'])
    expect(codingsOf(1)).toEqual(['B'])
  })

  it("does nothing when merging a code into its own subcode", () => {
    const before = useCodeStore.getState().codes
    useCodeStore.getState().mergeIntoCode('A', 'A1a', 'merge')
    expect(useCodeStore.getState().codes).toBe(before)
    expect(codingsOf(0)).toEqual(['A'])
  })

  it('can be undone in one step', async () => {
    await new Promise((r) => setTimeout(r, 600))
    useUndoStore.getState().clearHistory()
    useCodeStore.getState().mergeIntoCode('A', 'B', 'merge')
    await new Promise((r) => setTimeout(r, 600))
    expect(useUndoStore.getState().undoStack).toHaveLength(1)
    useUndoStore.getState().undo()
    expect(tree()).toEqual([{ A: [{ A1: ['A1a'] }, 'A2'] }, 'B'])
    expect(codingsOf(0)).toEqual(['A'])
  })
})
