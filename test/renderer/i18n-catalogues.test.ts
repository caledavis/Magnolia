/**
 * The translation catalogues (src/renderer/locales) stay complete and
 * consistent: every English string exists in each language with the same
 * placeholders (or is waiting for a translator, and shows in English until
 * then), plurals have every form the language needs, and every key the app
 * asks for exists.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { resolveLanguage, normaliseLanguagePreference, LANGUAGE_IDS } from '../../src/renderer/i18n'

type Tree = { [key: string]: string | Tree }
const LOCALES = 'src/renderer/locales'
/** Every catalogue in the locales folder, by language id. */
const CATALOGUES: Record<string, Tree> = Object.fromEntries(
  readdirSync(LOCALES)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f.slice(0, -'.json'.length), JSON.parse(readFileSync(join(LOCALES, f), 'utf-8')) as Tree])
)
const en = CATALOGUES.en
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/

/** Every string in a catalogue, by dotted key. */
function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') out.set(key, v)
    else for (const [kk, vv] of flatten(v, key)) out.set(kk, vv)
  }
  return out
}

/** Keys with plural forms folded into their base key. */
function messages(tree: Tree): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>()
  for (const [key, text] of flatten(tree)) {
    const m = key.match(PLURAL_SUFFIX)
    const base = m ? key.slice(0, -m[0].length) : key
    const form = m ? m[1] : ''
    if (!out.has(base)) out.set(base, new Map())
    out.get(base)!.set(form, text)
  }
  return out
}

const placeholders = (text: string): string[] => [...text.matchAll(/\{\{\s*(\w+)[^}]*\}\}/g)].map((m) => m[1]).sort()

const english = messages(en)
/** What npm run i18n:sync recorded (scripts/i18n-sync.mjs). */
const status = JSON.parse(readFileSync('src/renderer/i18n/translation-status.json', 'utf-8')) as {
  english: Record<string, string>
  pending: Record<string, Record<string, 'new' | { was: string }>>
}

describe('keeping translations in step with the English', () => {
  it('has recorded the current English (else run npm run i18n:sync)', () => {
    expect(status.english).toEqual(Object.fromEntries(flatten(en)))
  })
})

describe('the list of languages', () => {
  const ids = Object.keys(CATALOGUES).sort()

  it('offers every catalogue in the language picker (LANGUAGE_IDS)', () => {
    expect([...LANGUAGE_IDS].sort()).toEqual(ids)
  })

  it('names every language for the picker', () => {
    for (const id of ids) expect(flatten(en).has(`language.name.${id}`), `language.name.${id}`).toBe(true)
  })

  it('declares every language to macOS (Info.plist CFBundleLocalizations)', () => {
    const plist = readFileSync('src-tauri/Info.plist', 'utf-8')
    const block = plist.match(/<key>CFBundleLocalizations<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? ''
    expect([...block.matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1]).sort()).toEqual(ids)
  })
})

describe('translation catalogues', () => {
  for (const [language, tree] of Object.entries(CATALOGUES)) {
    const translated = messages(tree)
    const forms = new Intl.PluralRules(language).resolvedOptions().pluralCategories

    it(`${language} has the English keys, apart from those waiting for a translator`, () => {
      const extra = [...translated.keys()].filter((k) => !english.has(k))
      expect(extra, 'not in English (npm run i18n:sync removes them)').toEqual([])
      const waiting = status.pending[language] ?? {}
      const missing = [...english.keys()].filter((k) => !translated.has(k) && waiting[k] !== 'new')
      expect(missing, 'missing and not marked new (run npm run i18n:sync)').toEqual([])
    })

    it(`${language} has every plural form it needs, and no empty strings`, () => {
      for (const [key, versions] of translated) {
        for (const [form, text] of versions) expect(text.trim(), `${language} ${key}${form && '_' + form}`).not.toBe('')
        const isPlural = !english.get(key)?.has('')
        if (isPlural) expect([...versions.keys()].sort(), `${language} ${key}`).toEqual([...forms].sort())
      }
    })

    it(`${language} keeps the English placeholders`, () => {
      for (const [key, versions] of translated) {
        const source = english.get(key)
        if (!source) continue
        const expected = placeholders(source.get('') ?? source.get('other') ?? '')
        for (const [form, text] of versions) {
          // The zero, one and two forms may say the number in words
          // rather than {{count}} (Arabic "رمزان", two codes).
          const inWords = (p: string): boolean => ['zero', 'one', 'two'].includes(form) && p === 'count'
          const got = placeholders(text).filter((p) => !inWords(p))
          const want = expected.filter((p) => !inWords(p))
          expect(got, `${language} ${key}${form && '_' + form}`).toEqual(want)
        }
      }
    })
  }
})

/** Every file under `dir` with one of the extensions. */
function filesUnder(dir: string, exts: string[]): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return filesUnder(path, exts)
    return exts.some((e) => name.endsWith(e)) ? [path] : []
  })
}

describe('keys the app uses', () => {
  const keys = new Set(english.keys())

  it('exist for the backend (native.*)', () => {
    const used = new Set<string>()
    for (const file of filesUnder('src-tauri/src', ['.rs'])) {
      for (const m of readFileSync(file, 'utf-8').matchAll(/"((?:menu|dialog|import|window|update|print)\.[A-Za-z]+)"/g)) {
        if (!/\.(html|json|js)$/.test(m[1])) used.add(m[1]) // not file names such as "update.html"
      }
    }
    expect(used.size).toBeGreaterThan(0)
    for (const key of used) expect(keys.has(`native.${key}`), `native.${key}`).toBe(true)
  })

  it('match the English of the core\'s messages (native.core.*)', () => {
    // tr("key", "English", ...) and tr_count("key", "one", "other", ...);
    // the English at the call site is what shows without a translator.
    const unescape = (s: string): string => s.replace(/\\(.)/g, '$1')
    let found = 0
    for (const file of filesUnder('crates/magnolia-core/src', ['.rs'])) {
      if (file.endsWith('message.rs')) continue // its own tests use made-up keys
      const text = readFileSync(file, 'utf-8')
      for (const m of text.matchAll(/\btr\(\s*"([\w.]+)",\s*"((?:[^"\\]|\\.)*)"/g)) {
        found++
        expect(english.get(`native.core.${m[1]}`)?.get(''), `${m[1]} (${file})`).toBe(unescape(m[2]))
      }
      for (const m of text.matchAll(/\btr_count\(\s*"([\w.]+)",\s*"((?:[^"\\]|\\.)*)",\s*"((?:[^"\\]|\\.)*)"/g)) {
        found++
        expect(english.get(`native.core.${m[1]}`)?.get('one'), `${m[1]}_one (${file})`).toBe(unescape(m[2]))
        expect(english.get(`native.core.${m[1]}`)?.get('other'), `${m[1]}_other (${file})`).toBe(unescape(m[3]))
      }
    }
    expect(found).toBeGreaterThan(20)
  })

  it('exist for the renderer', () => {
    for (const file of filesUnder('src/renderer', ['.ts', '.tsx', '.html'])) {
      // t('key'), t("key"), i18nKey="key" and data-i18n="key"; keys built
      // at runtime are skipped.
      for (const m of readFileSync(file, 'utf-8').matchAll(/(?:\bt\(\s*|i18nKey=|data-i18n=)['"]([\w.-]+)['"]/g)) {
        expect(keys.has(m[1]), `${m[1]} (${file})`).toBe(true)
      }
    }
  })
})

describe('choosing the language', () => {
  it('uses the chosen language', () => {
    expect(resolveLanguage('nl', ['es-ES'])).toBe('nl')
  })

  it("follows the computer's first language Magnolia has", () => {
    expect(resolveLanguage('system', ['ja-JP', 'es-MX', 'en-GB'])).toBe('es')
    expect(resolveLanguage('system', ['nl-BE'])).toBe('nl')
    expect(resolveLanguage('system', ['en-AU', 'es-ES'])).toBe('en')
  })

  it('gives Norwegian and Nynorsk the Bokmål catalogue', () => {
    expect(resolveLanguage('system', ['nb-NO'])).toBe('nb')
    expect(resolveLanguage('system', ['no'])).toBe('nb')
    expect(resolveLanguage('system', ['nn-NO'])).toBe('nb')
  })

  it("matches the computer's variety of a language, else another variety", () => {
    expect(resolveLanguage('system', ['pt-PT'])).toBe('pt-PT')
    expect(resolveLanguage('system', ['pt_BR'])).toBe('pt-BR')
    expect(resolveLanguage('system', ['pt'])).toBe('pt-BR')
    expect(resolveLanguage('system', ['zh-CN'])).toBe('zh-Hans')
    expect(resolveLanguage('system', ['zh-Hans-CN'])).toBe('zh-Hans')
  })

  it('falls back to English', () => {
    expect(resolveLanguage('system', ['ja-JP', 'ko'])).toBe('en')
    expect(resolveLanguage('system', [])).toBe('en')
  })

  it('reads an unknown saved preference as "system"', () => {
    expect(normaliseLanguagePreference('ja')).toBe('system')
    expect(normaliseLanguagePreference(undefined)).toBe('system')
    expect(normaliseLanguagePreference('pt-BR')).toBe('pt-BR')
  })
})
