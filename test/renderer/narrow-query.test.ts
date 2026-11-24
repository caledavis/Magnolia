import { describe, it, expect } from 'vitest'
import { executeQuery } from '../../src/renderer/utils/query-engine'
import { narrowQueryToCell, cellOfColumns, type GridColumn } from '../../src/renderer/utils/narrow-query'
import { resultsInColumn } from '../../src/renderer/components/Analysis/analysis-helpers'
import { tagMembershipFromTags } from '../../src/renderer/utils/survey-cell-scope'
import type { Code, PlainTextSelection, QDASet, Query, QueryResult, SurveyCellScopeArgs, SurveyEntityRef, TextSource } from '../../src/renderer/models/types'

// Clicking a number in Results in Documents must show exactly the results
// counted there: the query run with its own filter, then sorted into the
// column. These run both ways over a project of documents and a survey and
// compare.

const X = 'code-x'
const codes = [{ guid: X, name: 'X', children: [] }] as unknown as Code[]
let n = 0
const coded = (surveyCell?: { respondentId: string; questionId: string }): PlainTextSelection => {
  n++
  return { guid: `sel-${n}`, startPosition: n, endPosition: n + 1, codings: [{ guid: `c-${n}`, codeGuid: X }], ...(surveyCell ? { surveyCell } : {}) } as PlainTextSelection
}
const doc = (guid: string): TextSource =>
  ({ guid, name: guid, sourceType: 'text', plainTextContent: 'x'.repeat(200), selections: [coded(), coded()] }) as unknown as TextSource
const respondents = ['r1', 'r2', 'r3', 'r4']
const questions = ['q1', 'q2']
const survey = {
  guid: 's1', name: 'Survey', sourceType: 'survey', plainTextContent: 'x'.repeat(200),
  selections: respondents.flatMap((r) => questions.map((q) => coded({ respondentId: r, questionId: q })))
} as unknown as TextSource
const sources = [doc('d1'), doc('d2'), doc('d3'), survey]

const ref = (id: string): SurveyEntityRef => ({ sourceGuid: 's1', id })
const tag = (guid: string, docs: string[], resp: string[] = [], quest: string[] = []): QDASet => ({
  guid, name: guid, memberSourceGuids: docs, memberCodeGuids: [],
  memberSurveyRespondents: resp.map(ref), memberSurveyQuestions: quest.map(ref)
})
const tags = [
  tag('A', ['d1', 'd2'], ['r1', 'r2']),     // documents and respondents
  tag('T', ['d2', 'd3'], ['r2', 'r3']),     // documents and respondents
  tag('Q', [], [], ['q1']),                  // questions only
  tag('M', [], ['r4'], ['q2']),              // respondents AND questions of one survey
  tag('W', ['s1'])                           // the whole survey
]
const membership = tagMembershipFromTags(tags)
const data = {
  tagMembers: membership.sourceMembersByTag,
  respondentTagMembers: membership.respondentMembersByTag,
  questionTagMembers: membership.questionMembersByTag
}

const run = (q: Query): QueryResult[] => executeQuery(q, sources, {}, codes, tags)
const ids = (rs: QueryResult[]) => rs.map((r) => `${r.sourceGuid}:${r.selectionGuid}`).sort()
const tagDocs = (t: string) => {
  const m = tags.find((x) => x.guid === t)!
  return [...new Set([...m.memberSourceGuids, ...(m.memberSurveyRespondents ?? []).map((r) => r.sourceGuid), ...(m.memberSurveyQuestions ?? []).map((r) => r.sourceGuid)])]
}

const condition = { type: 'code', codeGuid: X } as const
const queries: Record<string, Query> = {
  unfiltered: { documentFilter: {}, codeCondition: condition },
  taggedA: { documentFilter: { tagGuids: ['A'] }, codeCondition: condition },
  taggedQ: { documentFilter: { tagGuids: ['Q'] }, codeCondition: condition },
  someDocuments: { documentFilter: { sourceGuids: ['d1', 'd2', 's1'] }, codeCondition: condition },
  question1: { documentFilter: { questionScope: [ref('q1')] }, codeCondition: condition },
  threeRespondents: { documentFilter: { respondentScope: [ref('r1'), ref('r2'), ref('r3')] }, codeCondition: condition },
  taggedAQuestion2: { documentFilter: { tagGuids: ['A'], questionScope: [ref('q2')] }, codeCondition: condition },
  excludingT: { documentFilter: { tagExcludeGuids: ['T'] }, codeCondition: condition }
}
const columns: Record<string, GridColumn> = {
  d1: { sourceGuids: ['d1'] },
  d2: { sourceGuids: ['d2'] },
  survey: { sourceGuids: ['s1'] },
  tagT: { sourceGuids: tagDocs('T'), tagScopeGuids: ['T'] },
  tagA: { sourceGuids: tagDocs('A'), tagScopeGuids: ['A'] },
  tagQ: { sourceGuids: tagDocs('Q'), tagScopeGuids: ['Q'] },
  tagM: { sourceGuids: tagDocs('M'), tagScopeGuids: ['M'] },
  tagW: { sourceGuids: tagDocs('W'), tagScopeGuids: ['W'] },
  respondent2: { sourceGuids: ['s1'], respondentRef: ref('r2') }
}
const analysisScopes: Record<string, SurveyEntityRef[] | undefined> = { none: undefined, question2: [ref('q2')] }

/** What the analysis counts in a column (see ResultsInDocuments). */
function counted(q: Query, cols: GridColumn[], questionScope?: SurveyEntityRef[]): string[] {
  const inScope = (r: QueryResult) => !questionScope || !r.surveyCell || questionScope.some((s) => s.sourceGuid === r.sourceGuid && s.id === r.surveyCell!.questionId) || !questionScope.some((s) => s.sourceGuid === r.sourceGuid)
  const results = run(q).filter(inScope)
  return [...new Set(cols.filter((c) => !c.isSubtotal).flatMap((c) => ids(resultsInColumn(results, c, data))))].sort()
}
/** The scope a column's click sends (see surveyScope in ResultsInDocuments). */
function scopeOf(col: GridColumn, questionScope?: SurveyEntityRef[]): SurveyCellScopeArgs | undefined {
  const s: SurveyCellScopeArgs = {}
  if (questionScope) s.questionScope = questionScope
  if (col.respondentRef) s.respondentScope = [col.respondentRef]
  if (col.tagScopeGuids?.length) s.tagGuids = col.tagScopeGuids
  return s.questionScope || s.respondentScope || s.tagGuids ? s : undefined
}
const shown = (narrowed: Query | null) => (narrowed ? ids(run(narrowed)) : [])

describe('narrowQueryToCell', () => {
  for (const [qName, q] of Object.entries(queries)) {
    for (const [cName, col] of Object.entries(columns)) {
      for (const [sName, questionScope] of Object.entries(analysisScopes)) {
        it(`shows what was counted: ${qName} in ${cName} (questions: ${sName})`, () => {
          const narrowed = narrowQueryToCell(q, { sourceGuids: col.sourceGuids, scope: scopeOf(col, questionScope) }, membership)
          expect(shown(narrowed)).toEqual(counted(q, [col], questionScope))
        })
      }
    }
  }

  it('keeps the rest of the query', () => {
    const q: Query = { documentFilter: { tagGuids: ['A'], folderGuids: ['f'], tagExcludeGuids: ['Q'] }, codeCondition: condition, within: [queries.unfiltered] }
    const narrowed = narrowQueryToCell(q, { sourceGuids: ['d1'] }, membership)!
    expect(narrowed.within).toEqual(q.within)
    expect(narrowed.codeCondition).toEqual(condition)
    expect(narrowed.documentFilter).toMatchObject({ sourceGuids: ['d1'], tagGuids: ['A'], folderGuids: ['f'], tagExcludeGuids: ['Q'] })
  })

  it('reports a cell nothing of the query can be in', () => {
    expect(narrowQueryToCell(queries.someDocuments, { sourceGuids: ['d3'] }, membership)).toBeNull()
    expect(narrowQueryToCell(queries.question1, { sourceGuids: ['s1'], scope: { questionScope: [ref('q2')] } }, membership)).toBeNull()
  })

  it('falls back to more, never less, when both sides’ tags mix respondents and questions', () => {
    const q: Query = { documentFilter: { tagGuids: ['M'] }, codeCondition: condition }
    const narrowed = narrowQueryToCell(q, { sourceGuids: tagDocs('M'), scope: { tagGuids: ['M'] } }, membership)
    const want = counted(q, [columns.tagM])
    expect(shown(narrowed)).toEqual(expect.arrayContaining(want))
  })
})

describe('cellOfColumns (totals)', () => {
  const groupings: Record<string, GridColumn[]> = {
    documents: [columns.d1, columns.d2, { sourceGuids: ['d3'] }, columns.survey],
    byTagT: [columns.tagT, { sourceGuids: ['d1'] }],
    byTagsAandT: [columns.tagA, columns.tagT, { sourceGuids: tagDocs('A'), tagScopeGuids: ['A', 'T'], isSubtotal: true }],
    byQuestionTag: [columns.tagQ, { sourceGuids: ['d1', 'd2', 'd3'] }],
    respondents: [columns.respondent2, { sourceGuids: ['s1'], respondentRef: ref('r4') }, columns.d1],
    respondentAndQuestionTags: [columns.tagT, columns.tagQ]
  }
  for (const [qName, q] of Object.entries(queries)) {
    for (const [gName, cols] of Object.entries(groupings)) {
      for (const [sName, questionScope] of Object.entries(analysisScopes)) {
        it(`a total shows what it adds up, or more only where unavoidable: ${qName} grouped ${gName} (questions: ${sName})`, () => {
          const cell = cellOfColumns(cols, questionScope, membership)
          const got = shown(narrowQueryToCell(q, cell, membership))
          const want = counted(q, cols, questionScope)
          if (gName === 'respondentAndQuestionTags') {
            // One column limits the survey to respondents, another to
            // questions: their union isn't a scope, so the survey is
            // taken whole.
            expect(got).toEqual(expect.arrayContaining(want))
          } else {
            expect(got).toEqual(want)
          }
        })
      }
    }
  }
})
