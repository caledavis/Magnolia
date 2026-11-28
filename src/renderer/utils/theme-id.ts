/** The themes Magnolia offers. Magnolia is the new-install default
 *  (Magnolia Dark when the OS reports prefers-color-scheme: dark, per
 *  apply-theme.ts). */
export const THEME_IDS = ['magnolia', 'magnolia-dark', 'high-contrast'] as const

export type ThemeId = (typeof THEME_IDS)[number]

export const DEFAULT_THEME: ThemeId = 'magnolia'

/** A saved theme id, or the closest theme Magnolia still offers: a theme
 *  since removed opens in the Magnolia theme of the same lightness, dark
 *  for one whose id ends in "dark" (as every removed dark theme's did). */
export function normaliseThemeId(value: unknown): ThemeId {
  if ((THEME_IDS as readonly unknown[]).includes(value)) return value as ThemeId
  return typeof value === 'string' && /(^|-)dark$/.test(value) ? 'magnolia-dark' : DEFAULT_THEME
}
