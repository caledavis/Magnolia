import { BrowserWindow, dialog, WebContents } from 'electron'
import type { OpenDialogOptions, OpenDialogReturnValue, SaveDialogOptions, SaveDialogReturnValue } from 'electron'

/**
 * Native file dialogs, parented to the window that asked for them.
 *
 * An unparented dialog is just another top-level window to the window
 * manager. On Linux (GTK and the xdg-desktop-portal picker alike) that lets
 * focus-stealing prevention stack it *behind* Magnolia's window, so the
 * picker looks like it never opened. Parenting makes it a transient child
 * the WM always keeps on top. Windows gets the conventional owner-modal
 * dialog the same way, and macOS presents it as a sheet on that window.
 */
type DialogOwner = BrowserWindow | WebContents | null | undefined

function parentFor(owner: DialogOwner): BrowserWindow | null {
  if (!owner) return null
  const win = owner instanceof BrowserWindow ? owner : BrowserWindow.fromWebContents(owner)
  return win && !win.isDestroyed() ? win : null
}

export function showOpenDialog(owner: DialogOwner, options: OpenDialogOptions): Promise<OpenDialogReturnValue> {
  const parent = parentFor(owner)
  return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options)
}

export function showSaveDialog(owner: DialogOwner, options: SaveDialogOptions): Promise<SaveDialogReturnValue> {
  const parent = parentFor(owner)
  return parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options)
}
