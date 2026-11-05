import { describe, it, expect } from 'vitest'
import { memoPlacer, groupMemos, memoMatches, type MemoLookups } from '../../src/renderer/utils/memo-places'
import type { Memo } from '../../src/renderer/models/types'

const memo = (guid: string, type: Memo['type'], extra: Partial<Memo> = {}): Memo => ({
  guid, type, title: guid, content: '', createdDateTime: '2026-11-01T10:00:00Z', ...extra
})

const lookups: MemoLookups = {
  sources: [
    { guid: 'mia', name: 'Interview - Mia.txt', plainTextContent: 'I work two jobs to pay the rent every single month without fail.' },
    { guid: 'cv', name: 'CV.pdf' },
    {
      guid: 'survey', name: 'Student Survey',
      formatData: { survey: { questions: [{ id: 'q1', text: 'How do you pay for your studies?' }], respondents: [{ id: 'r1', displayName: 'Ana' }] } }
    }
  ],
  savedQueries: [{ guid: 'q', name: 'Rent and work' }],
  savedAnalyses: [{ guid: 'map', name: 'Pressures', toolType: 'relationship-map' }, { guid: 'cid', name: 'By student type', toolType: 'codes-in-documents' }]
}
const place = memoPlacer(lookups)

describe('memoPlacer', () => {
  it('puts project memos in the Project group', () => {
    expect(place(memo('p', 'project'))).toMatchObject({ groupKey: 'project', groupLabel: 'Project', canShow: false })
  })

  it('lists document and selection memos under their document, with the chosen text', () => {
    expect(place(memo('d', 'document', { sourceGuids: ['mia', 'cv'] }))).toMatchObject({
      groupKey: 'doc:mia', groupLabel: 'Interview - Mia.txt', detail: 'Document memo (also on 1 other document)', canShow: true
    })
    expect(place(memo('s', 'content', { sourceGuid: 'mia', startPosition: 2, endPosition: 15 })).detail).toBe('Selection: “work two jobs”')
    const fromStore = memoPlacer({ ...lookups, contents: { mia: 'Rent is the hardest part.' } })
    expect(fromStore(memo('s', 'content', { sourceGuid: 'mia', startPosition: 0, endPosition: 4 })).detail).toBe('Selection: “Rent”')
    expect(place(memo('r', 'content', { sourceGuid: 'cv', pdfRegion: { page: 3 } as Memo['pdfRegion'] })).detail).toBe('Region on page 3')
  })

  it('shortens long selections', () => {
    const text = 'x'.repeat(100)
    const p = memoPlacer({ ...lookups, sources: [{ guid: 'long', name: 'Long', plainTextContent: text }] })
    expect(p(memo('s', 'content', { sourceGuid: 'long', startPosition: 0, endPosition: 100 })).detail).toBe(`Selection: “${'x'.repeat(59)}…”`)
  })

  it('names survey questions, respondents and answers', () => {
    expect(place(memo('q', 'survey-question', { sourceGuid: 'survey', questionGuid: 'q1' })).detail).toBe('Question: How do you pay for your studies?')
    expect(place(memo('r', 'survey-respondent', { sourceGuid: 'survey', respondentId: 'r1' })).detail).toBe('Respondent: Ana')
    expect(place(memo('c', 'survey-cell', { sourceGuid: 'survey', surveyCell: { respondentId: 'r1', questionId: 'q1' } })).detail)
      .toBe('Answer of Ana to How do you pay for your studies?')
    expect(place(memo('c', 'survey-cell', { sourceGuid: 'survey', surveyCell: { respondentId: 'r1', questionId: 'q1' } })).groupKey).toBe('doc:survey')
  })

  it('groups query, analysis and map memos, and names what they are on', () => {
    expect(place(memo('sq', 'saved-query', { queryGuid: 'q' }))).toMatchObject({ groupKey: 'queries', detail: 'Query: Rent and work' })
    expect(place(memo('sa', 'saved-analysis', { analysisGuid: 'cid' }))).toMatchObject({ groupKey: 'analyses', detail: 'Analysis: By student type' })
    expect(place(memo('m', 'analysis', { analysisGuid: 'map' }))).toMatchObject({ groupKey: 'map:map', groupLabel: 'Map: Pressures' })
  })

  it('keeps memos whose document has gone, without Show', () => {
    expect(place(memo('d', 'document', { sourceGuids: ['gone'] }))).toMatchObject({ groupLabel: 'Deleted documents', canShow: false })
    expect(place(memo('sq', 'saved-query', { queryGuid: 'gone' })).detail).toBe('A deleted query')
  })
})

describe('groupMemos', () => {
  it('orders groups (project, documents by name, queries, analyses, maps) and memos newest first', () => {
    const memos = [
      memo('map1', 'analysis', { analysisGuid: 'map' }),
      memo('cv1', 'document', { sourceGuids: ['cv'] }),
      memo('mia-old', 'document', { sourceGuids: ['mia'] }),
      memo('mia-new', 'content', { sourceGuid: 'mia', createdDateTime: '2026-11-03T10:00:00Z' }),
      memo('q1', 'saved-query', { queryGuid: 'q' }),
      memo('p1', 'project')
    ]
    const places = Object.fromEntries(memos.map((m) => [m.guid, place(m)]))
    const groups = groupMemos(memos, places)
    expect(groups.map((g) => g.label)).toEqual(['Project', 'CV.pdf', 'Interview - Mia.txt', 'Saved Queries', 'Map: Pressures'])
    expect(groups[2].memos.map((m) => m.guid)).toEqual(['mia-new', 'mia-old'])
  })
})

describe('memoMatches', () => {
  it('searches the title, the text and what the memo is attached to', () => {
    const m = memo('d', 'document', { title: 'Work', content: 'She mentions **rent** often', sourceGuids: ['mia'] })
    const p = place(m)
    expect(memoMatches(m, p, 'work')).toBe(true)
    expect(memoMatches(m, p, 'RENT')).toBe(true)
    expect(memoMatches(m, p, 'mia')).toBe(true)
    expect(memoMatches(m, p, 'loneliness')).toBe(false)
    expect(memoMatches(m, p, '  ')).toBe(true)
  })
})
