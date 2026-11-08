/**
 * Magnolia's interface languages, through i18next. Each catalogue
 * (src/renderer/locales/<language>.json) is bundled, so switching language
 * needs no loading; English is the source and the fallback for anything a
 * catalogue lacks. See locales/GLOSSARY.md for the terms each language
 * uses.
 *
 * Components translate with react-i18next's useTranslation(), which
 * re-renders them when the language changes; code outside React uses the
 * `t` exported here.
 *
 * The language is a preference: a language id, or "system" (the default),
 * which follows the computer's language when Magnolia has it and is
 * English otherwise. Every window reads it at start-up (initLanguage, run
 * by each entry point before it renders, so the first frame is already in
 * the right language), and a change in Preferences is broadcast to the
 * others and reported to the backend for its menus and dialogs.
 */
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '../locales/en.json'
import es from '../locales/es.json'
import nl from '../locales/nl.json'
import ptBR from '../locales/pt-BR.json'

/** Every catalogue, by language id. Adding a language: see "Adding a
 *  language" in locales/GLOSSARY.md (the tests name anything missed). */
const CATALOGUES = { en, es, nl, 'pt-BR': ptBR }

export type LanguageId = keyof typeof CATALOGUES
export const LANGUAGE_IDS = Object.keys(CATALOGUES) as readonly LanguageId[]
export type LanguagePreference = 'system' | LanguageId

const isLanguageId = (v: unknown): v is LanguageId => (LANGUAGE_IDS as readonly unknown[]).includes(v)

/** A saved preference, or "system" for anything else (unset, unknown). */
export function normaliseLanguagePreference(v: unknown): LanguagePreference {
  return isLanguageId(v) ? v : 'system'
}

/** The language for a preference: the one chosen, or for "system" the first
 *  of the computer's languages Magnolia has, else English. A system
 *  language matches its own catalogue ("pt-BR"), else one in the same base
 *  language ("pt-PT" and "pt" get "pt-BR"; "es-MX" gets "es"). */
export function resolveLanguage(pref: LanguagePreference, systemLanguages: readonly string[]): LanguageId {
  if (pref !== 'system') return pref
  const baseOf = (tag: string): string => tag.toLowerCase().split(/[-_]/)[0]
  for (const tag of systemLanguages) {
    const exact = LANGUAGE_IDS.find((id) => id.toLowerCase() === tag.toLowerCase().replace('_', '-'))
    if (exact) return exact
    const sameBase = LANGUAGE_IDS.find((id) => baseOf(id) === baseOf(tag))
    if (sameBase) return sameBase
  }
  return 'en'
}

// Every value put into a message passes through this formatter (see
// formatInterpolated below); no message names a format of its own.
const numberFormatter = {
  type: 'formatter' as const,
  init: (): void => {},
  add: (): void => {},
  addCached: (): void => {},
  format: (value: unknown, format?: string, lng?: string, options?: { interpolationkey?: string }) =>
    formatInterpolated(value, format, lng, options) as string
}

void i18n.use(initReactI18next).use(numberFormatter).init({
  resources: Object.fromEntries(Object.entries(CATALOGUES).map(([id, translation]) => [id, { translation }])),
  lng: 'en',
  fallbackLng: 'en',
  // React escapes what it renders; the catalogues hold plain text.
  interpolation: { escapeValue: false, alwaysFormat: true },
  // Resources are bundled, so init and changeLanguage finish synchronously.
  initAsync: false
})

export const t = i18n.t.bind(i18n)
export { i18n }

/** The language the interface is in now. */
export const currentLanguage = (): LanguageId => (isLanguageId(i18n.language) ? i18n.language : 'en')

/** A date and time, a date, or a number, as the interface language writes
 *  them. */
export const formatDateTime = (d: Date | string | number, options?: Intl.DateTimeFormatOptions): string =>
  new Date(d).toLocaleString(currentLanguage(), options)
export const formatDate = (d: Date | string | number, options?: Intl.DateTimeFormatOptions): string =>
  new Date(d).toLocaleDateString(currentLanguage(), options)
export const formatNumber = (n: number, options?: Intl.NumberFormatOptions): string =>
  n.toLocaleString(currentLanguage(), options)

/** A number with exactly `digits` decimal places ("12.5", "12,5"). */
export const formatFixed = (n: number, digits: number): string =>
  formatNumber(n, { minimumFractionDigits: digits, maximumFractionDigits: digits })

/** A percentage given out of 100, with `digits` decimal places, as the
 *  language writes it ("12.5%", "12,5 %"). */
export const formatPercent = (percent: number, digits = 1): string =>
  formatNumber(percent / 100, { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits })

/** Compare two pieces of text in the interface language's alphabetical
 *  order (for sorting names shown to people). */
export function compareText(a: string, b: string): number {
  const language = currentLanguage()
  if (collatorLanguage !== language) {
    collator = new Intl.Collator(language, { numeric: true })
    collatorLanguage = language
  }
  return collator.compare(a, b)
}
let collator = new Intl.Collator('en', { numeric: true })
let collatorLanguage = 'en'

/** Numbers put into messages are written as the message's language writes
 *  them (so 1234 reads "1,234" or "1.234"); text is left alone. A
 *  respondent's id is a label, not a quantity. */
function formatInterpolated(value: unknown, _format: string | undefined, lng: string | undefined, options?: { interpolationkey?: string }): unknown {
  if (typeof value !== 'number' || options?.interpolationkey === 'id') return value
  return value.toLocaleString(lng && isLanguageId(lng) ? lng : currentLanguage(), { maximumFractionDigits: 2 })
}

const systemLanguages = (): readonly string[] =>
  typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : []

/** Whether a language is written right to left, by its usual script
 *  (from CLDR's likely subtags: "ar" → Arab), so a new right-to-left
 *  language needs no list here. */
export function isRtlLanguage(language: string): boolean {
  try {
    const script = new Intl.Locale(language).maximize().script
    return !!script && RTL_SCRIPTS.has(script)
  } catch {
    return false
  }
}
const RTL_SCRIPTS = new Set(['Arab', 'Hebr', 'Syrc', 'Thaa', 'Nkoo', 'Adlm', 'Rohg', 'Mand', 'Samr'])

function apply(language: LanguageId): void {
  void i18n.changeLanguage(language)
  document.documentElement.lang = language
  // The whole interface mirrors for a right-to-left language (the
  // stylesheets use start/end, not left/right, wherever that matters).
  document.documentElement.dir = isRtlLanguage(language) ? 'rtl' : 'ltr'
  // A window whose page names its title by key (a data-i18n attribute on <title>)
  // takes it in this language. The main window's title is the project's.
  const key = document.querySelector('title')?.dataset.i18n
  if (key) document.title = i18n.t(key)
}

/** Put this window in the saved language and keep it in step with the
 *  other windows. Each entry point awaits this before rendering. */
export async function initLanguage(): Promise<void> {
  let pref: LanguagePreference = 'system'
  try {
    const prefs = await window.api.loadPreferences()
    pref = normaliseLanguagePreference((prefs as { language?: unknown } | null)?.language)
  } catch { /* defaults */ }
  const language = resolveLanguage(pref, systemLanguages())
  apply(language)
  window.api.onLanguageChanged((id) => { if (isLanguageId(id)) apply(id) })
  // The backend builds the menus and dialogs, and learns from the first
  // window to start what "system" means here (it ignores repeats).
  window.api.setNativeLanguage(language, pref)
}

/** Switch every window to a newly chosen preference (from Preferences). */
export function setLanguagePreference(pref: LanguagePreference): void {
  const language = resolveLanguage(pref, systemLanguages())
  apply(language)
  window.api.broadcastLanguage(language)
  window.api.setNativeLanguage(language, pref)
}
