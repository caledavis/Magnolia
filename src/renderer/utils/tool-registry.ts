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
  faCircleNodes,
  faNotebookTabs
} from '../components/Icon'
import type { IconComponent } from '../components/Icon'

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
 * Labels are full-name versions ("Code Frequencies", "Word Frequencies"
 * — not the old "Code Freq.", "Word Freq." abbreviations). The
 * abbreviated forms only made sense in the old stacked-button toolbar
 * where horizontal space was tight; everywhere they're surfaced now
 * (Saved Analyses pane headings, the toolbar Analysis popover tiles)
 * the full name reads better.
 */
export const TOOL_REGISTRY: Record<string, ToolDef> = {
  queryBuilder:            { icon: faMagnifyingGlass,  label: 'Query Builder',        color: '#D06828', description: 'Build a code / text query' },                              // burnt orange
  'codes-in-documents':    { icon: faFileCodeCorner,   label: 'Codes in Documents',   color: '#C0A010', description: 'See which documents contain which codes' },                // golden
  'framework-matrix':      { icon: faFrame,            label: 'Framework Matrix',     color: '#C8407A', description: 'Summarise each code in each document' },                   // rose
  'results-in-documents':  { icon: faFileSearchCorner, label: 'Results in Documents', color: '#78B020', description: 'See which documents contain which query results' },        // yellow-green
  'code-cooccurrences':    { icon: faSquaresIntersect, label: 'Code Co-Occurrences',  color: '#20A848', description: 'See which codes overlap with each other' },                // green
  'code-frequencies':      { icon: faChartColumn,      label: 'Code Frequencies',     color: '#10A0A0', description: 'See how much of each document is covered by each code' }, // teal
  'code-orders':           { icon: faBarsStaggered,    label: 'Code Orders',          color: '#2080D8', description: 'See the order in which codes appear in each document' },  // blue
  'word-frequencies':      { icon: faFont,             label: 'Word Frequencies',     color: '#6848E0', description: 'See which words often appear' },                           // indigo
  'relationship-map':      { icon: faCircleNodes,      label: 'Relationships',        color: '#A830D0', description: 'Map relationships between different things' },             // violet
  'reports':               { icon: faNotebookTabs,     label: 'Reports',              color: '#607080', description: 'Compile results into an exportable PDF report' },          // slate
}

/** Backward-compatible color map (used by many components) */
export const toolColors: Record<string, string> = Object.fromEntries(
  Object.entries(TOOL_REGISTRY).map(([key, def]) => [key, def.color])
)

export type ToolColorKey = keyof typeof TOOL_REGISTRY
