#!/usr/bin/env node
/**
 * Generates THIRD-PARTY-LICENSES.txt: the license text of every
 * production npm package (via license-checker) and of every Rust crate the
 * app links on any platform (via `cargo tree` + `cargo metadata`). Bundled
 * with the app so it ships full attribution for every dependency,
 * satisfying BSD / Apache-2.0 / MIT notice requirements.
 *
 * Usage: node scripts/build-third-party-licenses.mjs > THIRD-PARTY-LICENSES.txt
 */
import { execSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const json = execSync('npx --yes license-checker --production --json', {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'ignore']
})
const packages = JSON.parse(json)

const out = [
  'THIRD-PARTY LICENSES',
  '',
  'Magnolia bundles a number of open-source libraries. The full license',
  'text for each is reproduced below, ordered alphabetically by package.',
  ''
]

// ── The Linux AppImage's system libraries ──
// Taken from the build machine by linuxdeploy, so not listable here: say
// what they are and where their notices and licence texts are inside the
// AppImage (src-tauri/linux/licenses/README).
out.push(
  '─'.repeat(72),
  'Linux AppImage: system libraries, including GStreamer and FFmpeg',
  '',
  'The Linux AppImage (Magnolia-linux-x86_64.AppImage) also carries the',
  'system libraries Magnolia needs to run on any distribution, taken from',
  'Ubuntu 22.04, on which it is built. They include GTK, WebKitGTK and the',
  'GStreamer media framework with its plugins, which Magnolia uses to play',
  'audio and video. Each library keeps its own licence: most are under',
  'the GNU Lesser General Public License, some under the GNU General',
  'Public License, the Mozilla Public License, the Apache License and',
  'others. Each one\'s copyright notice and licence, as its Ubuntu package',
  'states them, is inside the AppImage at usr/share/doc/<package>/copyright,',
  'and the full text of every licence those notices name is at',
  'usr/share/common-licenses. To see them, run the AppImage with',
  '--appimage-extract, which unpacks it into a folder named squashfs-root.',
  '',
  'This software uses libraries from the FFmpeg project (https://ffmpeg.org),',
  'through GStreamer\'s gst-libav plugin, to decode H.264 video and AAC',
  'audio. Ubuntu builds FFmpeg with its GPL components enabled, so these',
  'libraries are licensed under the GNU General Public License, version 2',
  'or later (usr/share/common-licenses/GPL-2 in the AppImage). FFmpeg is a',
  'trademark of Fabrice Bellard, originator of the FFmpeg project.',
  '',
  'The source code of every one of these libraries, in the versions the',
  'AppImage bundles, is published with each release beside the AppImage,',
  'as Magnolia-linux-x86_64-AppImage-sources.tar',
  '(https://github.com/caledavis/Magnolia/releases).',
  '',
  'The .deb and .rpm packages bundle none of these: they use the copies',
  'your distribution installs.',
  '',
  ''
)

for (const [pkgName, info] of Object.entries(packages).sort()) {
  out.push('─'.repeat(72))
  out.push(pkgName)
  if (info.publisher) out.push(`  Publisher: ${info.publisher}`)
  if (info.licenses) out.push(`  License:   ${info.licenses}`)
  if (info.repository) out.push(`  Source:    ${info.repository}`)
  out.push('')
  if (info.licenseFile) {
    try {
      const text = readFileSync(info.licenseFile, 'utf8').trim()
      out.push(text)
    } catch (err) {
      out.push(`(License file unreadable: ${err.message})`)
    }
  } else {
    out.push('(No license file in package; see "License" tag above.)')
  }
  out.push('')
  out.push('')
}

// ── Fonts pdf.js ships beside its code ──
// Copied into the app at /pdfjs/standard_fonts (vite.config.mts), each
// family under its own licence, which pdf.js keeps beside the fonts.
const fontDir = join('node_modules', 'pdfjs-dist', 'standard_fonts')
for (const file of readdirSync(fontDir).filter((f) => f.startsWith('LICENSE_')).sort()) {
  out.push('─'.repeat(72))
  out.push(`pdf.js standard fonts: ${file.slice('LICENSE_'.length)} (${readdirSync(fontDir).filter((f) => !f.startsWith('LICENSE_')).filter((f) => f.toUpperCase().includes(file.slice('LICENSE_'.length))).join(', ')})`)
  out.push('')
  out.push(readFileSync(join(fontDir, file), 'utf8').trim())
  out.push('')
  out.push('')
}

// ── Rust crates ──
// Normal (non-dev, non-build) dependencies of the app on every target.
const tree = execSync('cargo tree -p magnolia -e normal --target all --prefix none --format "{p}"', {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024
})
const linked = new Set(
  tree
    .split('\n')
    .map((l) => l.replace(/ \(.*$/, '').trim())
    .filter(Boolean)
)
const metadata = JSON.parse(
  execSync('cargo metadata --format-version 1', { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
)
const LICENSE_FILE = /^(licen[cs]e|copying|notice)/i
const crates = metadata.packages
  .filter((p) => linked.has(`${p.name} v${p.version}`) && p.source)
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
for (const pkg of crates) {
  out.push('─'.repeat(72))
  out.push(`${pkg.name}@${pkg.version} (Rust crate)`)
  if (pkg.authors?.length) out.push(`  Authors:   ${pkg.authors.join(', ')}`)
  if (pkg.license) out.push(`  License:   ${pkg.license}`)
  if (pkg.repository) out.push(`  Source:    ${pkg.repository}`)
  out.push('')
  const dir = dirname(pkg.manifest_path)
  const files = readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort()
  if (files.length === 0) out.push('(No license file in crate; see "License" tag above.)')
  for (const f of files) {
    if (files.length > 1) out.push(`[${f}]`)
    out.push(readFileSync(join(dir, f), 'utf8').trim())
    out.push('')
  }
  out.push('')
  out.push('')
}

process.stdout.write(out.join('\n'))
