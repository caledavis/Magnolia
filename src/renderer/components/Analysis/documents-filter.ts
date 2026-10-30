/**
 * The document filter an analysis reads, summarised for the From these
 * documents heading and loaded from a saved analysis.
 */
import type { SurveyEntityRef } from '../../models/types'
import { emptyDocumentFilter, type DocumentFilterState } from '../../utils/document-graph'
import { chosenEntries } from '../DocumentSelector/SurveyScope'

/** "All 9 documents", or "4 of 9 documents" when some are chosen, plus
 *  any survey questions or respondents chosen. */
export function documentsSummary(count: number, total: number, filter?: Pick<DocumentFilterState, 'questionScope' | 'respondentScope'>): string {
  const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`
  const parts = [count === total ? `All ${plural(total, 'document')}` : `${count} of ${plural(total, 'document')}`]
  const scope = (refs: SurveyEntityRef[] | undefined, noun: string) => {
    if (!refs?.length) return
    const n = chosenEntries(refs).length
    // Only "none" chosen (Deselect All on every survey listed).
    parts.push(n > 0 ? plural(n, noun) : `no ${noun}s`)
  }
  scope(filter?.questionScope, 'question')
  scope(filter?.respondentScope, 'respondent')
  return parts.join(' · ')
}

/** A saved analysis's document filter. Up to 1.9, survey questions were
 *  chosen in a separate Questions box saved as `questionScope` beside the
 *  filter; they now live in the filter. */
export function documentFilterFromConfig(config?: { docFilter?: DocumentFilterState; questionScope?: SurveyEntityRef[] }): DocumentFilterState {
  const filter = config?.docFilter ?? emptyDocumentFilter()
  const legacy = config?.questionScope ?? []
  if (filter.questionScope || legacy.length === 0) return filter
  return { ...filter, questionScope: legacy.map((r) => ({ sourceGuid: r.sourceGuid, id: r.id })) }
}
