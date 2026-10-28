/**
 * installDragSelectionKeeper — keeps the reader's text selection visible
 * when they press on a code to drag it onto that selection.
 *
 * Pressing the mouse on a code (in the Code Browser, an analysis tool,
 * anywhere draggable) makes the browser clear the text selection. The
 * viewer still remembers what was selected, so a drop or a hotkey codes
 * the right text, but the highlight vanishes and it looks as though the
 * selection was lost. So the selection is put back on the next animation
 * frame, which runs before the browser paints: the cleared state is never
 * shown.
 *
 * Install once per renderer; subsequent calls are no-ops.
 */

let installed = false

export function installDragSelectionKeeper(): void {
  if (installed) return
  installed = true

  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    if (!(e.target instanceof Element) || !e.target.closest('[draggable="true"]')) return
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return
    const range = sel.getRangeAt(0).cloneRange()
    requestAnimationFrame(() => {
      // Leave it alone if something else selected meanwhile, or if the
      // selected text has gone (e.g. its document was closed).
      const now = window.getSelection()
      if (!now || (now.rangeCount > 0 && !now.isCollapsed)) return
      if (!range.startContainer.isConnected || !range.endContainer.isConnected) return
      now.removeAllRanges()
      now.addRange(range)
    })
  }, true)
}
