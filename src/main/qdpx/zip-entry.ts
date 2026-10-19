import { readFile } from 'fs/promises'
import JSZip from 'jszip'
import yauzl from 'yauzl'

/**
 * Read ONE entry out of a .qdpx without loading the archive.
 *
 * JSZip needs the whole file in memory, so pulling a single PDF out of a
 * 1 GB project via JSZip.loadAsync(readFile(...)) costs a 1 GB read + parse
 * per call — and a pane that previews a hundred box codings fires a hundred
 * of those at once, freezing the main process (and with it the window's
 * input) for minutes. yauzl reads only the central directory and then the
 * one entry's bytes.
 *
 * `pick` receives every entry name and returns the one to read (or
 * undefined for "not present"). Anything yauzl refuses (it is stricter than
 * JSZip about odd entry names some exporters write) falls back to the old
 * whole-archive JSZip read, so behaviour never regresses — it's only slower.
 */
export async function readZipEntry(
  zipPath: string,
  pick: (names: string[]) => string | undefined
): Promise<Buffer | null> {
  try {
    return await readWithYauzl(zipPath, pick)
  } catch {
    const zip = await JSZip.loadAsync(await readFile(zipPath))
    const name = pick(Object.keys(zip.files).filter((n) => !zip.files[n].dir))
    const entry = name ? zip.file(name) : null
    return entry ? entry.async('nodebuffer') : null
  }
}

function readWithYauzl(
  zipPath: string,
  pick: (names: string[]) => string | undefined
): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (openErr, zip) => {
      if (openErr || !zip) return reject(openErr ?? new Error('zip open failed'))
      let settled = false
      const finish = (err: Error | null, value?: Buffer | null): void => {
        if (settled) return
        settled = true
        zip.close()
        if (err) reject(err)
        else resolve(value ?? null)
      }
      const entries = new Map<string, yauzl.Entry>()
      zip.on('error', (err) => finish(err))
      zip.on('entry', (entry: yauzl.Entry) => {
        if (!entry.fileName.endsWith('/')) entries.set(entry.fileName, entry)
        zip.readEntry()
      })
      zip.on('end', () => {
        const name = pick(Array.from(entries.keys()))
        const entry = name ? entries.get(name) : undefined
        if (!entry) return finish(null, null)
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return finish(streamErr ?? new Error('zip stream failed'))
          const chunks: Buffer[] = []
          stream.on('data', (c: Buffer) => chunks.push(c))
          stream.on('error', (err) => finish(err))
          stream.on('end', () => finish(null, Buffer.concat(chunks)))
        })
      })
      zip.readEntry()
    })
  })
}

/** Picker for an exact entry name. */
export const exactEntry = (name: string) => (names: string[]): string | undefined =>
  names.includes(name) ? name : undefined
