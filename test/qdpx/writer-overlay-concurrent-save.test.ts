import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import JSZip from 'jszip'

const userDataDir = mkdtempSync(join(tmpdir(), 'magnolia-userdata-'))

// See writer-lock-carry-forward.test.ts for why electron is stubbed.
vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test', getPath: () => userDataDir } }))

import { writeQdpx } from '../../src/main/qdpx/writer'
import { putOverlay, getOverlayByHandle, markPersisted, clearOverlay } from '../../src/main/binary-store'
import type { Project } from '../../src/renderer/models/types'

const dir = mkdtempSync(join(tmpdir(), 'magnolia-overlay-concurrent-'))
const GUID = 'C06D37BE-2934-4343-B59C-F690339B066B'
const BYTES = Buffer.from('not really an mp4, but bytes all the same')

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
})

beforeEach(() => clearOverlay())

function projectWithVideo(handle: string): Project {
  return {
    name: 'Test', origin: 'test', users: [], codes: [], sets: [], notes: [],
    sources: [{
      guid: GUID, name: 'Beispielvideo.mp4', sourceType: 'video', selections: [],
      formatData: { videoFilePath: handle, videoExt: 'mp4', mimeType: 'video/mp4' }
    } as any]
  }
}

async function seedEmptyQdpx(name: string): Promise<string> {
  const zip = new JSZip()
  zip.file('project.qde', '<Project name="Test"></Project>')
  const path = join(dir, name)
  writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer' }))
  return path
}

const opts = { resolveOverlay: getOverlayByHandle, markPersisted }

describe('writeQdpx with an overlay binary', () => {
  // The Merge scenario: a video pulled in from the comparison file lives
  // only in the overlay, and autosave and Merge's Save & Close both save
  // at once. The first save used to free the overlay buffer before its
  // archive reached disk, so the second found the bytes nowhere and was
  // refused by the completeness guard.
  it('lets two overlapping saves both embed the binary', async () => {
    const path = await seedEmptyQdpx('concurrent.qdpx')
    const handle = putOverlay(BYTES, 'mp4')
    const project = projectWithVideo(handle)

    await Promise.all([writeQdpx(path, project, {}, opts), writeQdpx(path, project, {}, opts)])

    const after = await JSZip.loadAsync(await readFile(path))
    const entry = after.file(`sources/${GUID}.mp4`)
    expect(entry).not.toBeNull()
    expect(Buffer.compare(await entry!.async('nodebuffer'), BYTES)).toBe(0)
  })

  it('keeps the overlay buffer when the save fails', async () => {
    const path = await seedEmptyQdpx('failing.qdpx')
    const handle = putOverlay(BYTES, 'mp4')
    const project = projectWithVideo(handle)
    // A second video with no recoverable bytes trips the completeness guard.
    project.sources.push({
      guid: 'MISSING', name: 'gone.mp4', sourceType: 'video', selections: [],
      formatData: { videoFilePath: 'magnolia-bin://archive/MISSING.mp4', videoExt: 'mp4' }
    } as any)

    await expect(writeQdpx(path, project, {}, opts)).rejects.toThrow(/could not be located/)
    expect(getOverlayByHandle(handle)).not.toBeNull()
  })

  it('frees the overlay buffer once the save reaches disk', async () => {
    const path = await seedEmptyQdpx('single.qdpx')
    const handle = putOverlay(BYTES, 'mp4')
    await writeQdpx(path, projectWithVideo(handle), {}, opts)
    expect(getOverlayByHandle(handle)).toBeNull()
  })
})
