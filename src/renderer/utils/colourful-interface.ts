/**
 * Whether the Colourful interface (dark slate toolbar with colour-coded
 * tool icons) is offered at all.
 *
 * Switched off for now: the Preferences → Appearance → Colour checkbox is
 * hidden and any saved `colourfulInterface` value is ignored, so it reads
 * as off everywhere. The preference and the [data-colourful] rules in
 * global.css are kept — set this to true to bring the option back. Pane
 * icon colours and code colour presets don't depend on it.
 */
export const COLOURFUL_INTERFACE_ENABLED = false

/** The effective Colourful interface setting for a saved preference value
 *  (on unless explicitly turned off, and only when the feature is enabled). */
export function colourfulInterfaceFromSaved(saved: unknown): boolean {
  return COLOURFUL_INTERFACE_ENABLED && saved !== false
}
