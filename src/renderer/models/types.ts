import type { DConn, DNode } from '../utils/document-graph'
import type { Preferences } from '../stores/preferences-store'
import type { IntercoderWindowData } from '../components/Analysis/intercoder/IntercoderResults'
import type {
  AnalysisMessages,
  ArgsMessage,
  CodebookMessages,
  IntercoderResultsMessages,
  LogbookMessages,
  MemosWindowMessages,
  MemoUpdate,
  PayloadMessage,
  QueryResultsMessages
} from './window-messages'
/** Magnolia-specific document folder. The REFI-QDA standard has no
 *  folder concept — these are persisted in a `magnolia-folders.json`
 *  side table inside the .qdpx alongside the per-doc folder mapping. */
export interface DocumentFolder {
  guid: string
  name: string
  parentGuid: string | null
  /** 'notebook' marks a folder that holds notes (and only notes).
   *  Absent for an ordinary folder. */
  kind?: 'notebook'
}

/** A project as opened from its file: with its documents' text, where
 *  it was opened from, who has it checked out, and any media files it
 *  refers to that couldn't be found. */
export interface OpenedProject extends Project {
  sourceContents: Record<string, string>
  filePath: string
  checkoutInfo: CheckoutMarker | null
  missingBinaries?: MissingBinary[]
  /** Saved by a newer Magnolia, in a format this one may not fully
   *  understand: opened read-only. */
  newerFormat?: { savedBy: string }
  /** What the file holds that Magnolia can't keep, by kind (from another
   *  program, usually): shown by NotKeptAlert. */
  notKept?: Partial<Record<NotKeptKind, number>>
}

/** Kinds of things in a project file Magnolia can't keep (magnolia-core
 *  qdpx/deserializer.rs `not_kept`). */
export type NotKeptKind =
  | 'documentCodings'
  | 'memoCodings'
  | 'memoAttachments'
  | 'descriptions'
  | 'attachedTexts'
  | 'links'
  | 'caseLinks'
  | 'setMemos'
  | 'extraTranscripts'

export interface Project {
  name: string
  origin: string
  /** Free-text project description (markdown). Maps to the REFI-QDA
   *  Project/<Description> element; edited in the Project Details dialog. */
  description?: string
  creatingUserGUID?: string
  creationDateTime?: string
  modifyingUserGUID?: string
  modifiedDateTime?: string
  users: User[]
  codes: Code[]
  sources: TextSource[]
  sets: QDASet[]
  notes: Note[]
  tagCategories?: TagCategory[]
  savedQueries?: SavedQuery[]
  logbookEntries?: LogbookEntry[]
  /** AI Assistance: whether it's on, its chats and proposals (magnolia-ai.json). */
  ai?: import('../stores/ai-store').ProjectAi
  memos?: Memo[]
  quotes?: Quote[]
  savedAnalyses?: SavedAnalysis[]
  /** Folder definitions (Magnolia-specific). */
  folders?: DocumentFolder[]
  /** Map of source guid → folder guid for documents that live inside a
   *  folder. Documents not in this map are at the root. */
  sourceFolder?: Record<string, string>
  /** Open Document Viewer tabs and per-tool counters. Persisted so
   *  re-opening a project restores the same tabs in the same order.
   *  Magnolia-specific (not part of REFI-QDA). */
  tabState?: PersistedTabState
}

/** Persisted Document Viewer tab state. Lives in `magnolia-tabs.json`
 *  inside the .qdpx zip. */
export interface PersistedTabState {
  openTabs: PersistedTab[]
  activeTabId: string | null
  /** Per-tool ad-hoc counter; saved analyses don't consume it. Keyed by
   *  toolType (incl. 'query-builder'). Persisted so re-opening doesn't
   *  reset numbering and collide with old tab labels the user remembers. */
  perToolCounters: Record<string, number>
}

export type PersistedTab =
  | { id: string; kind: 'document' }
  | { id: string; kind: 'map'; mapGuid: string }
  | {
      id: string
      kind: 'analysis'
      toolType: string
      title: string
      /** Set when the tab is backed by a SavedAnalysis. */
      savedAnalysisGuid?: string
      /** Set for ad-hoc tabs only — full config snapshot so the tool
       *  rehydrates without round-tripping through SavedAnalyses. */
      adhocConfig?: ToolConfig
    }
  | {
      id: string
      kind: 'query-builder'
      title: string
      adhocConfig?: ToolConfig
    }
  | { id: string; kind: 'notebook'; folderGuid: string }

export interface User {
  guid: string
  name?: string
  id?: string
}

export interface Code {
  guid: string
  name: string
  isCodable: boolean
  color?: string
  description?: string
  hotkey?: number // 0–9, mapped to Cmd+0 through Cmd+9
  children: Code[]
}

export type SourceType = 'text' | 'markdown' | 'pdf' | 'audio' | 'image' | 'video' | 'survey' | 'note'

// ─── Survey ──────────────────────────────────────────────────────────
//
// Survey sources are parsed from a CSV (later: XLSX). The user views
// either a per-respondent projection (one respondent's answers to all
// questions) or a per-question projection (all respondents' answers to
// one question). Codings are stored at the cell level and re-projected
// onto whichever view is active, so coding "Respondent A's Q1 answer"
// once shows the highlight in both views.
//
// The auto-detection assigns each column a type at import; the user
// can override every type in the import preview before commit.
//
// `metadata` columns (RespondentID, dates, IP, etc.) are still part of
// the survey data — they show up in the per-respondent view as a
// header block but aren't grouped under "Questions" in the tree.

export type SurveyColumnType =
  | 'metadata'
  | 'open-ended'
  | 'single-choice'
  | 'numeric'
  | 'multi-select'
  | 'skip'

export type SurveyQuestionType = Exclude<SurveyColumnType, 'metadata' | 'skip'>

export interface SurveyColumn {
  /** Stable id assigned at parse time. */
  id: string
  /** 0-based index in the original CSV. */
  index: number
  /** Row 1 cell, raw (may contain HTML, original whitespace). */
  rawHeader: string
  /** Row 2 cell, raw. */
  rawSubhead: string
  /** Row 1 with HTML stripped + whitespace collapsed. Empty for
   *  continuation columns of a multi-select group. */
  cleanHeader: string
  /** Row 2 with HTML stripped + whitespace collapsed. */
  cleanSubhead: string
  /** Detected (possibly user-overridden) type. */
  type: SurveyColumnType
}

export interface SurveyQuestion {
  /** Stable id. */
  id: string
  /** HTML-stripped, single-line question text. */
  text: string
  /** Original row-1 text (may contain HTML / line breaks) — kept so
   *  the import preview can show what was in the file. */
  rawText: string
  type: SurveyQuestionType
  /** Columns that compose this question. Single-cell questions have
   *  one entry; multi-select has N (one per option). */
  columns: {
    columnId: string
    /** The option label for this column. For single-cell questions
     *  this is just `cleanSubhead` (often "Response"). For multi-
     *  select it's the per-option text from row 2. */
    optionLabel: string
  }[]
}

export interface SurveyRespondent {
  /** Stable id. */
  id: string
  /** Display name used in the tree:
   *  "First Last" if both given, else "First", else "Respondent N"
   *  (1-indexed sequential). */
  displayName: string
  /** Original RespondentID from the CSV when present (for traceability). */
  rawRespondentId?: string
  /** Metadata columnId → cell value. */
  metadata: Record<string, string>
  /** questionId → answer.
   *  - Single-cell questions: a single string (may be empty).
   *  - Multi-select: array of selected option labels. */
  answers: Record<string, string | string[]>
}

export interface SurveyData {
  /** Display name (default: CSV filename without extension; user can
   *  rename like any other source). */
  name: string
  columns: SurveyColumn[]
  questions: SurveyQuestion[]
  /** Column ids classified as `metadata`. Order preserved from CSV. */
  metadataColumnIds: string[]
  respondents: SurveyRespondent[]
}

/** Format-specific data attached to a TextSource of `sourceType:
 *  'survey'`. Wraps the parsed SurveyData; the source's
 *  `plainTextContent` / `selections[]` aren't used (the survey carries
 *  its own viewing model). */
export interface SurveyFormatData {
  survey: SurveyData
  /** Verbatim CSV bytes (UTF-8). Kept so the user can reconvert /
   *  re-detect types without re-importing. */
  rawCsv: string
}

/** Format-specific data for audio sources */
export interface AudioFormatData {
  audioFilePath?: string   // path to temp file with audio data (for renderer to load)
  audioBase64?: string     // legacy: only used during QDPX migration
  mimeType: string         // 'audio/wav', 'audio/mpeg', 'audio/ogg', etc.
  duration: number         // seconds
  channels: number
  sampleRate: number
  /** Original extension, kept so the QDPX writer can preserve it. */
  audioExt?: string
  /** Per-transcript-line timestamps — same shape and role as the video
   *  counterpart. Maps 0-based line index (stringified) to the audio time
   *  (seconds) at which that line was typed. Lets the coding gutter show
   *  HH:MM:SS without storing timestamps inline in the transcript text. */
  lineTimes?: Record<string, number>
}

/** Format-specific data for video sources. */
export interface VideoFormatData {
  videoFilePath?: string   // path to temp file with video data (for renderer to load)
  mimeType: string         // 'video/mp4', 'video/quicktime', 'video/x-msvideo'
  duration: number         // seconds
  width?: number
  height?: number
  videoExt?: string        // original extension, kept so QDPX writer can preserve it
  /** Per-transcript-line timestamps. Maps 0-based line index (stringified)
   *  to the video time (seconds) at which that line was typed. Set silently
   *  during transcription; drives click-to-seek and automatic bracket
   *  line-anchor placement. */
  lineTimes?: Record<string, number>
}

/** Format-specific data for note sources. A note's name is derived from
 *  these: "YYMMDD HH:MM - Title" (see utils/notes.ts). */
export interface NoteFormatData {
  title: string
  /** When the observation happened (ISO). Defaults to when the note was
   *  created; the user can change it. */
  noteDateTime: string
}

/** Format-specific data for image sources */
export interface ImageFormatData {
  imageFilePath?: string   // path to temp file with image bytes (renderer reads via IPC)
  mimeType: string         // 'image/jpeg', 'image/png', 'image/gif', 'image/webp'
  /** Original file extension preserved so the QDPX writer can keep the same suffix. */
  imageExt?: string
}

/** Format-specific data for PDF sources. */
export interface PdfFormatData {
  pdfFilePath?: string     // handle of the PDF's bytes (renderer reads via IPC)
  pdfBase64?: string       // legacy: only in older projects and fresh imports
  /** Where each page's text starts in the document's text (codepoints). */
  pdfPageOffsets?: number[]
  /** Each page's geometry, written by the backend (pdf_info.rs). */
  pdfPageSizes?: unknown[]
}

/** A document's format-specific data: whichever of these fit its kind
 *  (sourceType). One type, every field optional, so a misspelt field is
 *  an error while a reader still needn't narrow by kind first. */
export type SourceFormatData = Partial<
  SurveyFormatData & AudioFormatData & VideoFormatData & NoteFormatData & ImageFormatData & PdfFormatData
>

export interface TextSource {
  guid: string
  name: string
  sourceType?: SourceType
  /** Format-specific data (PDF binary, audio binary, page offsets, etc.) */
  formatData?: SourceFormatData
  plainTextPath?: string
  plainTextContent?: string
  richTextPath?: string
  creatingUser?: string
  creationDateTime?: string
  modifyingUser?: string
  modifiedDateTime?: string
  /** The Zotero item the document was imported from (zotero://select/…),
   *  kept out of sight in magnolia-sources.json. */
  zoteroLink?: string
  selections: PlainTextSelection[]
}

/**
 * A rectangular region attached to a selection. Used by:
 *  - PDF sources: page = 1-based PDF page; coordinates in PDF user-space
 *    points from top-left.
 *  - Image sources: page = 1 (always); coordinates in image pixels from
 *    top-left.
 *
 * Originally PDF-only (hence the name), now also drives image box
 * selections. The shape is identical for both.
 */
export interface PdfRegionSelection {
  page: number        // 1-based (always 1 for images)
  x: number
  y: number
  width: number
  height: number
}

export interface TimeRange {
  startTime: number  // seconds
  endTime: number    // seconds
}

export interface PlainTextSelection {
  guid: string
  name?: string
  startPosition: number
  endPosition: number
  /** If present, this selection refers to a region on a PDF page instead
   *  of (or in addition to) a character range. startPosition/endPosition
   *  are still used as a fallback for text-based search. */
  pdfRegion?: PdfRegionSelection
  /** If present, this is a video coding's time range. Codings made on the
   *  transcript's text derive it from the lines their text spans; codings
   *  made on the timeline own it, and startPosition/endPosition (code-point
   *  offsets, like every coding) are the transcript lines it covers. Saved
   *  exactly in magnolia-sources.json's videoSelectionAnchors. */
  timeRange?: TimeRange
  /** Video time-range selections only. Set to true when the user has
   *  manually dragged the transcript-bracket endpoints to a new line. Once
   *  set, the bracket's line anchors are locked and won't be re-derived
   *  when the transcript's per-line timestamps change. Dragging the caps
   *  on the CodeTrack (which changes the time range) does not clear this
   *  flag — the user's transcript positioning intent is preserved. */
  manuallyAnchored?: boolean
  /** Survey-cell coding: this selection refers to a span inside one
   *  cell (one respondent × one question) of a survey source. When
   *  present, `startPosition`/`endPosition` are CELL-relative
   *  character offsets, not source-relative. The viewer re-projects
   *  these onto whichever sub-view (per-respondent / per-question)
   *  is active so coding done in one view shows up in the other. */
  surveyCell?: {
    respondentId: string
    questionId: string
  }
  creatingUser?: string
  creationDateTime?: string
  modifyingUser?: string
  modifiedDateTime?: string
  description?: string
  codings: Coding[]
}

export interface Coding {
  guid: string
  codeGuid: string
  creatingUser?: string
  creationDateTime?: string
}

export interface QDASet {
  guid: string
  name: string
  description?: string
  categoryGuid?: string
  value?: string // The tag value within its category (e.g. "Australia" for a Country category)
  memberSourceGuids: string[]
  memberCodeGuids: string[]
  /** Survey respondents this tag is applied to. Respondents aren't
   *  sources, so they can't live in memberSourceGuids — identified by
   *  the survey source's guid plus the respondent's stable id. The
   *  survey itself is a source, so survey-level tags use
   *  memberSourceGuids as usual. */
  memberSurveyRespondents?: SurveyEntityRef[]
  /** Survey questions this tag is applied to (same rationale). */
  memberSurveyQuestions?: SurveyEntityRef[]
}

/** Reference to a survey sub-entity (respondent or question) that a tag
 *  can be applied to. `id` is SurveyRespondent.id / SurveyQuestion.id. */
export interface SurveyEntityRef {
  sourceGuid: string
  id: string
}

export type TagCategoryType = 'text' | 'date' | 'numeric' | 'list'

export interface TagCategory {
  guid: string
  name: string
  type: TagCategoryType
  listOptions?: string[] // For 'list' type: the predefined options
}

export interface Note {
  guid: string
  name?: string
  plainTextContent?: string
  plainTextPath?: string
  creatingUser?: string
  creationDateTime?: string
}

// Query types
export type CodeCondition =
  | { type: 'code'; codeGuid: string; includeSubcodes?: boolean }
  | { type: 'any' }
  /** `sentences`: each result is the whole sentence the text occurs in,
   *  not the occurrence itself. */
  | { type: 'text'; searchText: string; caseSensitive?: boolean; wholeWord?: boolean; sentences?: boolean }
  | { type: 'and'; conditions: CodeCondition[] }
  | { type: 'or'; conditions: CodeCondition[] }
  | { type: 'xor'; conditions: CodeCondition[] }
  | { type: 'not'; condition: CodeCondition }
  | { type: 'overlap'; condition1: CodeCondition; condition2: CodeCondition }
  | { type: 'inside'; condition1: CodeCondition; condition2: CodeCondition }
  | { type: 'outside'; condition1: CodeCondition; condition2: CodeCondition }
  | { type: 'before'; condition1: CodeCondition; condition2: CodeCondition }
  | { type: 'followedBy'; condition1: CodeCondition; condition2: CodeCondition }
  /** The sentences containing both a Condition 1 and a Condition 2 selection.
   *  Only valid as the whole query: its sentences can't feed another operator. */
  | { type: 'sameSentence'; condition1: CodeCondition; condition2: CodeCondition }

export interface Query {
  documentFilter: {
    sourceGuids?: string[]
    /** Tags scope documents AND survey cells in one go: a tag here pulls
     *  in tagged documents/surveys plus the cells of any tagged
     *  respondents/questions (see survey-cell-scope.ts). */
    tagGuids?: string[]
    tagExcludeGuids?: string[]
    folderGuids?: string[]
    /** Survey question scope: restrict the listed surveys to these
     *  questions (a survey not named here keeps all of its questions).
     *  Like tagGuids, this scopes survey CELLS, not the document set —
     *  the surveys stay in scope, only their off-question cells drop. */
    questionScope?: SurveyEntityRef[]
    /** Survey respondent scope: restrict the listed surveys to these
     *  respondents (same cell-level semantics as questionScope). */
    respondentScope?: SurveyEntityRef[]
    /** The Document Selector node graph the user authored. This — not the
     *  flat arrays above — is the source of truth: the arrays are merely
     *  the graph's *resolved output*. Persisting it lets a reopened query
     *  rebuild the exact selector (operators and all) instead of
     *  re-synthesising a lossy one from the resolved doc list (which
     *  collapses every combiner to a union and re-adds resolved docs as
     *  explicit nodes). Optional for backward-compat with queries saved
     *  before this field existed. */
    graph?: { nodes: DNode[]; conns: DConn[] }
  }
  codeCondition: CodeCondition
  /** Only keep text matches that fall inside the results of these queries
   *  (each run with its own document filter). Set by the word tools'
   *  searches when they count words in query results; the Query Builder
   *  never authors it. */
  within?: Query[]
}

/** Survey-cell scope carried from an analysis result cell-click into the
 *  Query it generates, so the query re-runs against the same subset the
 *  cell represented (a chosen question, a single respondent, a tag
 *  column). Folded into Query.documentFilter by the action handlers. */
export interface SurveyCellScopeArgs {
  questionScope?: SurveyEntityRef[]
  respondentScope?: SurveyEntityRef[]
  tagGuids?: string[]
}

export interface SavedQuery {
  guid: string
  name: string
  query: Query
  createdDateTime: string
  graphLayout?: QueryGraphLayout
}

export interface QueryResult {
  sourceGuid: string
  sourceName: string
  selectionGuid: string
  startPosition: number
  endPosition: number
  matchedText: string
  contextBefore: string
  contextAfter: string
  matchedCodes: { guid: string; name: string; color?: string }[]
  /** Present when the matched selection is video-anchored. Drives the
   *  inline video player + fully-highlighted transcript rendering in
   *  the query results window. startPosition/endPosition carry the
   *  coding's transcript text span (code-point offsets). */
  timeRange?: TimeRange
  /** Present when the match is inside a survey answer cell — identifies
   *  the (respondent, question) so consumers (e.g. the Select Documents
   *  button) can map a result back to its respondent. */
  surveyCell?: { respondentId: string; questionId: string }
}

// Data sent to the query builder window
export interface QueryBuilderInitData {
  sources: { guid: string; name: string; sourceType?: string }[]
  folders: { guid: string; name: string; parentGuid: string | null }[]
  /** Map of source guid → folder guid. Lets the embedded DocumentSelector
   *  resolve a Folder input node into the documents inside that folder. */
  sourceFolder?: Record<string, string>
  codes: { guid: string; name: string; color?: string; isCodable: boolean; parentGuid?: string }[]
  tags: { guid: string; name: string; categoryGuid?: string; value?: string }[]
  categories: { guid: string; name: string; type?: TagCategoryType; listOptions?: string[] }[]
  tagMembers?: Record<string, string[]>
  /** Survey respondent/question tag membership for cell-precise scoping. */
  respondentTagMembers?: Record<string, SurveyEntityRef[]>
  questionTagMembers?: Record<string, SurveyEntityRef[]>
  surveyEntityLabels?: Record<string, { respondents: Record<string, string>; questions: Record<string, string> }>
  // When editing an existing saved query:
  editSavedQueryGuid?: string
  editQuery?: Query
  editGraphLayout?: QueryGraphLayout
  // Snapshot of the active query before the builder opened (for Cancel to restore)
  priorQuery?: Query | null
}

/** "Newer version available" nudge state, computed in the main process by
 *  comparing this build against the latest published GitHub release. Drives the
 *  toolbar wordmark badge and the Updates pane on all builds. */
/** What the software update window shows; see src-tauri/src/updater.rs. */
export type UpdateView =
  | { state: 'checking' }
  | { state: 'downloading'; version: string; received: number; total: number | null }
  | {
      state: 'available'
      version: string
      currentVersion: string
      /** Release day, YYYY-MM-DD. */
      releaseDate: string | null
      releaseNotes: string
    }
  | { state: 'ready'; version: string }
  | { state: 'installing'; version: string | null }
  | { state: 'up-to-date'; version: string }
  | { state: 'error'; title: string; message: string }

export interface UpdateBadgeState {
  available: boolean
  latestVersion: string | null
  currentVersion: string
}

/** A document whose binary content (PDF/image/audio/video) is declared in
 *  the project but absent from the .qdpx — surfaced on load so the user can
 *  re-import the original file. */
export interface MissingBinary {
  guid: string
  name: string
  sourceType: string
}

/** Check-out lock state for a .qdpx project. Lives only in the project's
 *  own magnolia-lock.json/magnolia-project-id.json zip entries — never in
 *  the REFI-QDA-standard .qde XML — so it's deliberately absent from the
 *  `Project` model itself (it must never enter collectProject()'s output
 *  or a save payload). */
export interface CheckoutMarker {
  projectId: string
  userName: string
  checkedOutAt: string
}

/** Who last saved a .qdpx, and when — stamped on every save regardless of
 *  checkout state (writer.ts's magnolia-editor.json), so merge can always
 *  attribute a file's differences to a person. */
export interface EditorInfo {
  lastEditedBy: string
  lastEditedAt: string
}

// IPC API exposed to renderer
/** A document being imported: Waiting, then Reading (or Converting, for
 *  Word, RTF and ODT files, which are typeset as PDFs), then Reading text
 *  (PDFs), then Done or Failed. */
export type ImportStage = 'waiting' | 'reading' | 'converting' | 'readingText' | 'done' | 'failed'
export interface ImportItem { name: string; stage: ImportStage; error?: string }
export interface ImportState { items: ImportItem[]; finished: boolean }

export interface MagnoliaAPI {
  /** The operating system Magnolia runs on. */
  platform: 'darwin' | 'win32' | 'linux'
  getFileSize: (filePath: string) => Promise<number | null>
  readPdfFile: (filePath: string) => Promise<Uint8Array>
  onProjectLoadProgress: (callback: (p: { stage: string; current: number; total: number }) => void) => () => void
  openProject: () => Promise<OpenedProject | null>
  pickProjectFile: () => Promise<string | null>
  /** Of the given files, those that no longer exist. */
  missingFiles: (paths: string[]) => Promise<string[]>
  /** Pick several .qdpx files at once (Inter-coder Agreement). */
  pickProjectFiles: () => Promise<string[]>
  openProjectPath: (filePath: string) => Promise<OpenedProject | null>
  readCheckoutMarker: (filePath: string) => Promise<CheckoutMarker | null>
  /** Atomic check-and-set: rejects (`ok: false`, `marker` = the current
   *  holder) if someone else already holds the lock, unless `steal` is
   *  passed, which writes through unconditionally. See
   *  checkout-marker.ts's writeCheckoutMarker for exactly how atomic. */
  checkOutProject: (filePath: string, userName: string, steal?: boolean) => Promise<{ ok: boolean; marker: CheckoutMarker | null }>
  /** Also check-and-set: rejects (does NOT remove the lock) if it no
   *  longer names `userName` as holder — the caller's belief that it
   *  still holds the lock may be stale, since there's no live push. */
  checkInProject: (filePath: string, userName: string) => Promise<{ ok: boolean; marker: CheckoutMarker | null }>
  /** Load a second .qdpx's full contents for merge comparison, WITHOUT
   *  touching the currently-open project's active-archive/binary state —
   *  see the handler in ipc-handlers.ts for why this is safe. No binary
   *  (PDF/audio/video/image) content can be resolved from the result. */
  readQdpxForCompare: (filePath: string) => Promise<Project & { sourceContents: Record<string, string>; filePath: string; editorInfo: EditorInfo | null }>
  /** Merge: pull one pdf/audio/video/image source's bytes out of
   *  comparisonFilePath (a second .qdpx, not the active project) and
   *  register them as an overlay in the ACTIVE project, returning a fresh
   *  magnolia-bin:// handle that actually resolves there. handle is the
   *  source's existing handle as read via readQdpxForCompare. Resolves to
   *  null if handle isn't an archive handle or the bytes can't be found. */
  importMergeBinary: (comparisonFilePath: string, handle: string) => Promise<string | null>
  /** Merge: read a source's raw bytes from comparisonFilePath WITHOUT
   *  registering an overlay — used only to compare against the active
   *  project's own copy of a same-named document (see
   *  dedupeIdenticalSources), not to bring anything in. */
  readCompareBinary: (comparisonFilePath: string, handle: string) => Promise<Uint8Array | null>
  saveProject: (data: {
    project: Project
    sourceContents: Record<string, string>
    /** The project may be saved empty over a file that has content: the
     *  user emptied it (see stores/empty-save-guard). */
    allowEmpty?: boolean
    filePath?: string
    /** Current user's name (Preferences). Enables the save-time staleness
     *  check: if the on-disk checkout lock now names someone else, the
     *  save is refused (`{ conflict: true, marker }`) instead of blindly
     *  overwriting their already-saved changes. Omit only when the user
     *  has no name set — checkout was never possible for them either. */
    userName?: string
  }) => Promise<string | { guardBlocked: true; message: string } | { conflict: true; marker: CheckoutMarker } | null>
  saveProjectAs: (data: {
    project: Project
    sourceContents: Record<string, string>
    /** The project may be saved empty over a file that has content: the
     *  user emptied it (see stores/empty-save-guard). */
    allowEmpty?: boolean
    /** Path of the project currently open, so the writer can carry
     *  imported binaries forward to the new file even if their temp
     *  working copies have been reaped. */
    currentFilePath?: string
  }) => Promise<string | null>
  /** "Create a Copy" from the checkout-conflict dialog: writes an
   *  unattended duplicate (no Save dialog) next to `currentFilePath`,
   *  named "YYMMDD<userName> <original filename>.qdpx" (incrementing with
   *  " (2)", " (3)", etc. on collision) and never carrying the source
   *  file's checkout lock forward — the copy starts completely unlocked. */
  createProjectCopy: (data: {
    project: Project
    sourceContents: Record<string, string>
    /** The project may be saved empty over a file that has content: the
     *  user emptied it (see stores/empty-save-guard). */
    allowEmpty?: boolean
    currentFilePath: string
    /** Current user's name (Preferences), stamped into the copy's
     *  filename. Omit or pass '' to skip the name portion. */
    userName?: string
  }) => Promise<string | null>
  /** Tell main which .qdpx is currently open, so reaped media temp files
   *  can be regenerated from it on demand. Pass null when no project is
   *  open. */
  setActiveProjectPath: (filePath: string | null) => Promise<void>
  createNewProjectFile: () => Promise<{ filePath: string; projectName: string } | null>
  importTextFile: () => Promise<ImportedFile[] | null>
  /** How an import is going: each file's stage, and whether it's finished. */
  onImportProgress: (callback: (s: ImportState) => void) => () => void
  readTextFiles: (filePaths: string[]) => Promise<ImportedFile[] | null>
  /** GET from the Zotero app's local API (a path under /api/). Rejects
   *  with "zotero-not-running" when Zotero isn't open. */
  zoteroGet: (path: string) => Promise<{ status: number; total: number | null; body: string }>
  /** Where a Zotero attachment's file is on this computer, or null. */
  zoteroFilePath: (library: string, key: string) => Promise<string | null>
  /** Filesystem path of a dropped / picked File ('' if it has none). */
  getPathForFile: (file: File) => string
  /** Re-import the file for an existing document of the given type whose
   *  bytes are missing from the .qdpx. Returns the read file (to be
   *  re-attached to the existing source), an error, or null if cancelled. */
  reimportDocument: (
    sourceType: string
  ) => Promise<ImportedFile | null>
  /** Open the bundled LICENSE (EUPL-1.2) in the OS's default text viewer. */
  openLicence: () => Promise<void>
  /** Open the bundled THIRD-PARTY-LICENSES.txt in the OS's default text viewer. */
  openAcknowledgements: () => Promise<void>
  exportPdf: (
    html: string,
    defaultName: string,
    dialogTitle?: string,
    headerTemplate?: string,
    footerTemplate?: string,
    /** Script to run in the print window before printing. The HTML itself
     *  may run none: it's built from project content. */
    script?: string
  ) => Promise<string | null>
  exportCodebook: (codes: Code[]) => Promise<string | null>
  importCodebook: () => Promise<Code[] | null>
  showNewQueryDialog: () => void
  onQueryFromBuilder: (callback: (query: Query, editSavedQueryGuid?: string, graphLayout?: QueryGraphLayout) => void) => () => void
  sendQueryToMain: (query: Query, editSavedQueryGuid?: string, graphLayout?: QueryGraphLayout) => void
  sendPreviewToMain: (query: Query, graphLayout?: QueryGraphLayout) => void
  onPreviewFromBuilder: (callback: (query: Query, graphLayout?: QueryGraphLayout) => void) => () => void
  sendSaveQueryToMain: (query: Query, name: string, graphLayout?: QueryGraphLayout, savedGuid?: string) => void
  onSaveQueryFromBuilder: (callback: (query: Query, name: string, graphLayout?: QueryGraphLayout, savedGuid?: string) => void) => () => void
  onMenuAction: (callback: (action: string) => void) => () => void
  broadcastTheme: (theme: string) => void
  onThemeChanged: (callback: (theme: string) => void) => () => void
  setZoomFactor: (factor: number) => void
  broadcastZoomFactor: (factor: number) => void
  onZoomFactorChanged: (callback: (factor: number) => void) => () => void
  /** The interface language, sent to every other window when it changes. */
  broadcastLanguage: (language: string) => void
  onLanguageChanged: (callback: (language: string) => void) => () => void
  /** Tell the backend the interface language, for its menus and dialogs,
   *  the preference it came from (a language id, or "system"), and the
   *  locale its numbers are written in ("ar-u-nu-latn"). */
  setNativeLanguage: (language: string, preference: string, numberLocale: string) => void
  /** The computer's region locale as the OS gives it ("ar_EG",
   *  "ar_EG@numbers=latn"); empty where there's none to read. */
  systemLocale: () => Promise<string>
  // Codebook window
  openCodebookWindow: (data: CodebookInitData) => void
  getCodebookData: () => Promise<CodebookInitData>
  onCodebookData: (callback: (data: CodebookInitData) => void) => () => void
  sendCodebookUpdate: <A extends keyof CodebookMessages>(action: A, ...args: CodebookMessages[A]) => void
  onCodebookUpdate: (callback: (message: ArgsMessage<CodebookMessages>) => void) => () => void
  // Welcome window
  sendWelcomeAction: (action: string) => void
  getRecentProjects: () => Promise<{ name: string; path: string }[]>
  onOpenRecentProject: (callback: (filePath: string) => void) => () => void
  onNewProjectAtPath: (callback: (data: { filePath: string; projectName: string }) => void) => () => void
  onFlushAndClose: (callback: () => void) => () => void
  notifyFlushComplete: () => void
  /** The pre-close save failed and the person chose to stay: the close is off. */
  cancelFlush: () => void
  sendFlushHeartbeat: () => void
  trackRecentProject: (name: string, filePath: string) => void
  onRecentProjectsChanged: (callback: () => void) => () => void
  // Memo edit window
  openMemoEditWindow: (data: MemoEditInitData) => void
  getMemoEditData: () => Promise<MemoEditInitData>
  onMemoEditData: (callback: (data: MemoEditInitData) => void) => () => void
  sendMemoUpdate: (memo: MemoUpdate) => void
  onMemoUpdate: (callback: (memo: MemoUpdate) => void) => () => void
  sendMemoDelete: (guid: string) => void
  onMemoDelete: (callback: (guid: string) => void) => () => void
  // Logbook window
  openLogbookWindow: (data: LogbookInitData) => void
  getLogbookData: () => Promise<LogbookInitData>
  onLogbookData: (callback: (data: LogbookInitData) => void) => () => void
  sendLogbookUpdate: <A extends keyof LogbookMessages>(action: A, ...args: LogbookMessages[A]) => void
  onLogbookUpdate: (callback: (message: ArgsMessage<LogbookMessages>) => void) => () => void
  // Memos window
  openMemosWindow: (data: MemosWindowData) => void
  /** Refreshes the Memos window if it is open. */
  updateMemosWindow: (data: MemosWindowData) => void
  getMemosWindowData: () => Promise<MemosWindowData>
  onMemosWindowData: (callback: (data: MemosWindowData) => void) => () => void
  /** 'edit' (guid), 'show' (guid), 'new' or 'delete' (guids): the main
   *  window acts on them, prompting first while the project is checked out. */
  sendMemosWindowAction: <A extends keyof MemosWindowMessages>(action: A, ...args: MemosWindowMessages[A]) => void
  onMemosWindowAction: (callback: (message: ArgsMessage<MemosWindowMessages>) => void) => () => void
  /** Brings the main project window to the front. */
  focusMainWindow: () => void
  // Analysis actions — round-trip through main so inline analysis
  // tools can hand work back to the main App (save-analysis,
  // run-query, open-memo, etc.).
  sendAnalysisAction: <A extends keyof AnalysisMessages>(action: A, ...args: AnalysisMessages[A]) => void
  onAnalysisAction: (callback: (message: ArgsMessage<AnalysisMessages>) => void) => () => void
  exportCsv: (content: string, defaultName: string) => Promise<string | null>
  exportSvg: (content: string, defaultName: string) => Promise<string | null>
  focusWindow: () => void
  // Custom window controls (Windows/Linux frameless main window)
  minimizeWindow: () => void
  toggleMaximizeWindow: () => void
  closeWindow: () => void
  isWindowMaximized: () => Promise<boolean>
  onWindowMaximizedChanged: (callback: (isMax: boolean) => void) => () => void
  // Software update window (Sparkle-style; opened and driven by the backend)
  getUpdateView: () => Promise<UpdateView | null>
  onUpdateView: (callback: (view: UpdateView) => void) => () => void
  installUpdate: () => void
  skipUpdateVersion: (version: string) => void
  /** Remind Me Later / Cancel / OK: close the update window. */
  dismissUpdate: () => void
  /** Resize the update window by `delta` px so its status panel fits. */
  fitUpdateWindow: (delta: number) => void
  getAppVersion: () => Promise<string>
  checkForUpdates: () => void
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void
  getUpdateBadge: () => Promise<UpdateBadgeState>
  onUpdateBadge: (callback: (state: UpdateBadgeState) => void) => () => void
  // Inter-coder Agreement results window (pop-out).
  openIntercoderResultsWindow: (data: IntercoderWindowData) => void
  updateIntercoderResultsWindow: (data: IntercoderWindowData) => void
  closeIntercoderResultsWindow: () => void
  getIntercoderResultsData: () => Promise<IntercoderWindowData | null>
  onIntercoderResultsData: (callback: (data: IntercoderWindowData) => void) => () => void
  sendIntercoderResultsAction: <A extends keyof IntercoderResultsMessages>(action: A, ...args: IntercoderResultsMessages[A]) => void
  onIntercoderResultsAction: (callback: (message: PayloadMessage<IntercoderResultsMessages>) => void) => () => void
  onIntercoderResultsClosed: (callback: () => void) => () => void
  // Query results window (pop-out)
  openQueryResultsWindow: (data: QueryResultsInitData) => void
  /** Whether Query Results was popped out when the main window last closed. */
  wasQueryResultsPoppedOut: () => Promise<boolean>
  updateQueryResultsWindow: (data: QueryResultsInitData) => void
  getQueryResultsData: () => Promise<QueryResultsInitData>
  onQueryResultsData: (callback: (data: QueryResultsInitData) => void) => () => void
  sendQueryResultsAction: <A extends keyof QueryResultsMessages>(action: A, ...args: QueryResultsMessages[A]) => void
  onQueryResultsAction: (callback: (message: PayloadMessage<QueryResultsMessages>) => void) => () => void
  jumpToQueryResult: (target: {
    sourceGuid: string
    startPosition: number
    endPosition: number
    pdfRegion?: PdfRegionSelection
    timeRange?: TimeRange
    surveyCell?: { respondentId: string; questionId: string }
  }) => void
  onJumpToQueryResult: (callback: (target: {
    sourceGuid: string
    startPosition: number
    endPosition: number
    pdfRegion?: PdfRegionSelection
    timeRange?: TimeRange
    surveyCell?: { respondentId: string; questionId: string }
  }) => void) => () => void
  onQueryResultsClosed: (callback: () => void) => () => void
  // Panel visibility
  updatePanelVisibility: (visibility: Record<string, boolean>) => void
  // Audio
  readAudioFile: (filePath: string) => Promise<ArrayBuffer>
  // Image
  readImageFile: (filePath: string) => Promise<ArrayBuffer>
  // Video
  readVideoFile: (filePath: string) => Promise<ArrayBuffer>
  /** Show a message in a native dialog over this window. Use this, not
   *  window.alert, which shows nothing here. A blank line separates the
   *  dialog's bold title from the rest. */
  showMessage: (message: string, kind?: 'info' | 'warning' | 'error') => Promise<void>
  /** Versions and the project file's size, for Help → Copy Diagnostic
   *  Information (utils/diagnostics.ts). */
  diagnosticsInfo: (filePath: string | null) => Promise<{
    appVersion: string; os: string; arch: string; osVersion: string | null; webview: string | null; projectFileBytes: number | null
  }>
  /** Ask a yes-or-no question in a native dialog; true for `okLabel`
   *  (default OK). Use this, not window.confirm, whose answer here is a
   *  Promise — which reads as yes. */
  askConfirm: (message: string, okLabel?: string) => Promise<boolean>
  /** Ask whether to open another project, or close this one (`closing`),
   *  although its latest changes couldn't be saved (why: `error`, or who
   *  now has control: `lockedBy`). True to go ahead and lose them. */
  confirmLosingChanges: (projectName: string, why: { error?: string; lockedBy?: string; closing?: boolean }) => Promise<boolean>
  /** A URL the <audio>/<video> elements stream a media handle from,
   *  served as `mimeType` (else as its extension suggests). */
  mediaUrl: (handle: string, mimeType?: string) => string
  /** Read a media handle a range at a time (for the waveform). */
  openMedia: (handle: string) => Promise<ByteSource>
  // Transcript import
  importTranscript: () => Promise<{ name: string; content: string } | null>
  // Preferences
  /** The saved preferences, or null if there are none yet. */
  loadPreferences: () => Promise<SavedPreferences | null>
  savePreferences: (prefs: SavedPreferences) => Promise<void>
  sendPreferencesUpdate: (prefs: SavedPreferences) => void
  onPreferencesUpdate: (callback: (prefs: SavedPreferences) => void) => () => void
  // AI apps on this computer (src-tauri/src/mcp.rs).
  mcpSetEnabled: (enabled: boolean) => Promise<void>
  mcpReply: (callId: string, content: string, isError: boolean) => Promise<void>
  onMcpCall: (callback: (call: { callId: string; session: string; client: string; name: string; input: Record<string, unknown> }) => void) => () => void
  /** The settings an AI app needs to start Magnolia's connector. */
  mcpConnectorSettings: () => Promise<Record<string, unknown>>
  /** Adds Magnolia to Claude Desktop's settings; the file changed. */
  mcpAddToClaudeDesktop: () => Promise<string>
  mcpClaudeDesktopFound: () => Promise<boolean>
}

export interface AiToolSpec {
  name: string
  description: string
  schema: Record<string, unknown>
}

export interface CodebookInitData {
  codes: Code[]
  /** Coded segments per code guid, for the counts in the code list. */
  codeCounts?: Record<string, number>
  /** A code for the Codebook to start renaming (one just added). */
  renameGuid?: string
  theme: string
}

export type MemoType =
  | 'project'
  | 'document'
  | 'content'
  | 'analysis'
  | 'saved-analysis'
  | 'saved-query'
  | 'survey-question'
  /** Whole-respondent memo created via the FAB on a Respondent view
   *  header. One memo per (survey, respondent). Conceptually the
   *  document-level memo for the respondent's submission. */
  | 'survey-respondent'
  /** Whole-cell memo created via the FAB on a survey cell. Distinct
   *  from a 'content' memo so the right-click span memos on the same
   *  cell don't light up the cell's FAB. */
  | 'survey-cell'

export interface Memo {
  guid: string
  type: MemoType
  title: string
  content: string
  createdDateTime: string
  modifiedDateTime?: string
  /** For document memos: the source guid(s) they are attached to */
  sourceGuids?: string[]
  /** For selection memos: the source guid and codepoint range */
  sourceGuid?: string
  startPosition?: number
  endPosition?: number
  /** For selection memos attached to a box selection on a PDF, this is the
   *  page-relative rectangle they apply to. startPosition/endPosition are
   *  still present (usually 0) as a fallback. */
  pdfRegion?: PdfRegionSelection
  /** For analysis memos (relationship-map elements) and saved-analysis
   *  memos (one per saved analysis): the analysis guid they're tied to. */
  analysisGuid?: string
  /** For saved-query memos: the saved query guid they're tied to. One
   *  memo per saved query. */
  queryGuid?: string
  /** For survey-question memos: the question guid the memo applies
   *  to. `sourceGuid` is also set (to the survey source). One memo
   *  per (survey, question). */
  questionGuid?: string
  /** For survey-respondent memos: the respondent id the memo applies
   *  to. `sourceGuid` is also set (to the survey source). One memo
   *  per (survey, respondent). */
  respondentId?: string
  /** For selection memos created inside a survey cell: the cell the
   *  memo applies to. startPosition / endPosition are CELL-relative
   *  when this is set, just like for survey-scoped selections. */
  surveyCell?: {
    respondentId: string
    questionId: string
  }
}

export interface Quote {
  guid: string
  sourceGuid: string
  sourceName: string
  startPosition: number
  endPosition: number
  text: string
  createdDateTime: string
  /** For quotes attached to a box selection on a PDF. */
  pdfRegion?: PdfRegionSelection
  /** For quotes created from a span inside a survey cell: the cell
   *  the quote applies to. startPosition / endPosition are CELL-
   *  relative when this is set. */
  surveyCell?: {
    respondentId: string
    questionId: string
  }
}

export interface MemoEditInitData {
  memo: Memo
  theme: string
  /** When true, the memo hasn't been persisted yet — save creates it */
  isNew?: boolean
}

export type MemosWindowAction = keyof MemosWindowMessages

export interface MemosWindowData {
  memos: Memo[]
  /** Where each memo is attached, by memo guid (see utils/memo-places.ts). */
  places: Record<string, import('../utils/memo-places').MemoPlace>
  /** Who has the project checked out, when it isn't this user: edits are
   *  then refused with a prompt in the main window. */
  lockedBy: string | null
  theme: string
}

export interface LogbookEntry {
  guid: string
  title: string
  content: string
  createdDateTime: string
  modifiedDateTime?: string
}

export interface LogbookInitData {
  entries: LogbookEntry[]
  theme: string
}

export interface QueryResultsInitData {
  results: QueryResult[]
  queryName: string
  isActive: boolean
  /** A run is in progress in the main window — show the loading bar. */
  isLoading?: boolean
  isUnsaved: boolean
  theme: string
  /** Source selections for showing other codes in result text (keyed by sourceGuid) */
  sourceSelections?: Record<string, PlainTextSelection[]>
  /** Survey data per survey-source guid — lets the popped-out
   *  window render "Respondent N · Question N" badges for results
   *  pulled from survey cells. Only sources whose sourceType is
   *  'survey' show up here. */
  surveysByGuid?: Record<string, SurveyData>
  /** PDF file paths by sourceGuid — needed for rendering region thumbnails
   *  in the popped-out window. */
  pdfFilePaths?: Record<string, string>
  /** Codepoint offset where each page's text starts, per PDF
   *  sourceGuid — lets PDF text results show their page number. */
  pdfPageOffsets?: Record<string, number[]>
  /** Video file paths + MIME types by sourceGuid — needed for the
   *  inline player that appears next to video query results. */
  videoFilePaths?: Record<string, string>
  videoMimeTypes?: Record<string, string>
  /** Flat code list for lookup */
  codes?: { guid: string; name: string; color?: string }[]
  /** Saved queries for the embedded Saved Queries sidebar inside the
   *  popped-out Queries window. Synced on each update of the popped
   *  window's data so the sidebar stays in sync with the main app. */
  savedQueries?: SavedQuery[]
  /** The currently active query — used by the Saved Queries sidebar
   *  to highlight which saved query's results are showing. */
  currentQuery?: Query
}

export type AnalysisToolType =
  | 'code-cooccurrences'
  | 'codes-in-documents'
  | 'framework-matrix'
  | 'intercoder-agreement'
  | 'results-in-documents'
  | 'code-frequencies'
  | 'code-orders'
  | 'word-frequencies'
  | 'word-combinations'
  | 'relationship-map'
  | 'reports'

export interface AnalysisInitData {
  toolType: AnalysisToolType
  theme: string
  sources: {
    guid: string
    name: string
    /** Source kind — drives extent calculations for the analysis tools
     *  (e.g. Code Frequencies uses % of duration for audio/video and
     *  % of area for image / PDF box codings). */
    sourceType?: SourceType
    /** Duration in seconds for audio/video; used as the denominator
     *  when computing % of media covered by code. */
    duration?: number
    /** Audio/video: each transcript line's start time (line index →
     *  seconds), to place codings made on the transcript in time. */
    lineTimes?: Record<string, number>
  }[]
  folders: { guid: string; name: string; parentGuid: string | null; kind?: 'notebook' }[]
  codes: { guid: string; name: string; color?: string; isCodable: boolean; parentGuid?: string }[]
  tags: { guid: string; name: string; categoryGuid?: string; value?: string }[]
  categories: { guid: string; name: string; type?: TagCategoryType; listOptions?: string[] }[]
  /** Source content keyed by source guid (for word frequencies, code frequencies) */
  sourceContents: Record<string, string>
  /** Full selections per source for computing co-occurrences, code-in-doc, frequencies */
  sourceSelections: Record<string, PlainTextSelection[]>
  /** Tag member source guids */
  tagMembers: Record<string, string[]>
  /** PDFs and images whose page sizes have been read (source guid →
   *  page key 'p1'… → width / height in points or pixels), for measuring
   *  box codings by area. A document missing here has its size estimated
   *  from its boxes. */
  pageSizes?: Record<string, Record<string, { w: number; h: number }>>
  /** Survey respondent/question tag membership (tag guid → entity refs),
   *  for cell-precise scoping of survey content by tag. */
  respondentTagMembers?: Record<string, SurveyEntityRef[]>
  questionTagMembers?: Record<string, SurveyEntityRef[]>
  /** Per survey source, the CODABLE cells — open-ended answers only,
   *  which are the only cells a user can apply codes to. These define
   *  what "100% of a survey" means for coverage metrics and what text
   *  word-frequency should count; the raw CSV in sourceContents must not
   *  be used as a survey's analysable content. Keyed by survey source
   *  guid. */
  surveyCodableCells?: Record<string, { respondentId: string; questionId: string; text: string }[]>
  /** Per survey source: respondent id → display name, question id → text.
   *  Lets the Document Selector name the respondents/questions a tag
   *  filter targets. */
  surveyEntityLabels?: Record<string, { respondents: Record<string, string>; questions: Record<string, string> }>
  /** Full SurveyData per survey source guid — populated for the
   *  Relationship Map sidebar so respondents, questions, and cells
   *  can be listed and dragged onto the canvas as nodes. */
  surveysByGuid?: Record<string, SurveyData>
  /** Document-to-folder mapping */
  sourceFolder?: Record<string, string>
  /** Saved queries (for relationship map sidebar and results-in-documents) */
  savedQueries?: { guid: string; name: string; query?: Query }[]
  /** Memos (for relationship map sidebar) */
  memos?: { guid: string; title: string; type: string; content?: string; sourceGuid?: string; sourceGuids?: string[] }[]
  /** Saved analyses (for relationship map sidebar) */
  savedAnalyses?: { guid: string; name: string; toolType: AnalysisToolType }[]
  /** Quotes (for relationship map sidebar) */
  quotes?: { guid: string; text: string; sourceName: string; sourceGuid: string; startPosition: number; endPosition: number; pdfRegion?: PdfRegionSelection }[]
  /** PDF file paths by sourceGuid — needed for rendering region thumbnails
   *  of quote / query-result elements dropped into the relationship map. */
  pdfFilePaths?: Record<string, string>
  /** Restored saved analysis config (if opening a saved analysis) */
  savedConfig?: ToolConfig
}

/** A tool's settings as saved (each tool reads its own fields). */
export type ToolConfig = object

/** The ad-hoc Query Builder tab's settings: what it was opened to edit. */
export interface QueryBuilderTabConfig {
  editSavedQueryGuid?: string
  editCurrentQuery?: boolean
}

export interface SavedAnalysis {
  guid: string
  toolType: AnalysisToolType
  name: string
  config: ToolConfig
  createdDateTime: string
  modifiedDateTime?: string
}

declare global {
  interface Window {
    api: MagnoliaAPI
    /** Set while Query Results starts a drag of its own, so the main window
     *  doesn't raise the other windows over it (platform/tauri-api). */
    __suppressRaiseChildWindows?: boolean
  }
}

/** Where a check for updates has got to. */
export interface UpdateStatus {
  state: 'checking' | 'up-to-date' | 'available' | 'error' | 'dev-disabled'
  version?: string
  message?: string
}

/** A file read a range at a time, so a long recording is never all in memory. */
export interface ByteSource {
  size: number
  /** Bytes `start` up to (not including) `end`. */
  read: (start: number, end: number) => Promise<Uint8Array>
}

/** How a save went: `error` says why it failed, or `lockedBy` names who
 *  took control of the project. */
export type SaveOutcome = { ok: true; error?: undefined; lockedBy?: undefined } | { ok: false; error?: string; lockedBy?: string }

/** A file read for import: the document it becomes (its text, its
 *  extension, and for media the details the source keeps as formatData),
 *  or why it couldn't be read. */
export type ImportedFile =
  | { name: string; content: string; extension: string; formatting?: TextSource['formatData']; error?: undefined }
  | { name: string; error: string; content?: undefined; extension?: undefined; formatting?: undefined }

// ── Query Builder graph ──

/** A Query Builder node's kind. */
export type QueryGraphNodeKind = 'code' | 'any' | 'text' | 'logical' | 'overlap' | 'inside' | 'outside' | 'before' | 'followedBy' | 'sameSentence' | 'result'

export type QueryGraphLogicalOp = 'and' | 'or' | 'not' | 'xor'

/** A node in the Query Builder's graph (saved with the query, so it reopens as drawn). */
export interface QueryGraphNode {
  id: string
  kind: QueryGraphNodeKind
  x: number
  y: number
  codeGuid?: string
  codeName?: string
  codeColor?: string
  includeSubcodes?: boolean
  searchText?: string
  caseSensitive?: boolean
  wholeWord?: boolean
  /** Text node: find the sentences the text occurs in. */
  sentences?: boolean
  /** For logical nodes: the single operator type */
  logicalOp?: QueryGraphLogicalOp
  /** @deprecated — old multi-op array, migrated to logicalOp on load */
  logicalOps?: (QueryGraphLogicalOp | undefined)[]
  /** For multi-input operators (and/or): how many input slots */
  inputCount?: number
  /** Inline NOT toggle — wraps this node's condition in { type: 'not' } */
  isNegated?: boolean
}

/** A wire from one node's output to another's input port. */
export interface QueryGraphConn {
  id: string
  from: string
  to: string
  toPort: number
}

/** The Query Builder's graph, as saved with a query. */
export interface QueryGraphLayout {
  nodes: QueryGraphNode[]
  conns: QueryGraphConn[]
}

/** The preferences file: the store's preferences, and how numbers are
 *  written (`digits`, which i18n applies). Saved by an older Magnolia, any
 *  of it may be missing. */
export type SavedPreferences = Partial<Preferences> & { digits?: string }

