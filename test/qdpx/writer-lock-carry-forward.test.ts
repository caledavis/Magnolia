import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import JSZip from 'jszip'

// writeQdpx pulls the app version from electron for the .qde `origin`
// attribute — stub it so this runs in plain Node (no Electron runtime),
// matching the convention in test/qdpx/refi-schema.test.ts.
vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test' } }))

import { writeQdpx } from '../../src/main/qdpx/writer'
import type { Project } from '../../src/renderer/models/types'

const dir = mkdtempSync(join(tmpdir(), 'magnolia-lock-carry-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

function emptyProject(): Project {
  return { name: 'Test', origin: 'test', users: [], codes: [], sources: [], sets: [], notes: [] }
}

describe('writeQdpx carries the checkout lock forward', () => {
  it('preserves magnolia-lock.json and magnolia-project-id.json across a normal save', async () => {
    // Seed a fixture .qdpx that's already "checked out" — this is what the
    // file looks like right before the user makes an edit and hits Save.
    const zip = new JSZip()
    zip.file('project.qde', '<Project name="Test"></Project>')
    zip.file('magnolia-project-id.json', JSON.stringify({ projectId: 'fixed-id' }))
    zip.file('magnolia-lock.json', JSON.stringify({ projectId: 'fixed-id', userName: 'Alice', checkedOutAt: '2024-01-01T00:00:00.000Z' }))
    const path = join(dir, 'checked-out.qdpx')
    writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer' }))

    // A normal save (e.g. the user edited a code and hit Save) — without
    // the carry-forward fix in writer.ts, this rebuilds the archive from
    // scratch and silently drops both lock entries.
    await writeQdpx(path, emptyProject(), {})

    const after = await JSZip.loadAsync(await readFile(path))
    const lockEntry = after.file('magnolia-lock.json')
    const idEntry = after.file('magnolia-project-id.json')
    expect(lockEntry).not.toBeNull()
    expect(idEntry).not.toBeNull()
    expect(JSON.parse(await lockEntry!.async('string'))).toEqual({
      projectId: 'fixed-id',
      userName: 'Alice',
      checkedOutAt: '2024-01-01T00:00:00.000Z'
    })
    expect(JSON.parse(await idEntry!.async('string'))).toEqual({ projectId: 'fixed-id' })
  })

  it('does not add lock entries to a project that was never checked out', async () => {
    const zip = new JSZip()
    zip.file('project.qde', '<Project name="Test"></Project>')
    const path = join(dir, 'never-checked-out.qdpx')
    writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer' }))

    await writeQdpx(path, emptyProject(), {})

    const after = await JSZip.loadAsync(await readFile(path))
    expect(after.file('magnolia-lock.json')).toBeNull()
    expect(after.file('magnolia-project-id.json')).toBeNull()
  })
})
