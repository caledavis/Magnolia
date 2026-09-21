import JSZip from 'jszip'
import { readFile, open, rename, unlink } from 'fs/promises'
import { randomUUID } from 'crypto'

/** Check-out lock state for a .qdpx project. Lives entirely in the
 *  project's own `magnolia-lock.json`/`magnolia-project-id.json` zip
 *  entries — never in the REFI-QDA-standard .qde XML — so it travels
 *  with the file wherever it's copied, and other REFI-QDA tools that
 *  don't recognize these entries simply ignore them. */
export interface CheckoutMarker {
  projectId: string
  userName: string
  checkedOutAt: string
}

const LOCK_ENTRY = 'magnolia-lock.json'
const PROJECT_ID_ENTRY = 'magnolia-project-id.json'
export const EDITOR_ENTRY = 'magnolia-editor.json'

/** Who last saved a .qdpx, and when — written unconditionally on every
 *  save (writer.ts), unlike the checkout lock which only exists while
 *  checked out. Lets features like merge attribute a file's differences
 *  to a person even if the user never used check-out/check-in. Lives in
 *  the same kind of Magnolia-only zip entry as the checkout marker. */
export interface EditorInfo {
  lastEditedBy: string
  lastEditedAt: string
}

/** Lightweight peek at a .qdpx's last-editor stamp, independent of the
 *  full readQdpx pipeline. Tolerant of any missing/unreadable/malformed
 *  case (returns null). */
export async function readEditorInfo(filePath: string): Promise<EditorInfo | null> {
  try {
    const zip = await JSZip.loadAsync(await readFile(filePath))
    const entry = zip.file(EDITOR_ENTRY)
    if (!entry) return null
    const info = JSON.parse(await entry.async('string'))
    return typeof info?.lastEditedBy === 'string' && typeof info?.lastEditedAt === 'string'
      ? (info as EditorInfo)
      : null
  } catch {
    return null
  }
}

/** Lightweight peek at a .qdpx's checkout marker, independent of the full
 *  readQdpx pipeline. Tolerant of any missing/unreadable/malformed case
 *  (returns null), matching every other magnolia-*.json reader. */
export async function readCheckoutMarker(filePath: string): Promise<CheckoutMarker | null> {
  try {
    const zip = await JSZip.loadAsync(await readFile(filePath))
    const entry = zip.file(LOCK_ENTRY)
    if (!entry) return null
    const marker = JSON.parse(await entry.async('string'))
    return typeof marker?.userName === 'string' &&
      typeof marker?.checkedOutAt === 'string' &&
      typeof marker?.projectId === 'string'
      ? (marker as CheckoutMarker)
      : null
  } catch {
    return null
  }
}

/** Result of a checkout/check-in write. `ok: false` means the write was
 *  refused because someone else already held the lock and the caller
 *  didn't pass `steal` — `marker` is then THEIR current marker (read in
 *  the same pass, no separate round trip), so the renderer can show who
 *  holds it without a second IPC call. */
export interface CheckoutWriteResult {
  ok: boolean
  marker: CheckoutMarker | null
}

/** Patch only the checkout-lock entries into an existing .qdpx. Every
 *  other entry (the .qde, sources/, every other magnolia-*.json) passes
 *  through JSZip.loadAsync → generateAsync unmodified, so this can never
 *  touch the REFI-QDA XML. Mints the project's stable id on first use and
 *  keeps it forever after (it's project identity, not lock state — never
 *  removed on check-in). Pass `marker.checkIn: true` to check in — this
 *  is check-and-set too, exactly like checking out: it only removes a
 *  lock that still names `marker.userName` as holder. A caller can only
 *  ever have stale knowledge of who holds the lock (there's no live
 *  push — see project-store.ts), so without this a check-in issued on
 *  stale belief ("I still hold it") would silently rip the lock out from
 *  under whoever actually holds it now, e.g. via a stolen-then-abandoned
 *  window's pre-close check-in racing the new holder's active session.
 *  Mirrors writer.ts's atomic temp-file + rename so a crash mid-write can
 *  never corrupt the project. Throws if filePath doesn't exist yet —
 *  callers must only invoke this for a project already saved to disk.
 *
 *  Checking OUT (and now checking IN) is check-and-set: the holder check
 *  reads the SAME zip this function already loaded (no separate
 *  read-then-write round trip from a caller, which is what let the old
 *  unconditional-overwrite version silently clobber another user's
 *  lock), and is re-verified once more immediately before the rename
 *  that actually commits the write, narrowing the window to just the
 *  temp-write + rename. Two Magnolia processes are separate OS processes
 *  writing the same file on disk (often over a network share), not two
 *  calls in this one process — there's no in-process mutex to make this
 *  airtight the way a single-process compare-and-swap would be, only a
 *  narrow one. A true guarantee would need OS-level file locking; this
 *  is deliberately not that, since the cost of the rare remaining race
 *  (two check-outs landing within the same few-hundred-ms write) is
 *  "surfaces as a steal-back conflict at the next save," not silent data
 *  loss — the save-time staleness check (ipc-handlers.ts's save-project
 *  handler) is the actual backstop. Pass `marker.steal: true` to write
 *  through unconditionally (the deliberate override / steal-back path;
 *  never valid together with `checkIn`). */
export async function writeCheckoutMarker(
  filePath: string,
  marker: { userName: string; steal?: boolean } | { userName: string; checkIn: true }
): Promise<CheckoutWriteResult> {
  const zip = await JSZip.loadAsync(await readFile(filePath))

  let projectId: string | undefined
  const idEntry = zip.file(PROJECT_ID_ENTRY)
  if (idEntry) {
    try {
      const parsed = JSON.parse(await idEntry.async('string'))
      if (typeof parsed?.projectId === 'string') projectId = parsed.projectId
    } catch {
      /* remint below */
    }
  }
  if (!projectId) projectId = randomUUID()
  zip.file(PROJECT_ID_ENTRY, JSON.stringify({ projectId }))

  const checkingIn = 'checkIn' in marker && marker.checkIn
  const bypassCheck = !checkingIn && (marker as { steal?: boolean }).steal

  let result: CheckoutMarker | null = null
  if (!bypassCheck) {
    const lockFile = zip.file(LOCK_ENTRY)
    if (lockFile) {
      try {
        const current = JSON.parse(await lockFile.async('string')) as CheckoutMarker
        if (current?.userName && current.userName !== marker.userName) {
          return { ok: false, marker: current }
        }
      } catch {
        /* corrupt marker — treat as unlocked, fall through */
      }
    }
  }
  if (checkingIn) {
    zip.remove(LOCK_ENTRY)
  } else {
    result = { projectId, userName: marker.userName, checkedOutAt: new Date().toISOString() }
    zip.file(LOCK_ENTRY, JSON.stringify(result))
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer' })

  // Late re-check: generateAsync above can take real time on a large
  // project, which is exactly the window another process could have
  // checked out (or stolen) the file in since the check above. Re-read
  // just the lock entry — not the whole zip we already built — right
  // before committing, and abort the write (nothing touched on disk) if
  // someone else has since taken it (or, for check-in, taken it since
  // the caller's own check-in request was issued). Skipped only for
  // steal, same as the early check.
  if (!bypassCheck) {
    const latest = await readCheckoutMarker(filePath)
    if (latest?.userName && latest.userName !== marker.userName) {
      return { ok: false, marker: latest }
    }
  }

  const tmpPath = `${filePath}.${randomUUID()}.tmp`
  try {
    const handle = await open(tmpPath, 'w')
    try {
      await handle.writeFile(buffer)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmpPath, filePath)
  } catch (err) {
    await unlink(tmpPath).catch(() => { /* temp may not exist */ })
    throw err
  }
  return { ok: true, marker: result }
}
