/**
 * pending-selection-store — the user's currently-pending text selection
 * in the active document viewer, lifted out of the viewer components so
 * other surfaces (notably the New Code dialog) can read it.
 *
 * Why this exists: each document viewer (plain-text, PDF, image, video)
 * tracks its own `pendingSelection` in local React state so it can
 * render the right-click context menu and apply codes via hotkey. The
 * Code Browser's "+ Code" button lives in a sibling pane, though, and
 * the New Code modal is rendered in App.tsx — neither has direct access
 * to a viewer's local state. Each viewer mirrors its local
 * pendingSelection into this store so App.tsx can read it the moment
 * the user finishes creating a code.
 *
 * Not persisted. Cleared whenever the active doc tab changes.
 */
import { create } from 'zustand'
import type { PdfRegionSelection } from '../models/types'

export interface PendingTextSelection {
  kind: 'text'
  /** The source document guid this selection belongs to. */
  sourceGuid: string
  startCp: number
  endCp: number
  selectedText: string
}

/** A stretch of a recording marked with the keyboard (I and O in the video
 *  viewer), in seconds. */
export interface PendingTimeSelection {
  kind: 'time'
  sourceGuid: string
  startTime: number
  endTime: number
}

export interface PendingRegionSelection {
  kind: 'region'
  /** The source document guid this selection belongs to. */
  sourceGuid: string
  /** The PDF user-space (PDF) or image-pixel (image) rectangle the
   *  user box-selected. */
  pdfRegion: PdfRegionSelection
}

/** Survey-cell pending selection. The user has highlighted text
 *  inside one OR MORE cells of a survey source. Selections that span
 *  cells (e.g. the user drags across two adjacent answers) carry one
 *  entry per cell in `cells`; the start/end on each entry are CELL-
 *  relative character offsets so the coding can be re-projected onto
 *  the per-respondent or per-question view interchangeably.
 *
 *  Most selections produce a single-cell pending. Multi-cell is
 *  treated as N independent codings that share one user gesture —
 *  applying a code creates one coding per cell. */
export interface PendingSurveyCellSelection {
  kind: 'survey-cell'
  sourceGuid: string
  cells: {
    respondentId: string
    questionId: string
    start: number
    end: number
    selectedText: string
  }[]
}

export type PendingSelection =
  | PendingTextSelection
  | PendingRegionSelection
  | PendingSurveyCellSelection
  | PendingTimeSelection

interface PendingSelectionState {
  selection: PendingSelection | null
  setSelection: (selection: PendingSelection | null) => void
}

export const usePendingSelectionStore = create<PendingSelectionState>((set) => ({
  selection: null,
  setSelection: (selection) => set({ selection })
}))
