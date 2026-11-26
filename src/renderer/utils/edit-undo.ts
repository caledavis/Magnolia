/**
 * Edit → Undo and Redo, in every window. The menu's items are Magnolia's
 * own (the system's undo only typing, so choosing them did nothing to a
 * coding), and as they carry Cmd/Ctrl+Z they're also what that key does.
 * In a text field they undo its typing; anywhere else they ask the window
 * to undo its last change to the project (the main window listens for
 * `magnolia-project-undo`; a note's editor counts as the project, since
 * every keystroke in it is a project edit).
 *
 * The main window also handles the keys itself (Windows and Linux may
 * deliver them that way rather than through the menu); `projectUndo`
 * ignores a second request within a moment, so one press never undoes
 * twice whichever way it arrives.
 */

/** Whether the keyboard is in a field whose own typing Undo should undo. */
export function inTextField(el: Element | null = document.activeElement): boolean {
  if (!el || el.closest('[data-note-editor]')) return false
  return el.matches('input, textarea') || (el as HTMLElement).isContentEditable
}

let lastAt = 0
/** Undo (or redo) the project's last change, once per press. */
export function projectUndo(redo: boolean): void {
  const now = Date.now()
  if (now - lastAt < 250) return
  lastAt = now
  window.dispatchEvent(new CustomEvent('magnolia-project-undo', { detail: { redo } }))
}

function editUndo(redo: boolean): void {
  if (inTextField()) {
    // The field's own history (a TipTap editor takes this too, as the
    // browser's undo of its text).
    document.execCommand(redo ? 'redo' : 'undo')
    return
  }
  projectUndo(redo)
}

export function installEditUndo(): void {
  const w = window as { __editUndo?: boolean; api?: { onMenuAction?: (cb: (a: string) => void) => unknown } }
  if (w.__editUndo || !w.api?.onMenuAction) return
  w.__editUndo = true
  w.api.onMenuAction((action) => {
    if (action === 'edit-undo') editUndo(false)
    else if (action === 'edit-redo') editUndo(true)
  })
}
