#!/usr/bin/env node
/**
 * Layout checks of the real app, per interface language (macOS).
 *
 *   npm run layout-check -- [--lang <id>|all] [--project <file.qdpx>] [check…]
 *
 * Checks (default: ribbon ui):
 *   ribbon      every ribbon tab at four window sizes: labels wider than
 *               their button, on more than two lines, or overlapping; and
 *               the scroll chevrons
 *   ribbon-rtl  the same with the page forced right to left
 *   ui          every view, tool, Preferences category, menu and dialog:
 *               text that spills, is clipped without an ellipsis, or
 *               overlaps other text
 *   pdf         exports a saved query's results as PDF, Word Frequencies as
 *               CSV, and a PDF of text in several scripts
 *   document-bar every document's bar at three widths: controls that
 *               spill out of it, or a bar that wraps
 *   coded-pdf   exports every document and notebook in the project from its
 *               Export menu, as a PDF with its codes and without
 *   rtl-ui      the main window, a tool and a document forced right to left
 *   rtl-text    imports and opens a mixed Arabic and English document
 *   screenshot  the main window with a document open
 *
 * --lang defaults to English; "all" checks every language in
 * src/renderer/locales one after the other. The project is a few made-up
 * coded interviews (fixture.mjs), written as a .qdpx by Magnolia's own
 * writer; --project opens another one instead, skipping the steps that
 * need names it doesn't have.
 *
 * Builds the debug app and runs it with MAGNOLIA_AUTOMATION (a debug-only
 * hook, src-tauri/src/automation.rs) on a scratch copy of the project with
 * its own preferences, so your projects and settings are untouched. Needs
 * Screen Recording permission for the terminal, and an awake display.
 * Writes captures and a report to layout-report/<lang>/, and exits with 1
 * if any language had an ISSUE or OVERFLOW.
 */
import { spawn, execFileSync } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fixture, NAMES } from './fixture.mjs'

const ROOT = path.resolve(import.meta.dirname, '../..')
const REPORT = path.join(ROOT, 'layout-report')
const CHECKS = ['ribbon', 'ribbon-rtl', 'ui', 'pdf', 'document-bar', 'coded-pdf', 'rtl-ui', 'rtl-text', 'screenshot']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Arguments ──────────────────────────────────────────────────────

const args = process.argv.slice(2)
const option = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1] }
const langArg = option('--lang') ?? 'en'
const projectArg = option('--project')
const project = projectArg ? path.resolve(projectArg) : path.join(REPORT, 'Layout check.qdpx')
const checks = args.length ? args : ['ribbon', 'ui']
const unknown = checks.filter((c) => !CHECKS.includes(c))
const allLanguages = fs.readdirSync(path.join(ROOT, 'src/renderer/locales')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort()
const languages = langArg === 'all' ? allLanguages : [langArg]
if (unknown.length || languages.some((l) => !allLanguages.includes(l)) || (projectArg && !fs.existsSync(project))) {
  if (unknown.length) console.error('Unknown check: ' + unknown.join(', ') + '. Checks: ' + CHECKS.join(', '))
  if (languages.some((l) => !allLanguages.includes(l))) console.error('Unknown language: ' + langArg + '. Languages: ' + allLanguages.join(', ') + ', all')
  if (projectArg && !fs.existsSync(project)) console.error('No project at ' + project + ' (use --project <file.qdpx>)')
  process.exit(2)
}

// ── The app ────────────────────────────────────────────────────────

// Vite may listen on IPv4 or only on IPv6, so try both; missing a server
// that's already running would start a second one.
const portOpenOn = (port, host) => new Promise((resolve) => {
  const s = net.connect(port, host)
  s.on('connect', () => { s.destroy(); resolve(true) })
  s.on('error', () => resolve(false))
})
const portOpen = async (port) => (await portOpenOn(port, '127.0.0.1')) || (await portOpenOn(port, '::1'))

/** Crop a capture to a CSS-pixel rect with sips. The web view fills the
 *  bottom of the window, so its top sits at (image height − view height). */
function crop(file, r) {
  const size = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]).toString()
  const W = +size.match(/pixelWidth: (\d+)/)[1], H = +size.match(/pixelHeight: (\d+)/)[1]
  const left = Math.max(0, Math.round(W - r.innerW * r.dpr + r.x * r.dpr))
  const top = Math.max(0, Math.round(H - r.innerH * r.dpr + r.y * r.dpr))
  const width = Math.min(W - left, Math.round(r.width * r.dpr))
  const height = Math.min(H - top, Math.round(r.height * r.dpr))
  execFileSync('sips', ['-c', String(height), String(width), '--cropOffset', String(top), String(left), file], { stdio: 'ignore' })
}

/** Run the checks in one language; returns the problems logged. */
async function checkLanguage(lang) {
  const out = path.join(REPORT, lang)
  const run = path.join(out, 'run')
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(path.join(run, 'userdata'), { recursive: true })
  const copy = path.join(run, path.basename(project))
  fs.copyFileSync(project, copy)
  fs.writeFileSync(path.join(run, 'userdata/magnolia-preferences.json'), JSON.stringify({ userName: 'Tester', toolbarStyle: 'ribbon', language: lang }))
  fs.writeFileSync(path.join(run, 'checks.js'),
    `const OUT = ${JSON.stringify(out)};\nconst ONLY = ${JSON.stringify(checks)};\nconst PROJECT = ${JSON.stringify(NAMES)};\n` +
    fs.readFileSync(path.join(import.meta.dirname, 'checks.js'), 'utf8'))

  const lines = []
  const rects = []
  await new Promise((resolve) => {
    const child = spawn(path.join(ROOT, 'target/debug/magnolia'), [copy], {
      env: { ...process.env, MAGNOLIA_AUTOMATION: path.join(run, 'checks.js'), MAGNOLIA_AUTOMATION_DATA: path.join(run, 'userdata'), MAGNOLIA_AUTOMATION_EXPORTS: out },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    // Bring the app to the front, so captures show it as the active window.
    setTimeout(() => {
      try { execFileSync('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${child.pid}) to true`]) } catch { /* captures still work */ }
    }, 4000)
    const timer = setTimeout(() => { lines.push(`ISSUE ${lang} timed out`); child.kill() }, 15 * 60 * 1000)
    let buf = ''
    child.stderr.on('data', (d) => {
      buf += d
      const parts = buf.split('\n')
      buf = parts.pop()
      for (const line of parts) {
        const m = line.match(/\[automation\] (.*)/)
        if (!m) continue
        if (m[1].startsWith('RECT ')) rects.push(JSON.parse(m[1].slice(5)))
        else { lines.push(m[1]); if (/^(ISSUE|OVERFLOW|JSERROR)/.test(m[1])) console.log('  ' + m[1]) }
      }
    })
    child.on('exit', () => { clearTimeout(timer); resolve() })
  })
  for (const r of rects) {
    try { crop(path.join(out, r.name + '.png'), r) } catch (e) { lines.push(`ISSUE ${lang} could not crop ${r.name}: ${e.message}`) }
  }
  fs.rmSync(run, { recursive: true, force: true })
  fs.writeFileSync(path.join(out, 'report.txt'), lines.join('\n') + '\n')
  return lines.filter((l) => /^(ISSUE|OVERFLOW|JSERROR)/.test(l))
}

// Keep the display awake while this runs: a sleeping or locked screen
// can't be captured.
spawn('caffeinate', ['-d', '-u', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref()

let vite = null
if (!(await portOpen(5173))) {
  vite = spawn('npx', ['vite'], { cwd: ROOT, stdio: 'ignore', detached: true })
  for (let i = 0; i < 60 && !(await portOpen(5173)); i++) await sleep(500)
}

const problems = {}
try {
  execFileSync('cargo', ['build'], { cwd: path.join(ROOT, 'src-tauri'), stdio: 'inherit' })
  if (!projectArg) {
    execFileSync('cargo', ['build', '--example', 'qdpx_tool', '-p', 'magnolia-core'], { cwd: ROOT, stdio: 'inherit' })
    fs.mkdirSync(REPORT, { recursive: true })
    const json = path.join(REPORT, 'fixture.json')
    fs.writeFileSync(json, JSON.stringify(fixture()))
    execFileSync(path.join(ROOT, 'target/debug/examples/qdpx_tool'), ['write', json, project])
    fs.rmSync(json)
  }
  for (const lang of languages) {
    console.log(`${lang}: ${checks.join(', ')}`)
    problems[lang] = await checkLanguage(lang)
  }
} finally {
  // npx starts Vite as a child of its own, so stop whatever this run
  // started listening on Vite's port (never a server that was already up).
  if (vite) {
    try { process.kill(-vite.pid) } catch { /* already gone */ }
    try {
      for (const pid of execFileSync('lsof', ['-ti', 'tcp:5173', '-sTCP:LISTEN']).toString().split('\n').filter(Boolean)) process.kill(Number(pid))
    } catch { /* nothing listening */ }
  }
}

console.log('\n' + Object.entries(problems).map(([l, p]) => `${l}: ${p.length ? p.length + ' problem(s)' : 'fine'}`).join('\n'))
console.log(`Captures and reports in ${path.relative(process.cwd(), REPORT) || '.'}/<language>/`)
if (Object.values(problems).some((p) => p.length)) process.exitCode = 1
