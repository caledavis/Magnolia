/** Magnolia-specific document folder. The REFI-QDA standard has no
 *  folder concept — these are persisted in a `magnolia-folders.json`
 *  side table inside the .qdpx alongside the per-doc folder mapping. */
export interface DocumentFolder {
  guid: string
  name: string
  parentGuid: string | null
}

export interface Project {
  name: string
  origin: string
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
      adhocConfig?: any
    }
  | {
      id: string
      kind: 'query-builder'
      title: string
      adhocConfig?: any
    }

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

export type SourceType = 'text' | 'markdown' | 'pdf' | 'audio' | 'image' | 'video' | 'survey'

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

/** Format-specific data for image sources */
export interface ImageFormatData {
  imageFilePath?: string   // path to temp file with image bytes (renderer reads via IPC)
  mimeType: string         // 'image/jpeg', 'image/png', 'image/gif', 'image/webp'
  /** Original file extension preserved so the QDPX writer can keep the same suffix. */
  imageExt?: string
}

export interface TextSource {
  guid: string
  name: string
  sourceType?: SourceType
  /** Format-specific data (PDF binary, audio binary, page offsets, etc.) */
  formatData?: any
  plainTextPath?: string
  plainTextContent?: string
  richTextPath?: string
  creatingUser?: string
  creationDateTime?: string
  modifyingUser?: string
  modifiedDateTime?: string
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
  /** If present, this is a video time-range coding. The authoritative range
   *  is on the video timeline; startPosition/endPosition carry the line-
   *  anchor range in the transcript (purely visual — dragging the transcript
   *  bracket updates startPosition/endPosition without changing timeRange). */
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
  | { type: 'text'; searchText: string; caseSensitive?: boolean; wholeWord?: boolean }
  | { type: 'and'; conditions: CodeCondition[] }
  | { type: 'or'; conditions: CodeCondition[] }
  | { type: 'xor'; conditions: CodeCondition[] }
  | { type: 'not'; condition: CodeCondition }
  | { type: 'overlap'; condition1: CodeCondition; condition2: CodeCondition }
  | { type: 'inside'; condition1: CodeCondition; condition2: CodeCondition }
  | { type: 'outside'; condition1: CodeCondition; condition2: CodeCondition }
  | { type: 'before'; condition1: CodeCondition; condition2: CodeCondition }
  | { type: 'followedBy'; condition1: CodeCondition; condition2: CodeCondition }

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
    graph?: { nodes: any[]; conns: any[] }
  }
  codeCondition: CodeCondition
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
  graphLayout?: { nodes: any[]; conns: any[] }
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
   *  the query results window. startPosition/endPosition still carry
   *  the matching transcript-line range (stored as line indexes for
   *  video selections). */
  timeRange?: TimeRange
  /** Present when the match is inside a survey answer cell — identifies
   *  the (respondent, question) so consumers (e.g. the Select Documents
   *  button) can map a result back to its respondent. */
  surveyCell?: { respondentId: string; questionId: string }
}

// Data sent to the query builder window
export interface QueryBuilderInitData {
  sources: { guid: string; name: string }[]
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
  editGraphLayout?: { nodes: any[]; conns: any[] }
  // Snapshot of the active query before the builder opened (for Cancel to restore)
  priorQuery?: Query | null
}

/** "Newer version available" nudge state, computed in the main process by
 *  comparing this build against the latest published GitHub release. Drives the
 *  toolbar wordmark badge and the Updates pane on all builds. */
export interface UpdateBadgeState {
  available: boolean
  latestVersion: string | null
  currentVersion: string
}

// IPC API exposed to renderer
export interface ElectronAPI {
  getFileSize: (filePath: string) => Promise<number | null>
  readPdfFile: (filePath: string) => Promise<Uint8Array>
  onProjectLoadProgress: (callback: (p: { stage: string; current: number; total: number }) => void) => () => void
  openProject: () => Promise<Project & { sourceContents: Record<string, string> } | null>
  pickProjectFile: () => Promise<string | null>
  openProjectPath: (filePath: string) => Promise<Project & { sourceContents: Record<string, string> } | null>
  saveProject: (data: {
    project: Project
    sourceContents: Record<string, string>
    filePath?: string
  }) => Promise<string | null>
  saveProjectAs: (data: {
    project: Project
    sourceContents: Record<string, string>
  }) => Promise<string | null>
  createNewProjectFile: () => Promise<{ filePath: string; projectName: string } | null>
  importTextFile: () => Promise<{ name: string; content: string } | null>
  readTextFiles: (filePaths: string[]) => Promise<{ name: string; content: string }[] | null>
  /** Open the bundled LICENSE (EUPL-1.2) in the OS's default text viewer. */
  openLicence: () => Promise<void>
  /** Open the bundled THIRD-PARTY-LICENSES.txt in the OS's default text viewer. */
  openAcknowledgements: () => Promise<void>
  exportPdf: (
    html: string,
    defaultName: string,
    dialogTitle?: string,
    headerTemplate?: string,
    footerTemplate?: string
  ) => Promise<string | null>
  exportCodebook: (codes: Code[]) => Promise<string | null>
  importCodebook: () => Promise<Code[] | null>
  showNewQueryDialog: () => void
  onQueryFromBuilder: (callback: (query: Query, editSavedQueryGuid?: string, graphLayout?: any) => void) => () => void
  sendQueryToMain: (query: Query, editSavedQueryGuid?: string, graphLayout?: any) => void
  sendPreviewToMain: (query: Query, graphLayout?: any) => void
  onPreviewFromBuilder: (callback: (query: Query, graphLayout?: any) => void) => () => void
  sendSaveQueryToMain: (query: Query, name: string, graphLayout?: any, savedGuid?: string) => void
  onSaveQueryFromBuilder: (callback: (query: Query, name: string, graphLayout?: any, savedGuid?: string) => void) => () => void
  onMenuAction: (callback: (action: string) => void) => () => void
  broadcastTheme: (theme: string) => void
  onThemeChanged: (callback: (theme: string) => void) => () => void
  // Codebook window
  openCodebookWindow: (data: CodebookInitData) => void
  getCodebookData: () => Promise<CodebookInitData>
  onCodebookData: (callback: (data: CodebookInitData) => void) => () => void
  sendCodebookUpdate: (action: string, ...args: any[]) => void
  onCodebookUpdate: (callback: (action: string, ...args: any[]) => void) => () => void
  // Welcome window
  sendWelcomeAction: (action: string) => void
  getRecentProjects: () => Promise<{ name: string; path: string }[]>
  onOpenRecentProject: (callback: (filePath: string) => void) => () => void
  onNewProjectAtPath: (callback: (data: { filePath: string; projectName: string }) => void) => () => void
  onFlushAndClose: (callback: () => void) => () => void
  notifyFlushComplete: () => void
  sendFlushHeartbeat: () => void
  trackRecentProject: (name: string, filePath: string) => void
  onRecentProjectsChanged: (callback: () => void) => () => void
  // Memo edit window
  openMemoEditWindow: (data: MemoEditInitData) => void
  getMemoEditData: () => Promise<MemoEditInitData>
  onMemoEditData: (callback: (data: MemoEditInitData) => void) => () => void
  sendMemoUpdate: (memo: Memo) => void
  onMemoUpdate: (callback: (memo: Memo) => void) => () => void
  sendMemoDelete: (guid: string) => void
  onMemoDelete: (callback: (guid: string) => void) => () => void
  // Logbook window
  openLogbookWindow: (data: LogbookInitData) => void
  getLogbookData: () => Promise<LogbookInitData>
  onLogbookData: (callback: (data: LogbookInitData) => void) => () => void
  sendLogbookUpdate: (action: string, ...args: any[]) => void
  onLogbookUpdate: (callback: (action: string, ...args: any[]) => void) => () => void
  // Analysis actions — round-trip through main so inline analysis
  // tools can hand work back to the main App (save-analysis,
  // run-query, open-memo, etc.).
  sendAnalysisAction: (action: string, ...args: any[]) => void
  onAnalysisAction: (callback: (action: string, ...args: any[]) => void) => () => void
  exportCsv: (content: string, defaultName: string) => Promise<string | null>
  exportSvg: (content: string, defaultName: string) => Promise<string | null>
  focusWindow: () => void
  // Custom window controls (Windows/Linux frameless main window)
  minimizeWindow: () => void
  toggleMaximizeWindow: () => void
  closeWindow: () => void
  isWindowMaximized: () => Promise<boolean>
  onWindowMaximizedChanged: (callback: (isMax: boolean) => void) => () => void
  // Auto-update dialog (Sparkle-style prompt driven by the renderer)
  onUpdateAvailable: (
    callback: (info: { version: string; currentVersion: string; releaseDate: string | null; releaseNotes: string }) => void
  ) => () => void
  installUpdate: () => void
  skipUpdateVersion: (version: string) => void
  remindUpdateLater: () => void
  getAppVersion: () => Promise<string>
  checkForUpdates: () => void
  onUpdateStatus: (
    callback: (status: {
      state: 'checking' | 'up-to-date' | 'available' | 'error' | 'dev-disabled'
      version?: string
      message?: string
    }) => void
  ) => () => void
  getUpdateBadge: () => Promise<UpdateBadgeState>
  onUpdateBadge: (callback: (state: UpdateBadgeState) => void) => () => void
  // Query results window (pop-out)
  openQueryResultsWindow: (data: QueryResultsInitData) => void
  updateQueryResultsWindow: (data: QueryResultsInitData) => void
  getQueryResultsData: () => Promise<QueryResultsInitData>
  onQueryResultsData: (callback: (data: QueryResultsInitData) => void) => () => void
  sendQueryResultsAction: (action: string, payload?: any) => void
  onQueryResultsAction: (callback: (action: string, payload?: any) => void) => () => void
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
  // Transcript import
  importTranscript: () => Promise<{ name: string; content: string } | null>
  // Preferences
  loadPreferences: () => Promise<any>
  savePreferences: (prefs: any) => Promise<void>
  sendPreferencesUpdate: (prefs: any) => void
  onPreferencesUpdate: (callback: (prefs: any) => void) => () => void
}

export interface CodebookInitData {
  codes: Code[]
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
  /** For content memos: the source guid and codepoint range */
  sourceGuid?: string
  startPosition?: number
  endPosition?: number
  /** For content memos attached to a box selection on a PDF, this is the
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
  /** For content memos created inside a survey cell: the cell the
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
  | 'results-in-documents'
  | 'code-frequencies'
  | 'code-orders'
  | 'word-frequencies'
  | 'relationship-map'

export interface AnalysisInitData {
  toolType: AnalysisToolType
  theme: string
  sources: {
    guid: string
    name: string
    /** Source kind — drives extent calculations for the analysis tools
     *  (e.g. Code Frequencies uses % of duration for audio/video and
     *  % of selection count for image / PDF-region codings, where a
     *  pixel-area denominator isn't available). */
    sourceType?: SourceType
    /** Duration in seconds for audio/video; used as the denominator
     *  when computing % of media covered by code. */
    duration?: number
  }[]
  folders: { guid: string; name: string; parentGuid: string | null }[]
  codes: { guid: string; name: string; color?: string; isCodable: boolean; parentGuid?: string }[]
  tags: { guid: string; name: string; categoryGuid?: string; value?: string }[]
  categories: { guid: string; name: string; type?: TagCategoryType; listOptions?: string[] }[]
  /** Source content keyed by source guid (for word frequencies, code frequencies) */
  sourceContents: Record<string, string>
  /** Full selections per source for computing co-occurrences, code-in-doc, frequencies */
  sourceSelections: Record<string, PlainTextSelection[]>
  /** Tag member source guids */
  tagMembers: Record<string, string[]>
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
  savedAnalyses?: { guid: string; name: string; toolType: string }[]
  /** Quotes (for relationship map sidebar) */
  quotes?: { guid: string; text: string; sourceName: string; sourceGuid: string; startPosition: number; endPosition: number; pdfRegion?: PdfRegionSelection }[]
  /** PDF file paths by sourceGuid — needed for rendering region thumbnails
   *  of quote / query-result elements dropped into the relationship map. */
  pdfFilePaths?: Record<string, string>
  /** Restored saved analysis config (if opening a saved analysis) */
  savedConfig?: any
}

export interface SavedAnalysis {
  guid: string
  toolType: AnalysisToolType
  name: string
  config: any
  createdDateTime: string
  modifiedDateTime?: string
}

declare global {
  interface Window {
    api: ElectronAPI
  }
}
