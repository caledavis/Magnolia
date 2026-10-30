import { describe, it, expect } from 'vitest'
import { NONE_CHOSEN, chosenEntries, chosenIds, scopeSummary, withSurveyEntity, withSurveyIds } from '../../src/renderer/components/DocumentSelector/SurveyScope'
import { documentFilterFromConfig, documentsSummary } from '../../src/renderer/components/Analysis/documents-filter'
import { emptyDocumentFilter } from '../../src/renderer/utils/document-graph'
import { applySurveyCellScope } from '../../src/renderer/components/Analysis/analysis-helpers'
import type { AnalysisInitData, PlainTextSelection } from '../../src/renderer/models/types'

describe('survey scope helpers', () => {
  const scope = [{ sourceGuid: 's1', id: 'q1' }, { sourceGuid: 's2', id: 'q9' }]

  it('reads and replaces one survey’s choices', () => {
    expect([...chosenIds(scope, 's1')]).toEqual(['q1'])
    expect(chosenIds(scope, 's3').size).toBe(0)
    expect(withSurveyIds(scope, 's1', ['q2', 'q3'])).toEqual([
      { sourceGuid: 's2', id: 'q9' }, { sourceGuid: 's1', id: 'q2' }, { sourceGuid: 's1', id: 'q3' }
    ])
    expect(withSurveyIds(scope, 's1', [])).toEqual([{ sourceGuid: 's2', id: 'q9' }])
  })

  it('summarises a survey’s choices', () => {
    const ids = ['q1', 'q2', 'q3']
    expect(scopeSummary('questions', new Set(), ids)).toBe('All questions')
    expect(scopeSummary('questions', new Set(['q2']), ids)).toBe('1 of 3 questions')
    expect(scopeSummary('respondents', new Set(ids), ids)).toBe('All respondents')
    expect(scopeSummary('questions', new Set([NONE_CHOSEN]), ids)).toBe('No questions')
  })

  it('adds a dropped question, replacing "none"', () => {
    const none = withSurveyIds(scope, 's1', [NONE_CHOSEN])
    expect(withSurveyEntity(none, { sourceGuid: 's1', id: 'q4' })).toEqual([{ sourceGuid: 's2', id: 'q9' }, { sourceGuid: 's1', id: 'q4' }])
    expect(withSurveyEntity(scope, { sourceGuid: 's1', id: 'q1' })).toEqual([{ sourceGuid: 's2', id: 'q9' }, { sourceGuid: 's1', id: 'q1' }])
    expect(chosenEntries(none)).toEqual([{ sourceGuid: 's2', id: 'q9' }])
  })
})

describe('documentsSummary', () => {
  it('counts documents, and any questions or respondents chosen', () => {
    expect(documentsSummary(9, 9)).toBe('All 9 documents')
    expect(documentsSummary(1, 1)).toBe('All 1 document')
    expect(documentsSummary(4, 9, { questionScope: [{ sourceGuid: 's', id: 'q' }] })).toBe('4 of 9 documents · 1 question')
    expect(documentsSummary(9, 9, {
      questionScope: [{ sourceGuid: 's', id: 'q1' }, { sourceGuid: 's', id: 'q2' }],
      respondentScope: [{ sourceGuid: 's', id: 'r1' }]
    })).toBe('All 9 documents · 2 questions · 1 respondent')
    expect(documentsSummary(9, 9, { questionScope: [{ sourceGuid: 's', id: NONE_CHOSEN }] })).toBe('All 9 documents · no questions')
  })
})

describe('documentFilterFromConfig', () => {
  it('moves an older analysis’s Questions box into the filter', () => {
    const docFilter = { ...emptyDocumentFilter(), sourceGuids: ['s'] }
    const migrated = documentFilterFromConfig({ docFilter, questionScope: [{ sourceGuid: 's', id: 'q', label: 'Why?' } as any] })
    expect(migrated).toEqual({ ...docFilter, questionScope: [{ sourceGuid: 's', id: 'q' }] })
  })

  it('leaves a current filter alone', () => {
    const docFilter = { ...emptyDocumentFilter(), questionScope: [{ sourceGuid: 's', id: 'q2' }] }
    expect(documentFilterFromConfig({ docFilter, questionScope: [{ sourceGuid: 's', id: 'q1' }] })).toBe(docFilter)
    expect(documentFilterFromConfig({ docFilter: emptyDocumentFilter() })).toEqual(emptyDocumentFilter())
    expect(documentFilterFromConfig(undefined)).toEqual(emptyDocumentFilter())
  })
})

describe('applySurveyCellScope with chosen questions and respondents', () => {
  const sel = (guid: string, respondentId: string, questionId: string): PlainTextSelection =>
    ({ guid, startPosition: 0, endPosition: 3, codings: [{ guid: `c-${guid}`, codeGuid: 'A' }], surveyCell: { respondentId, questionId } }) as PlainTextSelection
  const data = {
    toolType: 'code-frequencies', theme: '', folders: [], codes: [], tags: [], categories: [], tagMembers: {},
    sources: [{ guid: 's1', name: 'Survey', sourceType: 'survey' }, { guid: 'doc', name: 'Doc.txt', sourceType: 'text' }],
    sourceContents: {},
    sourceSelections: {
      s1: [sel('a', 'r1', 'q1'), sel('b', 'r1', 'q2'), sel('c', 'r2', 'q1'), sel('d', 'r2', 'q2')],
      doc: [{ guid: 'e', startPosition: 0, endPosition: 3, codings: [{ guid: 'ce', codeGuid: 'A' }] } as PlainTextSelection]
    }
  } as unknown as AnalysisInitData

  it('keeps only the chosen cells of the survey, and every other document', () => {
    const scoped = applySurveyCellScope(data, {
      ...emptyDocumentFilter(),
      questionScope: [{ sourceGuid: 's1', id: 'q1' }],
      respondentScope: [{ sourceGuid: 's1', id: 'r2' }]
    })
    expect(scoped.sourceSelections.s1.map((s) => s.guid)).toEqual(['c'])
    expect(scoped.sourceSelections.doc.map((s) => s.guid)).toEqual(['e'])
  })

  it('keeps none of a survey’s cells when none of its questions are chosen', () => {
    const scoped = applySurveyCellScope(data, { ...emptyDocumentFilter(), questionScope: [{ sourceGuid: 's1', id: NONE_CHOSEN }] })
    expect(scoped.sourceSelections.s1).toEqual([])
    expect(scoped.sourceSelections.doc.map((s) => s.guid)).toEqual(['e'])
  })
})
