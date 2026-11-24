/**
 * "Code all results" in the Query Results (in the pane or popped out).
 */
import { useDocumentStore } from '../stores/document-store'
import { useQueryStore } from '../stores/query-store'

/** Code every current query result with `codeGuid`. A result that is a
 *  coded passage gets the code (unless it has it); a text match becomes a
 *  passage first, in its survey answer when it's in a survey (its
 *  positions are within that answer). */
export function codeAllResults(codeGuid: string): void {
  const ds = useDocumentStore.getState()
  for (const r of useQueryStore.getState().results) {
    if (!r.selectionGuid.startsWith('text-match-')) {
      if (!r.matchedCodes.some((c) => c.guid === codeGuid)) ds.addCodingToSelection(r.sourceGuid, r.selectionGuid, codeGuid)
    } else {
      const selGuid = ds.addSelection(r.sourceGuid, r.startPosition, r.endPosition, r.matchedText, undefined, r.surveyCell)
      ds.addCodingToSelection(r.sourceGuid, selGuid, codeGuid)
    }
  }
}
