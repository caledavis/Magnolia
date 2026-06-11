/**
 * Unified tag scoping across documents and survey cells.
 *
 * A tag is one concept that can be applied to whole documents, to whole
 * surveys, to individual survey respondents, and to individual survey
 * questions (memberSourceGuids / memberSurveyRespondents /
 * memberSurveyQuestions on a QDASet). When a tag is used as a filter it
 * scopes ALL of those at once — the same tag node in the document
 * selector pulls in tagged documents AND the matching survey cells.
 *
 * Semantics for one include tag T (union within the tag):
 *   - document tagged T            → whole document in scope
 *   - survey tagged T (as a source)→ ALL of its cells in scope
 *   - respondent tagged T          → that respondent's cells in scope
 *   - question tagged T            → that question's cells in scope
 * A survey enters scope if tagged at ANY level; if only some
 * respondents/questions carry T, only their cells count. A whole-survey
 * tag wins (all cells), overriding narrower respondent/question tagging
 * for the same tag. Multiple include tags union. Exclude tags remove
 * matching documents (whole) and matching cells.
 *
 * Document-level set operations (intersect/subtract in the selector
 * graph) continue to operate on the document set; a tag's survey-cell
 * contribution is union-only.
 */
import type { SurveyEntityRef } from '../models/types'

export interface TagCellScopeFilter {
  /** Include tags (documentFilter.tagGuids). */
  tagGuids?: string[]
  /** Exclude tags (documentFilter.tagExcludeGuids). */
  tagExcludeGuids?: string[]
  /** Direct survey question scope (Query.documentFilter.questionScope /
   *  the analysis Questions box): a listed survey is restricted to these
   *  questions; a survey NOT listed keeps all of its cells. ANDed with
   *  the tag scope. Unlike tags, this does NOT narrow the source set. */
  questionScope?: SurveyEntityRef[]
  /** Direct survey respondent scope (one ref per respondent column),
   *  same cell-level AND semantics as questionScope. */
  respondentScope?: SurveyEntityRef[]
}

/** Predicate for a direct entity scope (respondent or question refs): a
 *  survey that appears in the list is restricted to its listed entity
 *  ids; a survey NOT in the list passes all of its entities. Returns
 *  null when there's no constraint. Mirrors entityScopePredicate in
 *  analysis-helpers so the engine and the analysis tools agree. */
function entityScopePredicate(
  refs: SurveyEntityRef[] | undefined
): ((sourceGuid: string, entityId: string) => boolean) | null {
  if (!refs || refs.length === 0) return null
  const bySurvey = new Map<string, Set<string>>()
  for (const r of refs) {
    let set = bySurvey.get(r.sourceGuid)
    if (!set) {
      set = new Set()
      bySurvey.set(r.sourceGuid, set)
    }
    set.add(r.id)
  }
  return (sourceGuid, entityId) => {
    const set = bySurvey.get(sourceGuid)
    return set ? set.has(entityId) : true
  }
}

export interface TagMembership {
  /** tag guid → document/source guids (memberSourceGuids). */
  sourceMembersByTag: Record<string, string[]>
  /** tag guid → survey respondent refs. */
  respondentMembersByTag: Record<string, SurveyEntityRef[]>
  /** tag guid → survey question refs. */
  questionMembersByTag: Record<string, SurveyEntityRef[]>
}

export interface TagCellScope {
  /** True when include tags are present (scope is being narrowed). */
  hasIncludeConstraint: boolean
  /** True when exclude tags are present. */
  hasExcludeConstraint: boolean
  /** True when either is present. */
  hasConstraint: boolean
  /** Document/source guids the include tags resolve to at the document
   *  level — whole docs/surveys tagged, PLUS surveys that have any
   *  tagged respondent/question (so cell-only-tagged surveys are pulled
   *  into the source set). Empty when there's no include constraint. */
  includedSourceGuids: Set<string>
  /** Source guids wholly excluded (in an exclude tag's source members). */
  excludedSourceGuids: Set<string>
  /** Is this (survey, respondent, question) cell in scope? */
  cellInScope: (sourceGuid: string, respondentId: string, questionId: string) => boolean
}

const SEP = ' '

interface MembershipSets {
  src: Set<string>
  resp: Set<string> // `${sourceGuid} ${respondentId}`
  quest: Set<string> // `${sourceGuid} ${questionId}`
  /** Every source guid touched by these tags (src ∪ sources of resp/quest). */
  allSources: Set<string>
}

function collectMembership(tagGuids: string[] | undefined, m: TagMembership): MembershipSets {
  const src = new Set<string>()
  const resp = new Set<string>()
  const quest = new Set<string>()
  const allSources = new Set<string>()
  for (const tg of tagGuids ?? []) {
    for (const g of m.sourceMembersByTag[tg] ?? []) {
      src.add(g)
      allSources.add(g)
    }
    for (const r of m.respondentMembersByTag[tg] ?? []) {
      resp.add(r.sourceGuid + SEP + r.id)
      allSources.add(r.sourceGuid)
    }
    for (const q of m.questionMembersByTag[tg] ?? []) {
      quest.add(q.sourceGuid + SEP + q.id)
      allSources.add(q.sourceGuid)
    }
  }
  return { src, resp, quest, allSources }
}

export function resolveTagCellScope(
  filter: TagCellScopeFilter,
  membership: TagMembership
): TagCellScope {
  const inc = collectMembership(filter.tagGuids, membership)
  const exc = collectMembership(filter.tagExcludeGuids, membership)

  const hasIncludeConstraint = (filter.tagGuids?.length ?? 0) > 0
  const hasExcludeConstraint = (filter.tagExcludeGuids?.length ?? 0) > 0

  // Direct (non-tag) scope. These narrow CELLS only — never the source
  // set — so they're folded into cellInScope / hasConstraint but left
  // out of hasIncludeConstraint / includedSourceGuids.
  const respondentPred = entityScopePredicate(filter.respondentScope)
  const questionPred = entityScopePredicate(filter.questionScope)

  const matches = (sets: MembershipSets, sg: string, rid: string, qid: string): boolean =>
    sets.src.has(sg) || sets.resp.has(sg + SEP + rid) || sets.quest.has(sg + SEP + qid)

  const cellInScope = (sourceGuid: string, respondentId: string, questionId: string): boolean => {
    if (hasIncludeConstraint && !matches(inc, sourceGuid, respondentId, questionId)) return false
    if (hasExcludeConstraint && matches(exc, sourceGuid, respondentId, questionId)) return false
    if (respondentPred && !respondentPred(sourceGuid, respondentId)) return false
    if (questionPred && !questionPred(sourceGuid, questionId)) return false
    return true
  }

  return {
    hasIncludeConstraint,
    hasExcludeConstraint,
    hasConstraint:
      hasIncludeConstraint || hasExcludeConstraint || !!respondentPred || !!questionPred,
    includedSourceGuids: inc.allSources,
    excludedSourceGuids: exc.src,
    cellInScope
  }
}

/** Build the three membership maps from full QDASet-shaped tags (used by
 *  the query engine, which holds the tags). Analysis tools instead get
 *  these via their init data. */
export function tagMembershipFromTags(
  tags: {
    guid: string
    memberSourceGuids?: string[]
    memberSurveyRespondents?: SurveyEntityRef[]
    memberSurveyQuestions?: SurveyEntityRef[]
  }[]
): TagMembership {
  const sourceMembersByTag: Record<string, string[]> = {}
  const respondentMembersByTag: Record<string, SurveyEntityRef[]> = {}
  const questionMembersByTag: Record<string, SurveyEntityRef[]> = {}
  for (const t of tags) {
    if (t.memberSourceGuids?.length) sourceMembersByTag[t.guid] = t.memberSourceGuids
    if (t.memberSurveyRespondents?.length) respondentMembersByTag[t.guid] = t.memberSurveyRespondents
    if (t.memberSurveyQuestions?.length) questionMembersByTag[t.guid] = t.memberSurveyQuestions
  }
  return { sourceMembersByTag, respondentMembersByTag, questionMembersByTag }
}
