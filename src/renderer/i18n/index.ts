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

export const LANGUAGE_IDS = ['en', 'es', 'nl', 'pt-BR'] as const
export type LanguageId = (typeof LANGUAGE_IDS)[number]
export type LanguagePreference = 'system' | LanguageId

const isLanguageId = (v: unknown): v is LanguageId => (LANGUAGE_IDS as readonly unknown[]).includes(v)

/** A saved preference, or "system" for anything else (unset, unknown). */
export function normaliseLanguagePreference(v: unknown): LanguagePreference {
  return isLanguageId(v) ? v : 'system'
}

/** The language for a preference: the one chosen, or for "system" the first
 *  of the computer's languages Magnolia has (any Portuguese gets Brazilian
 *  Portuguese, the only one it has), else English. */
export function resolveLanguage(pref: LanguagePreference, systemLanguages: readonly string[]): LanguageId {
  if (pref !== 'system') return pref
  for (const tag of systemLanguages) {
    const base = tag.toLowerCase().split(/[-_]/)[0]
    if (base === 'pt') return 'pt-BR'
    if (isLanguageId(base)) return base
  }
  return 'en'
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    es: { translation: es },
    nl: { translation: nl },
    'pt-BR': { translation: ptBR }
  },
  lng: 'en',
  fallbackLng: 'en',
  // React escapes what it renders; the catalogues hold plain text.
  interpolation: { escapeValue: false },
  // Resources are bundled, so init and changeLanguage finish synchronously.
  initAsync: false
})

export const t = i18n.t.bind(i18n)
export { i18n }

/** The language the interface is in now. */
export const currentLanguage = (): LanguageId => (isLanguageId(i18n.language) ? i18n.language : 'en')

const systemLanguages = (): readonly string[] =>
  typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : []

function apply(language: LanguageId): void {
  void i18n.changeLanguage(language)
  document.documentElement.lang = language
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
