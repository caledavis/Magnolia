import { usePreferencesStore } from '../stores/preferences-store'
import { themeTakesColour } from './icon-tint'

/** The preset colours offered for codes (colour pickers, the colour a new
 *  code starts with, speaker codes). Order matters: new codes walk the list,
 *  so neighbours are kept far apart in hue. */
export const CLASSIC_CODE_COLOURS: readonly string[] = [
  '#e05050', '#e08050', '#e0c050', '#50c050', '#5080e0',
  '#8050e0', '#e050a0', '#50c0c0', '#c07030', '#7070e0',
  '#a0a040', '#40a0a0', '#a040a0', '#e07070', '#70b070'
]

/** The standard presets, built around the icon palette (global.css,
 *  "Icon palette"): its coral (red) and blue lead, and its gold joins
 *  colours of the same weight, so coded text sits comfortably next to
 *  the icons. Lower-case, since nextCodeColour compares lower-case.
 *  (Originally made for the Colourful interface, hence the name.) */
export const COLOURFUL_CODE_COLOURS: readonly string[] = [
  '#e5674b', // coral, the palette's red (icon palette)
  '#3a78d8', // blue (icon palette)
  '#2a9d8f', // teal
  '#7b61d1', // violet
  '#eba62a', // gold (icon palette)
  '#5a9e4b', // green
  '#d6457a', // rose
  '#45a5d6', // sky
  '#e0873c', // orange
  '#a352b8', // plum
  '#5b6b85', // slate
  '#4c5bc4', // indigo
  '#b5543a', // brick
  '#b8952a', // ochre
  '#7aa35a'  // sage
]

export function codeColourPresets(colourful: boolean): readonly string[] {
  return colourful ? COLOURFUL_CODE_COLOURS : CLASSIC_CODE_COLOURS
}

/** Code colour presets for the given preferences: the Colourful set, or
 *  classic on the theme that doesn't take colour (High Contrast).
 *  Independent of the Colourful interface preference. */
export function codeColourPresetsFor(prefs: { theme: string }): readonly string[] {
  return codeColourPresets(themeTakesColour(prefs.theme))
}

/** The code colour presets for the current theme. */
export function useCodeColourPresets(): readonly string[] {
  return usePreferencesStore(codeColourPresetsFor)
}

/** The preset after `lastColour`, so consecutive new codes get distinct
 *  colours. Starts the list over when `lastColour` isn't a preset. */
export function nextCodeColour(presets: readonly string[], lastColour: string | undefined): string {
  const idx = lastColour ? presets.indexOf(lastColour.toLowerCase()) : -1
  return presets[(idx + 1) % presets.length]
}

/** How much of its colour a Visual-view box takes: a light tint at the
 *  smallest count, the full colour at the largest. */
function visualStrength(ratio: number): number {
  return Math.round(35 + 65 * Math.min(1, Math.max(0, ratio)))
}

/** A box in an analysis tool's Visual view: the icon palette's coral
 *  (the code presets' red), the same for every box, mixed with the empty
 *  box's grey by the count's share of the largest count. */
export function visualBoxColour(ratio: number): string {
  return `color-mix(in srgb, var(--rb-coral) ${visualStrength(ratio)}%, var(--bg-tertiary))`
}

/** visualBoxColour as a plain hex colour, for exported reports, mixed
 *  with their empty box's grey (#e9eef5). */
export function visualBoxHex(ratio: number): string {
  const from = [0xe5, 0x67, 0x4b] // coral, COLOURFUL_CODE_COLOURS[0]
  const to = [0xe9, 0xee, 0xf5]
  const t = visualStrength(ratio) / 100
  return '#' + from.map((c, i) => Math.round(c * t + to[i] * (1 - t)).toString(16).padStart(2, '0')).join('')
}
