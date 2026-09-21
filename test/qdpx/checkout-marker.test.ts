import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import JSZip from 'jszip'
import { readCheckoutMarker, writeCheckoutMarker, readEditorInfo } from '../../src/main/qdpx/checkout-marker'

const dir = mkdtempSync(join(tmpdir(), 'magnolia-checkout-'))

/** Build a minimal .qdpx with a fake .qde and a fake source, so round-trip
 *  tests can assert unrelated entries survive untouched. */
async function makeQdpx(name: string): Promise<string> {
  const zip = new JSZip()
  zip.file('project.qde', '<Project name="Test"></Project>')
  zip.folder('sources')!.file('x.txt', 'hello world')
  const buf = await zip.generateAsync({ type: 'nodebuffer' })
  const path = join(dir, name)
  writeFileSync(path, buf)
  return path
}

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('readCheckoutMarker', () => {
  it('returns null when there is no lock entry', async () => {
    const path = await makeQdpx('none.qdpx')
    expect(await readCheckoutMarker(path)).toBeNull()
  })

  it('returns null for a nonexistent file', async () => {
    expect(await readCheckoutMarker(join(dir, 'does-not-exist.qdpx'))).toBeNull()
  })

  it('returns null for a corrupt lock entry', async () => {
    const zip = new JSZip()
    zip.file('project.qde', '<Project name="Test"></Project>')
    zip.file('magnolia-lock.json', '{not valid json')
    const buf = await zip.generateAsync({ type: 'nodebuffer' })
    const path = join(dir, 'corrupt.qdpx')
    writeFileSync(path, buf)
    expect(await readCheckoutMarker(path)).toBeNull()
  })
})

describe('writeCheckoutMarker', () => {
  it('mints a projectId on first checkout and reuses it on the next check-out by the SAME user', async () => {
    const path = await makeQdpx('mint.qdpx')
    const first = await writeCheckoutMarker(path, { userName: 'Alice' })
    expect(first.ok).toBe(true)
    expect(first.marker?.userName).toBe('Alice')
    expect(first.marker?.projectId).toBeTruthy()

    // Same user re-checking-out (e.g. after their own check-in) isn't a
    // conflict — the projectId carries forward regardless.
    const second = await writeCheckoutMarker(path, { userName: 'Alice' })
    expect(second.ok).toBe(true)
    expect(second.marker?.userName).toBe('Alice')
    expect(second.marker?.projectId).toBe(first.marker?.projectId)
  })

  it('rejects a check-out by someone else without touching the existing lock', async () => {
    const path = await makeQdpx('conflict.qdpx')
    const first = await writeCheckoutMarker(path, { userName: 'Alice' })
    expect(first.ok).toBe(true)

    const second = await writeCheckoutMarker(path, { userName: 'Bob' })
    expect(second.ok).toBe(false)
    expect(second.marker?.userName).toBe('Alice')

    // The lock on disk is untouched — still Alice's, same checkedOutAt.
    const onDisk = await readCheckoutMarker(path)
    expect(onDisk?.userName).toBe('Alice')
    expect(onDisk?.checkedOutAt).toBe(first.marker?.checkedOutAt)
  })

  it('steal writes through unconditionally over someone else\'s lock', async () => {
    const path = await makeQdpx('steal.qdpx')
    await writeCheckoutMarker(path, { userName: 'Alice' })

    const stolen = await writeCheckoutMarker(path, { userName: 'Bob', steal: true })
    expect(stolen.ok).toBe(true)
    expect(stolen.marker?.userName).toBe('Bob')
    expect((await readCheckoutMarker(path))?.userName).toBe('Bob')
  })

  it('checking in removes the lock but keeps the project id', async () => {
    const path = await makeQdpx('checkin.qdpx')
    const { marker } = await writeCheckoutMarker(path, { userName: 'Alice' })
    expect(await readCheckoutMarker(path)).not.toBeNull()

    const result = await writeCheckoutMarker(path, { userName: 'Alice', checkIn: true })
    expect(result).toEqual({ ok: true, marker: null })
    expect(await readCheckoutMarker(path)).toBeNull()

    // The project id itself survives check-in.
    const zip = await JSZip.loadAsync(await readFile(path))
    const idEntry = zip.file('magnolia-project-id.json')
    expect(idEntry).not.toBeNull()
    const { projectId } = JSON.parse(await idEntry!.async('string'))
    expect(projectId).toBe(marker?.projectId)
  })

  it('rejects checking in someone else\'s lock without touching it', async () => {
    const path = await makeQdpx('checkin-conflict.qdpx')
    await writeCheckoutMarker(path, { userName: 'Alice' })

    // Bob's window still believes it holds the lock (stale local state —
    // there's no live push) and issues a check-in on that belief. It
    // must not rip out Alice's actual lock.
    const result = await writeCheckoutMarker(path, { userName: 'Bob', checkIn: true })
    expect(result.ok).toBe(false)
    expect(result.marker?.userName).toBe('Alice')
    expect((await readCheckoutMarker(path))?.userName).toBe('Alice')
  })

  it('leaves every other zip entry byte-identical', async () => {
    const path = await makeQdpx('untouched.qdpx')
    const before = await JSZip.loadAsync(await readFile(path))
    const beforeQde = await before.file('project.qde')!.async('string')
    const beforeSource = await before.file('sources/x.txt')!.async('string')

    await writeCheckoutMarker(path, { userName: 'Alice' })

    const after = await JSZip.loadAsync(await readFile(path))
    expect(await after.file('project.qde')!.async('string')).toBe(beforeQde)
    expect(await after.file('sources/x.txt')!.async('string')).toBe(beforeSource)
  })
})

describe('readEditorInfo', () => {
  it('returns null when there is no editor entry', async () => {
    const path = await makeQdpx('no-editor.qdpx')
    expect(await readEditorInfo(path)).toBeNull()
  })

  it('returns null for a nonexistent file', async () => {
    expect(await readEditorInfo(join(dir, 'does-not-exist-2.qdpx'))).toBeNull()
  })

  it('returns null for a corrupt editor entry', async () => {
    const zip = new JSZip()
    zip.file('project.qde', '<Project name="Test"></Project>')
    zip.file('magnolia-editor.json', '{not valid json')
    const buf = await zip.generateAsync({ type: 'nodebuffer' })
    const path = join(dir, 'corrupt-editor.qdpx')
    writeFileSync(path, buf)
    expect(await readEditorInfo(path)).toBeNull()
  })

  it('reads a well-formed editor entry', async () => {
    const zip = new JSZip()
    zip.file('project.qde', '<Project name="Test"></Project>')
    zip.file('magnolia-editor.json', JSON.stringify({ lastEditedBy: 'Alice', lastEditedAt: '2024-01-01T00:00:00.000Z' }))
    const buf = await zip.generateAsync({ type: 'nodebuffer' })
    const path = join(dir, 'well-formed-editor.qdpx')
    writeFileSync(path, buf)
    expect(await readEditorInfo(path)).toEqual({ lastEditedBy: 'Alice', lastEditedAt: '2024-01-01T00:00:00.000Z' })
  })
})
