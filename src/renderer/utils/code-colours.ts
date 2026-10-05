import { usePreferencesStore } from '../stores/preferences-store'

/** The preset colours offered for codes (colour pickers, the colour a new
 *  code starts with, speaker codes). Order matters: new codes walk the list,
 *  so neighbours are kept far apart in hue. */
export const CLASSIC_CODE_COLOURS: readonly string[] = [
  '#e05050', '#e08050', '#e0c050', '#50c050', '#5080e0',
  '#8050e0', '#e050a0', '#50c0c0', '#c07030', '#7070e0',
  '#a0a040', '#40a0a0', '#a040a0', '#e07070', '#70b070'
]

/** Presets used with the Colourful interface: drawn from the same family as
 *  its toolbar and --icon-* colours, so coded text sits comfortably next to
 *  the coloured icons and buttons. */
export const COLOURFUL_CODE_COLOURS: readonly string[] = [
  '#3b82f6', // blue
  '#e8833a', // orange
  '#2fa36b', // green
  '#8b5cf6', // violet
  '#d94a4a', // red
  '#2eb8d6', // cyan
  '#e0457b', // pink
  '#d9a13b', // amber
  '#5468d4', // indigo
  '#0e93a8', // teal
  '#c8336c', // raspberry
  '#6ba539', // leaf
  '#b06ae0', // orchid
  '#b07d4f', // tan
  '#64748b'  // slate
]

export function codeColourPresets(colourful: boolean): readonly string[] {
  return colourful ? COLOURFUL_CODE_COLOURS : CLASSIC_CODE_COLOURS
}

/** The code colour presets for the current Colourful interface setting. */
export function useCodeColourPresets(): readonly string[] {
  return codeColourPresets(usePreferencesStore((s) => s.colourfulInterface))
}

/** The preset after `lastColour`, so consecutive new codes get distinct
 *  colours. Starts the list over when `lastColour` isn't a preset. */
export function nextCodeColour(presets: readonly string[], lastColour: string | undefined): string {
  const idx = lastColour ? presets.indexOf(lastColour.toLowerCase()) : -1
  return presets[(idx + 1) % presets.length]
}
