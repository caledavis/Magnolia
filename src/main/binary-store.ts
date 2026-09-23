import { readFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import JSZip from 'jszip'

/**
 * Main-process source of truth for imported media bytes (PDF / image /
 * audio / video) at runtime.
 *
 * The .qdpx is self-contained: every imported file's bytes live inside the
 * archive. Rather than extracting them to OS temp files (which the system
 * reaps, blanking viewers and — historically — getting silently dropped on
 * save), the renderer holds an opaque `magnolia-bin://` handle and fetches
 * bytes through this store on demand:
 *
 *   - `archive/<guid>.<ext>` — a binary already saved in the open .qdpx.
 *     Served by reading `sources/<guid>.<ext>` straight from the archive
 *     on disk. No persistent copy outside the .qdpx.
 *   - `overlay/<token>.<ext>` — a freshly-imported binary not yet written
 *     to the archive (or a project with no file yet). Held in memory until
 *     the next save embeds it; afterwards the buffer is dropped and reads
 *     fall back to the archive via the token→guid map recorded at save.
 *
 * There is no OS-temp round-trip anywhere in this path.
 */

const HANDLE_PREFIX = 'magnolia-bin://'

/** Path to the .qdpx the renderer currently has open. */
let activeProjectPath: string | null = null

/** token → bytes for imported-but-not-yet-saved binaries. */
const overlay = new Map<string, { buffer: Buffer; ext: string }>()

/** token → guid, recorded once a save embeds an overlay binary into the
 *  archive so its handle keeps resolving (from the archive) after the
 *  in-memory buffer is freed. */
const tokenToGuid = new Map<string, string>()

export function setActiveProjectPath(filePath: string | null): void {
  const next = filePath || null
  // Only a switch to a DIFFERENT real project invalidates the import overlay —
  // those imports belonged to the previous archive. A null (project closing /
  // loading / unknown) is NOT a switch, so it must never drop a live overlay;
  // and re-asserting the SAME path (e.g. the renderer's path effect re-firing
  // after a save) must preserve the token→guid mappings that save recorded, or
  // a freshly-imported binary's handle stops resolving until reload.
  if (next && next !== activeProjectPath) {
    clearOverlay()
    activeProjectPath = next
  } else if (next) {
    activeProjectPath = next
  }
}

export function getActiveProjectPath(): string | null {
  return activeProjectPath
}

/** Set the active archive path WITHOUT clearing the import overlay. Used by
 *  the binary-read IPCs, which receive the open project's path from the
 *  renderer on every call — so resolution survives a main-process reload
 *  (dev HMR) or any load path that forgot to register the project. Never
 *  nulls an existing path. */
export function noteActiveProjectPath(filePath: string | null | undefined): void {
  if (filePath) activeProjectPath = filePath
}

export function isBinaryHandle(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.startsWith(HANDLE_PREFIX)
}

export function archiveHandle(guid: string, ext: string): string {
  return `${HANDLE_PREFIX}archive/${guid}.${ext}`
}

/** Handle for a binary stored under an arbitrary in-archive filename
 *  (e.g. `BB9E2A2C….pdf`). Files from other QDA tools name the binary
 *  differently from the source guid, so the reader points the handle at
 *  the real `sources/<fileName>` entry rather than `<guid>.<ext>`. */
export function archiveHandleForFile(fileName: string): string {
  return `${HANDLE_PREFIX}archive/${fileName}`
}

export function overlayHandle(token: string, ext: string): string {
  return `${HANDLE_PREFIX}overlay/${token}.${ext}`
}

/** Register freshly-imported bytes and return a handle for them. */
export function putOverlay(buffer: Buffer, ext: string): string {
  const token = randomUUID().toUpperCase()
  overlay.set(token, { buffer, ext })
  return overlayHandle(token, ext)
}

/** Read overlay bytes by the token embedded in a handle (used by the
 *  writer to embed a fresh import into the archive at save time). */
export function getOverlayByHandle(handle: string): Buffer | null {
  const parsed = parseHandle(handle)
  if (!parsed || parsed.kind !== 'overlay') return null
  return overlay.get(parsed.id)?.buffer ?? null
}

/** After a save embeds an overlay binary into the archive as
 *  `sources/<guid>.<ext>`, free the buffer but remember token→guid so the
 *  renderer's still-overlay handle keeps resolving from the archive. */
export function markPersisted(handle: string, guid: string): void {
  const parsed = parseHandle(handle)
  if (!parsed || parsed.kind !== 'overlay') return
  tokenToGuid.set(parsed.id, guid)
  overlay.delete(parsed.id)
}

export function clearOverlay(): void {
  overlay.clear()
  tokenToGuid.clear()
}

interface ParsedHandle {
  kind: 'archive' | 'overlay'
  /** guid (archive) or token (overlay) — extension stripped. */
  id: string
  /** the in-archive basename, e.g. `<guid>.<ext>` (archive handles only). */
  name: string
}

/** The in-archive filename encoded in an archive-kind handle (e.g.
 *  "magnolia-bin://archive/ABC123.pdf" → "ABC123.pdf") — null for an
 *  overlay handle or any non-handle string. Used by Merge to know which
 *  file to pull out of the comparison .qdpx for a binary-backed source
 *  it doesn't have (see qdpx/reader.ts's readArchiveFile). */
export function archiveFileNameFromHandle(handle: string): string | null {
  const parsed = parseHandle(handle)
  return parsed?.kind === 'archive' ? parsed.name : null
}

function parseHandle(handle: string): ParsedHandle | null {
  if (!handle.startsWith(HANDLE_PREFIX)) return null
  const rest = handle.slice(HANDLE_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash < 0) return null
  const kind = rest.slice(0, slash)
  const name = rest.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  const id = dot > 0 ? name.slice(0, dot) : name
  if (kind !== 'archive' && kind !== 'overlay') return null
  return { kind, id, name }
}

/** Extract `sources/<guid>.<ext>` (or any non-text `sources/<guid>.*`) from
 *  the open .qdpx. */
async function readFromArchive(guidName: string): Promise<Buffer | null> {
  if (!activeProjectPath) return null
  const guid = guidName.includes('.') ? guidName.slice(0, guidName.lastIndexOf('.')) : guidName
  try {
    const zip = await JSZip.loadAsync(await readFile(activeProjectPath))
    let entry = zip.file(`sources/${guidName}`)
    if (!entry) {
      const prefix = `sources/${guid}.`
      const altName = Object.keys(zip.files).find(
        (n) => n.startsWith(prefix) && !zip.files[n].dir && !n.toLowerCase().endsWith('.txt')
      )
      if (altName) entry = zip.file(altName)
    }
    return entry ? await entry.async('nodebuffer') : null
  } catch {
    return null
  }
}

/** Recover a legacy reaped temp file from the open .qdpx by its
 *  `<guid>.<ext>` basename. Kept so any old real-path reference still in
 *  flight resolves after the temp cache is cleaned. */
export async function readArchiveByName(name: string): Promise<Buffer | null> {
  return readFromArchive(name)
}

/**
 * Resolve a `magnolia-bin://` handle to its bytes. Overlay handles read
 * from memory, falling back to the archive once the import has been saved.
 * Archive handles read straight from the open .qdpx. Returns null when the
 * bytes can't be found.
 */
export async function resolveHandle(handle: string): Promise<Buffer | null> {
  const parsed = parseHandle(handle)
  if (!parsed) return null
  if (parsed.kind === 'overlay') {
    const live = overlay.get(parsed.id)
    if (live) return live.buffer
    const guid = tokenToGuid.get(parsed.id)
    if (guid) return readFromArchive(`${guid}.${parsed.name.slice(parsed.id.length + 1)}`)
    return null
  }
  return readFromArchive(parsed.name)
}
