#!/usr/bin/env node
/**
 * Release helpers (see RELEASING.md).
 *
 *   node scripts/release.mjs release <mac|win|linux> [--no-upload]
 *     (npm run release:mac / release:win / release:linux.) Build this
 *     platform's installers and update payloads, collect them, and upload
 *     them to the draft release for package.json's version (vX.Y.Z). Loads
 *     the updater key from ~/.tauri/magnolia-updater.key when
 *     TAURI_SIGNING_PRIVATE_KEY isn't set; on macOS, needs the APPLE_*
 *     variables (signing + notarization) and builds both architectures.
 *
 *   node scripts/release.mjs finish [notes-file]
 *     (npm run release:finish.) Download every asset of the draft release,
 *     write the update manifests (with the notes, if given) and upload them.
 *
 *   node scripts/release.mjs collect <mac-arm64|mac-x64|win|linux>
 *     Copy this machine's Tauri bundles into release/ under the stable,
 *     version-less names the README's download links and the update
 *     manifests use. On macOS it also zips the .app for electron-updater.
 *
 *   node scripts/release.mjs manifests <version> <dir> [notes-file] [--base-url <url>]
 *     Given every platform's assets in <dir> (e.g. from
 *     `gh release download vX.Y.Z -D <dir>`), write:
 *       latest.json       — Tauri's updater manifest (signed payloads)
 *       latest-mac.yml    — electron-updater manifests, so installs of
 *       latest.yml          Magnolia 1.x (Electron) still find and install
 *       latest-linux.yml    this release
 *     --base-url points the download links at <url> instead of the GitHub
 *     release, for rehearsing an update against a local server (RELEASING.md,
 *     "Testing an update before release").
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'caledavis/Magnolia'
const root = fileURLToPath(new URL('..', import.meta.url))
const out = join(root, 'release')

/** Per-platform bundle locations → stable asset names. */
const PLATFORMS = {
  'mac-arm64': { triple: 'aarch64-apple-darwin', arch: 'arm64' },
  'mac-x64': { triple: 'x86_64-apple-darwin', arch: 'x64' }
}

function findOne(dir, pattern) {
  if (!existsSync(dir)) throw new Error(`No bundle directory ${dir} — run the build first.`)
  // A previous version's bundle can still be sitting in this directory (Tauri
  // doesn't clean it between builds), so among every match take the newest —
  // not just the first alphabetically, which would silently grab a stale build.
  const hits = readdirSync(dir).filter((f) => pattern.test(f))
  if (!hits.length) throw new Error(`No file matching ${pattern} in ${dir}`)
  const newest = hits.map((f) => join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
  return newest
}

/** The files the current collect() copied, for uploading. */
let collected = []

function copy(from, name) {
  copyFileSync(from, join(out, name))
  collected.push(join(out, name))
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
    collected.push(zip)
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

function manifests(version, dir, notesFile, baseUrl) {
  const v = version.replace(/^v/, '')
  const date = new Date().toISOString()
  const base = baseUrl ? baseUrl.replace(/\/?$/, '/') : `https://github.com/${REPO}/releases/download/v${v}/`
  const url = (file) => `${base}${file}`
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

const version = () => JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version
const isWin = process.platform === 'win32'

/** Run a command with its output shown; npm and gh are .cmd files on Windows. */
function run(cmd, args, env = process.env) {
  execFileSync(cmd, args, { stdio: 'inherit', env, shell: isWin, cwd: root })
}

/** The environment for a signed release build, or an error saying what's missing. */
function releaseEnv(platform) {
  const env = { ...process.env }
  if (!env.TAURI_SIGNING_PRIVATE_KEY) {
    const keyFile = join(homedir(), '.tauri', 'magnolia-updater.key')
    if (!existsSync(keyFile)) {
      throw new Error(`No updater signing key: set TAURI_SIGNING_PRIVATE_KEY, or copy the key to ${keyFile} (see RELEASING.md).`)
    }
    env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyFile, 'utf-8')
  }
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= ''
  if (platform === 'mac') {
    // Unsigned Mac builds are blocked by Gatekeeper, and 1.x installs only
    // update to a build signed with the same Developer ID, so don't go on.
    const missing = ['APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'].filter((v) => !env[v])
    if (missing.length) throw new Error(`Set ${missing.join(', ')} first, so the build is signed and notarized (see RELEASING.md).`)
  }
  return env
}

/** Build, collect and (unless --no-upload) upload this platform's assets. */
function release(platform, upload) {
  const host = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform]
  if (platform !== host) throw new Error(`Build ${platform} on a ${platform} machine (this one is ${host ?? process.platform}).`)
  const env = releaseEnv(platform)
  const tag = `v${version()}`
  console.log(`Building Magnolia ${version()} for ${platform}…`)
  collected = []
  if (platform === 'mac') {
    for (const target of ['mac-arm64', 'mac-x64']) {
      run('npm', ['run', 'tauri', 'build', '--', '--target', PLATFORMS[target].triple], env)
    }
    for (const target of ['mac-arm64', 'mac-x64']) { console.log(`Collecting ${target}:`); collect(target) }
  } else {
    run('npm', ['run', 'tauri', 'build'], env)
    console.log(`Collecting ${platform}:`)
    collect(platform)
  }
  if (!upload) {
    console.log(`\nDone. Upload with: gh release upload ${tag} ${collected.map((f) => `release/${f.split(/[\\/]/).pop()}`).join(' ')} --clobber`)
    return
  }
  console.log(`Uploading to the ${tag} release…`)
  run('gh', ['release', 'upload', tag, ...collected, '--clobber', '--repo', REPO])
  console.log(`\nDone: ${collected.length} files uploaded to ${tag}.`)
}

/** Write the update manifests from the release's assets and upload them. */
function finish(notesFile) {
  const tag = `v${version()}`
  const dir = join(tmpdir(), `magnolia-${tag}-assets`)
  rmSync(dir, { recursive: true, force: true }) // a fresh copy of the release's assets
  mkdirSync(dir, { recursive: true })
  console.log(`Downloading the ${tag} assets…`)
  run('gh', ['release', 'download', tag, '-D', dir, '--clobber', '--repo', REPO])
  manifests(version(), dir, notesFile ? resolve(notesFile) : undefined)
  const written = ['latest.json', 'latest-mac.yml', 'latest.yml', 'latest-linux.yml'].map((f) => join(dir, f)).filter(existsSync)
  run('gh', ['release', 'upload', tag, ...written, '--clobber', '--repo', REPO])
  console.log(`\nDone. Check the draft on GitHub, then publish it.`)
}

const argv = process.argv.slice(2)
const flag = argv.indexOf('--base-url')
const baseUrl = flag >= 0 ? argv.splice(flag, 2)[1] : undefined
const noUpload = argv.includes('--no-upload')
const [cmd, ...args] = argv.filter((a) => a !== '--no-upload')
try {
  if (cmd === 'release' && args[0]) release(args[0], !noUpload)
  else if (cmd === 'finish') finish(args[0])
  else if (cmd === 'collect' && args[0]) collect(args[0])
  else if (cmd === 'manifests' && args[0] && args[1]) manifests(args[0], resolve(args[1]), args[2], baseUrl)
  else {
    console.error('usage: release.mjs release <mac|win|linux> [--no-upload]\n       release.mjs finish [notes-file]\n       release.mjs collect <mac-arm64|mac-x64|win|linux>\n       release.mjs manifests <version> <dir> [notes-file] [--base-url <url>]')
    process.exit(1)
  }
} catch (e) {
  console.error(e.message)
  process.exit(1)
}
