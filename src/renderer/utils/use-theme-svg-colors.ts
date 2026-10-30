import { useEffect, useMemo, useState } from 'react'

/**
 * Resolve a fixed set of theme CSS variables into concrete colours.
 *
 * Why: chart components save themselves as standalone SVG via
 * `chartRef.current.outerHTML`. SVG presentation attributes accept
 * `var(...)` while the SVG lives inside the app document (browser
 * resolves it from the cascade), but a standalone .svg file has no
 * stylesheet, so attribute values like `stroke="var(--border-color)"`
 * fall back to defaults — usually invisible (no stroke) or wrong
 * (black instead of theme text colour). Vector editors like Affinity
 * Designer / Inkscape exhibit the same problem.
 *
 * Passing the resolved colour into the SVG attribute keeps the
 * in-app render unchanged (same final colour) while making the
 * exported file self-contained.
 *
 * The hook re-reads on `data-theme` changes so the chart restyles
 * live when the user switches themes.
 */
/**
 * Proportional UI font stack used in SVG charts and exports.
 *
 * Why not the global `--font-family` stack: that one starts with
 * `-apple-system` / `BlinkMacSystemFont`, which are CSS keywords
 * the browser maps to the OS UI font. SVG / vector editors take
 * font-family literally — they skip those keywords, skip Segoe UI
 * (Windows), Roboto, Oxygen, and land on Ubuntu (often the first
 * one actually installed on a Mac) which looks nothing like the
 * in-app font. This stack uses real installed font names so
 * Affinity / Inkscape render in something close to the system UI
 * font on every platform.
 */
export const SVG_FONT_FAMILY =
  "'Helvetica Neue', Helvetica, Arial, sans-serif"

interface ThemeSvgColors {
  textPrimary: string
  textSecondary: string
  textMuted: string
  borderColor: string
  bgTertiary: string
  accent: string
}

const FALLBACKS: ThemeSvgColors = {
  textPrimary: '#1a1a1a',
  textSecondary: '#525252',
  textMuted: '#888888',
  borderColor: '#d0d0d0',
  bgTertiary: '#f5f5f5',
  accent: '#007AFF'
}

export function useThemeSvgColors(): ThemeSvgColors {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const el = document.documentElement
    const obs = new MutationObserver(() => setTick((t) => t + 1))
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])
  return useMemo(() => {
    const cs = getComputedStyle(document.documentElement)
    const read = (name: string, fallback: string) =>
      cs.getPropertyValue(name).trim() || fallback
    return {
      textPrimary: read('--text-primary', FALLBACKS.textPrimary),
      textSecondary: read('--text-secondary', FALLBACKS.textSecondary),
      textMuted: read('--text-muted', FALLBACKS.textMuted),
      borderColor: read('--border-color', FALLBACKS.borderColor),
      bgTertiary: read('--bg-tertiary', FALLBACKS.bgTertiary),
      accent: read('--accent', FALLBACKS.accent)
    }
  }, [tick])
}
