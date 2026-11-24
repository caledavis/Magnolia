import { describe, it, expect, beforeEach } from 'vitest'
import { codeAllResults } from '../../src/renderer/app/code-results'
import { useDocumentStore } from '../../src/renderer/stores/document-store'
import { useQueryStore } from '../../src/renderer/stores/query-store'
import type { QueryResult, TextSource } from '../../src/renderer/models/types'

// "Code all results": a text match in a survey answer is positioned within
// that answer, so the passage it becomes must be in that answer too.

const result = (r: Partial<QueryResult>): QueryResult =>
  ({ selectionGuid: '', sourceGuid: '', sourceName: '', startPosition: 0, endPosition: 0, matchedText: '', matchedCodes: [], ...r }) as QueryResult

describe('codeAllResults', () => {
  beforeEach(() => {
    useDocumentStore.setState({
      sources: [
        { guid: 'survey', name: 'Survey', sourceType: 'survey', selections: [] },
        { guid: 'doc', name: 'Doc', sourceType: 'text', selections: [{ guid: 'existing', startPosition: 0, endPosition: 4, codings: [] }] }
      ] as unknown as TextSource[],
      sourceContents: { doc: 'some text' }
    })
    useQueryStore.setState({
      results: [
        result({ selectionGuid: 'text-match-survey-r2-q1-5', sourceGuid: 'survey', startPosition: 5, endPosition: 9, matchedText: 'debt', surveyCell: { respondentId: 'r2', questionId: 'q1' } }),
        result({ selectionGuid: 'text-match-doc-5', sourceGuid: 'doc', startPosition: 5, endPosition: 9, matchedText: 'text' }),
        result({ selectionGuid: 'existing', sourceGuid: 'doc', startPosition: 0, endPosition: 4, matchedText: 'some' })
      ]
    })
  })

  it('codes a survey text match in its answer, and the others where they are', () => {
    codeAllResults('code-1')
    const sel = (guid: string) => useDocumentStore.getState().sources.find((s) => s.guid === guid)!.selections
    const [inSurvey] = sel('survey')
    expect(inSurvey).toMatchObject({ startPosition: 5, endPosition: 9, surveyCell: { respondentId: 'r2', questionId: 'q1' } })
    expect(inSurvey.codings.map((c) => c.codeGuid)).toEqual(['code-1'])
    const docSels = sel('doc')
    expect(docSels.find((s) => s.guid === 'existing')!.codings.map((c) => c.codeGuid)).toEqual(['code-1'])
    const made = docSels.find((s) => s.guid !== 'existing')!
    expect(made).toMatchObject({ startPosition: 5, endPosition: 9 })
    expect(made.surveyCell).toBeUndefined()
  })
})
