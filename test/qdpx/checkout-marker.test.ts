import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import JSZip from 'jszip'
import { readCheckoutMarker, writeCheckoutMarker } from '../../src/main/qdpx/checkout-marker'

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
  it('mints a projectId on first checkout and reuses it on the next', async () => {
    const path = await makeQdpx('mint.qdpx')
    const first = await writeCheckoutMarker(path, { userName: 'Alice' })
    expect(first?.userName).toBe('Alice')
    expect(first?.projectId).toBeTruthy()

    const second = await writeCheckoutMarker(path, { userName: 'Bob' })
    expect(second?.userName).toBe('Bob')
    expect(second?.projectId).toBe(first?.projectId)
  })

  it('checking in removes the lock but keeps the project id', async () => {
    const path = await makeQdpx('checkin.qdpx')
    const marker = await writeCheckoutMarker(path, { userName: 'Alice' })
    expect(await readCheckoutMarker(path)).not.toBeNull()

    const result = await writeCheckoutMarker(path, null)
    expect(result).toBeNull()
    expect(await readCheckoutMarker(path)).toBeNull()

    // The project id itself survives check-in.
    const zip = await JSZip.loadAsync(await readFile(path))
    const idEntry = zip.file('magnolia-project-id.json')
    expect(idEntry).not.toBeNull()
    const { projectId } = JSON.parse(await idEntry!.async('string'))
    expect(projectId).toBe(marker?.projectId)
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
