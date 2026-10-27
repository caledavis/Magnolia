import { create } from 'zustand'
import type { TextSource, PlainTextSelection, PdfRegionSelection, TimeRange, Coding, SourceType, DocumentFolder, NoteFormatData } from '../models/types'
import { generateGuid } from '../utils/guid'
import { useProjectStore } from './project-store'
import { useMemoStore } from './memo-store'
import { useQuoteStore } from './quote-store'
import { deriveLineAnchorsFromTimeRange, deriveVideoTimeRange, lineStartOffsets, lineForChar } from '../components/DocumentViewer/video-time-utils'
import { isToolTab } from '../utils/tab-ids'
import { computeTextEdit, adjustRange } from '../utils/text-edit-offsets'
import { promotedArchiveHandle, mediaPathField } from '../utils/binary-handles'
import { makeHmrSafe } from './hmr-preserve'
import { noteName, noteData } from '../utils/notes'

// Re-export so callers that already imported from this store don't break.
export type { DocumentFolder }

/** Key for a selected survey sub-entity in selectedSurveyEntities.
 *  GUIDs contain no ':', so the parts split cleanly. */
export function surveyEntityKey(kind: 'resp' | 'quest', sourceGuid: string, id: string): string {
  return `${kind}:${sourceGuid}:${id}`
}
export function parseSurveyEntityKey(key: string): { kind: 'resp' | 'quest'; sourceGuid: string; id: string } | null {
  const i = key.indexOf(':')
  const j = key.indexOf(':', i + 1)
  if (i < 0 || j < 0) return null
  const kind = key.slice(0, i)
  if (kind !== 'resp' && kind !== 'quest') return null
  return { kind, sourceGuid: key.slice(i + 1, j), id: key.slice(j + 1) }
}

/** Notes live only in notebooks, and notebooks hold only notes. */
function canPlaceSource(
  state: Pick<DocumentState, 'sources' | 'folders'>,
  sourceGuid: string,
  folderGuid: string | null
): boolean {
  const isNoteSource = state.sources.find((s) => s.guid === sourceGuid)?.sourceType === 'note'
  const intoNotebook = !!folderGuid && state.folders.find((f) => f.guid === folderGuid)?.kind === 'notebook'
  return isNoteSource === intoNotebook
}

interface DocumentState {
  sources: TextSource[]
  selectedDocumentGuids: Set<string> // selected in the browser (can be multiple)
  /** Selected survey sub-entities (respondents/questions), so a tag can
   *  be applied to many at once. Each key is `${kind}:${sourceGuid}:${id}`
   *  with kind 'resp' | 'quest' (see surveyEntityKey). */
  selectedSurveyEntities: Set<string>
  viewedDocumentGuid: string | null   // active tab in the Document Viewer
  openTabs: string[]                  // ordered list of open document GUIDs (tabs)
  sourceContents: Record<string, string> // guid -> text content
  folders: DocumentFolder[]
  sourceFolder: Record<string, string> // sourceGuid -> folderGuid

  setSources: (sources: TextSource[], contents: Record<string, string>) => void
  addSource: (name: string, content: string, sourceType?: SourceType, formatData?: any) => string // returns guid
  /** Re-attach binary content to an existing source whose bytes were
   *  missing from the .qdpx. Replaces its formatData (the new
   *  magnolia-bin:// handle / pdf data) and text content while preserving
   *  the source's guid, codes, and selections. Marks the project dirty so
   *  the next save embeds the recovered bytes. */
  reattachSourceBinary: (guid: string, formatData: any, content: string) => void
  removeSource: (guid: string) => void
  /** @deprecated use selectDocuments / viewDocument instead */
  selectDocument: (guid: string | null) => void
  selectDocuments: (guids: Set<string>) => void
  selectSurveyEntities: (keys: Set<string>) => void
  viewDocument: (guid: string | null) => void
  closeTab: (guid: string) => void
  reorderTabs: (guids: string[]) => void
  /** Insert any tool tab id (map: / analysis: / query-builder:) into
   *  openTabs and make it active. Tab-kind agnostic. */
  openToolTab: (tabId: string) => void
  /** Remove a tool tab id from openTabs without touching the underlying
   *  per-kind store (callers handle that — relationship-map-store for
   *  maps, analysis-tabs-store for analysis / query-builder). */
  closeToolTab: (tabId: string) => void
  /** Drop every non-document tab on project switch so a tab from project
   *  A doesn't survive into project B. */
  closeAllToolTabs: () => void
  /** Restore openTabs / activeTabId from a persisted snapshot at project
   *  load. validToolTabIds filters out tool tabs that the analysis-tabs-store
   *  failed to rehydrate (so we never strand orphan tab ids). */
  restoreTabs: (
    openTabs: string[],
    activeTabId: string | null,
    validToolTabIds: Set<string>
  ) => void
  getDocumentContent: (guid: string) => string | undefined
  addSelection: (
    sourceGuid: string,
    startPosition: number,
    endPosition: number,
    name: string,
    pdfRegion?: PdfRegionSelection,
    /** When set, the selection is scoped to a single survey cell.
     *  startPosition / endPosition become cell-relative offsets. */
    surveyCell?: { respondentId: string; questionId: string }
  ) => string // returns selection guid
  addCodingToSelection: (
    sourceGuid: string,
    selectionGuid: string,
    codeGuid: string
  ) => void
  removeCoding: (
    sourceGuid: string,
    selectionGuid: string,
    codingGuid: string
  ) => void
  removeSelection: (sourceGuid: string, selectionGuid: string) => void
  /** Create a time-range selection on a video source. Returns selection guid. */
  addTimeRangeSelection: (
    sourceGuid: string,
    startTime: number,
    endTime: number,
    startLine?: number,
    endLine?: number
  ) => string
  /** Update a time-range selection's time bounds (called when user drags
   *  the track bracket handles). By default, clears `manuallyAnchored` so
   *  the transcript's bracket re-derives its line position from the new
   *  time; pass `preserveAnchor: true` from the transcript-bracket drag
   *  (which is updating both the line anchors and the time together). */
  updateSelectionTimeRange: (
    sourceGuid: string,
    selectionGuid: string,
    range: TimeRange,
    options?: { preserveAnchor?: boolean }
  ) => void
  /** Update a time-range selection's line anchors (transcript bracket). The
   *  time range is unchanged; this only rebinds the visual attachment. */
  updateSelectionLineAnchors: (
    sourceGuid: string,
    selectionGuid: string,
    startLine: number,
    endLine: number
  ) => void
  /** Merge a fresh lineTimes map into a video source's formatData AND
   *  re-derive every time-range selection's transcript line anchors
   *  against the new map. This is what keeps codes that were added before
   *  the transcript existed in sync with the text once the user starts
   *  transcribing. */
  updateLineTimes: (
    sourceGuid: string,
    lineTimes: Record<string, number>
  ) => void
  /** Bulk-load folders + per-source folder mapping at project open.
   *  Doesn't markDirty (load paths are already-clean state). */
  setFolders: (folders: DocumentFolder[], sourceFolder: Record<string, string>) => void
  addFolder: (name: string, parentGuid?: string | null, kind?: DocumentFolder['kind']) => string
  /** Create an empty note in a notebook, stamped now. Returns its guid. */
  addNote: (notebookGuid: string) => string
  /** Change a note's title and/or timestamp; its name follows. */
  updateNote: (guid: string, patch: Partial<NoteFormatData>) => void
  removeFolder: (guid: string) => void
  renameSource: (guid: string, name: string) => void
  /** Change a single survey question's type (and its columns' types
   *  so they stay in sync). Display switches immediately because
   *  the SurveyViewer dispatches per-question by type. */
  updateSurveyQuestionType: (
    sourceGuid: string,
    questionId: string,
    newType: 'open-ended' | 'single-choice' | 'numeric' | 'multi-select'
  ) => void
  renameFolder: (guid: string, name: string) => void
  moveSourceToFolder: (sourceGuid: string, folderGuid: string | null) => void
  /** Reorder source to before or after a sibling source */
  moveSourceNear: (sourceGuid: string, siblingGuid: string, position: 'before' | 'after') => void
  moveFolderToFolder: (folderGuid: string, newParentGuid: string | null) => void
  updateSourceContent: (guid: string, content: string) => void
  /** Apply an in-place transcript edit (a single contiguous change from the
   *  transcription textarea): replace the source text AND shift every
   *  codepoint anchor — codes, quotes and content memos — so they keep
   *  pointing at the same words instead of drifting onto whatever text now
   *  sits at their old offsets. Time-range (video) codings are left to
   *  updateLineTimes; only character-anchored selections move here. */
  applyTranscriptEdit: (guid: string, content: string) => void
  updateSourceFormatData: (guid: string, formatData: any) => void
  /** After a save embeds freshly-imported binaries into the .qdpx, swap each
   *  source's transient `overlay://` media handle for the durable
   *  `archive://<guid>.<ext>` handle. Idempotent; does not mark the project
   *  dirty (it's a handle-representation change, the saved file is unchanged). */
  promoteImportedBinariesToArchive: () => void
  /** Open a source in the viewer and pulse a coded range. Consumed by
   *  saved-pane clicks / query-result jumps to spotlight a selection. */
  viewDocumentAt: (
    guid: string,
    startCp: number,
    endCp: number,
    pdfRegion?: PdfRegionSelection,
    timeRange?: TimeRange
  ) => void
  /** Latest scroll/highlight target (consumed by individual viewer
   *  components and cleared after they handle it). */
  scrollTarget: { startCp: number; endCp: number; pdfRegion?: PdfRegionSelection; timeRange?: TimeRange } | null
  clearScrollTarget: () => void
  clearAll: () => void
}

export const useDocumentStore = create<DocumentState>((set, get) => ({
  sources: [],
  selectedDocumentGuids: new Set<string>(),
  selectedSurveyEntities: new Set<string>(),
  viewedDocumentGuid: null,
  openTabs: [],
  sourceContents: {},
  folders: [],
  sourceFolder: {},

  setSources: (sources, contents) => {
    // Guarantee the selection invariant `codings: Coding[]` (and that
    // `selections` itself is an array) the moment sources enter the store.
    // Some imported .qdpx selections — notably from survey projects — can
    // arrive with `codings` undefined, which crashes every consumer that
    // iterates `sel.codings` (e.g. CodeBrowser's occurrence count, which
    // tears down the whole window on project load). Normalising here, at
    // the single ingest point, fixes all consumers at once. Clean sources
    // pass through untouched (no needless object churn on large projects).
    const normalized = sources.map((s) => {
      const selections = s.selections ?? []
      let touched = !s.selections
      const fixedSelections = selections.map((sel) => {
        if (sel.codings) return sel
        touched = true
        return { ...sel, codings: [] }
      })
      return touched ? { ...s, selections: fixedSelections } : s
    })
    const validGuids = new Set(normalized.map((s) => s.guid))
    set((state) => ({
      sources: normalized,
      sourceContents: contents,
      // Preserve non-document tabs (map / analysis / query-builder) even
      // when the document list changes — they don't depend on a source guid.
      openTabs: state.openTabs.filter((g) => validGuids.has(g) || isToolTab(g)),
      viewedDocumentGuid:
        state.viewedDocumentGuid &&
        (validGuids.has(state.viewedDocumentGuid) || isToolTab(state.viewedDocumentGuid))
          ? state.viewedDocumentGuid
          : null
    }))
  },

  addSource: (name, content, sourceType, formatData) => {
    const guid = generateGuid()
    const now = new Date().toISOString()
    const userGuid = useProjectStore.getState().creatingUserGUID
    const source: TextSource = {
      guid,
      name,
      sourceType: sourceType || undefined,
      formatData: formatData || undefined,
      creatingUser: userGuid,
      creationDateTime: now,
      modifyingUser: userGuid,
      modifiedDateTime: now,
      selections: []
    }
    set((state) => ({
      sources: [...state.sources, source],
      sourceContents: { ...state.sourceContents, [guid]: content }
    }))
    useProjectStore.getState().markDirty()
    return guid
  },

  reattachSourceBinary: (guid, formatData, content) => {
    const now = new Date().toISOString()
    const userGuid = useProjectStore.getState().creatingUserGUID
    set((state) => {
      // Re-attaching audio/video media carries no text of its own, so never
      // let an empty re-import wipe an existing transcript — keep the current
      // content when the re-imported file brings none. (PDFs etc. bring their
      // extracted text and legitimately replace it.)
      const nextContent = content && content.length > 0 ? content : (state.sourceContents[guid] ?? '')
      return {
        sources: state.sources.map((s) =>
          s.guid === guid
            ? { ...s, formatData: formatData || undefined, modifyingUser: userGuid, modifiedDateTime: now }
            : s
        ),
        sourceContents: { ...state.sourceContents, [guid]: nextContent }
      }
    })
    useProjectStore.getState().markDirty()
  },

  removeSource: (guid) => {
    set((state) => {
      const { [guid]: _, ...rest } = state.sourceContents
      const nextSelected = new Set(state.selectedDocumentGuids)
      nextSelected.delete(guid)
      const nextTabs = state.openTabs.filter((g) => g !== guid)
      let nextViewed = state.viewedDocumentGuid
      if (nextViewed === guid) {
        const oldIdx = state.openTabs.indexOf(guid)
        nextViewed = nextTabs[Math.min(oldIdx, nextTabs.length - 1)] || null
      }
      return {
        sources: state.sources.filter((s) => s.guid !== guid),
        sourceContents: rest,
        selectedDocumentGuids: nextSelected,
        viewedDocumentGuid: nextViewed,
        openTabs: nextTabs
      }
    })
    // Cascade-delete memos linked to this document
    const ms = useMemoStore.getState()
    const linkedMemos = ms.memos.filter(
      (m) => (m.type === 'document' && m.sourceGuids?.includes(guid)) ||
             (m.type === 'content' && m.sourceGuid === guid)
    )
    for (const m of linkedMemos) ms.removeMemo(m.guid)
    // Cascade-delete quotes linked to this document
    const qs = useQuoteStore.getState()
    const linkedQuotes = qs.quotes.filter((q) => q.sourceGuid === guid)
    for (const q of linkedQuotes) qs.removeQuote(q.guid)

    useProjectStore.getState().markDirty()
  },

  selectDocument: (guid) => set({
    selectedDocumentGuids: guid ? new Set([guid]) : new Set<string>(),
    viewedDocumentGuid: guid
  }),
  selectDocuments: (guids) => set({ selectedDocumentGuids: guids }),
  selectSurveyEntities: (keys) => set({ selectedSurveyEntities: keys }),
  viewDocument: (guid) => {
    set((state) => {
      if (!guid) return { viewedDocumentGuid: null }
      return {
        viewedDocumentGuid: guid,
        openTabs: state.openTabs.includes(guid) ? state.openTabs : [...state.openTabs, guid]
      }
    })
    // Tab state (openTabs + viewedDocumentGuid) is persisted in
    // magnolia-tabs.json, so tab navigation needs to mark the project
    // dirty for the autosave to pick up the new active-tab pointer.
    // Otherwise quitting without any other edit leaves the saved
    // activeTabId stuck on whatever the last "real" edit captured.
    useProjectStore.getState().markDirty()
  },
  closeTab: (guid) => {
    set((state) => {
      const nextTabs = state.openTabs.filter((g) => g !== guid)
      let nextViewed = state.viewedDocumentGuid
      if (nextViewed === guid) {
        const oldIdx = state.openTabs.indexOf(guid)
        nextViewed = nextTabs[Math.min(oldIdx, nextTabs.length - 1)] || null
      }
      return { openTabs: nextTabs, viewedDocumentGuid: nextViewed }
    })
    useProjectStore.getState().markDirty()
  },
  reorderTabs: (guids) => {
    set({ openTabs: guids })
    useProjectStore.getState().markDirty()
  },
  openToolTab: (tabId) => {
    set((state) => ({
      viewedDocumentGuid: tabId,
      openTabs: state.openTabs.includes(tabId)
        ? state.openTabs
        : [...state.openTabs, tabId]
    }))
    useProjectStore.getState().markDirty()
  },
  closeToolTab: (tabId) => {
    set((state) => {
      const nextTabs = state.openTabs.filter((g) => g !== tabId)
      let nextViewed = state.viewedDocumentGuid
      if (nextViewed === tabId) {
        const oldIdx = state.openTabs.indexOf(tabId)
        nextViewed = nextTabs[Math.min(oldIdx, nextTabs.length - 1)] || null
      }
      return { openTabs: nextTabs, viewedDocumentGuid: nextViewed }
    })
    useProjectStore.getState().markDirty()
  },
  closeAllToolTabs: () => {
    set((state) => ({
      openTabs: state.openTabs.filter((g) => !isToolTab(g)),
      viewedDocumentGuid:
        state.viewedDocumentGuid && isToolTab(state.viewedDocumentGuid)
          ? null
          : state.viewedDocumentGuid
    }))
    useProjectStore.getState().markDirty()
  },
  restoreTabs: (openTabs, activeTabId, validToolTabIds) => {
    const sourcesAtLoad = get().sources
    const validSources = new Set(sourcesAtLoad.map((s) => s.guid))
    const filtered = openTabs.filter((id) =>
      isToolTab(id) ? validToolTabIds.has(id) : validSources.has(id)
    )
    const nextActive =
      activeTabId && filtered.includes(activeTabId)
        ? activeTabId
        : filtered[0] ?? null
    set({ openTabs: filtered, viewedDocumentGuid: nextActive })
  },
  scrollTarget: null as { startCp: number; endCp: number; pdfRegion?: PdfRegionSelection; timeRange?: TimeRange } | null,
  viewDocumentAt: (guid: string, startCp: number, endCp: number, pdfRegion?: PdfRegionSelection, timeRange?: TimeRange) => set((state) => ({
    viewedDocumentGuid: guid,
    openTabs: state.openTabs.includes(guid) ? state.openTabs : [...state.openTabs, guid],
    scrollTarget: { startCp, endCp, pdfRegion, timeRange }
  })),
  clearScrollTarget: () => set({ scrollTarget: null }),

  getDocumentContent: (guid) => get().sourceContents[guid],

  addSelection: (sourceGuid, startPosition, endPosition, name, pdfRegion?, surveyCell?) => {
    const selGuid = generateGuid()
    const now = new Date().toISOString()
    const userGuid = useProjectStore.getState().creatingUserGUID
    const selection: PlainTextSelection = {
      guid: selGuid,
      name,
      startPosition,
      endPosition,
      pdfRegion,
      surveyCell,
      creatingUser: userGuid,
      creationDateTime: now,
      codings: []
    }
    set((state) => {
      // Video transcript codings are character-precise but also project onto
      // the CodeTrack timeline: derive a time range from the transcript lines
      // the selected text spans (line-granular timing — adjusting the text
      // within a line leaves the time range; crossing onto another line
      // moves it). Audio/text/pdf codings carry no time range.
      const source = state.sources.find((s) => s.guid === sourceGuid)
      if (source?.sourceType === 'video' && !pdfRegion && !surveyCell) {
        const tr = deriveVideoTimeRange(
          state.sourceContents[sourceGuid] ?? '',
          startPosition,
          endPosition,
          source.formatData?.lineTimes
        )
        if (tr) selection.timeRange = tr
      }
      return {
        sources: state.sources.map((s) =>
          s.guid === sourceGuid ? { ...s, selections: [...s.selections, selection] } : s
        )
      }
    })
    useProjectStore.getState().markDirty()
    return selGuid
  },

  addCodingToSelection: (sourceGuid, selectionGuid, codeGuid) => {
    const codingGuid = generateGuid()
    const now = new Date().toISOString()
    const userGuid = useProjectStore.getState().creatingUserGUID
    const coding: Coding = {
      guid: codingGuid,
      codeGuid,
      creatingUser: userGuid,
      creationDateTime: now
    }
    set((state) => ({
      sources: state.sources.map((s) =>
        s.guid === sourceGuid
          ? {
              ...s,
              selections: s.selections.map((sel) =>
                sel.guid === selectionGuid
                  ? { ...sel, codings: [...sel.codings, coding] }
                  : sel
              )
            }
          : s
      )
    }))
    useProjectStore.getState().markDirty()
  },

  removeCoding: (sourceGuid, selectionGuid, codingGuid) => {
    set((state) => ({
      sources: state.sources.map((s) =>
        s.guid === sourceGuid
          ? {
              ...s,
              selections: s.selections.map((sel) =>
                sel.guid === selectionGuid
                  ? {
                      ...sel,
                      codings: sel.codings.filter((c) => c.guid !== codingGuid)
                    }
                  : sel
              )
            }
          : s
      )
    }))
    useProjectStore.getState().markDirty()
  },

  addTimeRangeSelection: (sourceGuid, startTime, endTime, startLine, endLine) => {
    const selGuid = generateGuid()
    const now = new Date().toISOString()
    const userGuid = useProjectStore.getState().creatingUserGUID
    // If line anchors weren't supplied (e.g. the code was dropped on the
    // CodeTrack or the video frame rather than on a transcript selection),
    // derive them from the source's lineTimes so the bracket lands on the
    // transcript lines that correspond to the time range.
    let finalStart = startLine
    let finalEnd = endLine
    if (finalStart === undefined || finalEnd === undefined) {
      const source = get().sources.find((s) => s.guid === sourceGuid)
      const lineTimes = source?.formatData?.lineTimes as Record<string, number> | undefined
      const derived = deriveLineAnchorsFromTimeRange(startTime, endTime, lineTimes)
      if (finalStart === undefined) finalStart = derived.startLine
      if (finalEnd === undefined) finalEnd = derived.endLine
    }
    const selection: PlainTextSelection = {
      guid: selGuid,
      startPosition: finalStart ?? 0,
      endPosition: finalEnd ?? finalStart ?? 0,
      timeRange: { startTime, endTime },
      creatingUser: userGuid,
      creationDateTime: now,
      codings: []
    }
    set((state) => ({
      sources: state.sources.map((s) =>
        s.guid === sourceGuid
          ? { ...s, selections: [...s.selections, selection] }
          : s
      )
    }))
    useProjectStore.getState().markDirty()
    return selGuid
  },

  updateSelectionTimeRange: (sourceGuid, selectionGuid, range, options) => {
    const preserveAnchor = options?.preserveAnchor === true
    set((state) => {
      const source = state.sources.find((s) => s.guid === sourceGuid)
      const text = state.sourceContents[sourceGuid] ?? ''
      const lineTimes = source?.formatData?.lineTimes as Record<string, number> | undefined
      // Time → text coupling: when a video coding's time range is dragged on
      // the CodeTrack, the coded text follows it onto the lines the new range
      // covers. Sub-line precision is kept while the in/out stays on the same
      // line; crossing onto another line snaps that end to the line boundary.
      const offsets = lineStartOffsets(text)
      const span = !preserveAnchor && lineTimes && offsets.length > 1
        ? deriveLineAnchorsFromTimeRange(range.startTime, range.endTime, lineTimes)
        : null
      return {
        sources: state.sources.map((s) =>
          s.guid === sourceGuid
            ? {
                ...s,
                selections: s.selections.map((sel) => {
                  if (sel.guid !== selectionGuid) return sel
                  const next: any = { ...sel, timeRange: range }
                  if (!preserveAnchor) next.manuallyAnchored = false
                  if (span) {
                    const curStart = sel.startPosition ?? 0
                    const curEnd = sel.endPosition ?? curStart
                    if (lineForChar(offsets, curStart) !== span.startLine) {
                      next.startPosition = offsets[span.startLine] ?? 0
                    }
                    if (lineForChar(offsets, Math.max(curEnd - 1, curStart)) !== span.endLine) {
                      next.endPosition = Math.max(
                        (offsets[span.endLine + 1] ?? offsets[offsets.length - 1] ?? 0) - 1,
                        next.startPosition ?? curStart
                      )
                    }
                  }
                  return next
                })
              }
            : s
        )
      }
    })
    useProjectStore.getState().markDirty()
  },

  updateSelectionLineAnchors: (sourceGuid, selectionGuid, startLine, endLine) => {
    set((state) => ({
      sources: state.sources.map((s) =>
        s.guid === sourceGuid
          ? {
              ...s,
              selections: s.selections.map((sel) =>
                sel.guid === selectionGuid
                  ? {
                      ...sel,
                      startPosition: startLine,
                      endPosition: endLine,
                      // Mark this bracket as manually anchored so a
                      // subsequent transcription edit (which re-derives
                      // anchors from lineTimes) won't clobber the user's
                      // deliberate placement.
                      manuallyAnchored: true
                    }
                  : sel
              )
            }
          : s
      )
    }))
    useProjectStore.getState().markDirty()
  },

  updateLineTimes: (sourceGuid, lineTimes) => {
    set((state) => ({
      sources: state.sources.map((s) => {
        if (s.guid !== sourceGuid) return s
        const newFormatData = { ...(s.formatData || {}), lineTimes }
        // For every time-range selection, re-derive its line anchors
        // against the fresh lineTimes. This covers two cases:
        //   1. The code was added before any transcript existed — it was
        //      placed at line 0 by default and now jumps to the correct
        //      line(s) as soon as transcription catches up in time.
        //   2. Transcription added / removed lines, shifting later lines
        //      up or down — the bracket follows its canonical time range.
        // Brackets that the user has manually repositioned in the
        // transcript (manuallyAnchored: true) are LEFT ALONE — their
        // placement is a deliberate user choice we must preserve.
        const newSelections = s.selections.map((sel) => {
          if (!sel.timeRange || sel.manuallyAnchored) return sel
          const derived = deriveLineAnchorsFromTimeRange(
            sel.timeRange.startTime,
            sel.timeRange.endTime,
            lineTimes
          )
          if (sel.startPosition === derived.startLine && sel.endPosition === derived.endLine) {
            return sel
          }
          return { ...sel, startPosition: derived.startLine, endPosition: derived.endLine }
        })
        return { ...s, formatData: newFormatData, selections: newSelections }
      })
    }))
    useProjectStore.getState().markDirty()
  },

  removeSelection: (sourceGuid, selectionGuid) => {
    set((state) => ({
      sources: state.sources.map((s) =>
        s.guid === sourceGuid
          ? {
              ...s,
              selections: s.selections.filter(
                (sel) => sel.guid !== selectionGuid
              )
            }
          : s
      )
    }))
    useProjectStore.getState().markDirty()
  },

  setFolders: (folders, sourceFolder) => {
    set({ folders, sourceFolder })
  },

  addFolder: (name, parentGuid = null, kind) => {
    const guid = generateGuid()
    // Notebooks hold notes only — never a folder.
    if (parentGuid && get().folders.find((f) => f.guid === parentGuid)?.kind === 'notebook') parentGuid = null
    set((state) => ({
      folders: [...state.folders, kind ? { guid, name, parentGuid, kind } : { guid, name, parentGuid }]
    }))
    useProjectStore.getState().markDirty()
    return guid
  },

  addNote: (notebookGuid) => {
    const data: NoteFormatData = { title: '', noteDateTime: new Date().toISOString() }
    const guid = get().addSource(noteName(data), '', 'note', data)
    set((state) => ({ sourceFolder: { ...state.sourceFolder, [guid]: notebookGuid } }))
    return guid
  },

  updateNote: (guid, patch) => {
    set((state) => ({
      sources: state.sources.map((s) => {
        if (s.guid !== guid) return s
        const data = { ...noteData(s), ...patch }
        return { ...s, name: noteName(data), formatData: data }
      })
    }))
    useProjectStore.getState().markDirty()
  },

  removeFolder: (guid) => {
    // Notes can't live outside a notebook, so deleting a notebook deletes
    // its notes (the browser confirms first).
    const state0 = get()
    const noteGuids = state0.folders.find((f) => f.guid === guid)?.kind === 'notebook'
      ? Object.entries(state0.sourceFolder).filter(([, fg]) => fg === guid).map(([sg]) => sg)
      : []
    for (const sg of noteGuids) get().removeSource(sg)
    set((state) => {
      // Collect all descendant folder guids. Notebooks inside a deleted
      // folder keep their notes and move to the root instead.
      const toRemove = new Set<string>()
      const rehome = new Set<string>()
      const collect = (id: string) => {
        toRemove.add(id)
        for (const f of state.folders) {
          if (f.parentGuid !== id) continue
          if (f.kind === 'notebook') rehome.add(f.guid)
          else collect(f.guid)
        }
      }
      collect(guid)
      // Move documents in removed folders to root
      const newSourceFolder = { ...state.sourceFolder }
      for (const [sg, fg] of Object.entries(newSourceFolder)) {
        if (toRemove.has(fg)) delete newSourceFolder[sg]
      }
      return {
        folders: state.folders
          .filter((f) => !toRemove.has(f.guid))
          .map((f) => (rehome.has(f.guid) ? { ...f, parentGuid: null } : f)),
        sourceFolder: newSourceFolder
      }
    })
    useProjectStore.getState().markDirty()
  },

  renameSource: (guid, name) => {
    set((state) => ({
      sources: state.sources.map((s) => (s.guid === guid ? { ...s, name } : s))
    }))
    useProjectStore.getState().markDirty()
  },

  updateSurveyQuestionType: (sourceGuid, questionId, newType) => {
    set((state) => ({
      sources: state.sources.map((s) => {
        if (s.guid !== sourceGuid) return s
        const fd = (s.formatData as any) // SurveyFormatData when sourceType === 'survey'
        const survey = fd?.survey
        if (!survey) return s
        const newQuestions = survey.questions.map((q: any) =>
          q.id === questionId ? { ...q, type: newType } : q
        )
        // Keep the column-level type in sync so anything that
        // consumes per-column types (the import preview re-open,
        // serialization, etc.) sees a consistent picture.
        const touchedColumnIds = new Set<string>()
        const target = newQuestions.find((q: any) => q.id === questionId)
        if (target) {
          for (const c of target.columns) touchedColumnIds.add(c.columnId)
        }
        const newColumns = survey.columns.map((col: any) =>
          touchedColumnIds.has(col.id) ? { ...col, type: newType } : col
        )
        return {
          ...s,
          formatData: {
            ...fd,
            survey: {
              ...survey,
              questions: newQuestions,
              columns: newColumns
            }
          }
        }
      })
    }))
    useProjectStore.getState().markDirty()
  },

  renameFolder: (guid, name) => {
    set((state) => ({
      folders: state.folders.map((f) => (f.guid === guid ? { ...f, name } : f))
    }))
    useProjectStore.getState().markDirty()
  },

  moveSourceToFolder: (sourceGuid, folderGuid) => {
    if (!canPlaceSource(get(), sourceGuid, folderGuid)) return
    set((state) => {
      const newSourceFolder = { ...state.sourceFolder }
      if (folderGuid === null) {
        delete newSourceFolder[sourceGuid]
      } else {
        newSourceFolder[sourceGuid] = folderGuid
      }
      return { sourceFolder: newSourceFolder }
    })
    useProjectStore.getState().markDirty()
  },

  moveSourceNear: (sourceGuid, siblingGuid, position) => {
    if (sourceGuid === siblingGuid) return
    set((state) => {
      const source = state.sources.find((s) => s.guid === sourceGuid)
      if (!source) return state
      // Move the source into the same folder as the sibling
      const siblingFolder = state.sourceFolder[siblingGuid] || null
      if (!canPlaceSource(state, sourceGuid, siblingFolder)) return state
      const newSourceFolder = { ...state.sourceFolder }
      if (siblingFolder) {
        newSourceFolder[sourceGuid] = siblingFolder
      } else {
        delete newSourceFolder[sourceGuid]
      }
      // Reorder within the sources array
      const without = state.sources.filter((s) => s.guid !== sourceGuid)
      const sibIdx = without.findIndex((s) => s.guid === siblingGuid)
      if (sibIdx < 0) return state
      const insertIdx = position === 'before' ? sibIdx : sibIdx + 1
      const newSources = [...without]
      newSources.splice(insertIdx, 0, source)
      return { sources: newSources, sourceFolder: newSourceFolder }
    })
    useProjectStore.getState().markDirty()
  },

  moveFolderToFolder: (folderGuid, newParentGuid) => {
    // Prevent moving a folder into its own descendant
    const isDescendant = (parentId: string, childId: string): boolean => {
      const folders = get().folders
      for (const f of folders) {
        if (f.parentGuid === parentId) {
          if (f.guid === childId) return true
          if (isDescendant(f.guid, childId)) return true
        }
      }
      return false
    }
    if (newParentGuid && (folderGuid === newParentGuid || isDescendant(folderGuid, newParentGuid))) {
      return
    }
    // Nothing nests inside a notebook.
    if (newParentGuid && get().folders.find((f) => f.guid === newParentGuid)?.kind === 'notebook') return
    set((state) => ({
      folders: state.folders.map((f) =>
        f.guid === folderGuid ? { ...f, parentGuid: newParentGuid } : f
      )
    }))
    useProjectStore.getState().markDirty()
  },

  updateSourceContent: (guid, content) => {
    set((state) => ({
      sourceContents: { ...state.sourceContents, [guid]: content }
    }))
    useProjectStore.getState().markDirty()
  },

  applyTranscriptEdit: (guid, content) => {
    const oldContent = get().sourceContents[guid]
    const edit = oldContent === undefined ? null : computeTextEdit(oldContent, content)
    // No diffable change (identical, or content not loaded yet): fall back to a
    // plain content write so anchors are never shifted against an unknown base.
    if (!edit) {
      set((state) => ({ sourceContents: { ...state.sourceContents, [guid]: content } }))
      useProjectStore.getState().markDirty()
      return
    }

    set((state) => ({
      sourceContents: { ...state.sourceContents, [guid]: content },
      sources: state.sources.map((s) => {
        if (s.guid !== guid) return s
        const selections = s.selections.flatMap((sel) => {
          // Every transcript coding — audio AND video — is rendered
          // character-precise from startPosition/endPosition (CodedTextView),
          // so those offsets must follow the text edit. Video codings also
          // carry a `timeRange` for the CodeTrack: we keep that untouched (a
          // within-line edit doesn't change when the line was spoken; a
          // line-count change re-derives it via updateLineTimes). Only
          // PDF-region and survey-cell selections aren't anchored to this
          // text at all.
          if (sel.pdfRegion || sel.surveyCell) return [sel]
          const next = adjustRange(sel.startPosition, sel.endPosition, edit)
          // Range wholly deleted — drop the now-empty coding.
          if (!next) return []
          if (next.start === sel.startPosition && next.end === sel.endPosition) return [sel]
          return [{ ...sel, startPosition: next.start, endPosition: next.end }]
        })
        return { ...s, selections }
      })
    }))

    // Quotes and content memos anchor to the same codepoint offsets — shift
    // them too so they don't drift out from under the edit.
    useQuoteStore.getState().adjustQuotesForEdit(guid, edit)
    useMemoStore.getState().adjustContentMemosForEdit(guid, edit)
    useProjectStore.getState().markDirty()
  },

  updateSourceFormatData: (guid, formatData) => {
    set((state) => ({
      sources: state.sources.map((s) =>
        s.guid === guid ? { ...s, formatData: { ...s.formatData, ...formatData } } : s
      )
    }))
    useProjectStore.getState().markDirty()
  },

  promoteImportedBinariesToArchive: () => {
    set((state) => {
      let changed = false
      const sources = state.sources.map((s) => {
        const archiveHandle = promotedArchiveHandle(s)
        if (!archiveHandle) return s
        changed = true
        const field = mediaPathField((s as any).sourceType)!
        return { ...s, formatData: { ...(s as any).formatData, [field]: archiveHandle } }
      })
      return changed ? { sources } : {}
    })
    // Deliberately no markDirty: the binary is already on disk; we've only
    // upgraded the in-memory handle that points at it.
  },

  clearAll: () =>
    set({ sources: [], selectedDocumentGuids: new Set<string>(), selectedSurveyEntities: new Set<string>(), viewedDocumentGuid: null, openTabs: [], sourceContents: {}, folders: [], sourceFolder: {} })
}))

makeHmrSafe('documentStore', useDocumentStore)
