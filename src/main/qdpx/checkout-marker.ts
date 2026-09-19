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

/** Patch only the checkout-lock entries into an existing .qdpx. Every
 *  other entry (the .qde, sources/, every other magnolia-*.json) passes
 *  through JSZip.loadAsync → generateAsync unmodified, so this can never
 *  touch the REFI-QDA XML. Mints the project's stable id on first use and
 *  keeps it forever after (it's project identity, not lock state — never
 *  removed on check-in). Pass `marker: null` to check in. Mirrors
 *  writer.ts's atomic temp-file + rename so a crash mid-write can never
 *  corrupt the project. Throws if filePath doesn't exist yet — callers
 *  must only invoke this for a project already saved to disk. */
export async function writeCheckoutMarker(
  filePath: string,
  marker: { userName: string } | null
): Promise<CheckoutMarker | null> {
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

  let result: CheckoutMarker | null = null
  if (marker) {
    result = { projectId, userName: marker.userName, checkedOutAt: new Date().toISOString() }
    zip.file(LOCK_ENTRY, JSON.stringify(result))
  } else {
    zip.remove(LOCK_ENTRY)
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer' })
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
  return result
}
