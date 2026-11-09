#!/usr/bin/env node
/**
 * Keeps the translations in step with the English.
 *
 * src/renderer/i18n/translation-status.json holds the English as it was at
 * the last sync, and per language the messages waiting for a translator:
 *   "new"                 not translated yet (Magnolia shows the English)
 *   { "was": "<English>" } translated, but the English has changed since
 *
 *   npm run i18n:sync
 *     After changing en.json: marks new and changed messages as pending in
 *     every language that needs them, removes messages English no longer
 *     has from every catalogue, and records the English. A message added
 *     together with its translations is not marked. The tests fail until
 *     this has been run.
 *
 *   npm run i18n:sync -- done <lang|all> <key>…
 *     The translations of these messages (base keys, without _one/_other)
 *     have been checked and still fit the new English.
 *
 * Review spreadsheets (scripts/translation-review.mjs) list pending
 * messages first, and importing one clears what the reviewer translated
 * or checked.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOCALES = path.join(ROOT, 'src/renderer/locales')
export const STATUS_FILE = path.join(ROOT, 'src/renderer/i18n/translation-status.json')
const PLURAL = /_(zero|one|two|few|many|other)$/

export const languages = () =>
  fs.readdirSync(LOCALES).filter((f) => f.endsWith('.json') && f !== 'en.json').map((f) => f.slice(0, -5)).sort()
export const readCatalogue = (lang) => JSON.parse(fs.readFileSync(path.join(LOCALES, `${lang}.json`), 'utf8'))
export const writeCatalogue = (lang, tree) => fs.writeFileSync(path.join(LOCALES, `${lang}.json`), JSON.stringify(tree, null, 2) + '\n')

/** Every string in a catalogue, by dotted key, in file order. */
export function flatten(tree, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') out.set(key, v)
    else flatten(v, key, out)
  }
  return out
}

/** A key without its plural suffix. */
export const baseKey = (key) => key.replace(PLURAL, '')

/** Base keys, each with its forms ('' for a message without plurals). */
export function messages(flat) {
  const out = new Map()
  for (const [key, text] of flat) {
    const base = baseKey(key)
    if (!out.has(base)) out.set(base, new Map())
    out.get(base).set(key.match(PLURAL)?.[1] ?? '', text)
  }
  return out
}

export function readStatus() {
  if (!fs.existsSync(STATUS_FILE)) return { english: {}, pending: {} }
  const s = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'))
  return { english: s.english ?? {}, pending: s.pending ?? {} }
}

export function writeStatus(status) {
  const pending = Object.fromEntries(Object.entries(status.pending)
    .filter(([, keys]) => Object.keys(keys).length)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([lang, keys]) => [lang, Object.fromEntries(Object.entries(keys).sort(([a], [b]) => a.localeCompare(b)))]))
  const out = {
    about: 'Written by npm run i18n:sync; see scripts/i18n-sync.mjs. "english" is en.json at the last sync; "pending" lists, per language, the messages waiting for a translator.',
    pending,
    english: status.english
  }
  fs.writeFileSync(STATUS_FILE, JSON.stringify(out, null, 2) + '\n')
}

/** Remove a dotted key from a tree, and any object it leaves empty. */
function deleteKey(tree, key) {
  const parts = key.split('.')
  const trail = [tree]
  for (const p of parts.slice(0, -1)) { const next = trail.at(-1)?.[p]; if (typeof next !== 'object') return; trail.push(next) }
  delete trail.at(-1)[parts.at(-1)]
  for (let i = trail.length - 1; i > 0; i--) {
    if (Object.keys(trail[i]).length) break
    delete trail[i - 1][parts[i - 1]]
  }
}

/** Bring the status (and catalogues) up to date with en.json. */
export function sync() {
  const status = readStatus()
  const enFlat = flatten(readCatalogue('en'))
  const en = messages(enFlat)
  const before = messages(new Map(Object.entries(status.english)))
  const firstSync = Object.keys(status.english).length === 0
  const changed = [...en.keys()].filter((k) => {
    const old = before.get(k)
    if (!old) return false
    return [...en.get(k)].some(([form, text]) => old.get(form) !== text)
  })
  const removed = [...before.keys()].filter((k) => !en.has(k))
  const report = { added: [...en.keys()].filter((k) => !firstSync && !before.has(k)), changed, removed, pending: {} }

  for (const lang of languages()) {
    const tree = readCatalogue(lang)
    const flat = flatten(tree)
    const pending = status.pending[lang] ?? {}
    // Messages English no longer has.
    let edited = false
    for (const key of flat.keys()) {
      if (!en.has(baseKey(key))) { deleteKey(tree, key); edited = true }
    }
    if (edited) writeCatalogue(lang, tree)
    const has = new Set([...flat.keys()].filter((k) => en.has(baseKey(k))).map(baseKey))
    for (const key of Object.keys(pending)) {
      if (!en.has(key) || (pending[key] === 'new' && has.has(key))) delete pending[key]
    }
    for (const key of en.keys()) {
      if (!has.has(key)) pending[key] = 'new'
      else if (changed.includes(key) && !pending[key]) {
        const old = before.get(key)
        pending[key] = { was: old.get('') ?? old.get('other') ?? [...old.values()][0] }
      }
    }
    status.pending[lang] = pending
    report.pending[lang] = Object.keys(pending).length
  }
  status.english = Object.fromEntries(enFlat)
  writeStatus(status)
  return report
}

/** Clear pending messages whose translations have been checked. */
export function markDone(lang, keys) {
  const status = readStatus()
  const cleared = []
  for (const l of lang === 'all' ? languages() : [lang]) {
    const pending = status.pending[l] ?? {}
    for (const key of keys.map(baseKey)) {
      if (pending[key] && pending[key] !== 'new') { delete pending[key]; cleared.push(`${l} ${key}`) }
    }
  }
  writeStatus(status)
  return cleared
}

function main([cmd, lang, ...keys]) {
  if (!cmd) {
    const r = sync()
    const list = (label, ks) => ks.length && console.log(`${label} (${ks.length}): ${ks.join(', ')}`)
    list('New in English', r.added)
    list('English changed', r.changed)
    list('Removed from every catalogue', r.removed)
    const waiting = Object.entries(r.pending).filter(([, n]) => n)
    console.log(waiting.length ? 'Waiting for a translator: ' + waiting.map(([l, n]) => `${l} ${n}`).join(', ') : 'Every language is up to date.')
  } else if (cmd === 'done' && lang && keys.length) {
    const cleared = markDone(lang, keys)
    console.log(cleared.length ? cleared.map((c) => 'Checked: ' + c).join('\n') : 'Nothing to clear: those messages are not waiting for a check.')
  } else {
    console.log('Usage:\n  npm run i18n:sync\n  npm run i18n:sync -- done <lang|all> <key>…')
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2))
