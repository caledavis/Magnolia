/**
 * new-code-trigger-store — a tiny event channel the document viewers use
 * to ask App.tsx to open the New Code dialog. Each .request() bumps a
 * counter; App.tsx subscribes and opens the dialog whenever the counter
 * changes. Existence is a workaround for the fact that the dialog state
 * lives in App.tsx but the context menus that need to open it live
 * inside DocumentViewer / PdfDocumentViewer / ImageDocumentViewer /
 * TranscriptEditor etc. — passing an onNewCode callback through every
 * viewer prop chain would be much more invasive.
 *
 * The dialog reads the user's current pending selection from
 * pending-selection-store and auto-applies the new code to it (see
 * App.tsx's handleCreateCode), so a simple "open the dialog" trigger
 * is all the viewers need to push.
 */
import { create } from 'zustand'

interface NewCodeTriggerState {
  count: number
  request: () => void
}

export const useNewCodeTriggerStore = create<NewCodeTriggerState>((set) => ({
  count: 0,
  request: () => set((state) => ({ count: state.count + 1 }))
}))
