/**
 * Whether a message from another window (the Codebook, Logbook, Memos or a
 * memo edit window) is about the project open now. Those windows stay open
 * when the main window opens another project, and what they sent after
 * that landed in the new one: a memo or logbook entry from the old project
 * added to the new, an edit made to the wrong code. Each message carries
 * the project its window's data came from (WindowSender).
 */
import { t } from '../i18n'
import { isOpenProjectPath } from '../stores/project-store'
import type { WindowSender } from '../models/window-messages'

/** When the person was last told (so a burst of messages tells them once). */
let toldAt = 0

/** True when `from` is about the open project (or doesn't say); otherwise
 *  says so, plainly, and the message is to be dropped. */
export function fromOpenProject(from: WindowSender): boolean {
  if (from.projectPath === undefined || isOpenProjectPath(from.projectPath)) return true
  if (Date.now() - toldAt > 3000) {
    toldAt = Date.now()
    void window.api.showMessage(t('app.otherProjectWindow'), 'warning')
  }
  return false
}
