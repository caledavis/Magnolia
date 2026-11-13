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
import ar from '../locales/ar.json'
import fr from '../locales/fr.json'
import ru from '../locales/ru.json'
import zhHans from '../locales/zh-Hans.json'
import it from '../locales/it.json'
import hi from '../locales/hi.json'
import ptPT from '../locales/pt-PT.json'
import de from '../locales/de.json'
import fi from '../locales/fi.json'
import sv from '../locales/sv.json'
import nb from '../locales/nb.json'
import da from '../locales/da.json'
import tr from '../locales/tr.json'
import ca from '../locales/ca.json'
import cs from '../locales/cs.json'

/** Every catalogue, by language id. Adding a language: see "Adding a
 *  language" in locales/GLOSSARY.md (the tests name anything missed). */
const CATALOGUES = { en, es, nl, 'pt-BR': ptBR, ar, fr, ru, 'zh-Hans': zhHans, it, hi, 'pt-PT': ptPT, de, fi, sv, nb, da, tr, ca, cs }

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
  // Norwegian ("no") and Nynorsk ("nn") read the Bokmål catalogue.
  const baseOf = (tag: string): string => {
    const base = tag.toLowerCase().split(/[-_]/)[0]
    return base === 'no' || base === 'nn' ? 'nb' : base
  }
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
/** The digits numbers and dates are written in, when not the language's
 *  usual ones (a CLDR numbering system, such as "latn" or "arab"). */
let numbering: string | null = null

/** The computer's region ("AU" in en_AU), set at start-up. */
let region: string | null = null

/** The region a system locale names ("en_AU", "ar-EG@numbers=latn",
 *  "zh_Hans_CN"), if any. */
export function systemRegion(systemLocale: string): string | null {
  return systemLocale.match(/^[a-z]{2,3}(?:[_-][A-Za-z]{4})?[_-]([A-Z]{2}|\d{3})/)?.[1] ?? null
}

/** The locale numbers and dates are formatted in: the interface language
 *  in the computer's region (English in Australia writes "2 Sept 2026",
 *  not "Sep 2, 2026"), with the chosen digits as a Unicode extension. */
export function resolveFormatLocale(language: string, inRegion: string | null, nu: string | null): string {
  let base = language
  if (inRegion) {
    try { base = new Intl.Locale(language, { region: inRegion }).toString() } catch { /* an odd region: the language alone */ }
  }
  return nu ? `${base}-u-nu-${nu}` : base
}

export const formatLocale = (): string => resolveFormatLocale(currentLanguage(), region, numbering)

export const formatDateTime = (d: Date | string | number, options?: Intl.DateTimeFormatOptions): string =>
  new Date(d).toLocaleString(formatLocale(), options)
export const formatDate = (d: Date | string | number, options?: Intl.DateTimeFormatOptions): string =>
  new Date(d).toLocaleDateString(formatLocale(), options)
export const formatNumber = (n: number, options?: Intl.NumberFormatOptions): string =>
  n.toLocaleString(formatLocale(), options)

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
  const locale = lng && isLanguageId(lng) && lng !== currentLanguage() ? lng : formatLocale()
  return value.toLocaleString(locale, { maximumFractionDigits: 2 })
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

// ── Digits ─────────────────────────────────────────────────────────
// Some languages are written with more than one set of digits (Arabic
// with Arabic-Indic or Western ones). The Digits preference is "system"
// (the computer's region decides) or a CLDR numbering system id.

export type DigitsPreference = string

const defaultNumbering = (locale: string): string => new Intl.NumberFormat(locale).resolvedOptions().numberingSystem

/** The digit sets `language` can be written in, its plain default first:
 *  that, its most likely region's (CLDR's likely subtags: Arabic → Egypt,
 *  which writes Arabic-Indic digits, though plain Arabic is Western) and
 *  Western ones. One entry means there's nothing to choose. */
export function digitChoices(language: string): string[] {
  const loc = new Intl.Locale(language) as Intl.Locale & { getNumberingSystems?: () => string[]; numberingSystems?: string[] }
  const listed = loc.getNumberingSystems?.() ?? loc.numberingSystems ?? []
  // Language and region only: a script subtag ("ar-Arab-EG") loses the
  // region's digits.
  const likely = loc.maximize()
  const regional = likely.region ? defaultNumbering(`${likely.language}-${likely.region}`) : defaultNumbering(language)
  return [...new Set([defaultNumbering(language), regional, ...listed, 'latn'])]
}

/** The digits for `language` under a Digits preference, or null where the
 *  language has no choice. "system" follows the computer's region
 *  (`systemLocale`, as macOS gives it: "ar_EG" or "ar_EG@numbers=latn"),
 *  so Egypt gets Arabic-Indic digits and Morocco Western ones. */
export function resolveNumbering(language: string, pref: DigitsPreference, systemLocale: string): string | null {
  const choices = digitChoices(language)
  if (choices.length < 2) return null
  let nu: string | undefined
  if (pref !== 'system' && choices.includes(pref)) nu = pref
  else {
    const override = systemLocale.match(/@.*\bnumbers=(\w+)/)?.[1]
    const region = systemLocale.match(/^[a-z]{2,3}(?:[_-][A-Za-z]{4})?[_-]([A-Z]{2}|\d{3})/)?.[1]
    if (override && choices.includes(override)) nu = override
    else if (region) {
      try { nu = defaultNumbering(`${language}-${region}`) } catch { /* unknown region */ }
    }
  }
  // Always explicit: formatting also takes the region, whose own default
  // could differ from the choice (Arabic in Egypt with Western digits).
  return nu ?? choices[0]
}

/** The interface locale as one tag: the language, with the digits as a
 *  Unicode extension. It's what windows pass each other and the backend. */
const localeTag = (language: LanguageId, nu: string | null): string => (nu ? `${language}-u-nu-${nu}` : language)

let digitsPref: DigitsPreference = 'system'
let systemLocale = ''

/** 1,234.5 as the interface language writes it in digits `nu` (null:
 *  the computer's choice), for the Digits menu in Preferences. */
export function digitsSample(nu: string | null): string {
  const language = currentLanguage()
  const resolved = nu ?? resolveNumbering(language, 'system', systemLocale)
  return new Intl.NumberFormat(resolved ? `${language}-u-nu-${resolved}` : language).format(1234.5)
}

function apply(tag: string): void {
  let language: string = tag
  let nu: string | null = null
  try {
    const loc = new Intl.Locale(tag)
    language = loc.baseName
    nu = loc.numberingSystem ?? null
  } catch { /* a plain id */ }
  if (!isLanguageId(language)) return
  numbering = nu
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
    const prefs = (await window.api.loadPreferences()) as { language?: unknown; digits?: unknown } | null
    pref = normaliseLanguagePreference(prefs?.language)
    if (typeof prefs?.digits === 'string') digitsPref = prefs.digits
  } catch { /* defaults */ }
  try { systemLocale = await window.api.systemLocale() } catch { /* none */ }
  if (!systemLocale) systemLocale = systemLanguages()[0] ?? ''
  region = systemRegion(systemLocale)
  languagePref = pref
  const tag = currentTag()
  apply(tag)
  window.api.onLanguageChanged((t) => apply(t))
  // The backend builds the menus and dialogs, and learns from the first
  // window to start what "system" means here (it ignores repeats).
  window.api.setNativeLanguage(tagLanguage(tag), pref, formatLocale())
}

let languagePref: LanguagePreference = 'system'

/** The tag for the current preferences. */
function currentTag(): string {
  const language = resolveLanguage(languagePref, systemLanguages())
  return localeTag(language, resolveNumbering(language, digitsPref, systemLocale))
}
const tagLanguage = (tag: string): string => tag.split('-u-')[0]

/** Put every window and the backend in step with the preferences. */
function broadcast(): void {
  const tag = currentTag()
  apply(tag)
  window.api.broadcastLanguage(tag)
  window.api.setNativeLanguage(tagLanguage(tag), languagePref, formatLocale())
}

/** Switch every window to a newly chosen preference (from Preferences). */
export function setLanguagePreference(pref: LanguagePreference): void {
  languagePref = pref
  broadcast()
}

/** Switch every window to newly chosen digits (from Preferences). */
export function setDigitsPreference(pref: DigitsPreference): void {
  digitsPref = pref
  broadcast()
}
