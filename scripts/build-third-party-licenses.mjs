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
