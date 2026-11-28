/**
 * measure-text — synchronous canvas-based width measurement for UI
 * labels. Used to pack margin-column icons as close to code-name labels
 * as possible without a two-pass render.
 *
 * Accuracy: within a pixel or two of real layout — good enough for
 * deciding where an 18-px icon sits. Re-uses a single canvas context
 * across calls so it's cheap to call in a loop.
 */

let cachedCtx: CanvasRenderingContext2D | null = null

function getCtx(): CanvasRenderingContext2D | null {
  if (cachedCtx) return cachedCtx
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  cachedCtx = canvas.getContext('2d')
  return cachedCtx
}

/**
 * Measure the rendered width of `text` at the given CSS `font` shorthand.
 * Falls back to a rough character-width estimate if canvas is unavailable
 * (e.g. during SSR, which Magnolia doesn't do today but protects the
 * util against future callers).
 */
export function measureTextWidth(text: string, font: string): number {
  const ctx = getCtx()
  if (!ctx) return text.length * 6
  ctx.font = font
  return ctx.measureText(text).width
}

/** Pre-built font string matching the bracket label CSS. */
export const BRACKET_LABEL_FONT =
  '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, Oxygen, Ubuntu, Cantarell, sans-serif'

/** Convenience: measure a bracket-label's rendered width. */
export function measureLabelWidth(codeName: string): number {
  return measureTextWidth(codeName, BRACKET_LABEL_FONT)
}
