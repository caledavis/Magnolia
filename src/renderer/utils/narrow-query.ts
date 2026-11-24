/**
 * A query narrowed to one cell of an analysis grid: the query's own
 * results, only in the cell's documents and survey cells.
 *
 * An analysis counts a query's results under the query's own document
 * filter, then sorts them into its columns. Clicking a number must show
 * exactly those results, so the narrowed query keeps everything the query
 * had (its documents, tags, folders, survey scope and `within`) and adds
 * the cell's limits on top. Every limit narrows: documents are intersected,
 * and survey scopes are intersected survey by survey.
 */
import type { Query, SurveyCellScopeArgs, SurveyEntityRef } from '../models/types'
import type { TagMembership } from './survey-cell-scope'

type DocumentFilter = Query['documentFilter']

/** The cell clicked: its documents, and for surveys the cells it covers. */
export interface GridCell {
  sourceGuids: string[]
  scope?: SurveyCellScopeArgs
}

/** Refs grouped by survey. */
function bySurvey(refs: SurveyEntityRef[] | undefined): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const r of refs ?? []) {
    let ids = out.get(r.sourceGuid)
    if (!ids) out.set(r.sourceGuid, (ids = new Set()))
    ids.add(r.id)
  }
  return out
}

/** Two survey scopes (respondents, or questions) as one: a survey that
 *  only one of them names keeps that one's list (the other doesn't limit
 *  it); a survey both name keeps what's in both. Surveys left with none
 *  are returned in `emptied`: nothing of them is in scope. */
function intersectScopes(
  a: SurveyEntityRef[] | undefined,
  b: SurveyEntityRef[] | undefined
): { refs: SurveyEntityRef[] | undefined; emptied: Set<string> } {
  const ma = bySurvey(a)
  const mb = bySurvey(b)
  const emptied = new Set<string>()
  const refs: SurveyEntityRef[] = []
  for (const survey of new Set([...ma.keys(), ...mb.keys()])) {
    const ia = ma.get(survey)
    const ib = mb.get(survey)
    const ids = ia && ib ? [...ia].filter((id) => ib.has(id)) : [...(ia ?? ib)!]
    if (ids.length === 0) emptied.add(survey)
    for (const id of ids) refs.push({ sourceGuid: survey, id })
  }
  return { refs: refs.length > 0 ? refs : undefined, emptied }
}

/** Tags restated as the documents, respondents and questions they're on,
 *  so they can be combined with other limits by intersecting: a tag filter
 *  can't be, as it takes anything with any of its tags. Null when, in some
 *  survey, the tags are on both respondents and questions: the cells
 *  either covers aren't a respondent scope and a question scope (each of
 *  which limits on its own). */
function tagsAsScopes(
  tags: string[],
  membership: TagMembership
): { sources: Set<string>; respondents: SurveyEntityRef[]; questions: SurveyEntityRef[] } | null {
  const whole = new Set(tags.flatMap((t) => membership.sourceMembersByTag[t] ?? []))
  const resp = tags.flatMap((t) => membership.respondentMembersByTag[t] ?? []).filter((r) => !whole.has(r.sourceGuid))
  const quest = tags.flatMap((t) => membership.questionMembersByTag[t] ?? []).filter((q) => !whole.has(q.sourceGuid))
  const respSurveys = new Set(resp.map((r) => r.sourceGuid))
  if (quest.some((q) => respSurveys.has(q.sourceGuid))) return null
  return {
    sources: new Set([...whole, ...respSurveys, ...quest.map((q) => q.sourceGuid)]),
    respondents: resp,
    questions: quest
  }
}

/**
 * `query` narrowed to `cell`, or null when nothing of it can be in the
 * cell. `query`'s document filter must already be resolved: a document
 * graph turned into the documents it selects (see liveResolveFilter).
 */
export function narrowQueryToCell(query: Query, cell: GridCell, membership: TagMembership): Query | null {
  const own: DocumentFilter = query.documentFilter
  const ownDocs = own.sourceGuids?.length ? new Set(own.sourceGuids) : null
  let docs = cell.sourceGuids.filter((g) => !ownDocs || ownDocs.has(g))
  let respondents = intersectScopes(own.respondentScope, cell.scope?.respondentScope)
  let questions = intersectScopes(own.questionScope, cell.scope?.questionScope)
  let tagGuids = own.tagGuids ?? []

  /** Narrow by tags restated as scopes. */
  const narrowBy = (scopes: NonNullable<ReturnType<typeof tagsAsScopes>>) => {
    docs = docs.filter((g) => scopes.sources.has(g))
    if (scopes.respondents.length > 0) {
      const r = intersectScopes(respondents.refs, scopes.respondents)
      respondents = { refs: r.refs, emptied: new Set([...respondents.emptied, ...r.emptied]) }
    }
    if (scopes.questions.length > 0) {
      const q = intersectScopes(questions.refs, scopes.questions)
      questions = { refs: q.refs, emptied: new Set([...questions.emptied, ...q.emptied]) }
    }
  }

  const cellTags = cell.scope?.tagGuids ?? []
  if (cellTags.length > 0) {
    if (tagGuids.length === 0) {
      // The query has no tags of its own: the cell's are its tag filter.
      tagGuids = cellTags
    } else {
      const cellScopes = tagsAsScopes(cellTags, membership)
      const ownScopes = cellScopes ? null : tagsAsScopes(tagGuids, membership)
      if (cellScopes) narrowBy(cellScopes)
      else if (ownScopes) {
        // The cell's tags can't be restated, but the query's can: they
        // become scopes, and the cell's tags the tag filter.
        narrowBy(ownScopes)
        tagGuids = cellTags
      } else {
        // Neither can (both sets of tags are on respondents and questions
        // of one survey, which is rare): add the cell's tags to the
        // query's, which may show more of that survey than was counted.
        tagGuids = [...new Set([...tagGuids, ...cellTags])]
      }
    }
  }

  // A survey with no respondents (or questions) left in scope has nothing
  // in the cell.
  docs = docs.filter((g) => !respondents.emptied.has(g) && !questions.emptied.has(g))
  // An empty document list means every document to the query engine, so
  // a cell with no documents left is reported as nothing.
  if (docs.length === 0) return null

  const { graph: _graph, ...rest } = own
  const documentFilter: DocumentFilter = { ...rest, sourceGuids: docs }
  if (tagGuids.length > 0) documentFilter.tagGuids = tagGuids
  else delete documentFilter.tagGuids
  if (respondents.refs) documentFilter.respondentScope = respondents.refs
  else delete documentFilter.respondentScope
  if (questions.refs) documentFilter.questionScope = questions.refs
  else delete documentFilter.questionScope
  return { ...query, documentFilter }
}

/** A column of an analysis grid, as resultsInColumn reads it. */
export interface GridColumn {
  sourceGuids: string[]
  isSubtotal?: boolean
  /** For surveys, only the cells these tags cover. */
  tagScopeGuids?: string[]
  /** One survey respondent's cells. */
  respondentRef?: SurveyEntityRef
}

/**
 * The cells of several columns together, as one cell: what a total adds
 * up. Subtotal columns repeat their parts and are left out. A document
 * is in it if any column has it; a survey whole if any column has it
 * whole, otherwise only the respondents (or questions) its columns cover.
 * `questionScope` is the analysis's own (applied to every column).
 */
export function cellOfColumns(
  columns: GridColumn[],
  questionScope: SurveyEntityRef[] | undefined,
  membership: TagMembership
): GridCell {
  const docs = new Set<string>()
  const whole = new Set<string>()
  const respondents = new Map<string, SurveyEntityRef[]>()
  const questions = new Map<string, SurveyEntityRef[]>()
  const add = (into: Map<string, SurveyEntityRef[]>, refs: SurveyEntityRef[]) => {
    for (const r of refs) into.set(r.sourceGuid, [...(into.get(r.sourceGuid) ?? []), r])
  }
  for (const col of columns) {
    if (col.isSubtotal) continue
    for (const g of col.sourceGuids) docs.add(g)
    if (col.respondentRef) {
      add(respondents, [col.respondentRef])
    } else if (col.tagScopeGuids?.length) {
      const scopes = tagsAsScopes(col.tagScopeGuids, membership)
      if (!scopes) {
        // Tags on both respondents and questions of a survey: those
        // surveys are taken whole (see tagsAsScopes).
        for (const g of col.sourceGuids) whole.add(g)
        continue
      }
      // Tagged documents (and surveys tagged as a whole) are in whole.
      for (const g of col.sourceGuids) {
        if (!scopes.respondents.some((r) => r.sourceGuid === g) && !scopes.questions.some((q) => q.sourceGuid === g)) whole.add(g)
      }
      add(respondents, scopes.respondents)
      add(questions, scopes.questions)
    } else {
      for (const g of col.sourceGuids) whole.add(g)
    }
  }
  // A survey some columns limit to respondents and others to questions
  // (or that's also whole somewhere) is taken whole: the union of a
  // respondent scope and a question scope isn't either.
  for (const survey of new Set([...respondents.keys(), ...questions.keys()])) {
    if (whole.has(survey) || (respondents.has(survey) && questions.has(survey))) {
      respondents.delete(survey)
      questions.delete(survey)
    }
  }
  const respondentRefs = [...respondents.values()].flat()
  const columnQuestions = [...questions.values()].flat()
  const q = intersectScopes(questionScope, columnQuestions.length > 0 ? columnQuestions : undefined)
  const scope: SurveyCellScopeArgs = {}
  if (respondentRefs.length > 0) scope.respondentScope = respondentRefs
  if (q.refs) scope.questionScope = q.refs
  return {
    sourceGuids: [...docs].filter((g) => !q.emptied.has(g)),
    scope: scope.respondentScope || scope.questionScope ? scope : undefined
  }
}

/** What a clicked number in an analysis tool covers, besides its
 *  documents: the tool's own filter's limits (which it counts under), and
 *  the clicked column's (or row's). */
export interface CellScope {
  /** The tool's document filter: any of its tags, none of its excluded
   *  tags, and its chosen survey questions and respondents. */
  filter?: Pick<Query['documentFilter'], 'tagGuids' | 'tagExcludeGuids' | 'questionScope' | 'respondentScope'>
  /** The clicked column: a tag column's tags (any of them), or one
   *  survey respondent. */
  column?: { tagGuids?: string[]; respondentRef?: SurveyEntityRef }
}

/**
 * The query for a clicked number in an analysis tool: `query` (its
 * condition, and any `within`) in `docs`, the tool's filtered documents,
 * under the tool's filter, narrowed to the clicked column. Null when
 * nothing can be in it.
 *
 * `docs` are already what the tool's filter selects, so the filter's tags
 * only narrow survey cells, as the tool counts them (applySurveyCellScope):
 * a survey keeps the respondents or questions the tags are on, or all of
 * it if it's tagged whole, and none if they aren't on it. `surveys` says
 * which documents are surveys.
 */
export function queryForCell(
  query: Query,
  docs: string[],
  scope: CellScope | undefined,
  membership: TagMembership,
  surveys: Set<string>
): Query | null {
  const filter = scope?.filter ?? {}
  let sourceGuids = docs
  let respondents = intersectScopes(filter.respondentScope, undefined)
  let questions = intersectScopes(filter.questionScope, undefined)
  const filterTags = filter.tagGuids ?? []
  if (filterTags.length > 0) {
    const whole = new Set(filterTags.flatMap((t) => membership.sourceMembersByTag[t] ?? []))
    const tagRespondents = filterTags.flatMap((t) => membership.respondentMembersByTag[t] ?? [])
    const tagQuestions = filterTags.flatMap((t) => membership.questionMembersByTag[t] ?? [])
    const extraRespondents: SurveyEntityRef[] = []
    const extraQuestions: SurveyEntityRef[] = []
    sourceGuids = docs.filter((g) => {
      if (!surveys.has(g) || whole.has(g)) return true
      const resp = tagRespondents.filter((r) => r.sourceGuid === g)
      const quest = tagQuestions.filter((q) => q.sourceGuid === g)
      if (resp.length === 0 && quest.length === 0) return false
      // On respondents and questions of this survey both: the cells
      // either covers aren't a scope, so the survey is taken whole.
      if (resp.length > 0 && quest.length > 0) return true
      extraRespondents.push(...resp)
      extraQuestions.push(...quest)
      return true
    })
    if (extraRespondents.length > 0) {
      const r = intersectScopes(respondents.refs, extraRespondents)
      respondents = { refs: r.refs, emptied: new Set([...respondents.emptied, ...r.emptied]) }
    }
    if (extraQuestions.length > 0) {
      const q = intersectScopes(questions.refs, extraQuestions)
      questions = { refs: q.refs, emptied: new Set([...questions.emptied, ...q.emptied]) }
    }
  }
  sourceGuids = sourceGuids.filter((g) => !respondents.emptied.has(g) && !questions.emptied.has(g))
  if (sourceGuids.length === 0) return null
  const own: Query = {
    ...query,
    documentFilter: {
      ...query.documentFilter,
      sourceGuids,
      ...(filter.tagExcludeGuids?.length ? { tagExcludeGuids: filter.tagExcludeGuids } : {}),
      ...(questions.refs ? { questionScope: questions.refs } : {}),
      ...(respondents.refs ? { respondentScope: respondents.refs } : {})
    }
  }
  const column = scope?.column
  if (!column?.tagGuids?.length && !column?.respondentRef) return own
  return narrowQueryToCell(own, {
    sourceGuids,
    scope: {
      ...(column.tagGuids?.length ? { tagGuids: column.tagGuids } : {}),
      ...(column.respondentRef ? { respondentScope: [column.respondentRef] } : {})
    }
  }, membership)
}
