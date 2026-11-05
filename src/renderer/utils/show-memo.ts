/**
 * Takes the main window to the place a memo is attached to: the document
 * (scrolled to the memo's passage for a selection memo), or the survey
 * view of its question, respondent or answer. Project, query and analysis
 * memos have no place to show, so this does nothing for them.
 *
 * Shared by the Saved Memos pane (single click) and the Memos window
 * (Show), so both behave the same.
 */
import type { Memo } from '../models/types'
import { useDocumentStore } from '../stores/document-store'
import { useSurveyViewStore } from '../stores/survey-view-store'

export function showMemoLocation(memo: Memo): void {
  const { viewDocument, viewDocumentAt } = useDocumentStore.getState()
  const { setView, setScrollTarget } = useSurveyViewStore.getState()
  // Survey-question memo → the Question view of that question.
  if (memo.type === 'survey-question' && memo.sourceGuid && memo.questionGuid) {
    setView(memo.sourceGuid, 'question', memo.questionGuid)
    setScrollTarget({ surveyGuid: memo.sourceGuid, questionId: memo.questionGuid })
    viewDocument(memo.sourceGuid)
    return
  }
  // Survey-respondent memo → the Respondent view of that respondent (no
  // question to scroll to: the memo sits on the sticky header at the top).
  if (memo.type === 'survey-respondent' && memo.sourceGuid && memo.respondentId) {
    setView(memo.sourceGuid, 'respondent', memo.respondentId)
    setScrollTarget({ surveyGuid: memo.sourceGuid, respondentId: memo.respondentId })
    viewDocument(memo.sourceGuid)
    return
  }
  // A whole-answer memo, or a selection memo inside an answer → the
  // Respondent view, scrolled to that question.
  if ((memo.type === 'survey-cell' || memo.type === 'content') && memo.sourceGuid && memo.surveyCell) {
    setView(memo.sourceGuid, 'respondent', memo.surveyCell.respondentId)
    setScrollTarget({
      surveyGuid: memo.sourceGuid,
      respondentId: memo.surveyCell.respondentId,
      questionId: memo.surveyCell.questionId
    })
    viewDocument(memo.sourceGuid)
    return
  }
  if (memo.type === 'content' && memo.sourceGuid && memo.startPosition !== undefined) {
    viewDocumentAt(memo.sourceGuid, memo.startPosition, memo.endPosition ?? memo.startPosition, memo.pdfRegion)
  } else if (memo.type === 'document' && memo.sourceGuids && memo.sourceGuids.length > 0) {
    viewDocument(memo.sourceGuids[0])
  }
}
