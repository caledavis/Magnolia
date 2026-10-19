import { useCallback, useEffect, type CSSProperties } from 'react'
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

const ICON_TINT_KINDS: IconTintKind[] = [
  'folder', 'text', 'pdf', 'audio', 'video', 'image', 'survey', 'respondent', 'question'
]

const GRADIENT_DEFS_ID = 'magnolia-icon-gradients'

/** One linearGradient per kind, from --icon-<kind>-2 (top left) into
 *  --icon-<kind> (bottom right), at the theme's --icon-fill-from / -to
 *  opacities, in the 24×24 icon space so a glyph's parts share one
 *  sweep. Injected once per document (popped-out
 *  windows are separate documents), into a hidden <svg> the tinted
 *  icons' url(#…) fills point at. Stops read the CSS tokens, so a theme
 *  change recolours them with no re-render. */
function ensureIconGradients(doc: Document): void {
  if (doc.getElementById(GRADIENT_DEFS_ID)) return
  const NS = 'http://www.w3.org/2000/svg'
  const svg = doc.createElementNS(NS, 'svg')
  svg.id = GRADIENT_DEFS_ID
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden')
  const defs = doc.createElementNS(NS, 'defs')
  for (const kind of ICON_TINT_KINDS) {
    const grad = doc.createElementNS(NS, 'linearGradient')
    grad.id = `magnolia-icon-fill-${kind}`
    grad.setAttribute('gradientUnits', 'userSpaceOnUse')
    grad.setAttribute('x1', '2')
    grad.setAttribute('y1', '2')
    grad.setAttribute('x2', '22')
    grad.setAttribute('y2', '22')
    for (const [offset, token, opacity] of [['0', `--icon-${kind}-2`, '--icon-fill-from'], ['1', `--icon-${kind}`, '--icon-fill-to']] as const) {
      const stop = doc.createElementNS(NS, 'stop')
      stop.setAttribute('offset', offset)
      stop.setAttribute('style', `stop-color:var(${token});stop-opacity:var(${opacity})`)
      grad.appendChild(stop)
    }
    defs.appendChild(grad)
  }
  svg.appendChild(defs)
  doc.body.appendChild(svg)
}

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
 *  only the toolbar) — except on Granola and High Contrast. */
export function useIconColourActive(): boolean {
  return usePreferencesStore((s) => themeTakesColour(s.theme))
}

export function themeTakesColour(theme: string): boolean {
  return theme !== 'high-contrast' && theme !== 'granola' && theme !== 'granola-dark'
}

/**
 * Returns a function giving the style overrides that colour an icon:
 * the palette colour for the outline plus a two-colour gradient fill
 * (glyphs whose details shouldn't fill opt out in icons/lucide.ts).
 * Spread it after the icon's usual style: on Granola / High Contrast it
 * returns {}, so the muted default stands untouched.
 */
export function useIconTint(): (kind: IconTintKind) => CSSProperties {
  const colourful = useIconColourActive()
  useEffect(() => {
    if (colourful) ensureIconGradients(document)
  }, [colourful])
  return useCallback(
    (kind: IconTintKind) => (colourful
      // fillOpacity resets global.css's flat .lucide-folder fill (22%),
      // which would otherwise wash out the folder's gradient.
      ? { color: `var(--icon-${kind})`, opacity: 1, fill: `url(#magnolia-icon-fill-${kind})`, fillOpacity: 1 }
      : {}),
    [colourful]
  )
}
