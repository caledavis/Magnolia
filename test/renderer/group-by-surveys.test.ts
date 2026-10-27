import { describe, it, expect } from 'vitest'
import { buildSurveyAwareColumns } from '../../src/renderer/components/Analysis/survey-grouping'
import { groupByKey, mergeGroupBy, type GroupByEntry } from '../../src/renderer/components/Analysis/group-by'
import type { AnalysisInitData } from '../../src/renderer/models/types'

const data = {
  sources: [
    { guid: 'sA', name: 'Survey A', sourceType: 'survey' },
    { guid: 'sB', name: 'Survey B', sourceType: 'survey' },
    { guid: 'doc', name: 'Interview.txt' },
    { guid: 'note', name: '261027 14:32 - Market', sourceType: 'note' }
  ],
  surveyEntityLabels: {
    sA: { respondents: { r1: 'A1', r2: 'A2' }, questions: {} },
    sB: { respondents: { r1: 'B1' }, questions: {} }
  },
  folders: [{ guid: 'nb', name: 'Field notes', parentGuid: null, kind: 'notebook' }],
  tags: [], categories: [], tagMembers: {}, sourceFolder: { note: 'nb' }
} as unknown as AnalysisInitData
const names = new Map(data.sources.map((s) => [s.guid, s.name]))
const labels = (groupBy: GroupByEntry[]) =>
  buildSurveyAwareColumns(groupBy, data, ['sA', 'sB', 'doc'], names, { includeSubtotals: false }).columns.map((c) => c.label)

describe('Respondents grouping per survey', () => {
  it('collapses only the surveys that have a chip', () => {
    expect(labels([{ kind: 'respondents', surveyGuid: 'sA' }])).toEqual(['B1', 'Survey A', 'Interview.txt'])
    expect(labels([{ kind: 'respondents', surveyGuid: 'sB' }])).toEqual(['A1', 'A2', 'Survey B', 'Interview.txt'])
  })

  it('expands every survey with no chips, and collapses all with one each', () => {
    expect(labels([])).toEqual(['A1', 'A2', 'B1', 'Interview.txt'])
    expect(labels([{ kind: 'respondents', surveyGuid: 'sA' }, { kind: 'respondents', surveyGuid: 'sB' }]))
      .toEqual(['Survey A', 'Survey B', 'Interview.txt'])
  })

  it('treats a saved chip with no survey as covering every survey', () => {
    expect(labels([{ kind: 'respondents' }])).toEqual(['Survey A', 'Survey B', 'Interview.txt'])
  })

  const cols = (groupBy: GroupByEntry[]) => buildSurveyAwareColumns(groupBy, data, ['sA', 'doc', 'note'], names, { includeSubtotals: false })
    .columns.map((c) => [c.label, c.sourceGuids])

  it('shows a notebook with its chip as one total, and leaves other documents in their own columns', () => {
    expect(cols([{ kind: 'respondents', surveyGuid: 'sA' }, { kind: 'folder', folderGuid: 'nb' }])).toEqual([
      ['Field notes', ['note']],
      ['Survey A', ['sA']],
      ['Interview.txt', ['doc']]
    ])
  })

  it('expands a notebook without its chip into its notes, newest first, like a survey into respondents', () => {
    const twoNotes = {
      ...data,
      sources: [...data.sources, { guid: 'note2', name: '261101 08:00 - Later', sourceType: 'note' }],
      sourceFolder: { note: 'nb', note2: 'nb' }
    } as unknown as AnalysisInitData
    const built = buildSurveyAwareColumns([], twoNotes, ['note', 'note2', 'doc'], new Map(twoNotes.sources.map((s) => [s.guid, s.name])))
    expect(built.columns.map((c) => c.label)).toEqual(['261101 08:00 - Later', '261027 14:32 - Market', 'Subtotal', 'Interview.txt'])
    expect(built.headerGroups[0]).toEqual({ id: 'notebook:nb', label: 'Field notes', span: 3 })
  })

  it('gathers documents into Other only for a grouping the user chose, keeping surveys out of it', () => {
    const withTag = { ...data, tags: [{ guid: 't', name: 'Tag' }], tagMembers: { t: [] } } as unknown as AnalysisInitData
    const columns = buildSurveyAwareColumns(
      [{ kind: 'respondents', surveyGuid: 'sA' }, { kind: 'folder', folderGuid: 'nb' }, { kind: 'tag', tagGuid: 't' }],
      withTag, ['sA', 'doc', 'note'], names, { includeSubtotals: false }
    ).columns.map((c) => [c.label, c.sourceGuids])
    expect(columns).toEqual([
      ['Field notes', ['note']],
      ['Tag', []],
      ['Survey A', ['sA']],
      ['Other', ['doc']]
    ])
  })

  it('keeps one chip per survey', () => {
    const merged = mergeGroupBy([{ kind: 'respondents', surveyGuid: 'sA' }], [
      { kind: 'respondents', surveyGuid: 'sA' },
      { kind: 'respondents', surveyGuid: 'sB' }
    ])
    expect(merged.map(groupByKey)).toEqual(['r:sA', 'r:sB'])
  })
})
