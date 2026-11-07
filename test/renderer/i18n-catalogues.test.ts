/**
 * The translation catalogues (src/renderer/locales) stay complete and
 * consistent: every English string exists in each language with the same
 * placeholders, plurals have every form the language needs, and every key
 * the app asks for exists.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import en from '../../src/renderer/locales/en.json'
import es from '../../src/renderer/locales/es.json'
import nl from '../../src/renderer/locales/nl.json'
import ptBR from '../../src/renderer/locales/pt-BR.json'
import { resolveLanguage, normaliseLanguagePreference } from '../../src/renderer/i18n'

type Tree = { [key: string]: string | Tree }
const CATALOGUES: Record<string, Tree> = { en, es, nl, 'pt-BR': ptBR }
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

describe('translation catalogues', () => {
  for (const [language, tree] of Object.entries(CATALOGUES)) {
    const translated = messages(tree)
    const forms = new Intl.PluralRules(language).resolvedOptions().pluralCategories

    it(`${language} has exactly the English keys`, () => {
      expect([...translated.keys()].sort()).toEqual([...english.keys()].sort())
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
          // A singular form may say "one" in words rather than {{count}}.
          const got = placeholders(text).filter((p) => !(form === 'one' && p === 'count'))
          const want = expected.filter((p) => !(form === 'one' && p === 'count'))
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
    expect(resolveLanguage('system', ['fr-FR', 'es-MX', 'en-GB'])).toBe('es')
    expect(resolveLanguage('system', ['nl-BE'])).toBe('nl')
    expect(resolveLanguage('system', ['en-AU', 'es-ES'])).toBe('en')
  })

  it('gives any Portuguese Brazilian Portuguese', () => {
    expect(resolveLanguage('system', ['pt-PT'])).toBe('pt-BR')
    expect(resolveLanguage('system', ['pt_BR'])).toBe('pt-BR')
  })

  it('falls back to English', () => {
    expect(resolveLanguage('system', ['fr-FR', 'de'])).toBe('en')
    expect(resolveLanguage('system', [])).toBe('en')
  })

  it('reads an unknown saved preference as "system"', () => {
    expect(normaliseLanguagePreference('fr')).toBe('system')
    expect(normaliseLanguagePreference(undefined)).toBe('system')
    expect(normaliseLanguagePreference('pt-BR')).toBe('pt-BR')
  })
})
