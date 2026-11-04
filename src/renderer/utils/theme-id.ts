/** The themes Magnolia offers. Magnolia is the new-install default
 *  (Magnolia Dark when the OS reports prefers-color-scheme: dark, per
 *  apply-theme.ts). */
export const THEME_IDS = ['magnolia', 'magnolia-dark', 'high-contrast'] as const

export type ThemeId = (typeof THEME_IDS)[number]

export const DEFAULT_THEME: ThemeId = 'magnolia'

/** Themes that have been removed: Clean (''), Clean Dark ('dark'),
 *  Granola and Granola Dark. A saved one opens in the Magnolia theme of
 *  the same lightness. */
const DARK_REMOVED_THEMES = new Set(['dark', 'granola-dark'])

/** A saved theme id, or the closest theme Magnolia still offers. */
export function normaliseThemeId(value: unknown): ThemeId {
  if ((THEME_IDS as readonly unknown[]).includes(value)) return value as ThemeId
  return DARK_REMOVED_THEMES.has(value as string) ? 'magnolia-dark' : DEFAULT_THEME
}
