/**
 * What the windows say to each other: for each conversation, every action
 * and exactly what it carries. The window that sends and the window that
 * receives are both checked against these, so a misnamed action, a missing
 * value or values in the wrong order fail the build instead of quietly
 * doing nothing.
 *
 * Each map lists an action's values in the order they're sent, e.g.
 * `'rename-code': [guid, name]` is sent as `send('rename-code', guid, name)`
 * and received as `{ action: 'rename-code', args: [guid, name] }`.
 */
import type { Drill } from '../components/Analysis/intercoder/IntercoderResults'
import type { ResultsView } from '../components/Analysis/intercoder/intercoder-tables'
import type { Measure } from '../components/Analysis/intercoder/intercoder-model'
import type { FrameworkMatrixConfig } from '../components/Analysis/framework-matrix-model'
import type { WordQueryCodes } from '../components/Analysis/word-counts'
import type { CellScope } from '../utils/narrow-query'
import type { AnalysisToolType, Code, LogbookEntry, Memo, Query, SavedAnalysis, SurveyCellScopeArgs } from './types'

/** A conversation's actions, each with the values it carries. (Keyed by
 *  its own actions, not by any string, so an unknown action is an error.) */
type MessageMap<M> = { [A in keyof M]: unknown[] }

/** A message as received where its values travel as a list. */
export type ArgsMessage<M extends MessageMap<M>> = { [A in keyof M]: { action: A; args: M[A] } }[keyof M]

/** A message as received where it carries at most one value. */
export type PayloadMessage<M extends MessageMap<M>> = {
  [A in keyof M]: { action: A; payload: M[A] extends [infer P] ? P : undefined }
}[keyof M]

/** A memo edit window (or a relationship map) → the main window: the memo
 *  as saved. `_isNew` marks a draft's first save, which creates the memo. */
export type MemoUpdate = Memo & { _isNew?: boolean }

/** The Codebook window → the main window. */
export interface CodebookMessages {
  'rename-code': [guid: string, name: string]
  'recolor-code': [guid: string, color: string]
  /** A "New Code" under this one, which the Codebook then opens for renaming. */
  'add-child-code': [parentGuid: string]
  'move-code-to-top': [guid: string]
  'delete-code': [guid: string]
  'show-in-all-documents': [codeGuid: string]
  'show-in-active-document': [codeGuid: string]
  'save-code': [guid: string, name: string, color: string, description: string, hotkey: number | undefined]
  /** Codes imported from a codebook file. */
  'merge-codes': [imported: Code[]]
}

/** The Codebook's right-click actions on a code: each carries just its guid. */
export type CodeMenuAction = 'show-in-all-documents' | 'show-in-active-document' | 'add-child-code' | 'move-code-to-top' | 'delete-code'

/** The logbook window → the main window. */
export interface LogbookMessages {
  'add-entry': [entry: LogbookEntry]
  'update-entry': [guid: string, title: string, content: string]
  'remove-entry': [guid: string]
}

/** The Memos window → the main window. */
export interface MemosWindowMessages {
  edit: [memoGuid: string]
  /** Show where the memo is attached. */
  show: [memoGuid: string]
  new: []
  delete: [memoGuids: string[]]
}

/** The analysis tools (in tabs or popped out) → the main window. A
 *  clicked number's query runs in `filteredGuids` (the tool's filtered
 *  documents; none for all) under `scope`: the tool's filter and the
 *  clicked column (see CellScope). */
export interface AnalysisMessages {
  'save-analysis': [analysis: Pick<SavedAnalysis, 'guid' | 'toolType' | 'name' | 'config'>]
  'run-cooccurrence-query': [codeGuidA: string, codeGuidB: string, filteredGuids?: string[], scope?: CellScope]
  'run-code-in-doc-query': [codeGuid: string, sourceGuids: string[], filteredGuids?: string[], scope?: CellScope]
  'run-codes-in-doc-query': [codeGuids: string[], sourceGuids: string[], scope?: CellScope]
  /** Codes in Documents → "Open as Framework Matrix". */
  'open-framework-matrix': [config: FrameworkMatrixConfig]
  /** Results in Documents: a saved query, narrowed to a cell (see narrowQueryToCell). */
  'run-query-in-docs': [query: Query, sourceGuids: string[], scope?: SurveyCellScopeArgs]
  'run-word-query': [word: string, filteredGuids?: string[], scope?: CellScope, codes?: WordQueryCodes, queryGuids?: string[]]
  'run-sentence-query': [word1: string, word2: string, filteredGuids?: string[], scope?: CellScope, codes?: WordQueryCodes, queryGuids?: string[]]
  'open-document': [sourceGuid: string]
  'view-document-at': [sourceGuid: string, startPosition: number, endPosition: number]
  'run-code-query': [codeGuid: string]
  'open-memo': [memoGuid: string]
  'run-saved-query': [queryGuid: string]
  'select-tag-documents': [tagGuid: string]
  'select-tag-category-documents': [categoryGuid: string]
  'select-folder-documents': [folderGuid: string]
  /** The main window looks up the rest of the analysis by its guid. */
  'open-saved-analysis': [toolType: AnalysisToolType, analysis: { guid: string; name: string }]
}

/** The popped-out Query Results window → the main window. */
export interface QueryResultsMessages {
  'edit-query': []
  'clear-query': []
  /** Its × closes the pane too. */
  'close-panel': []
  'save-query': []
  /** Code every result with a new code (the main window asks for it). */
  'code-all-new-code': []
  'code-all-existing-code': [code: { guid: string }]
  /** Select every document (and survey respondent) the results came from. */
  'select-documents': []
  'run-saved-query': [query: { guid: string }]
  'delete-saved-query': [query: { guid: string }]
  'rename-saved-query': [query: { guid: string; name: string }]
  'edit-saved-query': [query: { guid: string }]
}

/** The popped-out Inter-coder Agreement results → the tool. */
export interface IntercoderResultsMessages {
  view: [view: ResultsView]
  measure: [measure: Measure]
  threshold: [threshold: number]
  'toggle-expanded': [codeKey: string]
  drill: [drill: Drill | null]
}
