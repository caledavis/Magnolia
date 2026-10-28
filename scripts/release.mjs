#!/usr/bin/env node
/**
 * Release helpers (see RELEASING.md).
 *
 *   node scripts/release.mjs collect <mac-arm64|mac-x64|win|linux>
 *     Copy this machine's Tauri bundles into release/ under the stable,
 *     version-less names the README's download links and the update
 *     manifests use. On macOS it also zips the .app for electron-updater.
 *
 *   node scripts/release.mjs manifests <version> <dir> [notes-file]
 *     Given every platform's assets in <dir> (e.g. from
 *     `gh release download vX.Y.Z -D <dir>`), write:
 *       latest.json       — Tauri's updater manifest (signed payloads)
 *       latest-mac.yml    — electron-updater manifests, so installs of
 *       latest.yml          Magnolia 1.x (Electron) still find and install
 *       latest-linux.yml    this release
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const REPO = 'caledavis/Magnolia'
const root = resolve(new URL('..', import.meta.url).pathname)
const out = join(root, 'release')

/** Per-platform bundle locations → stable asset names. */
const PLATFORMS = {
  'mac-arm64': { triple: 'aarch64-apple-darwin', arch: 'arm64' },
  'mac-x64': { triple: 'x86_64-apple-darwin', arch: 'x64' }
}

function findOne(dir, pattern) {
  if (!existsSync(dir)) throw new Error(`No bundle directory ${dir} — run the build first.`)
  const hit = readdirSync(dir).find((f) => pattern.test(f))
  if (!hit) throw new Error(`No file matching ${pattern} in ${dir}`)
  return join(dir, hit)
}

function copy(from, name) {
  copyFileSync(from, join(out, name))
  console.log(`  ${name}`)
}

function collect(platform) {
  mkdirSync(out, { recursive: true })
  if (platform.startsWith('mac-')) {
    const { triple, arch } = PLATFORMS[platform]
    const bundle = join(root, 'target', triple, 'release', 'bundle')
    copy(findOne(join(bundle, 'dmg'), /\.dmg$/), `Magnolia-mac-${arch}.dmg`)
    copy(findOne(join(bundle, 'macos'), /\.app\.tar\.gz$/), `Magnolia-mac-${arch}.app.tar.gz`)
    copy(findOne(join(bundle, 'macos'), /\.app\.tar\.gz\.sig$/), `Magnolia-mac-${arch}.app.tar.gz.sig`)
    // electron-updater (Magnolia 1.x) installs a zipped .app via Squirrel.Mac.
    const zip = join(out, `Magnolia-mac-${arch}.zip`)
    execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', join(bundle, 'macos', 'Magnolia.app'), zip])
    console.log(`  Magnolia-mac-${arch}.zip`)
  } else if (platform === 'win') {
    const nsis = join(root, 'target', 'release', 'bundle', 'nsis')
    copy(findOne(nsis, /-setup\.exe$/), 'Magnolia-win-x64.exe')
    copy(findOne(nsis, /-setup\.exe\.sig$/), 'Magnolia-win-x64.exe.sig')
  } else if (platform === 'linux') {
    const bundle = join(root, 'target', 'release', 'bundle')
    copy(findOne(join(bundle, 'appimage'), /\.AppImage$/), 'Magnolia-linux-x86_64.AppImage')
    copy(findOne(join(bundle, 'appimage'), /\.AppImage\.sig$/), 'Magnolia-linux-x86_64.AppImage.sig')
    copy(findOne(join(bundle, 'deb'), /\.deb$/), 'Magnolia-linux-amd64.deb')
    copy(findOne(join(bundle, 'rpm'), /\.rpm$/), 'Magnolia-linux-x86_64.rpm')
  } else {
    throw new Error(`Unknown platform "${platform}" (mac-arm64, mac-x64, win, linux)`)
  }
}

const sha512 = (file) => createHash('sha512').update(readFileSync(file)).digest('base64')

/** electron-updater manifest for one file. */
function legacyYml(version, dir, file, date, extra = '') {
  const path = join(dir, file)
  const hash = sha512(path)
  const size = statSync(path).size
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${file}`,
    `    sha512: ${hash}`,
    `    size: ${size}`,
    `path: ${file}`,
    `sha512: ${hash}`,
    `releaseDate: '${date}'`,
    extra
  ]
    .filter(Boolean)
    .join('\n') + '\n'
}

function manifests(version, dir, notesFile) {
  const v = version.replace(/^v/, '')
  const date = new Date().toISOString()
  const url = (file) => `https://github.com/${REPO}/releases/download/v${v}/${file}`
  const has = (f) => existsSync(join(dir, f))
  const sig = (f) => readFileSync(join(dir, `${f}.sig`), 'utf-8').trim()

  const platforms = {}
  const add = (key, file) => {
    if (has(file) && has(`${file}.sig`)) platforms[key] = { signature: sig(file), url: url(file) }
  }
  add('darwin-aarch64', 'Magnolia-mac-arm64.app.tar.gz')
  add('darwin-x86_64', 'Magnolia-mac-x64.app.tar.gz')
  add('windows-x86_64', 'Magnolia-win-x64.exe')
  add('linux-x86_64', 'Magnolia-linux-x86_64.AppImage')
  const notes = notesFile ? readFileSync(notesFile, 'utf-8') : ''
  writeFileSync(join(dir, 'latest.json'), JSON.stringify({ version: v, notes, pub_date: date, platforms }, null, 2) + '\n')
  console.log(`  latest.json (${Object.keys(platforms).join(', ')})`)

  // macOS: list both architectures; electron-updater picks the arm64 file on
  // Apple Silicon and the other on Intel. minimumSystemVersion is a Darwin
  // version (macOS 13 = Darwin 22), quoted so it stays a string.
  const macFiles = ['Magnolia-mac-arm64.zip', 'Magnolia-mac-x64.zip'].filter(has)
  if (macFiles.length) {
    const entries = macFiles.map((f) => `  - url: ${f}\n    sha512: ${sha512(join(dir, f))}\n    size: ${statSync(join(dir, f)).size}`)
    const first = macFiles[0]
    writeFileSync(
      join(dir, 'latest-mac.yml'),
      `version: ${v}\nfiles:\n${entries.join('\n')}\npath: ${first}\nsha512: ${sha512(join(dir, first))}\nreleaseDate: '${date}'\nminimumSystemVersion: '22.0.0'\n`
    )
    console.log('  latest-mac.yml')
  }
  if (has('Magnolia-win-x64.exe')) {
    writeFileSync(join(dir, 'latest.yml'), legacyYml(v, dir, 'Magnolia-win-x64.exe', date))
    console.log('  latest.yml')
  }
  if (has('Magnolia-linux-x86_64.AppImage')) {
    writeFileSync(join(dir, 'latest-linux.yml'), legacyYml(v, dir, 'Magnolia-linux-x86_64.AppImage', date))
    console.log('  latest-linux.yml')
  }
}

const [cmd, ...args] = process.argv.slice(2)
try {
  if (cmd === 'collect' && args[0]) collect(args[0])
  else if (cmd === 'manifests' && args[0] && args[1]) manifests(args[0], resolve(args[1]), args[2])
  else {
    console.error('usage: release.mjs collect <mac-arm64|mac-x64|win|linux>\n       release.mjs manifests <version> <dir> [notes-file]')
    process.exit(1)
  }
} catch (e) {
  console.error(e.message)
  process.exit(1)
}
