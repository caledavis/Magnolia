#!/usr/bin/env node
// Magnolia's end-to-end tests: each spec runs in the app itself, on a
// fresh copy of the sample project (e2e/fixture/sample.qdpx), driving it as
// a user does and checking what it shows.
//
//   node e2e/run.mjs                 every spec in e2e/specs
//   node e2e/run.mjs analysis-tools  just those named
//   node e2e/run.mjs --make-fixture  rebuild e2e/fixture/sample.qdpx
//   node e2e/run.mjs --make-large    build e2e/perf/large.qdpx (not kept in git)
//   node e2e/run.mjs --perf          time the app on it (e2e/perf/measure.js)
//
// Needs a development build (`cargo build -p magnolia`): automation is
// compiled out of release builds. The runner starts the Vite dev server the
// build loads its pages from, unless one is already serving on port 5173.
// A spec `foo.js` may have a `foo.after.js`, run next on the same project
// (to check what `foo` saved, after reopening it), and a `foo.prepare.mjs`,
// whose default export is given the project's path (and `qdpxTool`, which
// runs the qdpx_tool example) to change the file before the app opens it.

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const LARGE = join(HERE, 'perf', 'large.qdpx')
const perf = process.argv.includes('--perf')
const FIXTURE = perf ? LARGE : join(HERE, 'fixture', 'sample.qdpx')
const BIN = process.env.MAGNOLIA_BIN || join(ROOT, 'target', 'debug', process.platform === 'win32' ? 'magnolia.exe' : 'magnolia')
const PORT = 5173
const SPEC_TIMEOUT_S = Number(process.env.E2E_TIMEOUT || 600)

const args = process.argv.slice(2)
const makeLarge = args.includes('--make-large')
const makeFixture = args.includes('--make-fixture') || makeLarge
const named = args.filter((a) => !a.startsWith('--'))

async function serverUp() {
  try {
    return (await fetch(`http://localhost:${PORT}/`)).ok
  } catch {
    return false
  }
}

/** Start the dev server unless one is running; returns a stop function. */
async function startServer() {
  if (await serverUp()) return () => {}
  // Vite itself (not through npx), so stopping it stops the server.
  const vite = spawn(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], {
    cwd: ROOT, stdio: 'ignore'
  })
  for (let i = 0; i < 120 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 500))
  if (!(await serverUp())) throw new Error('the Vite dev server did not start')
  return () => vite.kill()
}

/** Run one script in the app on `project`; resolves to its report lines. */
function runInApp(name, script, project, dataDir) {
  return new Promise((resolveRun) => {
    const scriptPath = join(dirname(project), `${name}.js`)
    writeFileSync(scriptPath, script)
    const child = spawn(BIN, [project], {
      env: { ...process.env, MAGNOLIA_AUTOMATION: scriptPath, MAGNOLIA_AUTOMATION_DATA: dataDir },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    const lines = []
    let buf = ''
    child.stderr.on('data', (d) => {
      buf += d
      const parts = buf.split('\n')
      buf = parts.pop()
      for (const l of parts) {
        const m = l.match(/\[automation\] (.*)/)
        if (m) lines.push(m[1])
        else if (/panicked/i.test(l)) lines.push('ERROR ' + l.trim())
      }
    })
    const timer = setTimeout(() => {
      lines.push(`ERROR timed out after ${SPEC_TIMEOUT_S}s`)
      child.kill()
    }, SPEC_TIMEOUT_S * 1000)
    child.on('exit', () => {
      clearTimeout(timer)
      resolveRun(lines)
    })
  })
}

/** A fresh project folder: a copy of `from`, and settings of its own. */
function workspace(from, fileName = 'Project.qdpx') {
  const dir = mkdtempSync(join(tmpdir(), 'magnolia-e2e-'))
  const project = join(dir, fileName)
  if (from) copyFileSync(from, project)
  const data = join(dir, 'userdata')
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, 'magnolia-preferences.json'), JSON.stringify({ userName: 'Tester', toolbarStyle: 'ribbon', language: 'en' }))
  return { dir, project, data }
}

/** Run the qdpx_tool example (crates/magnolia-core/examples) with `args`. */
function qdpxTool(...args) {
  const r = spawnSync('cargo', ['run', '-q', '-p', 'magnolia-core', '--example', 'qdpx_tool', '--', ...args], { cwd: ROOT, stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`qdpx_tool ${args[0]} failed`)
}

const harness = readFileSync(join(HERE, 'harness.js'), 'utf8')
const withHarness = (spec) => `${spec}\n${harness}`

/** Print a script's report; returns whether it passed. */
function report(name, lines) {
  const checks = lines.filter((l) => l.startsWith('CHECK '))
  const failed = checks.filter((l) => l.startsWith('CHECK FAIL'))
  const errors = lines.filter((l) => l.startsWith('ERROR '))
  const done = lines.includes('DONE')
  const ok = done && failed.length === 0 && errors.length === 0 && checks.length > 0
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${checks.length - failed.length}/${checks.length} checks${errors.length ? `, ${errors.length} errors` : ''}${done ? '' : ', did not finish'}`)
  for (const l of [...failed, ...errors]) console.log('    ' + l)
  if (process.env.E2E_VERBOSE) for (const l of lines.filter((x) => !failed.includes(x) && !errors.includes(x))) console.log('      ' + l)
  return ok
}

async function main() {
  if (!existsSync(BIN)) throw new Error(`no development build at ${BIN}: run \`cargo build -p magnolia\` first`)
  const stop = await startServer()
  let allOk = true
  try {
    if (makeFixture) {
      // A seed with just a name, written by Magnolia's own writer; the app
      // fills it in (fixture/make-sample.js) and saves it as it saves any
      // project.
      const ws = workspace(null, 'Sample.qdpx')
      const seed = join(ws.dir, 'seed.json')
      writeFileSync(seed, JSON.stringify({ project: { name: 'Sample', origin: 'Magnolia e2e', sources: [], codes: [], sets: [] }, sourceContents: {} }))
      qdpxTool('write', seed, ws.project)
      const maker = makeLarge ? join(HERE, 'perf', 'make-large.js') : join(HERE, 'fixture', 'make-sample.js')
      const out = makeLarge ? LARGE : FIXTURE
      const lines = await runInApp('make', withHarness(readFileSync(maker, 'utf8')), ws.project, ws.data)
      allOk = report(makeLarge ? 'make-large' : 'make-sample', lines)
      if (allOk) {
        copyFileSync(ws.project, out)
        console.log(`wrote ${out}`)
      }
      rmSync(ws.dir, { recursive: true, force: true })
      return allOk
    }
    if (!existsSync(FIXTURE)) throw new Error(perf ? 'no large project: run `node e2e/run.mjs --make-large`' : 'no sample project: run `node e2e/run.mjs --make-fixture`')
    const specDir = join(HERE, perf ? 'perf' : 'specs')
    const specs = readdirSync(specDir)
      .filter((f) => f.endsWith('.js') && !f.endsWith('.after.js') && !f.startsWith('make-'))
      .map((f) => f.slice(0, -3))
      .filter((n) => named.length === 0 || named.includes(n))
      .sort()
    if (specs.length === 0) throw new Error('no specs to run')
    for (const name of specs) {
      const ws = workspace(FIXTURE)
      const prepare = join(specDir, `${name}.prepare.mjs`)
      if (existsSync(prepare)) await (await import(pathToFileURL(prepare).href)).default(ws.project, { qdpxTool })
      const ok = report(name, await runInApp(name, withHarness(readFileSync(join(specDir, `${name}.js`), 'utf8')), ws.project, ws.data))
      allOk = allOk && ok
      const after = join(specDir, `${name}.after.js`)
      if (existsSync(after)) {
        const okAfter = report(`${name} (reopened)`, await runInApp(`${name}.after`, withHarness(readFileSync(after, 'utf8')), ws.project, ws.data))
        allOk = allOk && okAfter
      }
      rmSync(ws.dir, { recursive: true, force: true })
    }
  } finally {
    stop()
  }
  return allOk
}

main().then(
  (ok) => process.exit(ok ? 0 : 1),
  (e) => {
    console.error(e.message || e)
    process.exit(1)
  }
)
