/**
 * What the Codebook, Logbook, Memos and memo edit windows send the main
 * window, each message carrying the project the window was opened for
 * (`projectPath`, from its init data). The main window drops a message
 * meant for a project that's no longer open, so an edit made just as the
 * user switched projects can't land in the new one.
 *
 * Each message is what platform/tauri-api.ts's sender of the same name
 * sends, plus `projectPath`: `{ action, args, projectPath }` for the
 * Codebook, Logbook and Memos windows; the memo with `projectPath` for a
 * memo update; and `{ guid, projectPath }` for a memo deleted or a memo
 * window's close cancelled.
 */
import { emitTo } from '@tauri-apps/api/event'
import type { CodebookMessages, LogbookMessages, MemosWindowMessages, MemoUpdate } from '../models/window-messages'

const MAIN = 'main'

// Each window is its own page, so this is the one window's project.
let windowProject: string | undefined

/** Note the project this window was opened for, from its init data (sent
 *  again whenever the main window refreshes it). */
export function noteWindowProject(initData: unknown): void {
  const p = (initData as { projectPath?: unknown } | null | undefined)?.projectPath
  windowProject = typeof p === 'string' ? p : undefined
}

function toMain(event: string, payload: Record<string, unknown>): Promise<void> {
  return emitTo(MAIN, event, { ...payload, projectPath: windowProject })
}

export function sendCodebookUpdate<A extends keyof CodebookMessages>(action: A, ...args: CodebookMessages[A]): void {
  void toMain('codebook-update', { action, args })
}

export function sendLogbookUpdate<A extends keyof LogbookMessages>(action: A, ...args: LogbookMessages[A]): void {
  void toMain('logbook-update', { action, args })
}

export function sendMemosWindowAction<A extends keyof MemosWindowMessages>(action: A, ...args: MemosWindowMessages[A]): void {
  void toMain('memos-window-action', { action, args })
}

/** A memo saved in its edit window. */
export function sendMemoUpdate(memo: MemoUpdate): Promise<void> {
  return toMain('memo-update', { ...memo })
}

/** A memo deleted in its edit window. */
export function sendMemoDelete(guid: string): Promise<void> {
  return toMain('memo-delete', { guid })
}

/** The user chose Cancel when closing a memo edit window with unsaved
 *  changes: whatever was closing it (a project switch, quitting) stops. */
export function sendMemoCloseCancelled(guid: string): Promise<void> {
  return toMain('memo-close-cancelled', { guid })
}
