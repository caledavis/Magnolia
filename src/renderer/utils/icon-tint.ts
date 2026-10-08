import { useCallback, type CSSProperties } from 'react'
import { usePreferencesStore } from '../stores/preferences-store'

/** Icon kinds that carry a colour in the Colourful interface palette —
 *  one --icon-<kind> token each in global.css. */
export type IconTintKind =
  | 'folder'
  | 'text'
  | 'pdf'
  | 'audio'
  | 'video'
  | 'image'
  | 'survey'
  | 'respondent'
  | 'question'

/** Palette entry for a source's resolved type (sourceType, or the type
 *  sniffed from its filename). Anything unrecognised reads as text. */
export function iconTintKindForSourceType(sourceType: string): IconTintKind {
  if (
    sourceType === 'pdf' ||
    sourceType === 'audio' ||
    sourceType === 'video' ||
    sourceType === 'image' ||
    sourceType === 'survey'
  ) {
    return sourceType
  }
  return 'text'
}

/** True when the Colourful interface preference is on and the current
 *  theme takes it. Granola (light and dark) and High Contrast never do. */
export function useColourfulActive(): boolean {
  return usePreferencesStore((s) => s.colourfulInterface && themeTakesColour(s.theme))
}

export function themeTakesColour(theme: string): boolean {
  return theme !== 'high-contrast' && theme !== 'granola' && theme !== 'granola-dark'
}

/**
 * Returns a function giving the style overrides that colour an icon when
 * Preferences → Appearance → "Colourful interface" is on. Spread it after
 * the icon's usual style: with the preference off (or on Granola / High
 * Contrast) it returns {}, so the muted default stands untouched.
 */
export function useIconTint(): (kind: IconTintKind) => CSSProperties {
  const colourful = useColourfulActive()
  return useCallback(
    (kind: IconTintKind) => (colourful ? { color: `var(--icon-${kind})`, opacity: 1 } : {}),
    [colourful]
  )
}
