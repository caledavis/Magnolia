import { describe, it, expect } from 'vitest'
import { diffProjects, type ProjectSide } from '../../src/renderer/utils/project-diff'
import type { Project, Code, TextSource, QDASet, SavedAnalysis } from '../../src/renderer/models/types'

function emptyProject(overrides: Partial<Project> = {}): Project {
  return {
    name: 'Test',
    origin: 'test',
    users: [],
    codes: [],
    sources: [],
    sets: [],
    notes: [],
    ...overrides
  }
}

function side(project: Project, sourceContents: Record<string, string> = {}): ProjectSide {
  return { project, sourceContents }
}

describe('diffProjects — codes', () => {
  it('detects a code added only in theirs and one added only in mine', () => {
    const mineCode: Code = { guid: 'a', name: 'Alpha', isCodable: true, children: [] }
    const theirsCode: Code = { guid: 'b', name: 'Beta', isCodable: true, children: [] }
    const diff = diffProjects(
      side(emptyProject({ codes: [mineCode] })),
      side(emptyProject({ codes: [theirsCode] }))
    )
    expect(diff.codes).toEqual([
      { guid: 'a', bucket: 'onlyMine', mine: mineCode },
      { guid: 'b', bucket: 'onlyTheirs', theirs: theirsCode }
    ])
  })

  it('detects a renamed code (same guid, field differs) and reports no diff for an identical shared code', () => {
    const shared: Code = { guid: 'x', name: 'Same', isCodable: true, children: [] }
    const mineCode: Code = { guid: 'a', name: 'Old Name', color: '#fff', isCodable: true, children: [] }
    const theirsCode: Code = { guid: 'a', name: 'New Name', color: '#fff', isCodable: true, children: [] }
    const diff = diffProjects(
      side(emptyProject({ codes: [shared, mineCode] })),
      side(emptyProject({ codes: [shared, theirsCode] }))
    )
    expect(diff.codes).toHaveLength(1)
    expect(diff.codes[0]).toMatchObject({ guid: 'a', bucket: 'bothDiffer', changedFields: ['name'] })
    expect(diff.codes[0].moved).toBeUndefined()
  })

  it('detects a moved code (same guid, different parent) even with no field changes', () => {
    const child: Code = { guid: 'child', name: 'Child', isCodable: true, children: [] }
    const mineTree: Code[] = [{ guid: 'p1', name: 'Parent 1', isCodable: true, children: [child] }, { guid: 'p2', name: 'Parent 2', isCodable: true, children: [] }]
    const theirsTree: Code[] = [{ guid: 'p1', name: 'Parent 1', isCodable: true, children: [] }, { guid: 'p2', name: 'Parent 2', isCodable: true, children: [child] }]
    const diff = diffProjects(side(emptyProject({ codes: mineTree })), side(emptyProject({ codes: theirsTree })))
    const childDiff = diff.codes.find((c) => c.guid === 'child')
    expect(childDiff).toMatchObject({ bucket: 'bothDiffer', moved: { fromParentGuid: 'p1', toParentGuid: 'p2' } })
  })
})

describe('diffProjects — tags', () => {
  it('reports added/removed document membership without flagging the whole tag as an opaque change', () => {
    const mineTag: QDASet = { guid: 't1', name: 'Important', memberSourceGuids: ['doc1'], memberCodeGuids: [] }
    const theirsTag: QDASet = { guid: 't1', name: 'Important', memberSourceGuids: ['doc1', 'doc2'], memberCodeGuids: [] }
    const diff = diffProjects(side(emptyProject({ sets: [mineTag] })), side(emptyProject({ sets: [theirsTag] })))
    expect(diff.tags).toEqual([
      {
        guid: 't1',
        bucket: 'bothDiffer',
        mine: mineTag,
        theirs: theirsTag,
        changedFields: [],
        addedMemberSourceGuids: ['doc2'],
        removedMemberSourceGuids: undefined,
        addedMemberCodeGuids: undefined,
        removedMemberCodeGuids: undefined
      }
    ])
  })

  it('reports no diff for two identical tags', () => {
    const tag: QDASet = { guid: 't1', name: 'Same', memberSourceGuids: ['doc1'], memberCodeGuids: [] }
    const diff = diffProjects(side(emptyProject({ sets: [tag] })), side(emptyProject({ sets: [{ ...tag }] })))
    expect(diff.tags).toEqual([])
  })
})

describe('diffProjects — quotes (no update API, bothDiffer means remove+add)', () => {
  it('flags a quote whose text changed under the same guid', () => {
    const mineQuote = { guid: 'q1', sourceGuid: 's1', sourceName: 'Doc', startPosition: 0, endPosition: 5, text: 'hello', createdDateTime: '2024-01-01' }
    const theirsQuote = { ...mineQuote, text: 'howdy' }
    const diff = diffProjects(side(emptyProject({ quotes: [mineQuote] })), side(emptyProject({ quotes: [theirsQuote] })))
    expect(diff.quotes).toMatchObject([{ guid: 'q1', bucket: 'bothDiffer', changedFields: ['text'] }])
  })
})

describe('diffProjects — document text and codings', () => {
  const source = (guid: string): TextSource => ({ guid, name: `${guid}.txt`, sourceType: 'text', selections: [] })

  it('itemizes added/removed codings when the underlying text is identical', () => {
    const mineSource: TextSource = {
      ...source('s1'),
      selections: [
        { guid: 'sel1', startPosition: 0, endPosition: 5, codings: [{ guid: 'c1', codeGuid: 'codeA' }] }
      ]
    }
    const theirsSource: TextSource = {
      ...source('s1'),
      selections: [
        { guid: 'sel1-different-guid', startPosition: 0, endPosition: 5, codings: [{ guid: 'c1-different-guid', codeGuid: 'codeA' }] },
        { guid: 'sel2', startPosition: 10, endPosition: 15, codings: [{ guid: 'c2', codeGuid: 'codeB' }] }
      ]
    }
    const diff = diffProjects(
      side(emptyProject({ sources: [mineSource] }), { s1: 'identical text here' }),
      side(emptyProject({ sources: [theirsSource] }), { s1: 'identical text here' })
    )
    expect(diff.documentText).toEqual([]) // text matches — no text diff item
    expect(diff.codings).toHaveLength(1)
    expect(diff.codings[0].coarse).toBe(false)
    // The (0,5,codeA) coding matches by anchor+code despite different guids — no diff for it.
    expect(diff.codings[0].onlyMine).toEqual([])
    expect(diff.codings[0].onlyTheirs).toHaveLength(1)
    expect(diff.codings[0].onlyTheirs![0].coding.codeGuid).toBe('codeB')
  })

  it('collapses to a coarse per-document choice when the text differs, but still itemizes the text diff', () => {
    const mineSource: TextSource = {
      ...source('s1'),
      selections: [{ guid: 'sel1', startPosition: 0, endPosition: 5, codings: [{ guid: 'c1', codeGuid: 'codeA' }] }]
    }
    const theirsSource: TextSource = {
      ...source('s1'),
      selections: [{ guid: 'sel1', startPosition: 0, endPosition: 5, codings: [{ guid: 'c1', codeGuid: 'codeA' }] }]
    }
    const diff = diffProjects(
      side(emptyProject({ sources: [mineSource] }), { s1: 'the original text' }),
      side(emptyProject({ sources: [theirsSource] }), { s1: 'the edited text' })
    )
    expect(diff.documentText).toHaveLength(1)
    expect(diff.documentText[0].sourceGuid).toBe('s1')
    expect(diff.documentText[0].mineText).toBe('the original text')
    expect(diff.documentText[0].theirsText).toBe('the edited text')
    expect(diff.codings).toMatchObject([{ sourceGuid: 's1', sourceName: 's1.txt', coarse: true }])
    expect(diff.codings[0].theirsSource).toEqual(theirsSource)
  })
})

describe('diffProjects — saved analyses', () => {
  it('treats a non-relationship-map config as an opaque changed/unchanged blob', () => {
    const mine: SavedAnalysis = { guid: 'sa1', toolType: 'code-frequencies', name: 'Freq', config: { sort: 'asc' }, createdDateTime: '2024-01-01' }
    const theirs: SavedAnalysis = { ...mine, config: { sort: 'desc' } }
    const diff = diffProjects(side(emptyProject({ savedAnalyses: [mine] })), side(emptyProject({ savedAnalyses: [theirs] })))
    expect(diff.savedAnalyses).toMatchObject([{ guid: 'sa1', bucket: 'bothDiffer', changedFields: ['config'] }])
    expect(diff.savedAnalyses[0].relationshipMapSummary).toBeUndefined()
  })

  it('gives a relationship-map config a friendlier element/connection summary instead of a raw blob diff', () => {
    const mine: SavedAnalysis = {
      guid: 'map1',
      toolType: 'relationship-map',
      name: 'Map',
      createdDateTime: '2024-01-01',
      config: {
        elements: [{ id: 'e1', kind: 'code', label: 'A', x: 0, y: 0, width: 10, height: 10 }],
        freeTexts: [],
        connections: [],
        pan: { x: 0, y: 0 }
      }
    }
    const theirs: SavedAnalysis = {
      ...mine,
      config: {
        elements: [
          { id: 'e1', kind: 'code', label: 'A', x: 0, y: 0, width: 10, height: 10 },
          { id: 'e2', kind: 'code', label: 'B', x: 0, y: 0, width: 10, height: 10 }
        ],
        freeTexts: [],
        connections: [{ id: 'c1', fromId: 'e1', toId: 'e2', arrowFrom: false, arrowTo: true, label: '' }],
        pan: { x: 0, y: 0 }
      }
    }
    const diff = diffProjects(side(emptyProject({ savedAnalyses: [mine] })), side(emptyProject({ savedAnalyses: [theirs] })))
    expect(diff.savedAnalyses[0].relationshipMapSummary).toEqual({
      addedElements: 1,
      removedElements: 0,
      addedConnections: 1,
      removedConnections: 0
    })
  })

  it('reports no diff for two identical saved analyses', () => {
    const analysis: SavedAnalysis = { guid: 'sa1', toolType: 'code-frequencies', name: 'Freq', config: { sort: 'asc' }, createdDateTime: '2024-01-01' }
    const diff = diffProjects(side(emptyProject({ savedAnalyses: [analysis] })), side(emptyProject({ savedAnalyses: [{ ...analysis }] })))
    expect(diff.savedAnalyses).toEqual([])
  })
})
