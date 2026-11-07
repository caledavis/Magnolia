/**
 * Dragging a selection onto a code in the Code Browser codes it — the
 * reverse of dragging a code onto the selection — and dragging it into the
 * Saved Quotes pane saves it as a quote.
 *
 * The viewer shows a grab handle at the end of its pending selection (or
 * the corner of its pending box), SelectionDragHandle, whose drag carries
 * the document's guid (startSelectionDrag). The drop target calls
 * requestSelectionDrop, and the viewer codes or quotes its pending
 * selection exactly as a code hotkey or its "Add as Quote" menu item would
 * (onSelectionDrop, registered beside its hotkey listener, so only the
 * active viewer, or the active half of a split view, responds).
 *
 * The handle exists because WebKit doesn't start a drag when the reader
 * presses on selected text: it starts a new selection instead. A box
 * selection couldn't be dragged that way either, since pressing in it
 * starts a new box.
 */
import type React from 'react'

export const SELECTION_DRAG_MIME = 'application/x-magnolia-selection'
const SELECTION_DROP_EVENT = 'magnolia-selection-drop'

/** What to do with the dropped selection. */
export type SelectionDropAction =
  | { kind: 'code'; codeGuids: string[] }
  | { kind: 'quote' }

interface SelectionDropDetail {
  sourceGuid: string
  action: SelectionDropAction
}

/** What a viewer does with its pending selection when it's dropped. */
export interface SelectionDropHandlers {
  /** Code it, as the code's hotkey would. */
  code: (codeGuid: string) => void
  /** Save it as a quote, as "Add as Quote" would. */
  quote: () => void
}

/** Start dragging `sourceGuid`'s pending selection, shown in the drag
 *  image as `label`. */
export function startSelectionDrag(e: React.DragEvent, sourceGuid: string, label: string): void {
  e.dataTransfer.setData(SELECTION_DRAG_MIME, sourceGuid)
  e.dataTransfer.setData('text/plain', label)
  e.dataTransfer.effectAllowed = 'copy'
}

export function isSelectionDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(SELECTION_DRAG_MIME)
}

/** Ask the viewer the dropped selection came from to code or quote it. */
export function requestSelectionDrop(e: React.DragEvent, action: SelectionDropAction): void {
  const sourceGuid = e.dataTransfer.getData(SELECTION_DRAG_MIME)
  if (!sourceGuid) return
  window.dispatchEvent(new CustomEvent<SelectionDropDetail>(SELECTION_DROP_EVENT, { detail: { sourceGuid, action } }))
}

/** Handle the drops of a selection dragged from `sourceGuid`. Returns the
 *  unsubscribe function. */
export function onSelectionDrop(sourceGuid: string, handlers: SelectionDropHandlers): () => void {
  const listener = (e: Event): void => {
    const { detail } = e as CustomEvent<SelectionDropDetail>
    if (detail.sourceGuid !== sourceGuid) return
    if (detail.action.kind === 'quote') handlers.quote()
    else for (const codeGuid of detail.action.codeGuids) handlers.code(codeGuid)
  }
  window.addEventListener(SELECTION_DROP_EVENT, listener)
  return () => window.removeEventListener(SELECTION_DROP_EVENT, listener)
}
