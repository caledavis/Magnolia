import { describe, it, expect } from 'vitest'
import {
  buildDisplayRows,
  countInScope,
  liveLeafKeys,
  mergeRowEntries,
  moveItem,
  queryArgsForScope,
  summaryKey,
  type SummaryData,
  type SummaryRowEntry
} from '../../src/renderer/components/Analysis/framework-matrix-model'

const CODE = 'code-a'

function sel(guid: string, codeGuid: string, respondentId?: string): any {
  return {
    guid,
    startPosition: 0,
    endPosition: 5,
    codings: [{ guid: `c-${guid}`, codeGuid }],
    ...(respondentId ? { surveyCell: { respondentId, questionId: 'q1' } } : {})
  }
}

function makeData(overrides: Partial<SummaryData> = {}): SummaryData {
  return {
    sources: [
      { guid: 'd1', name: 'Interview 1' },
      { guid: 'd2', name: 'Interview 2' },
      { guid: 'd3', name: 'Interview 3' },
      { guid: 's1', name: 'Survey', sourceType: 'survey' }
    ],
    tags: [
      { guid: 't1', name: 'Teachers', categoryGuid: 'cat1' },
      { guid: 't2', name: 'Students', categoryGuid: 'cat1' }
    ],
    categories: [{ guid: 'cat1', name: 'Role' }],
    folders: [
      { guid: 'f1', name: 'Wave 1', parentGuid: null },
      { guid: 'f2', name: 'Sub', parentGuid: 'f1' }
    ],
    sourceFolder: { d1: 'f1', d3: 'f2' },
    tagMembers: { t1: ['d1', 'd2'], t2: ['d2'] },
    respondentTagMembers: { t2: [{ sourceGuid: 's1', id: 'r1' }] },
    surveyEntityLabels: { s1: { respondents: { r1: 'Alice', r2: 'Bob' }, questions: { q1: 'How was it?' } } },
    sourceSelections: {
      d1: [sel('a', CODE), sel('b', CODE), sel('c', 'other')],
      d2: [sel('d', CODE)],
      d3: [],
      s1: [sel('e', CODE, 'r1'), sel('f', CODE, 'r2')]
    },
    ...overrides
  } as SummaryData
}

const config = (rows: SummaryRowEntry[], extra: { summaries?: Record<string, string>; collapsed?: string[] } = {}) => ({
  rows,
  codeGuids: [CODE],
  summaries: extra.summaries ?? {},
  collapsed: extra.collapsed ?? []
})

describe('framework matrix rows', () => {
  it('nests a tag’s documents and respondents under it', () => {
    const rows = buildDisplayRows(makeData(), config([{ kind: 'tag', tagGuid: 't2' }]))
    expect(rows.map((r) => [r.depth, r.key, r.label])).toEqual([
      [0, 'tag:t2', 'Students'],
      [1, 'doc:d2', 'Interview 2'],
      [1, 'resp:s1:r1', 'Alice']
    ])
    expect(rows[0].memberCount).toBe(2)
  })

  it('collapsed groups show only their header', () => {
    const rows = buildDisplayRows(makeData(), config([{ kind: 'tag', tagGuid: 't1' }], { collapsed: ['tag:t1'] }))
    expect(rows.map((r) => r.key)).toEqual(['tag:t1'])
  })

  it('nests categories as category → tag → documents', () => {
    const rows = buildDisplayRows(makeData(), config([{ kind: 'category', categoryGuid: 'cat1' }]))
    expect(rows.map((r) => `${r.depth}:${r.key}`)).toEqual([
      '0:category:cat1',
      '1:tag:t1', '2:doc:d1', '2:doc:d2',
      '1:tag:t2', '2:doc:d2', '2:resp:s1:r1'
    ])
    // d2 is in both tags but counted once in the category.
    expect(rows[0].memberCount).toBe(3)
  })

  it('folders include documents in subfolders', () => {
    const rows = buildDisplayRows(makeData(), config([{ kind: 'folder', folderGuid: 'f1' }]))
    expect(rows.map((r) => r.key)).toEqual(['folder:f1', 'doc:d1', 'doc:d3'])
  })

  it('a document under two tags shares one summary key', () => {
    const rows = buildDisplayRows(makeData(), config([{ kind: 'tag', tagGuid: 't1' }, { kind: 'tag', tagGuid: 't2' }]))
    const d2 = rows.filter((r) => r.key === 'doc:d2')
    expect(d2).toHaveLength(2)
    expect(new Set(d2.map((r) => r.path)).size).toBe(2)
  })

  it('keeps a remembered member with text as an orphan once it leaves the tag', () => {
    const data = makeData({ tagMembers: { t1: ['d1'], t2: ['d2'] } })
    const entry: SummaryRowEntry = { kind: 'tag', tagGuid: 't1', kept: ['doc:d2'] }
    const withText = buildDisplayRows(data, config([entry], { summaries: { [summaryKey('doc:d2', CODE)]: 'Notes' } }))
    expect(withText.map((r) => [r.key, r.orphanOf])).toEqual([['tag:t1', undefined], ['doc:d1', undefined], ['doc:d2', 'tag']])
    // Without text there is nothing to preserve, so it simply disappears.
    const noText = buildDisplayRows(data, config([entry]))
    expect(noText.map((r) => r.key)).toEqual(['tag:t1', 'doc:d1'])
  })

  it('reports live leaf keys for groups', () => {
    expect(liveLeafKeys(makeData(), { kind: 'tag', tagGuid: 't2' })).toEqual(['doc:d2', 'resp:s1:r1'])
  })

  it('dedups dropped entries', () => {
    const prev: SummaryRowEntry[] = [{ kind: 'doc', sourceGuid: 'd1' }]
    const next = mergeRowEntries(prev, [{ kind: 'doc', sourceGuid: 'd1' }, { kind: 'tag', tagGuid: 't1' }])
    expect(next).toHaveLength(2)
    expect(mergeRowEntries(next, [{ kind: 'tag', tagGuid: 't1' }])).toBe(next)
  })
})

const scope = (docs: string[], respondents: { sourceGuid: string; id: string }[] = [], questions: { sourceGuid: string; id: string }[] = []) =>
  ({ docs, respondents, questions })

describe('framework matrix counts and queries', () => {
  it('counts the code within documents, respondents and questions', () => {
    const data = makeData()
    expect(countInScope(data, scope(['d1']), CODE)).toBe(2)
    expect(countInScope(data, scope([], [{ sourceGuid: 's1', id: 'r1' }]), CODE)).toBe(1)
    expect(countInScope(data, scope([], [], [{ sourceGuid: 's1', id: 'q1' }]), CODE)).toBe(2)
    expect(countInScope(data, scope(['d3']), CODE)).toBe(0)
  })

  it('counts a survey cell once when both its respondent and question are in scope', () => {
    expect(countInScope(makeData(), scope([], [{ sourceGuid: 's1', id: 'r1' }], [{ sourceGuid: 's1', id: 'q1' }]), CODE)).toBe(2)
  })

  it('a group’s count covers all its members', () => {
    const [group] = buildDisplayRows(makeData(), config([{ kind: 'tag', tagGuid: 't2' }]))
    expect(countInScope(makeData(), group.scope, CODE)).toBe(2)
  })

  it('scopes single respondent and question rows to that entity', () => {
    expect(queryArgsForScope(scope(['d1']))).toEqual({ sourceGuids: ['d1'] })
    expect(queryArgsForScope(scope([], [{ sourceGuid: 's1', id: 'r1' }]))).toEqual({
      sourceGuids: ['s1'],
      cellScope: { respondentScope: [{ sourceGuid: 's1', id: 'r1' }] }
    })
    expect(queryArgsForScope(scope([], [], [{ sourceGuid: 's1', id: 'q1' }]))).toEqual({
      sourceGuids: ['s1'],
      cellScope: { questionScope: [{ sourceGuid: 's1', id: 'q1' }] }
    })
    expect(queryArgsForScope(scope([]))).toBeNull()
  })

  it('scopes tag groups by their tag, so tagged respondents and questions union', () => {
    const data = makeData({ questionTagMembers: { t2: [{ sourceGuid: 's1', id: 'q2' }] } })
    const [group] = buildDisplayRows(data, config([{ kind: 'tag', tagGuid: 't2' }]))
    expect(queryArgsForScope(group.scope)).toEqual({ sourceGuids: ['d2', 's1'], cellScope: { tagGuids: ['t2'] } })
  })
})

describe('framework matrix question rows', () => {
  it('nests a tag’s questions under it, after its respondents', () => {
    const data = makeData({ questionTagMembers: { t2: [{ sourceGuid: 's1', id: 'q1' }] } })
    const rows = buildDisplayRows(data, config([{ kind: 'tag', tagGuid: 't2' }]))
    expect(rows.map((r) => [r.key, r.label, r.detail])).toEqual([
      ['tag:t2', 'Students', undefined],
      ['doc:d2', 'Interview 2', undefined],
      ['resp:s1:r1', 'Alice', 'Survey'],
      ['quest:s1:q1', 'How was it?', 'Survey']
    ])
  })

  it('shows a dropped question with its survey as detail', () => {
    const [row] = buildDisplayRows(makeData(), config([{ kind: 'question', sourceGuid: 's1', questionId: 'q1' }]))
    expect([row.key, row.label, row.detail, row.icon]).toEqual(['quest:s1:q1', 'How was it?', 'Survey', 'question'])
  })
})

describe('moveItem', () => {
  const arr = ['a', 'b', 'c', 'd']
  it('moves an item before the insertion point', () => {
    expect(moveItem(arr, 3, 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(moveItem(arr, 0, 2)).toEqual(['b', 'a', 'c', 'd'])
    expect(moveItem(arr, 1, 4)).toEqual(['a', 'c', 'd', 'b'])
  })
  it('returns the same array for a no-op move', () => {
    expect(moveItem(arr, 1, 1)).toBe(arr)
    expect(moveItem(arr, 1, 2)).toBe(arr)
  })
})
