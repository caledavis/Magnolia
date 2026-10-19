import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import JSZip from 'jszip'
import { readZipEntry, exactEntry } from '../../src/main/qdpx/zip-entry'
import { readArchiveFile } from '../../src/main/qdpx/reader'

let dir: string
let lower: string
let nvivo: string
const pdfBytes = Buffer.from('%PDF-1.4 fake pdf bytes \u0000ÿ', 'binary')

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zip-entry-'))
  const a = new JSZip()
  a.file('project.qde', '<Project/>')
  a.file('magnolia-lock.json', '{"userName":"A"}')
  a.file('sources/AAA.pdf', pdfBytes)
  a.file('sources/BBB.txt', 'plain text')
  lower = join(dir, 'lower.qdpx')
  await writeFile(lower, await a.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))

  const b = new JSZip()
  b.file('Sources/AAA.pdf', pdfBytes)
  nvivo = join(dir, 'nvivo.qdpx')
  await writeFile(nvivo, await b.generateAsync({ type: 'nodebuffer' }))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('readZipEntry', () => {
  it('reads one compressed entry byte-for-byte', async () => {
    expect(await readZipEntry(lower, exactEntry('sources/AAA.pdf'))).toEqual(pdfBytes)
    expect((await readZipEntry(lower, exactEntry('magnolia-lock.json')))!.toString()).toBe('{"userName":"A"}')
  })

  it('returns null for a missing entry', async () => {
    expect(await readZipEntry(lower, exactEntry('sources/NOPE.pdf'))).toBeNull()
  })

  it('lets the picker choose from every file entry name', async () => {
    const seen: string[] = []
    const bytes = await readZipEntry(lower, (names) => {
      seen.push(...names)
      return names.find((n) => n.startsWith('sources/AAA.'))
    })
    expect(bytes).toEqual(pdfBytes)
    expect(seen).toEqual(expect.arrayContaining(['project.qde', 'sources/AAA.pdf', 'sources/BBB.txt']))
    expect(seen.some((n) => n.endsWith('/'))).toBe(false)
  })

  it('rejects for a file that is not a zip', async () => {
    const bad = join(dir, 'bad.qdpx')
    await writeFile(bad, 'not a zip')
    await expect(readZipEntry(bad, exactEntry('x'))).rejects.toThrow()
  })
})

describe('readArchiveFile', () => {
  it('honours the NVivo "Sources" folder casing', async () => {
    expect(await readArchiveFile(nvivo, 'AAA.pdf')).toEqual(pdfBytes)
    expect(await readArchiveFile(lower, 'AAA.pdf')).toEqual(pdfBytes)
    expect(await readArchiveFile(lower, 'ZZZ.pdf')).toBeNull()
  })
})
