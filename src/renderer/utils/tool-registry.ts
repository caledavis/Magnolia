/**
 * Centralized registry of all analysis/query tools.
 * Icons, colors, and labels defined in one place.
 */
import {
  faMagnifyingGlass,
  faFileCodeCorner,
  faFrame,
  faFileSearchCorner,
  faSquaresIntersect,
  faChartColumn,
  faBarsStaggered,
  faFont,
  faWholeWord,
  faCircleNodes,
  faNotebookTabs
} from '../components/Icon'
import type { IconComponent } from '../components/Icon'
import { t } from '../i18n'

/** A tool whose label and description are read from the catalogues
 *  (tools.<key>.label / .description) each time, in the current language. */
function tool(key: string, icon: IconComponent, color: string): ToolDef {
  return {
    icon,
    color,
    get label() { return t(`tools.${key}.label`) },
    get description() { return t(`tools.${key}.description`) }
  }
}

export interface ToolDef {
  icon: IconComponent
  label: string
  color: string
  /** One-line summary shown in the toolbar Analysis popover's tile
   *  grid. Optional so existing call sites that only need icon/label/
   *  color don't have to provide one. */
  description?: string
}

/**
 * Tools spread across the warm→cool hue wheel; Framework Matrix takes the
 * otherwise-unused rose hue.
 * Order matches the toolbar layout (left to right).
 *
 * Labels are full names ("Code Frequencies", not "Code Freq."), in the
 * catalogues under tools.<key>.
 */
export const TOOL_REGISTRY: Record<string, ToolDef> = {
  queryBuilder:            tool('queryBuilder',       faMagnifyingGlass,  '#D06828'), // burnt orange
  'codes-in-documents':    tool('codesInDocuments',   faFileCodeCorner,   '#C0A010'), // golden
  'framework-matrix':      tool('frameworkMatrix',    faFrame,            '#C8407A'), // rose
  'results-in-documents':  tool('resultsInDocuments', faFileSearchCorner, '#78B020'), // yellow-green
  'code-cooccurrences':    tool('codeCooccurrences',  faSquaresIntersect, '#20A848'), // green
  'code-frequencies':      tool('codeFrequencies',    faChartColumn,      '#10A0A0'), // teal
  'code-orders':           tool('codeOrders',         faBarsStaggered,    '#2080D8'), // blue
  'word-frequencies':      tool('wordFrequencies',    faFont,             '#6848E0'), // indigo
  'word-combinations':     tool('wordCombinations',   faWholeWord,        '#C83C3C'), // crimson
  'relationship-map':      tool('relationshipMap',    faCircleNodes,      '#A830D0'), // violet
  'reports':               tool('reports',            faNotebookTabs,     '#607080'), // slate
}

/** Backward-compatible color map (used by many components) */
export const toolColors: Record<string, string> = Object.fromEntries(
  Object.entries(TOOL_REGISTRY).map(([key, def]) => [key, def.color])
)

export type ToolColorKey = keyof typeof TOOL_REGISTRY
