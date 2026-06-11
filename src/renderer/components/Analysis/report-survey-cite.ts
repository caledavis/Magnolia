/**
 * Shared survey-cell citation for the report PDF. A survey quote and a
 * survey query-result both cite the same thing — the respondent and the
 * question (number + text) — so the wording and, crucially, the ORDER
 * live here in one place. Change the order once and both follow.
 *
 * Returns a fragment with leading " · " separators (so it can be appended
 * after a source name), HTML-escaped. Empty when the survey or cell can't
 * be resolved.
 */
import { useDocumentStore } from '../../stores/document-store'
import { escHtml } from '../../utils/pdf-export'
import type { SurveyFormatData } from '../../models/types'

export function surveyCellCitation(
  sourceGuid: string,
  cell: { respondentId: string; questionId: string }
): string {
  const src = useDocumentStore.getState().sources.find((s) => s.guid === sourceGuid)
  const survey = (src?.formatData as SurveyFormatData | undefined)?.survey
  if (!survey) return ''
  const rIdx = survey.respondents.findIndex((r) => r.id === cell.respondentId)
  const qIdx = survey.questions.findIndex((qq) => qq.id === cell.questionId)
  const respLabel =
    (rIdx >= 0 ? survey.respondents[rIdx]?.displayName : '') ||
    (rIdx >= 0 ? `Respondent ${rIdx + 1}` : 'Respondent')

  let cite = ` · ${escHtml(respLabel)}`
  if (qIdx >= 0) {
    const qText = (survey.questions[qIdx]?.text ?? '').trim()
    cite += ` · Q${qIdx + 1}${qText ? `: “${escHtml(qText)}”` : ''}`
  }
  return cite
}
