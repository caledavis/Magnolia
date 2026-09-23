import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import JSZip from 'jszip'
import { readArchiveFile } from '../../src/main/qdpx/reader'
import { archiveFileNameFromHandle, setActiveProjectPath, clearOverlay, putOverlay, resolveHandle, archiveHandleForFile } from '../../src/main/binary-store'

// Exercises the pieces behind Merge's "bring a binary-backed document
// (pdf/audio/video/image) into the active project" flow — see
// ipc-handlers.ts's import-merge-binary IPC, which is just these two
// functions wired together and isn't itself unit-testable without a real
// Electron ipcMain. The scenario: a source only exists in a SECOND .qdpx
// (the Merge comparison file), never opened as the active project — its
// bytes have to be read from that other archive and re-registered as an
// overlay scoped to whichever .qdpx IS active.

const BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46]) // arbitrary "pdf-ish" bytes
const dir = mkdtempSync(join(tmpdir(), 'magnolia-merge-binary-'))

async function makeQdpx(name: string, internalFileName: string, bytes: Buffer): Promise<string> {
  const zip = new JSZip()
  zip.folder('sources')!.file(internalFileName, bytes)
  const buf = await zip.generateAsync({ type: 'nodebuffer' })
  const path = join(dir, name)
  writeFileSync(path, buf)
  return path
}

beforeEach(() => {
  clearOverlay()
  setActiveProjectPath(null)
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('archiveFileNameFromHandle', () => {
  it('recovers the in-archive filename from an archive-kind handle', () => {
    expect(archiveFileNameFromHandle('magnolia-bin://archive/ABC123.pdf')).toBe('ABC123.pdf')
  })

  it('returns null for an overlay-kind handle', () => {
    expect(archiveFileNameFromHandle('magnolia-bin://overlay/tok1.pdf')).toBeNull()
  })

  it('returns null for a non-handle string', () => {
    expect(archiveFileNameFromHandle('/some/real/path.pdf')).toBeNull()
  })
})

describe('readArchiveFile', () => {
  it('reads a binary by its in-archive filename from an arbitrary .qdpx, independent of the active project', async () => {
    const comparisonPath = await makeQdpx('compare.qdpx', 'DOC1.pdf', BYTES)
    // No active project set at all — readArchiveFile must not depend on it.
    const bytes = await readArchiveFile(comparisonPath, 'DOC1.pdf')
    expect(bytes).not.toBeNull()
    expect(bytes!.equals(BYTES)).toBe(true)
  })

  it('returns null when the file is not present in that archive', async () => {
    const comparisonPath = await makeQdpx('compare2.qdpx', 'DOC1.pdf', BYTES)
    expect(await readArchiveFile(comparisonPath, 'MISSING.pdf')).toBeNull()
  })

  it('finds the binary even when the comparison archive uses NVivo\'s capitalized "Sources" folder', async () => {
    const zip = new JSZip()
    zip.folder('Sources')!.file('DOC2.pdf', BYTES)
    const buf = await zip.generateAsync({ type: 'nodebuffer' })
    const path = join(dir, 'nvivo-compare.qdpx')
    writeFileSync(path, buf)
    const bytes = await readArchiveFile(path, 'DOC2.pdf')
    expect(bytes!.equals(BYTES)).toBe(true)
  })
})

describe('end-to-end: pulling a binary out of a second .qdpx and serving it from the active one', () => {
  it('registers the comparison file\'s bytes as an overlay that resolves against the ACTIVE project, not the comparison one', async () => {
    const activePath = await makeQdpx('active.qdpx', 'unrelated.txt', Buffer.from('n/a'))
    const comparisonPath = await makeQdpx('compare3.qdpx', 'DOC3.pdf', BYTES)
    setActiveProjectPath(activePath)

    // This is exactly what the import-merge-binary IPC handler does.
    const theirsHandle = archiveHandleForFile('DOC3.pdf')
    const internalName = archiveFileNameFromHandle(theirsHandle)!
    const fetched = await readArchiveFile(comparisonPath, internalName)
    expect(fetched).not.toBeNull()
    const newHandle = putOverlay(fetched!, 'pdf')

    // The new handle resolves against the ACTIVE project (via the overlay,
    // not by re-reading the comparison file) — this is the whole point:
    // the document is now genuinely part of the active project's binary
    // store, not just a dangling reference to the other file.
    const resolved = await resolveHandle(newHandle)
    expect(resolved).not.toBeNull()
    expect(Buffer.from(resolved!).equals(BYTES)).toBe(true)
  })
})
