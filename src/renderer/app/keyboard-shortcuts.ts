/**
 * The main window's project-level keyboard shortcuts.
 */
import { useEffect } from 'react'
import { isMac } from '../utils/platform'
import { useDocumentStore } from '../stores/document-store'
import { useUndoStore } from '../stores/undo-store'
import { isLetterKey } from '../utils/keys'
import { projectUndo } from '../utils/edit-undo'

/** Cmd/Ctrl shortcuts that act on the project rather than on text: switch
 *  tabs, select every document or code (in the pane `activePanelRef`
 *  names), project undo and redo, and Find (`openFind`). */
export function useProjectShortcuts(activePanelRef: { readonly current: string | null }, openFind: () => void): void {
  // Custom keyboard shortcuts for project-level operations.
  // Native text undo/redo/selectAll is handled by the menu's predefined items.
  // When no text input is focused, these shortcuts trigger project-level actions instead.
  useEffect(() => {
    const isTextInput = () => {
      const el = document.activeElement
      if (!el) return false
      const tag = el.tagName.toLowerCase()
      return tag === 'input' || tag === 'textarea' || (el as HTMLElement).isContentEditable
    }
    // A note's editor keeps no native undo history (every keystroke is a
    // project edit — see CodedTextView), so undo there is project undo.
    const inNoteEditor = () => !!(document.activeElement as HTMLElement | null)?.closest?.('[data-note-editor]')
    const handleKeydown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      // The other standard pair for switching tabs (the View menu has
      // Ctrl+Tab / Ctrl+Shift+Tab): Cmd+Shift+] / [ on macOS, as in
      // Safari and Finder; Ctrl+PageDown / PageUp elsewhere.
      const tabStep = isMac
        ? (e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey
            ? (e.code === 'BracketRight' ? 1 : e.code === 'BracketLeft' ? -1 : 0)
            : 0)
        : (e.ctrlKey && !e.shiftKey && !e.altKey
            ? (e.key === 'PageDown' ? 1 : e.key === 'PageUp' ? -1 : 0)
            : 0)
      if (tabStep !== 0) {
        e.preventDefault()
        useDocumentStore.getState().showAdjacentTab(tabStep)
        return
      }
      if (isLetterKey(e, 'a') && !isTextInput()) {
        if (activePanelRef.current === 'documents') {
          e.preventDefault()
          const docStore = useDocumentStore.getState()
          docStore.selectDocuments(new Set(docStore.sources.map((s) => s.guid)))
        } else if (activePanelRef.current === 'codes') {
          e.preventDefault()
          window.dispatchEvent(new CustomEvent('magnolia-select-all-codes'))
        }
      } else if (isLetterKey(e, 'z') && !e.shiftKey && (!isTextInput() || inNoteEditor())) {
        e.preventDefault()
        projectUndo(false)
      } else if (isLetterKey(e, 'z') && e.shiftKey && (!isTextInput() || inNoteEditor())) {
        e.preventDefault()
        projectUndo(true)
      } else if (isLetterKey(e, 'f')) {
        // Find is the only global Cmd/Ctrl+F behaviour — fires even
        // when a text input is focused (e.g. while the user is
        // selecting text in a transcript). Only available when a
        // document is actually open in the viewer. Opening the popup
        // also un-hides the Query Results pane so the results are
        // visible after the user runs Find.
        const guid = useDocumentStore.getState().viewedDocumentGuid
        if (!guid) return
        e.preventDefault()
        openFind()
      }
    }
    // Edit → Undo / Redo, and the keys, arrive here (utils/edit-undo.ts).
    const onProjectUndo = (e: Event) => {
      if ((e as CustomEvent<{ redo: boolean }>).detail.redo) useUndoStore.getState().redo()
      else useUndoStore.getState().undo()
    }
    window.addEventListener('keydown', handleKeydown)
    window.addEventListener('magnolia-project-undo', onProjectUndo)
    return () => {
      window.removeEventListener('keydown', handleKeydown)
      window.removeEventListener('magnolia-project-undo', onProjectUndo)
    }
  }, [activePanelRef, openFind])
}
