import { useCallback, type CSSProperties } from 'react'
import { usePreferencesStore } from '../stores/preferences-store'

/** Icon kinds that carry a colour in the icon palette —
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

/** The class that puts an icon in the four-colour icon palette (see
 *  "Icon palette" in global.css), which colours each part of the glyph.
 *  Harmless on High Contrast, where the palette is off. */
export const PALETTE_ICON_CLASS = 'mg-icon'

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

/** True when the current theme takes coloured icons. They're always on,
 *  independent of the Colourful interface preference (which now governs
 *  only the toolbar) — except on High Contrast. */
export function useIconColourActive(): boolean {
  return usePreferencesStore((s) => themeTakesColour(s.theme))
}

export function themeTakesColour(theme: string): boolean {
  return theme !== 'high-contrast'
}

/**
 * Returns a function giving the style overrides for a palette icon (one
 * with PALETTE_ICON_CLASS) of the given kind: full strength, with the
 * kind's colour in --mg-kind for the parts of file, folder and media
 * glyphs that show it. Spread it after the icon's usual style: on
 * High Contrast it returns {}, so the muted default stands.
 */
export function useIconTint(): (kind: IconTintKind) => CSSProperties {
  const colourful = useIconColourActive()
  return useCallback(
    (kind: IconTintKind) => (colourful
      ? { opacity: 1, '--mg-kind': `var(--icon-${kind})` } as CSSProperties
      : {}),
    [colourful]
  )
}
