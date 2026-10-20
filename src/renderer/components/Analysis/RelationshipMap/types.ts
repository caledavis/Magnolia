export type MapElementKind =
  | 'document'
  | 'code'
  | 'query'
  | 'query-result'
  | 'memo'
  | 'analysis'
  | 'tag'
  | 'tag-category'
  | 'quote'
  | 'folder'
  | 'survey-respondent'
  | 'survey-question'
  | 'survey-cell'

export interface MapElement {
  id: string
  kind: MapElementKind
  label: string
  entityGuid?: string
  codeColor?: string
  /** For query-result and quote kinds: the text content */
  snippet?: string
  /** For query-result, quote: the source document guid */
  sourceGuid?: string
  /** For document kind: the underlying source's type ('survey',
   *  'audio', 'video', etc.) — denormalised at drop time so the
   *  card / chip can pick a type-specific icon (e.g. SURVEY_ICON
   *  for surveys) that mirrors the Document Browser's glyph for
   *  the same source. Optional; absent means "use the generic
   *  document icon". */
  sourceType?: string
  /** For query-result, quote: text position for navigation */
  startPosition?: number
  endPosition?: number
  /** For query-result / quote kinds attached to a PDF box region: the
   *  rectangle on a PDF page. When present, the element renders a
   *  cropped thumbnail of that region instead of a text snippet. */
  pdfRegion?: { page: number; x: number; y: number; width: number; height: number }
  /** For analysis kind: the tool type (e.g. 'code-frequencies') */
  analysisToolType?: string
  /** If set, the guid of an analysis memo attached to THIS node on THIS
   *  map (not the underlying entity). Adding an Analysis Memo to a node
   *  box via right-click assigns this; the node renders a paperclip
   *  badge that opens the memo editor on click. */
  memoGuid?: string
  /** For survey-respondent / survey-question / survey-cell kinds: the
   *  guid of the parent survey source. Lets the map look the survey
   *  data back up for re-labelling, navigation, and double-click
   *  actions. */
  surveyGuid?: string
  /** For survey-cell kind: which question this cell belongs to.
   *  Combined with entityGuid (the respondent id) it uniquely
   *  identifies a single answer cell within `surveyGuid`. */
  questionId?: string
  /** For survey-cell kind: the question's text, denormalised at drop
   *  time so the cell card can render the question as a subtitle
   *  above the answer body without needing the survey data passed
   *  back down to MapElement. Snapshots the question wording from
   *  the time the cell was added; surviving renames would require a
   *  re-import anyway since question text comes from the CSV. */
  questionLabel?: string
  x: number
  y: number
  width: number
  height: number
}

export interface FreeTextElement {
  id: string
  kind: 'freetext'
  x: number
  y: number
  width: number
  height: number
  /** Markdown string content */
  content: string
}

export interface MapConnection {
  id: string
  fromId: string
  toId: string
  arrowFrom: boolean
  arrowTo: boolean
  label: string
}

export interface RelationshipMapConfig {
  elements: MapElement[]
  freeTexts: FreeTextElement[]
  connections: MapConnection[]
  pan: { x: number; y: number }
}

export type AnyNode = MapElement | FreeTextElement

/** Default element dimensions per kind.
 *  Simple entities (document, code, query, tag, tag-category, analysis)
 *  render as chips — short pill-shaped rows. Content-bearing kinds (memo,
 *  quote, query-result) render as edge-accent cards with a title + snippet. */
export const ELEMENT_DIMS: Record<MapElementKind, { w: number; h: number }> = {
  document: { w: 160, h: 28 },
  code: { w: 160, h: 28 },
  query: { w: 160, h: 28 },
  'query-result': { w: 220, h: 72 },
  memo: { w: 220, h: 116 },
  analysis: { w: 160, h: 28 },
  tag: { w: 160, h: 28 },
  'tag-category': { w: 160, h: 28 },
  quote: { w: 220, h: 72 },
  folder: { w: 160, h: 28 },
  'survey-respondent': { w: 160, h: 28 },
  'survey-question': { w: 200, h: 28 },
  // Cells render as edge-accent cards: respondent name as the title,
  // question text as an italic subtitle, answer text as the body —
  // a touch taller than quotes to accommodate the extra subtitle row.
  'survey-cell': { w: 220, h: 96 }
}

/** Element header colors — grey for codes/documents, tool colors for the rest */
export const ELEMENT_COLORS: Record<MapElementKind, string> = {
  document: '#636e7b',
  code: '#a89880',
  query: '#D06828',
  'query-result': '#D06828',
  memo: '#8e8e93',
  analysis: '#8e8e93', // overridden per-tool in MapElement
  tag: '#636e7b',
  'tag-category': '#636e7b',
  quote: '#7c6f64',
  folder: '#636e7b',
  // Survey kinds share a teal-blue family — distinct from documents
  // (grey) and codes (warm beige), close enough to read as a single
  // "survey" group when several land on the canvas together.
  'survey-respondent': '#0E8A8A',
  'survey-question': '#1E6FA0',
  'survey-cell': '#0E8A8A'
}

/** Map analysis tool type to its colour from the main toolbar */
export const ANALYSIS_TOOL_COLORS: Record<string, string> = {
  'codes-in-documents': '#B89818',
  'framework-matrix': '#C8407A',
  'code-cooccurrences': '#30A830',
  'code-frequencies': '#10A8A0',
  'code-orders': '#1880D8',
  'word-frequencies': '#6848E0',
  'relationship-map': '#A830D0'
}

export const FREE_TEXT_DEFAULT_WIDTH = 200
export const FREE_TEXT_DEFAULT_HEIGHT = 60
