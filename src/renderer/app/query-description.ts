/**
 * Plain-language descriptions of queries, for result titles and reports,
 * and the scope helpers they share.
 */
import { useQueryStore } from '../stores/query-store'
import type { Query, CodeCondition, Code, TextSource, QDASet, SurveyCellScopeArgs } from '../models/types'
import { buildSurveyEntityLabels } from '../utils/survey/survey-labels'
import { t } from '../i18n'

/** Fold the survey-cell scope carried by an analysis cell-click into the
 *  documentFilter of the Query being generated, so it re-runs against the
 *  same subset the cell represented. Tag scope unions with any existing
 *  tagGuids; question/respondent scope is set directly. */
export function applySurveyScopeToFilter(
  df: Query['documentFilter'],
  scope?: SurveyCellScopeArgs
): Query['documentFilter'] {
  if (!scope) return df
  const next: Query['documentFilter'] = { ...df }
  if (scope.tagGuids?.length) {
    next.tagGuids = Array.from(new Set([...(df.tagGuids ?? []), ...scope.tagGuids]))
  }
  if (scope.questionScope?.length) next.questionScope = scope.questionScope
  if (scope.respondentScope?.length) next.respondentScope = scope.respondentScope
  return next
}

export function describeCondition(cond: CodeCondition, findCode: (guid: string) => Code | undefined, depth?: number): string {
  const d = depth ?? 0
  const codeName = (guid: string) => findCode(guid)?.name ?? t('queryBuilder.code')
  switch (cond.type) {
    case 'code':
      return cond.includeSubcodes ? t('queryDesc.inclSubcodes', { name: codeName(cond.codeGuid) }) : codeName(cond.codeGuid)
    case 'text':
      if (!cond.searchText) return t('queryBuilder.kind.text')
      return cond.sentences ? t('queryDesc.sentencesWith', { text: cond.searchText }) : `"${cond.searchText}"`
    case 'and':
      return cond.conditions.map((c) => describeCondition(c, findCode, d + 1)).join(' AND ')
    case 'or':
      return cond.conditions.map((c) => describeCondition(c, findCode, d + 1)).join(' OR ')
    case 'xor':
      return cond.conditions.map((c) => describeCondition(c, findCode, d + 1)).join(' XOR ')
    case 'not':
      return t('queryDesc.not', { names: describeCondition(cond.condition, findCode, d + 1) })
    case 'overlap':
      return t('queryDesc.overlap', { a: `(${describeCondition(cond.condition1, findCode, d + 1)})`, b: `(${describeCondition(cond.condition2, findCode, d + 1)})` })
    case 'inside':
      return t('queryDesc.inside', { a: `(${describeCondition(cond.condition1, findCode, d + 1)})`, b: `(${describeCondition(cond.condition2, findCode, d + 1)})` })
    case 'outside':
      return t('queryDesc.outside', { a: `(${describeCondition(cond.condition1, findCode, d + 1)})`, b: `(${describeCondition(cond.condition2, findCode, d + 1)})` })
    case 'before':
      return t('queryDesc.before', { a: `(${describeCondition(cond.condition1, findCode, d + 1)})`, b: `(${describeCondition(cond.condition2, findCode, d + 1)})` })
    case 'followedBy':
      return t('queryDesc.followedBy', { a: `(${describeCondition(cond.condition1, findCode, d + 1)})`, b: `(${describeCondition(cond.condition2, findCode, d + 1)})` })
    case 'sameSentence':
      return t('queryDesc.sameSentence', { a: `(${describeCondition(cond.condition1, findCode, d + 1)})`, b: `(${describeCondition(cond.condition2, findCode, d + 1)})` })
    default:
      return t('queryDesc.query')
  }
}

/** The saved queries a word search is limited to (see Query.within), or
 *  undefined when the word tool wasn't counting query results. */
export function withinQueries(queryGuids: string[] | undefined): Query[] | undefined {
  if (!queryGuids) return undefined
  const saved = useQueryStore.getState().savedQueries
  return queryGuids.flatMap((g) => {
    const q = saved.find((sq) => sq.guid === g)?.query
    return q ? [q] : []
  })
}

export function describeQuery(
  query: Query,
  findCode: (guid: string) => Code | undefined,
  sources: TextSource[],
  tags: QDASet[]
): string {
  let name = describeCondition(query.codeCondition, findCode)
  const df = query.documentFilter
  const parts: string[] = []
  // Name explicitly-picked documents only — not the full resolved source
  // list. For a tag-based filter the sourceGuids are just the tags' output,
  // so naming them duplicates the tags (and bloats the name). Use the
  // selector graph's explicit `docs` nodes when present; older queries with
  // no graph fall back to the resolved sourceGuids.
  const docGuids = (df as { graph?: { nodes: { kind?: string; docGuids?: string[] }[] } }).graph
    ? (df as { graph: { nodes: { kind?: string; docGuids?: string[] }[] } }).graph.nodes
        .filter((n) => n?.kind === 'docs')
        .flatMap((n) => n.docGuids ?? [])
    : df.sourceGuids ?? []
  if (docGuids.length > 0) {
    const names = docGuids
      .map((g) => sources.find((s) => s.guid === g)?.name)
      .filter(Boolean) as string[]
    if (names.length > 0) parts.push(names.length <= 2 ? names.join(', ') : t('queryDesc.docs', { count: names.length }))
  }
  if (df.tagGuids && df.tagGuids.length > 0) {
    const tagNames = df.tagGuids
      .map((g) => tags.find((tg) => tg.guid === g)?.name)
      .filter(Boolean) as string[]
    if (tagNames.length > 0) parts.push(tagNames.join(', '))
  }
  if (df.tagExcludeGuids && df.tagExcludeGuids.length > 0) {
    const excludeNames = df.tagExcludeGuids
      .map((g) => tags.find((tg) => tg.guid === g)?.name)
      .filter(Boolean) as string[]
    if (excludeNames.length > 0) parts.push(t('queryDesc.not', { names: excludeNames.join(', ') }))
  }
  if (df.questionScope?.length || df.respondentScope?.length) {
    // Resolve respondent/question display names from the survey sources.
    const labels = buildSurveyEntityLabels(sources)
    if (df.questionScope?.length) {
      const names = df.questionScope.map((r) => labels?.[r.sourceGuid]?.questions?.[r.id]).filter(Boolean) as string[]
      parts.push(names.length > 0 && names.length <= 2 ? names.join(', ') : t('survey.questionCount', { count: df.questionScope.length }))
    }
    if (df.respondentScope?.length) {
      const names = df.respondentScope.map((r) => labels?.[r.sourceGuid]?.respondents?.[r.id]).filter(Boolean) as string[]
      parts.push(names.length > 0 && names.length <= 2 ? names.join(', ') : t('survey.respondentCount', { count: df.respondentScope.length }))
    }
  }
  if (parts.length > 0) name += ' ' + t('queryDesc.in', { scope: parts.join(', ') })
  if (query.within) name += ' ' + t('queryDesc.within', { count: query.within.length })
  return name
}
