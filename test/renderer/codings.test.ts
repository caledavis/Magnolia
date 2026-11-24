import { describe, it, expect } from 'vitest'
import { useDocumentStore } from '../../src/renderer/stores/document-store'
import type { TextSource } from '../../src/renderer/models/types'

describe('addCodingToSelection', () => {
  it('applies a code to a passage once', () => {
    useDocumentStore.setState({
      sources: [{ guid: 'd', name: 'd', sourceType: 'text', selections: [{ guid: 's', startPosition: 0, endPosition: 4, codings: [] }] }] as unknown as TextSource[]
    })
    const { addCodingToSelection } = useDocumentStore.getState()
    addCodingToSelection('d', 's', 'A')
    addCodingToSelection('d', 's', 'A')
    addCodingToSelection('d', 's', 'B')
    const codes = useDocumentStore.getState().sources[0].selections[0].codings.map((c) => c.codeGuid)
    expect(codes).toEqual(['A', 'B'])
  })
})
