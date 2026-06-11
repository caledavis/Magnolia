import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { Icon, faXmark } from '../Icon'
import { PaletteGroup, PaletteDivider, PaletteButton } from '../NodePalette'
import {
  resolveDocGraph,
  type DocGraphData,
  type DNode,
  type DConn,
  type SetOp,
  type DNodeKind,
  type DocCategory
} from '../../utils/document-graph'

const CATEGORY_LABELS: Record<DocCategory, string> = {
  video: 'Video',
  audio: 'Audio',
  document: 'Document',
  image: 'Image'
}

/* ═══════════════════════════════════════════════════
   Exported interfaces (backward-compatible)
   ═══════════════════════════════════════════════════ */

export interface DocumentSelectorSource {
  guid: string
  name: string
}

export interface DocumentSelectorTag {
  guid: string
  name: string
  categoryGuid?: string
  value?: string
}

export interface DocumentSelectorCategory {
  guid: string
  name: string
  type?: 'text' | 'date' | 'numeric' | 'list'
  listOptions?: string[]
}

export interface DocumentSelectorFolder {
  guid: string
  name: string
  parentGuid: string | null
}

export interface DocumentFilterState {
  sourceGuids: string[]
  tagGuids: string[]
  tagExcludeGuids: string[]
  folderGuids: string[]
  typeInclude: string[]
  typeExclude: string[]
  /** Persisted graph layout for the node editor */
  graph?: { nodes: DNode[]; conns: DConn[] }
}

export function emptyDocumentFilter(): DocumentFilterState {
  return {
    sourceGuids: [],
    tagGuids: [],
    tagExcludeGuids: [],
    folderGuids: [],
    typeInclude: [],
    typeExclude: []
  }
}

/* ═══════════════════════════════════════════════════
   Node graph types
   ═══════════════════════════════════════════════════ */

// DNodeKind, SetOp, DNode, DConn now live in ../../utils/document-graph
// (imported above) so the query engine can resolve the same graph.

type DragState =
  | null
  | { t: 'node'; id: string; ox: number; oy: number }
  | { t: 'wire'; fromId: string }
  | { t: 'marquee'; sx: number; sy: number; cx: number; cy: number }

/* ═══════════════════════════════════════════════════
   Module-level context for nodeH (set by DocumentSelector component)
   ═══════════════════════════════════════════════════ */
let _ctxTags: DocumentSelectorTag[] = []
let _ctxCategories: DocumentSelectorCategory[] = []

/* ═══════════════════════════════════════════════════
   Constants
   ═══════════════════════════════════════════════════ */

const DOCS_W = 150
const TAG_W = 160
const TYPE_W = 120
const FOLDER_W = 160
const ALL_W = 110
const OP_W = 110
const RESULT_W = 100
const PORT_R = 6
const SLOT_H = 22
const HDR_H = 24
const DOC_LINE_H = 16
const MAX_VISIBLE_DOCS = 4
const DROP_ZONE_H = 22
const RESULT_H = 36
const LABEL_H = 20
const ADD_BTN_H = 20
const CANVAS_H = 300

const KIND_COLOR: Record<DNodeKind, string> = {
  docs: '#3b82f6',
  tag: '#8b5cf6',
  type: '#f59e0b',
  folder: '#0ea5e9',
  allDocs: '#10b981',
  setOp: '#6366f1',
  result: '#8b5cf6'
}

const KIND_LABEL: Record<DNodeKind, string> = {
  docs: 'Documents',
  tag: 'Tag',
  type: 'Type',
  folder: 'Folder',
  allDocs: 'All docs',
  setOp: 'Logical',
  result: 'Result'
}

const SET_OP_LABEL: Record<SetOp, string> = {
  union: 'Union',
  intersect: 'Intersect',
  subtract: 'Subtract'
}

const SET_OP_COLOR: Record<SetOp, string> = {
  union: '#10b981',
  intersect: '#6366f1',
  subtract: '#f43f5e'
}

const SET_OP_TOOLTIP: Record<SetOp, string> = {
  union: 'UNION \u2014 documents from either input (Input 1 + Input 2)',
  intersect: 'INTERSECT \u2014 only documents in both inputs (Input 1 \u2229 Input 2)',
  subtract: 'SUBTRACT \u2014 documents in Input 1 but not in Input 2 (Input 1 \u2212 Input 2)'
}

const KIND_TOOLTIP: Record<DNodeKind, string> = {
  docs: 'A specific set of documents dragged from the Document Browser',
  tag: 'All documents assigned to a particular tag',
  type: 'All documents matching a file type extension',
  folder: 'All documents inside a folder (sub-folders included)',
  allDocs: 'Every document in the project',
  setOp: 'Combine document sets with union, intersect, or subtract',
  result: 'The final document selection \u2014 connect an input or operation here'
}

/* ═══════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════ */

let _uid = 1
const uid = () => `dn${_uid++}`

function advanceUidPast(nodes: DNode[], conns: DConn[]): void {
  let max = 0
  for (const n of nodes) {
    const m = n.id.match(/^dn(\d+)$/)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  for (const c of conns) {
    const m = c.id.match(/^dn(\d+)$/)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  if (max >= _uid) _uid = max + 1
}

/**
 * Synthesize a graph from flat filter arrays (sourceGuids / tagGuids)
 * when no persisted graph layout exists.
 */
function graphFromFilter(
  filter: DocumentFilterState,
  tags: DocumentSelectorTag[]
): { nodes: DNode[]; conns: DConn[] } | null {
  const hasSourceGuids = filter.sourceGuids && filter.sourceGuids.length > 0
  const hasTagGuids = filter.tagGuids && filter.tagGuids.length > 0
  const hasTagExclude = filter.tagExcludeGuids && filter.tagExcludeGuids.length > 0
  if (!hasSourceGuids && !hasTagGuids && !hasTagExclude) return null

  const nodes: DNode[] = []
  const conns: DConn[] = []

  // Layout columns (x positions) with generous horizontal gaps
  const COL_SOURCES = 30           // leftmost: source leaves (docs, tags, allDocs)
  const COL_EXCLUDE_OP = 240       // union op for multiple excluded tags
  const COL_SUBTRACT = 420         // subtract op (allDocs − excluded tags)
  const COL_COMBINE = 560          // union op when mixing include + exclude groups
  const COL_RESULT = 700           // result node
  const ROW_GAP = 90               // vertical gap between rows

  const sourceNodes: DNode[] = []  // nodes that feed into the final result
  let nextRow = 0                  // running row counter for vertical layout

  // Create a docs node for explicit source guids
  if (hasSourceGuids) {
    const docsId = uid()
    const docsNode: DNode = {
      id: docsId,
      kind: 'docs',
      x: COL_SOURCES,
      y: 30 + nextRow * ROW_GAP,
      docGuids: [...filter.sourceGuids]
    }
    nodes.push(docsNode)
    sourceNodes.push(docsNode)
    nextRow++
  }

  // Create a tag node for each included tag guid
  if (hasTagGuids) {
    for (let i = 0; i < filter.tagGuids.length; i++) {
      const tagGuid = filter.tagGuids[i]
      const tag = tags.find((t) => t.guid === tagGuid)
      const tagId = uid()
      const tagNode: DNode = {
        id: tagId,
        kind: 'tag',
        x: COL_SOURCES,
        y: 30 + nextRow * ROW_GAP,
        tagCategoryGuid: tag?.categoryGuid,
        tagGuid,
        tagName: tag?.value || tag?.name || 'Tag'
      }
      nodes.push(tagNode)
      sourceNodes.push(tagNode)
      nextRow++
    }
  }

  // Handle tag exclusions: ALL DOCS subtract excluded tags
  if (hasTagExclude) {
    const excludeStartRow = nextRow

    // Create ALL DOCS node
    const allDocsId = uid()
    const allDocsNode: DNode = {
      id: allDocsId,
      kind: 'allDocs',
      x: COL_SOURCES,
      y: 30 + nextRow * ROW_GAP
    }
    nodes.push(allDocsNode)
    nextRow++

    // Create tag nodes for each excluded tag
    const excludeTagNodes: DNode[] = []
    for (let i = 0; i < filter.tagExcludeGuids.length; i++) {
      const tagGuid = filter.tagExcludeGuids[i]
      const tag = tags.find((t) => t.guid === tagGuid)
      const tagId = uid()
      const tagNode: DNode = {
        id: tagId,
        kind: 'tag',
        x: COL_SOURCES,
        y: 30 + nextRow * ROW_GAP,
        tagCategoryGuid: tag?.categoryGuid,
        tagGuid,
        tagName: tag?.value || tag?.name || 'Tag'
      }
      nodes.push(tagNode)
      excludeTagNodes.push(tagNode)
      nextRow++
    }

    // If multiple excluded tags, union them first
    let excludeSourceId: string
    if (excludeTagNodes.length === 1) {
      excludeSourceId = excludeTagNodes[0].id
    } else {
      const unionId = uid()
      // Centre the union op vertically among the excluded tag nodes
      const firstTagY = excludeTagNodes[0].y
      const lastTagY = excludeTagNodes[excludeTagNodes.length - 1].y
      const unionNode: DNode = {
        id: unionId,
        kind: 'setOp',
        x: COL_EXCLUDE_OP,
        y: (firstTagY + lastTagY) / 2,
        setOps: Array(excludeTagNodes.length - 1).fill('union' as SetOp)
      }
      nodes.push(unionNode)
      for (let i = 0; i < excludeTagNodes.length; i++) {
        conns.push({ id: uid(), from: excludeTagNodes[i].id, to: unionId, toPort: i })
      }
      excludeSourceId = unionId
    }

    // Subtract excluded tags from ALL DOCS — centre between allDocs and last excluded tag
    const subtractId = uid()
    const subtractY = (allDocsNode.y + excludeTagNodes[excludeTagNodes.length - 1].y) / 2
    const subtractNode: DNode = {
      id: subtractId,
      kind: 'setOp',
      x: excludeTagNodes.length > 1 ? COL_SUBTRACT : COL_EXCLUDE_OP,
      y: subtractY,
      setOps: ['subtract' as SetOp]
    }
    nodes.push(subtractNode)
    conns.push({ id: uid(), from: allDocsId, to: subtractId, toPort: 0 })
    conns.push({ id: uid(), from: excludeSourceId, to: subtractId, toPort: 1 })

    sourceNodes.push(subtractNode)
  }

  // Position result node — vertically centred among all source nodes
  const allSourceY = sourceNodes.map((n) => n.y)
  const resultY = allSourceY.length > 0
    ? (Math.min(...allSourceY) + Math.max(...allSourceY)) / 2
    : 130

  // Determine result x based on how deep the graph is
  const maxSourceX = Math.max(...sourceNodes.map((n) => n.x + nodeW(n)))
  const resultX = sourceNodes.length === 1 && !hasTagExclude
    ? Math.max(COL_SUBTRACT, maxSourceX + 120)  // simple case: source → result
    : COL_RESULT

  const resultNode: DNode = { id: 'result', kind: 'result', x: resultX, y: resultY }
  nodes.push(resultNode)

  // Wire source nodes to result
  if (sourceNodes.length === 1) {
    conns.push({ id: uid(), from: sourceNodes[0].id, to: 'result', toPort: 0 })
  } else if (sourceNodes.length > 1) {
    // Multiple source nodes: connect via a union set-op node
    const opId = uid()
    const combineX = hasTagExclude ? COL_COMBINE : COL_SUBTRACT
    const opNode: DNode = {
      id: opId,
      kind: 'setOp',
      x: combineX,
      y: resultY,
      setOps: Array(sourceNodes.length - 1).fill('union' as SetOp)
    }
    nodes.push(opNode)
    // Shift result further right to make room
    resultNode.x = combineX + OP_W + 120
    for (let i = 0; i < sourceNodes.length; i++) {
      conns.push({ id: uid(), from: sourceNodes[i].id, to: opId, toPort: i })
    }
    conns.push({ id: uid(), from: opId, to: 'result', toPort: 0 })
  }

  return { nodes, conns }
}

/**
 * Clamp pan so content always stays substantially visible.
 * At least half the viewport (or half the content, whichever is smaller)
 * must overlap with the content bounding box.
 */
function clampPan<N extends { x: number; y: number }>(
  nx: number, ny: number,
  nodes: N[],
  el: HTMLElement,
  getW: (n: N) => number,
  getH: (n: N) => number
): { x: number; y: number } {
  if (nodes.length === 0) return { x: nx, y: ny }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + getW(n))
    maxY = Math.max(maxY, n.y + getH(n))
  }
  const pad = 60
  minX -= pad; minY -= pad; maxX += pad; maxY += pad
  const cw = el.clientWidth
  const ch = el.clientHeight
  // Content in screen-space: [minX + pan.x .. maxX + pan.x]
  // Require: maxX + pan.x >= cw * 0.25  (content right edge can't go too far left)
  //          minX + pan.x <= cw * 0.75  (content left edge can't go too far right)
  const clampedX = Math.max(cw * 0.25 - maxX, Math.min(cw * 0.75 - minX, nx))
  const clampedY = Math.max(ch * 0.25 - maxY, Math.min(ch * 0.75 - minY, ny))
  return { x: clampedX, y: clampedY }
}

function nodeW(n: DNode): number {
  switch (n.kind) {
    case 'docs': return DOCS_W
    case 'tag': return TAG_W
    case 'type': return TYPE_W
    case 'folder': return FOLDER_W
    case 'allDocs': return ALL_W
    case 'setOp': return OP_W
    case 'result': return RESULT_W
    default: return OP_W
  }
}

function docsNodeH(n: DNode): number {
  const count = n.docGuids?.length ?? 0
  const lines = Math.min(count, MAX_VISIBLE_DOCS)
  const moreH = count > MAX_VISIBLE_DOCS ? 14 : 0
  return HDR_H + lines * DOC_LINE_H + moreH + DROP_ZONE_H
}

function setOpSlotCount(n: DNode): number {
  return (n.setOps?.length ?? 1) + 1
}

function inputSlots(n: DNode): number {
  if (n.kind === 'docs' || n.kind === 'tag' || n.kind === 'type' || n.kind === 'folder' || n.kind === 'allDocs') return 0
  if (n.kind === 'result') return 1
  if (n.kind === 'setOp') return setOpSlotCount(n)
  return 0
}

function tagNodeH(n: DNode): number {
  let h = HDR_H + 4 // header + container bottom padding
  h += 22 // category select (~20px + 2px breathing room)

  // Determine whether the mode picker is visible, matching the render logic
  const tags = _ctxTags
  const categories = _ctxCategories
  let showModePicker = false
  const uncatTags = tags.filter((t) => !t.categoryGuid)
  const effectiveCatGuid = n.tagCategoryGuid
    || (uncatTags.length === 0 && categories.length > 0 ? categories[0].guid : undefined)
  if (effectiveCatGuid) {
    const catTags = tags.filter((t) => t.categoryGuid === effectiveCatGuid)
    const cat = categories.find((c) => c.guid === effectiveCatGuid)
    const allValues = catTags.map((t) => t.value).filter(Boolean) as string[]
    const isDateCat = cat?.type === 'date' || (allValues.length > 0 && allValues.every((v) => !isNaN(new Date(v.split('/').reverse().join('-')).getTime())))
    const isNumCat = cat?.type === 'numeric' || (!isDateCat && allValues.length > 0 && allValues.every((v) => !isNaN(parseFloat(v))))
    showModePicker = (isDateCat || isNumCat) && catTags.length > 1
  } else if (n.betweenMode !== undefined) {
    // Fallback: use betweenMode as a hint
    showModePicker = true
  }

  if (showModePicker) h += 22 // marginTop 3 + mode button row (~16px + 3px)
  h += 24 // marginTop 3 + value 1 select (~20px)
  if (n.betweenMode === 'between' || n.betweenMode === 'not-between') {
    h += 16 // "and" label (marginTop 2 + lineHeight 12)
    h += 24 // marginTop 2 + value 2 select (~20px)
  }
  return h
}

function nodeH(n: DNode): number {
  if (n.kind === 'docs') return docsNodeH(n)
  if (n.kind === 'tag') return tagNodeH(n)
  if (n.kind === 'type') return HDR_H + 26
  if (n.kind === 'folder') return HDR_H + 26
  if (n.kind === 'allDocs') return 34
  if (n.kind === 'result') return RESULT_H
  if (n.kind === 'setOp') {
    const slots = setOpSlotCount(n)
    const ops = slots - 1
    return HDR_H + slots * SLOT_H + ops * LABEL_H + ADD_BTN_H + 6
  }
  return HDR_H
}

function outPortXY(n: DNode): [number, number] {
  return [n.x + nodeW(n), n.y + nodeH(n) / 2]
}

function inPortXY(n: DNode, i: number): [number, number] {
  if (n.kind === 'result') return [n.x, n.y + nodeH(n) / 2]
  if (n.kind === 'setOp') {
    return [n.x, n.y + HDR_H + i * (SLOT_H + LABEL_H) + SLOT_H / 2]
  }
  return [n.x, n.y + HDR_H + i * SLOT_H + SLOT_H / 2]
}

function bezPath(x1: number, y1: number, x2: number, y2: number): string {
  const d = Math.max(Math.abs(x2 - x1) * 0.4, 40)
  return `M${x1},${y1} C${x1 + d},${y1} ${x2 - d},${y2} ${x2},${y2}`
}

function wouldCycle(fromId: string, toId: string, cc: DConn[]): boolean {
  const visited = new Set<string>()
  const q = [toId]
  while (q.length) {
    const cur = q.pop()!
    if (cur === fromId) return true
    if (visited.has(cur)) continue
    visited.add(cur)
    for (const c of cc) if (c.from === cur) q.push(c.to)
  }
  return false
}

/* ═══════════════════════════════════════════════════
   Component
   ═══════════════════════════════════════════════════ */

/**
 * Collect the tag guids referenced by tag nodes feeding the Result,
 * split into include vs exclude by graph polarity. The graph already
 * flattens to a document set (resolveGraph); these tag guids are emitted
 * alongside so downstream can apply cell-precise survey scoping (a tag
 * node that pulled a survey in via a respondent then narrows to that
 * respondent's cells). Polarity starts at 'include' from the Result and
 * flips through each 'subtract' input of a setOp.
 */
function collectFilterTags(nodes: DNode[], conns: DConn[]): { include: string[]; exclude: string[] } {
  const include = new Set<string>()
  const exclude = new Set<string>()
  const res = nodes.find((n) => n.kind === 'result')
  const inp = res ? conns.find((c) => c.to === res.id) : undefined
  if (!inp) return { include: [], exclude: [] }
  const visited = new Set<string>()
  const walk = (id: string, polarity: 'inc' | 'exc'): void => {
    if (visited.has(id)) return
    visited.add(id)
    const n = nodes.find((nd) => nd.id === id)
    if (!n) return
    if (n.kind === 'tag') {
      const target = polarity === 'inc' ? include : exclude
      if (n.tagGuid) target.add(n.tagGuid)
      if (n.tagGuid2) target.add(n.tagGuid2)
      return
    }
    if (n.kind === 'setOp') {
      const ops = n.setOps ?? ['union']
      const ins = conns.filter((c) => c.to === id).sort((a, b) => a.toPort - b.toPort)
      ins.forEach((c, idx) => {
        let p = polarity
        if (idx >= 1 && (ops[idx - 1] ?? 'union') === 'subtract') {
          p = polarity === 'inc' ? 'exc' : 'inc'
        }
        walk(c.from, p)
      })
    }
    // docs / type / folder / allDocs aren't tags — ignored here.
  }
  walk(inp.from, 'inc')
  return { include: [...include], exclude: [...exclude] }
}

/** Items for the scope breakdown list, capping long lists with a
 *  trailing "+N more" so a big respondent group doesn't flood the panel. */
function scopeListItems(items: string[], max = 50): string[] {
  if (items.length <= max) return items
  return [...items.slice(0, max), `+${items.length - max} more`]
}

interface Props {
  sources: DocumentSelectorSource[]
  tags: DocumentSelectorTag[]
  categories: DocumentSelectorCategory[]
  folders: DocumentSelectorFolder[]
  /** Map of source guid → folder guid. Required for the Folder input
   *  to resolve which documents live inside the chosen folder. */
  sourceFolder?: Record<string, string>
  tagMembers?: Record<string, string[]>
  /** Survey respondent/question tag membership (tag guid → entity refs).
   *  Lets a tag node pull in surveys tagged only via a respondent or
   *  question, so cell-precise scoping survives downstream. */
  respondentTagMembers?: Record<string, import('../../models/types').SurveyEntityRef[]>
  questionTagMembers?: Record<string, import('../../models/types').SurveyEntityRef[]>
  /** Per survey source: respondent id → name, question id → text. Lets
   *  the Selected Documents list name the respondents/questions a tag
   *  filter targets inside a survey. */
  surveyEntityLabels?: Record<string, { respondents: Record<string, string>; questions: Record<string, string> }>
  filter: DocumentFilterState
  onChange: (filter: DocumentFilterState) => void
}

export function DocumentSelector({
  sources, tags, categories, folders, sourceFolder = {}, tagMembers = {},
  respondentTagMembers = {}, questionTagMembers = {}, surveyEntityLabels = {}, filter, onChange
}: Props) {
  const canvasRef = useRef<HTMLDivElement>(null)
  const wireRef = useRef<SVGPathElement>(null)
  // Update module-level context so nodeH can compute accurate tag node heights
  _ctxTags = tags
  _ctxCategories = categories

  // Bundle the data the shared resolver needs, rebuilt when any input
  // changes. Used by both resolve sites below (and the same shape the query
  // store builds when it re-resolves a saved filter live).
  const docGraphData = useMemo<DocGraphData>(
    () => ({ sources, tags, tagMembers, folders, sourceFolder, respondentTagMembers, questionTagMembers }),
    [sources, tags, tagMembers, folders, sourceFolder, respondentTagMembers, questionTagMembers]
  )

  // Initialize graph from saved filter, synthesize from arrays, or default
  const computedGraph = useRef((() => {
    if (filter.graph) {
      advanceUidPast(filter.graph.nodes, filter.graph.conns)
      return filter.graph
    }
    // Synthesize graph from flat sourceGuids/tagGuids when no graph is persisted
    const synth = graphFromFilter(filter, tags)
    if (synth) {
      advanceUidPast(synth.nodes, synth.conns)
      return synth
    }
    return null
  })())

  const defaultGraph = useRef<{ nodes: DNode[]; conns: DConn[] } | null>(null)
  const [nodes, setNodes] = useState<DNode[]>(
    () => {
      if (computedGraph.current?.nodes) return computedGraph.current.nodes as DNode[]
      const allDocsId = uid()
      const ns: DNode[] = [
        { id: allDocsId, kind: 'allDocs', x: 120, y: 130 } as DNode,
        { id: 'result', kind: 'result', x: 520, y: 130 } as DNode
      ]
      const cs: DConn[] = [
        { id: uid(), from: allDocsId, to: 'result', toPort: 0 }
      ]
      defaultGraph.current = { nodes: ns, conns: cs }
      return ns
    }
  )
  const [conns, setConns] = useState<DConn[]>(
    () => {
      if (computedGraph.current?.conns) return computedGraph.current.conns as DConn[]
      return defaultGraph.current?.conns ?? []
    }
  )
  const [selNodes, setSelNodes] = useState<Set<string>>(new Set())
  const [selConn, setSelConn] = useState<string | null>(null)
  const [marqueeRect, setMarqueeRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const panRef = useRef(pan)
  panRef.current = pan
  const [showRecentre, setShowRecentre] = useState(false)

  const dragRef = useRef<DragState>(null)
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const connsRef = useRef(conns)
  connsRef.current = conns

  /* --- canvas coords (adjusted for pan) --- */
  const cpos = useCallback(
    (e: MouseEvent | React.MouseEvent): [number, number] => {
      const r = canvasRef.current?.getBoundingClientRect()
      return r ? [e.clientX - r.left - panRef.current.x, e.clientY - r.top - panRef.current.y] : [0, 0]
    },
    []
  )

  /* --- drag helpers --- */
  const setDrag = useCallback((d: DragState) => {
    dragRef.current = d
    if (wireRef.current) {
      wireRef.current.style.display = d?.t === 'wire' ? '' : 'none'
    }
    if (d?.t !== 'marquee') setMarqueeRect(null)
  }, [])

  const updateWire = useCallback(
    (mx: number, my: number) => {
      const d = dragRef.current
      if (!d || d.t !== 'wire' || !wireRef.current) return
      const fn = nodesRef.current.find((n) => n.id === d.fromId)
      if (!fn) return
      const [x1, y1] = outPortXY(fn)
      wireRef.current.setAttribute('d', bezPath(x1, y1, mx, my))
      wireRef.current.style.display = ''
    },
    []
  )

  /* --- add nodes --- */
  const addNode = useCallback((kind: DNodeKind, extra?: Partial<DNode>) => {
    setNodes((p) => [
      ...p,
      {
        id: uid(),
        kind,
        x: -panRef.current.x + 40 + Math.random() * 80,
        y: -panRef.current.y + 30 + ((p.length * 50) % 240),
        ...(kind === 'setOp' ? { setOps: [undefined] } : {}),
        ...extra
      }
    ])
  }, [])

  /* --- delete --- */
  const doDelete = useCallback(() => {
    if (selConn) {
      setConns((p) => p.filter((c) => c.id !== selConn))
      setSelConn(null)
    } else if (selNodes.size > 0) {
      const toDelete = new Set(selNodes)
      toDelete.delete('result')
      if (toDelete.size === 0) return
      setConns((p) => p.filter((c) => !toDelete.has(c.from) && !toDelete.has(c.to)))
      setNodes((p) => p.filter((n) => !toDelete.has(n.id)))
      setSelNodes(new Set())
    }
  }, [selNodes, selConn])

  /* --- copy/paste --- */
  const doCopy = useCallback(() => {
    if (selNodes.size === 0) return
    const copyNodes = nodesRef.current.filter((n) => selNodes.has(n.id) && n.kind !== 'result')
    if (copyNodes.length === 0) return
    const copyNodeIds = new Set(copyNodes.map((n) => n.id))
    const copyConns = connsRef.current.filter((c) => copyNodeIds.has(c.from) && copyNodeIds.has(c.to))
    const payload = JSON.stringify({ _magnoliaDocNodes: true, nodes: copyNodes, conns: copyConns })
    navigator.clipboard.writeText(payload).catch(() => {})
  }, [selNodes])

  const doPaste = useCallback(() => {
    navigator.clipboard.readText().then((text) => {
      try {
        const data = JSON.parse(text)
        if (!data._magnoliaDocNodes || !Array.isArray(data.nodes)) return
        const pastedNodes = data.nodes as DNode[]
        const pastedConns = data.conns as DConn[]
        if (pastedNodes.length === 0) return
        const idMap = new Map<string, string>()
        for (const n of pastedNodes) idMap.set(n.id, uid())
        const newNodes = pastedNodes.map((n) => ({ ...n, id: idMap.get(n.id)!, x: n.x + 30, y: n.y + 30 }))
        const newConns = pastedConns
          .filter((c) => idMap.has(c.from) && idMap.has(c.to))
          .map((c) => ({ ...c, id: uid(), from: idMap.get(c.from)!, to: idMap.get(c.to)! }))
        setNodes((p) => [...p, ...newNodes])
        setConns((p) => [...p, ...newConns])
        setSelNodes(new Set(newNodes.map((n) => n.id)))
      } catch { /* ignore */ }
    }).catch(() => {})
  }, [])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      // Don't swallow Delete/Backspace from any editable element — incl.
      // contentEditable (TipTap rich-text editors), or this window-level
      // handler steals the key from those editors app-wide.
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); doDelete() }
      if ((e.metaKey || e.ctrlKey) && e.key === 'c') doCopy()
      if ((e.metaKey || e.ctrlKey) && e.key === 'v') doPaste()
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        e.preventDefault()
        setSelNodes(new Set(nodesRef.current.map((n) => n.id)))
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [doDelete, doCopy, doPaste])

  /* --- wheel to pan (clamped so content stays visible) --- */
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setPan((p) => {
        const next = clampPan(p.x - e.deltaX, p.y - e.deltaY, nodesRef.current, el, nodeW, nodeH)
        if (next.x !== p.x || next.y !== p.y) setShowRecentre(true)
        return next
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const handleCentre = useCallback(() => {
    const ns = nodesRef.current
    const el = canvasRef.current
    if (ns.length === 0 || !el) { setPan({ x: 0, y: 0 }); setShowRecentre(false); return }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const n of ns) {
      minX = Math.min(minX, n.x)
      minY = Math.min(minY, n.y)
      maxX = Math.max(maxX, n.x + nodeW(n))
      maxY = Math.max(maxY, n.y + nodeH(n))
    }
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    setPan({ x: el.clientWidth / 2 - cx, y: el.clientHeight / 2 - cy })
    setShowRecentre(false)
  }, [])

  // Auto-centre on mount so a loaded selector graph (e.g. one
  // resolved from a saved document filter) appears centred in the
  // canvas instead of stuck in the top-left corner.
  useEffect(() => {
    handleCentre()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* --- notify parent --- */
  useEffect(() => {
    const resolved = resolveDocGraph(nodes, conns, docGraphData)
    // Emit the tag guids the graph used (include/exclude) alongside the
    // resolved document set, so downstream can apply cell-precise survey
    // scoping. sourceGuids already includes surveys pulled in by a
    // respondent/question tag (walkNode), and tagGuids narrows them to
    // the matching cells.
    const { include, exclude } = collectFilterTags(nodes, conns)
    const newFilter: DocumentFilterState = {
      sourceGuids: resolved,
      tagGuids: include,
      tagExcludeGuids: exclude,
      folderGuids: [],
      typeInclude: [],
      typeExclude: [],
      graph: { nodes, conns }
    }
    onChange(newFilter)
  }, [nodes, conns, sources, tagMembers, folders, sourceFolder])

  /* --- document-level mouse handlers --- */
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      const [mx, my] = cpos(e)

      if (d.t === 'node') {
        if (selNodes.size > 1 && selNodes.has(d.id)) {
          const dn = nodesRef.current.find((n) => n.id === d.id)!
          const dx = mx - d.ox - dn.x
          const dy = my - d.oy - dn.y
          setNodes((p) => p.map((n) => selNodes.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n))
        } else {
          setNodes((p) => p.map((n) => n.id === d.id ? { ...n, x: mx - d.ox, y: my - d.oy } : n))
        }
      } else if (d.t === 'wire') {
        updateWire(mx, my)
      } else if (d.t === 'marquee') {
        dragRef.current = { ...d, cx: mx, cy: my }
        const x1 = Math.min(d.sx, mx), y1 = Math.min(d.sy, my)
        const x2 = Math.max(d.sx, mx), y2 = Math.max(d.sy, my)
        setMarqueeRect({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 })
        // Live-preview selection
        const hit = new Set<string>()
        for (const n of nodesRef.current) {
          if (n.x < x2 && n.x + nodeW(n) > x1 && n.y < y2 && n.y + nodeH(n) > y1) hit.add(n.id)
        }
        setSelNodes(hit)
      }
    }

    const onUp = (e: MouseEvent) => {
      const d = dragRef.current
      if (!d) return

      if (d.t === 'wire') {
        const [mx, my] = cpos(e)
        for (const n of nodesRef.current) {
          if (n.kind === 'docs' || n.kind === 'tag' || n.kind === 'type' || n.kind === 'folder' || n.kind === 'allDocs' || n.id === d.fromId) continue
          const ic = inputSlots(n)
          for (let i = 0; i < ic; i++) {
            const [px, py] = inPortXY(n, i)
            if (Math.hypot(mx - px, my - py) < 18) {
              if (wouldCycle(d.fromId, n.id, connsRef.current)) break
              const cleaned = connsRef.current.filter((c) => !(c.to === n.id && c.toPort === i))
              setConns([...cleaned, { id: uid(), from: d.fromId, to: n.id, toPort: i }])
              setDrag(null)
              return
            }
          }
        }
      } else if (d.t === 'marquee') {
        const x1 = Math.min(d.sx, d.cx), y1 = Math.min(d.sy, d.cy)
        const x2 = Math.max(d.sx, d.cx), y2 = Math.max(d.sy, d.cy)
        const hit = new Set<string>()
        for (const n of nodesRef.current) {
          if (n.x < x2 && n.x + nodeW(n) > x1 && n.y < y2 && n.y + nodeH(n) > y1) hit.add(n.id)
        }
        if (e.altKey || e.metaKey) {
          setSelNodes((prev) => { const next = new Set(prev); for (const id of hit) next.add(id); return next })
        } else {
          setSelNodes(hit)
        }
        setMarqueeRect(null)
      }
      setDrag(null)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
  }, [cpos, setDrag, updateWire])

  /* --- port mousedown --- */
  const portDown = useCallback((e: React.MouseEvent, nodeId: string, side: 'out' | 'in', idx: number) => {
    e.stopPropagation()
    e.preventDefault()
    const [mx, my] = cpos(e)
    if (side === 'in') {
      const existing = connsRef.current.find((c) => c.to === nodeId && c.toPort === idx)
      if (existing) {
        setConns((p) => p.filter((c) => c.id !== existing.id))
        setDrag({ t: 'wire', fromId: existing.from })
        updateWire(mx, my)
      }
      return
    }
    setDrag({ t: 'wire', fromId: nodeId })
    updateWire(mx, my)
  }, [cpos, setDrag, updateWire])

  /* --- node mousedown --- */
  const nodeDown = useCallback((e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation()
    const [mx, my] = cpos(e)
    const n = nodesRef.current.find((nd) => nd.id === nodeId)
    if (!n) return
    setSelConn(null)

    if (e.altKey || e.metaKey) {
      setSelNodes((prev) => {
        const next = new Set(prev)
        if (next.has(nodeId)) next.delete(nodeId); else next.add(nodeId)
        return next
      })
      return
    }

    if (!selNodes.has(nodeId)) setSelNodes(new Set([nodeId]))

    // Right third → wire
    const localX = mx - n.x
    if (localX > nodeW(n) * 0.65 && n.kind !== 'result') {
      setDrag({ t: 'wire', fromId: nodeId })
      updateWire(mx, my)
      return
    }

    setDrag({ t: 'node', id: nodeId, ox: mx - n.x, oy: my - n.y })
  }, [cpos, setDrag, updateWire])

  /* --- connection click --- */
  const connClick = useCallback((e: React.MouseEvent, connId: string) => {
    e.stopPropagation()
    setConns((p) => p.filter((c) => c.id !== connId))
    setSelConn(null)
  }, [])

  /* --- canvas click / mousedown --- */
  const canvasClick = useCallback(() => { setSelNodes(new Set()); setSelConn(null) }, [])
  const canvasMouseDown = useCallback((e: React.MouseEvent) => {
    // Nodes call e.stopPropagation(), so any click reaching here is on the background.
    const [mx, my] = cpos(e)
    setDrag({ t: 'marquee', sx: mx, sy: my, cx: mx, cy: my })
    dragRef.current = { t: 'marquee', sx: mx, sy: my, cx: mx, cy: my }
  }, [cpos])

  /* --- HTML5 drag-and-drop: accept docs, tags, and toolbar nodes --- */
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (
      e.dataTransfer.types.includes('application/x-magnolia-docs') ||
      e.dataTransfer.types.includes('application/x-magnolia-doc') ||
      e.dataTransfer.types.includes('application/x-magnolia-doc-reorder') ||
      e.dataTransfer.types.includes('application/x-magnolia-tag') ||
      e.dataTransfer.types.includes('application/x-magnolia-ds-node')
    ) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    const [mx, my] = cpos(e)

    // Drop documents → create docs node
    const multiData = e.dataTransfer.getData('application/x-magnolia-docs')
    const singleData = e.dataTransfer.getData('application/x-magnolia-doc-reorder') || e.dataTransfer.getData('application/x-magnolia-doc')
    if (multiData || singleData) {
      e.preventDefault()
      try {
        let guids: string[]
        if (multiData) {
          guids = JSON.parse(multiData)
        } else if (singleData.startsWith('{')) {
          guids = [JSON.parse(singleData).guid]
        } else {
          guids = [singleData]
        }
        if (guids.length > 0) {
          setNodes((p) => [
            ...p,
            { id: uid(), kind: 'docs', x: mx - DOCS_W / 2, y: my - 20, docGuids: guids }
          ])
        }
      } catch { /* ignore */ }
      return
    }

    // Drop tag → create tag node
    const tagData = e.dataTransfer.getData('application/x-magnolia-tag')
    if (tagData) {
      e.preventDefault()
      try {
        const tagGuids: string[] = JSON.parse(tagData)
        tagGuids.forEach((guid, i) => {
          const tag = tags.find((t) => t.guid === guid)
          // Auto-detect if this tag's category is date/number
          let autoMode: 'is' | undefined = undefined
          if (tag?.categoryGuid) {
            const tagCat = categories.find((c) => c.guid === tag.categoryGuid)
            const tagCatTags = tags.filter((t) => t.categoryGuid === tag.categoryGuid)
            const vals = tagCatTags.map((t) => t.value).filter(Boolean) as string[]
            const isD = tagCat?.type === 'date' || (vals.length > 0 && vals.every((v) => !isNaN(new Date(v.split('/').reverse().join('-')).getTime())))
            const isN = tagCat?.type === 'numeric' || (!isD && vals.length > 0 && vals.every((v) => !isNaN(parseFloat(v))))
            if ((isD || isN) && tagCatTags.length > 1) autoMode = 'is'
          }
          setNodes((p) => [
            ...p,
            {
              id: uid(),
              kind: 'tag',
              x: mx - TAG_W / 2,
              y: my - 20 + i * 60,
              tagCategoryGuid: tag?.categoryGuid,
              tagGuid: guid,
              tagName: tag?.value || tag?.name || 'Tag',
              betweenMode: autoMode
            }
          ])
        })
      } catch { /* ignore */ }
      return
    }

    // Drop toolbar node
    const dsNodeData = e.dataTransfer.getData('application/x-magnolia-ds-node')
    if (dsNodeData) {
      e.preventDefault()
      try {
        const data = JSON.parse(dsNodeData) as { kind: DNodeKind }
        const w = nodeW({ kind: data.kind } as DNode)
        setNodes((p) => [
          ...p,
          {
            id: uid(),
            kind: data.kind,
            x: mx - w / 2,
            y: my - 20,
            ...(data.kind === 'docs' ? { docGuids: [] } : {}),
            ...(data.kind === 'setOp' ? { setOps: [undefined] } : {})
          }
        ])
      } catch { /* ignore */ }
    }
  }, [cpos, tags])

  /* --- source name lookup --- */
  const sourceMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of sources) m.set(s.guid, s.name)
    return m
  }, [sources])

  /* --- folder dropdown options: depth-first traversal so children sit
   *     directly below their parent, with two non-breaking spaces of
   *     leading indent per level.   because <option> collapses
   *     regular leading whitespace in most browsers. --- */
  const folderOptions = useMemo(() => {
    const out: { guid: string; label: string }[] = []
    const byParent = new Map<string | null, typeof folders>()
    for (const f of folders) {
      const key = f.parentGuid ?? null
      if (!byParent.has(key)) byParent.set(key, [])
      byParent.get(key)!.push(f)
    }
    // Stable per-level sort by name so siblings are alphabetical.
    for (const list of byParent.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name))
    }
    const walk = (parent: string | null, depth: number): void => {
      const children = byParent.get(parent) ?? []
      for (const f of children) {
        out.push({ guid: f.guid, label: '  '.repeat(depth) + f.name })
        walk(f.guid, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }, [folders])

  /* --- resolved count for status --- */
  const resolvedGuids = useMemo(
    () => resolveDocGraph(nodes, conns, docGraphData),
    [nodes, conns, docGraphData]
  )

  // Per survey source, which respondent/question tags are narrowing it —
  // so the Selected Documents list can show what the query actually
  // targets inside a survey. A survey tagged at the whole-document level
  // is NOT narrowed (all its cells are in scope), so it's omitted here.
  const surveyScopeByGuid = useMemo(() => {
    const { include, exclude } = collectFilterTags(nodes, conns)
    const result = new Map<string, { respondents: string[]; questions: string[] }>()
    if (include.length === 0) return result
    // A whole-survey tag puts all cells in scope, so it's not "narrowed".
    const wholeTagged = new Set<string>()
    for (const tg of include) for (const sg of (tagMembers[tg] || [])) wholeTagged.add(sg)
    // Collect in-scope respondent/question ids per survey from the
    // include tags, then drop excluded ones.
    const respIds = new Map<string, Set<string>>()
    const questIds = new Map<string, Set<string>>()
    const addId = (m: Map<string, Set<string>>, sg: string, id: string) => {
      let s = m.get(sg); if (!s) { s = new Set(); m.set(sg, s) } s.add(id)
    }
    for (const tg of include) {
      for (const r of (respondentTagMembers[tg] || [])) if (!wholeTagged.has(r.sourceGuid)) addId(respIds, r.sourceGuid, r.id)
      for (const q of (questionTagMembers[tg] || [])) if (!wholeTagged.has(q.sourceGuid)) addId(questIds, q.sourceGuid, q.id)
    }
    for (const tg of exclude) {
      for (const r of (respondentTagMembers[tg] || [])) respIds.get(r.sourceGuid)?.delete(r.id)
      for (const q of (questionTagMembers[tg] || [])) questIds.get(q.sourceGuid)?.delete(q.id)
    }
    const collate = (Intl as any).Collator ? new Intl.Collator(undefined, { numeric: true }) : null
    const sortNames = (a: string[]) => collate ? a.sort((x, y) => collate.compare(x, y)) : a.sort()
    const sgs = new Set<string>([...respIds.keys(), ...questIds.keys()])
    for (const sg of sgs) {
      const labels = surveyEntityLabels[sg] || { respondents: {}, questions: {} }
      const rNames = [...(respIds.get(sg) || [])].map((id) => labels.respondents[id] || 'Respondent')
      const qNames = [...(questIds.get(sg) || [])].map((id) => labels.questions[id] || 'Question')
      result.set(sg, { respondents: sortNames(rNames), questions: sortNames(qNames) })
    }
    return result
  }, [nodes, conns, tagMembers, respondentTagMembers, questionTagMembers, surveyEntityLabels])

  /* ═══ Render ═══ */

  return (
    <div>
      {/* ── Toolbar ── two labeled groups (Input / Logical) using the
          shared PaletteGroup + PaletteButton + PaletteDivider helpers
          so the look matches the Content Query palette exactly. */}
      <div style={{ display: 'flex', gap: 14, marginBottom: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <PaletteGroup label="Input">
          <PaletteButton
            kind="docs"
            label={KIND_LABEL.docs}
            color={KIND_COLOR.docs}
            tooltip={KIND_TOOLTIP.docs}
            dragMimeType="application/x-magnolia-ds-node"
            onClick={() => addNode('docs', { docGuids: [] })}
          />
          <PaletteButton
            kind="tag"
            label={KIND_LABEL.tag}
            color={KIND_COLOR.tag}
            tooltip={KIND_TOOLTIP.tag}
            dragMimeType="application/x-magnolia-ds-node"
            onClick={() => addNode('tag')}
          />
          <PaletteButton
            kind="type"
            label={KIND_LABEL.type}
            color={KIND_COLOR.type}
            tooltip={KIND_TOOLTIP.type}
            dragMimeType="application/x-magnolia-ds-node"
            onClick={() => addNode('type')}
          />
          <PaletteButton
            kind="folder"
            label={KIND_LABEL.folder}
            color={KIND_COLOR.folder}
            tooltip={KIND_TOOLTIP.folder}
            dragMimeType="application/x-magnolia-ds-node"
            onClick={() => addNode('folder')}
          />
          <PaletteButton
            kind="allDocs"
            label={KIND_LABEL.allDocs}
            color={KIND_COLOR.allDocs}
            tooltip={KIND_TOOLTIP.allDocs}
            dragMimeType="application/x-magnolia-ds-node"
            onClick={() => addNode('allDocs')}
          />
        </PaletteGroup>

        <PaletteDivider />

        <PaletteGroup label="Logical">
          <PaletteButton
            kind="setOp"
            label={KIND_LABEL.setOp}
            color={KIND_COLOR.setOp}
            tooltip={KIND_TOOLTIP.setOp}
            dragMimeType="application/x-magnolia-ds-node"
            onClick={() => addNode('setOp', { setOps: [undefined] })}
          />
        </PaletteGroup>
      </div>

      {/* ── Canvas + Selected Documents ── */}
      <div style={{ display: 'flex', gap: 10 }}>
      <div
        ref={canvasRef}
        onClick={canvasClick}
        onMouseDown={canvasMouseDown}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        style={{
          position: 'relative',
          flex: 1,
          minWidth: 0,
          height: CANVAS_H,
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-md)',
          overflow: 'hidden',
          background: 'var(--canvas-bg)',
          cursor: 'default',
          userSelect: 'none'
        }}
      >
        {/* Pan wrapper */}
        <div style={{ position: 'absolute', inset: 0, transform: `translate(${pan.x}px, ${pan.y}px)` }}>
        {/* Grid dots */}
        <svg style={{ position: 'absolute', left: -pan.x, top: -pan.y, width: 4000, height: 4000, pointerEvents: 'none' }}>
          <defs>
            <pattern id="dsgrid" width="20" height="20" patternUnits="userSpaceOnUse" x={pan.x % 20} y={pan.y % 20}>
              <circle cx="10" cy="10" r="0.8" fill="var(--text-muted)" opacity="0.15" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#dsgrid)" />
        </svg>

        {/* Connections SVG */}
        <svg style={{ position: 'absolute', inset: 0, width: 4000, height: 4000, pointerEvents: 'none' }}>
          {conns.map((conn) => {
            const fn = nodes.find((n) => n.id === conn.from)
            const tn = nodes.find((n) => n.id === conn.to)
            if (!fn || !tn) return null
            const [x1, y1] = outPortXY(fn)
            const [x2, y2] = inPortXY(tn, conn.toPort)
            const selected = selConn === conn.id
            return (
              <g key={conn.id}>
                <path
                  d={bezPath(x1, y1, x2, y2)}
                  fill="none" stroke="transparent" strokeWidth={14}
                  style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                  onClick={(e) => connClick(e, conn.id)}
                />
                <path
                  d={bezPath(x1, y1, x2, y2)}
                  fill="none"
                  stroke={selected ? 'var(--accent-primary)' : 'var(--text-secondary)'}
                  strokeWidth={selected ? 2.5 : 2}
                  opacity={selected ? 1 : 0.5}
                  style={{ pointerEvents: 'none' }}
                />
              </g>
            )
          })}
        </svg>

        {/* Nodes */}
        {nodes.map((node) => {
          const h = nodeH(node)
          const w = nodeW(node)
          const selected = selNodes.has(node.id)
          const firstOp = node.kind === 'setOp' ? node.setOps?.find((o) => o != null) : undefined
          const color =
            node.kind === 'setOp' && firstOp
              ? SET_OP_COLOR[firstOp]
              : KIND_COLOR[node.kind]
          const inConns = conns.filter((c) => c.to === node.id)
          const connectedIn = new Set(inConns.map((c) => c.toPort))
          const hasOut = conns.some((c) => c.from === node.id)

          const portLabel = (port: number): string | null => {
            const conn = inConns.find((c) => c.toPort === port)
            if (!conn) return null
            const src = nodes.find((n) => n.id === conn.from)
            if (!src) return null
            if (src.kind === 'docs') return `${src.docGuids?.length || 0} doc(s)`
            if (src.kind === 'tag') return src.tagName || 'Tag'
            if (src.kind === 'type') return src.typeExt ? CATEGORY_LABELS[src.typeExt as DocCategory] : 'Type'
            if (src.kind === 'folder') {
              const fname = folders.find((f) => f.guid === src.folderGuid)?.name
              return fname || 'Folder'
            }
            if (src.kind === 'allDocs') return 'All Docs'
            if (src.kind === 'setOp') return 'Set input'
            return 'Input'
          }

          return (
            <div
              key={node.id}
              title={KIND_TOOLTIP[node.kind]}
              onMouseDown={(e) => nodeDown(e, node.id)}
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'absolute',
                left: node.x,
                top: node.y,
                width: w,
                height: h,
                borderRadius: 'var(--radius-sm)',
                borderTop: `3px solid ${color}`,
                borderRight: `1.5px solid ${selected ? color : 'var(--border-color)'}`,
                borderBottom: `1.5px solid ${selected ? color : 'var(--border-color)'}`,
                borderLeft: `1.5px solid ${selected ? color : 'var(--border-color)'}`,
                background: 'var(--bg-panel)',
                boxShadow: selected
                  ? `0 0 0 2px ${color}44, 0 2px 8px rgba(0,0,0,0.15)`
                  : '0 1px 4px rgba(0,0,0,0.08)',
                cursor: 'grab',
                fontSize: 11,
                zIndex: selected ? 5 : 2
              }}
            >
              {/* Header */}
              <div style={{
                padding: node.kind === 'allDocs' || node.kind === 'result' ? '7px 8px' : '3px 6px',
                fontWeight: 600,
                color: 'var(--text-primary)',
                fontSize: node.kind === 'allDocs' ? 11 : 10,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                pointerEvents: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: 4
              }}>
                {node.kind === 'result' && <span style={{ color: KIND_COLOR.result }}>&#9654;</span>}
                {KIND_LABEL[node.kind]}
              </div>

              {/* Docs node: list + drop zone */}
              {node.kind === 'docs' && (
                <div style={{ pointerEvents: 'auto' }}>
                  {(node.docGuids || []).slice(0, MAX_VISIBLE_DOCS).map((guid) => (
                    <div key={guid} style={{
                      height: DOC_LINE_H, lineHeight: `${DOC_LINE_H}px`,
                      padding: '0 6px', fontSize: 9,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between'
                    }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {sourceMap.get(guid) || '(deleted document)'}
                      </span>
                      <span
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          setNodes((p) => p.map((nd) =>
                            nd.id === node.id
                              ? { ...nd, docGuids: (nd.docGuids || []).filter((g) => g !== guid) }
                              : nd
                          ))
                        }}
                        style={{ fontSize: 9, color: 'var(--text-muted)', cursor: 'pointer', flexShrink: 0, marginLeft: 2 }}
                      >
                        <Icon icon={faXmark} />
                      </span>
                    </div>
                  ))}
                  {(node.docGuids?.length || 0) > MAX_VISIBLE_DOCS && (
                    <div style={{ fontSize: 8, color: 'var(--text-muted)', padding: '0 6px', height: 14, lineHeight: '14px' }}>
                      +{(node.docGuids?.length || 0) - MAX_VISIBLE_DOCS} more
                    </div>
                  )}
                  <div
                    onMouseDown={(e) => e.stopPropagation()}
                    onDragOver={(e) => {
                      if (e.dataTransfer.types.includes('application/x-magnolia-docs') ||
                          e.dataTransfer.types.includes('application/x-magnolia-doc') ||
                          e.dataTransfer.types.includes('application/x-magnolia-doc-reorder')) {
                        e.preventDefault()
                        e.stopPropagation()
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      const multi = e.dataTransfer.getData('application/x-magnolia-docs')
                      const single = e.dataTransfer.getData('application/x-magnolia-doc-reorder') || e.dataTransfer.getData('application/x-magnolia-doc')
                      let guids: string[] = []
                      try {
                        if (multi) guids = JSON.parse(multi)
                        else if (single && single.startsWith('{')) guids = [JSON.parse(single).guid]
                        else if (single) guids = [single]
                      } catch { /* ignore */ }
                      if (guids.length > 0) {
                        setNodes((p) => p.map((nd) => {
                          if (nd.id !== node.id) return nd
                          const existing = new Set(nd.docGuids || [])
                          const newGuids = guids.filter((g) => !existing.has(g))
                          return { ...nd, docGuids: [...(nd.docGuids || []), ...newGuids] }
                        }))
                      }
                    }}
                    style={{
                      height: DROP_ZONE_H, lineHeight: `${DROP_ZONE_H}px`,
                      textAlign: 'center', fontSize: 8, color: 'var(--text-muted)',
                      borderTop: '1px dashed var(--border-color)', margin: '0 4px'
                    }}
                  >
                    {(node.docGuids?.length || 0) === 0 ? 'Drop docs here' : '+ Drop more'}
                  </div>
                </div>
              )}

              {/* Tag node: category → mode → value(s) */}
              {node.kind === 'tag' && (() => {
                const uncatTags = tags.filter((t) => !t.categoryGuid)
                // Derive effective category: use node's value, or auto-select the first
                // category when there are no uncategorised tags (prevents empty value list
                // when the dropdown visually shows a category but state hasn't been set)
                const effectiveCatGuid = node.tagCategoryGuid
                  || (uncatTags.length === 0 && categories.length > 0 ? categories[0].guid : undefined)
                const catTags = effectiveCatGuid
                  ? tags.filter((t) => t.categoryGuid === effectiveCatGuid)
                  : []
                const valueTags = effectiveCatGuid ? catTags : uncatTags
                const cat = effectiveCatGuid ? categories.find((c) => c.guid === effectiveCatGuid) : null
                // Determine if all values in this category are numeric or dates
                const allValues = catTags.map((t) => t.value).filter(Boolean) as string[]
                const isDateCat = cat?.type === 'date' || (allValues.length > 0 && allValues.every((v) => !isNaN(new Date(v.split('/').reverse().join('-')).getTime())))
                const isNumCat = cat?.type === 'numeric' || (!isDateCat && allValues.length > 0 && allValues.every((v) => !isNaN(parseFloat(v))))
                const showModePicker = effectiveCatGuid && (isDateCat || isNumCat) && catTags.length > 1
                const mode = node.betweenMode || 'is'
                const selectStyle: React.CSSProperties = {
                  width: '100%', fontSize: 9, padding: '2px 4px',
                  border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none'
                }
                const modeBtn = (m: 'is' | 'between' | 'not-between', label: string, activeColor: string) => (
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      setNodes((p) => p.map((nd) =>
                        nd.id === node.id ? {
                          ...nd,
                          betweenMode: m,
                          tagGuid2: m === 'is' ? undefined : nd.tagGuid2
                        } : nd
                      ))
                    }}
                    style={{
                      flex: 1, fontSize: 7, padding: '1px 2px', cursor: 'pointer',
                      border: `1px solid ${mode === m ? activeColor : 'var(--border-color)'}`,
                      borderRadius: 'var(--radius-sm)',
                      background: mode === m ? activeColor + '20' : 'var(--bg-primary)',
                      color: mode === m ? activeColor : 'var(--text-secondary)',
                      fontWeight: mode === m ? 700 : 400
                    }}
                  >
                    {label}
                  </button>
                )
                return (
                  <div style={{ padding: '0 6px 4px', pointerEvents: 'auto' }}>
                    {/* 1. Category */}
                    <select
                      value={effectiveCatGuid || '__uncat__'}
                      onChange={(e) => {
                        const val = e.target.value
                        const catGuid = val === '__uncat__' ? undefined : val
                        // Auto-detect if the new category is date/number
                        let newMode: 'is' | undefined = undefined
                        if (catGuid) {
                          const newCat = categories.find((c) => c.guid === catGuid)
                          const newCatTags = tags.filter((t) => t.categoryGuid === catGuid)
                          const vals = newCatTags.map((t) => t.value).filter(Boolean) as string[]
                          const isD = newCat?.type === 'date' || (vals.length > 0 && vals.every((v) => !isNaN(new Date(v.split('/').reverse().join('-')).getTime())))
                          const isN = newCat?.type === 'numeric' || (!isD && vals.length > 0 && vals.every((v) => !isNaN(parseFloat(v))))
                          if ((isD || isN) && newCatTags.length > 1) newMode = 'is'
                        }
                        setNodes((p) => p.map((nd) =>
                          nd.id === node.id ? {
                            ...nd,
                            tagCategoryGuid: catGuid,
                            tagGuid: undefined,
                            tagName: undefined,
                            tagGuid2: undefined,
                            betweenMode: newMode
                          } : nd
                        ))
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => e.stopPropagation()}
                      style={selectStyle}
                    >
                      {categories.length > 0 && (
                        <option value="" disabled>Select category...</option>
                      )}
                      {categories.map((c) => (
                        <option key={c.guid} value={c.guid}>{c.name}</option>
                      ))}
                      {uncatTags.length > 0 && (
                        <option value="__uncat__">Uncategorised</option>
                      )}
                    </select>

                    {/* 2. Mode: Is / Between / Not Between (only for date/number categories) */}
                    {showModePicker && (
                      <div style={{ display: 'flex', gap: 2, marginTop: 3 }}>
                        {modeBtn('is', 'Is', '#6366f1')}
                        {modeBtn('between', 'Between', '#6366f1')}
                        {modeBtn('not-between', 'Not Between', '#f43f5e')}
                      </div>
                    )}

                    {/* 3. Value 1 */}
                    <select
                      value={node.tagGuid || ''}
                      onChange={(e) => {
                        const val = e.target.value
                        const tag = valueTags.find((t) => t.guid === val)
                        setNodes((p) => p.map((nd) =>
                          nd.id === node.id ? {
                            ...nd,
                            tagGuid: val || undefined,
                            tagName: tag?.value || tag?.name || 'Tag',
                            // Sync the effective category onto the node state
                            tagCategoryGuid: nd.tagCategoryGuid || effectiveCatGuid
                          } : nd
                        ))
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => e.stopPropagation()}
                      style={{ ...selectStyle, marginTop: 3 }}
                    >
                      <option value="">Select value...</option>
                      {valueTags.map((t) => (
                        <option key={t.guid} value={t.guid}>{t.value || t.name}</option>
                      ))}
                    </select>

                    {/* 4. "and" + Value 2 (only for between / not-between) */}
                    {(mode === 'between' || mode === 'not-between') && (
                      <>
                      <div style={{ textAlign: 'center', fontSize: 8, color: 'var(--text-muted)', fontStyle: 'italic', marginTop: 2, lineHeight: '12px' }}>and</div>
                      <select
                        value={node.tagGuid2 || ''}
                        onChange={(e) => {
                          setNodes((p) => p.map((nd) =>
                            nd.id === node.id ? { ...nd, tagGuid2: e.target.value || undefined } : nd
                          ))
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        style={{ ...selectStyle, marginTop: 2 }}
                      >
                        <option value="">Select value 2...</option>
                        {catTags.filter((t) => t.guid !== node.tagGuid).map((t) => (
                          <option key={t.guid} value={t.guid}>{t.value || t.name}</option>
                        ))}
                      </select>
                      </>
                    )}
                  </div>
                )
              })()}

              {/* Type node: dropdown */}
              {node.kind === 'type' && (
                <div style={{ padding: '0 6px 4px', pointerEvents: 'auto' }}>
                  <select
                    value={node.typeExt || ''}
                    onChange={(e) => {
                      setNodes((p) => p.map((nd) =>
                        nd.id === node.id ? { ...nd, typeExt: e.target.value || undefined } : nd
                      ))
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      width: '100%', fontSize: 9, padding: '2px 4px',
                      border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)',
                      background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none'
                    }}
                  >
                    <option value="">Select type...</option>
                    <option value="video">Video</option>
                    <option value="audio">Audio</option>
                    <option value="document">Document</option>
                    <option value="image">Image</option>
                  </select>
                </div>
              )}

              {node.kind === 'folder' && (
                <div style={{ padding: '0 6px 4px', pointerEvents: 'auto' }}>
                  <select
                    value={node.folderGuid || ''}
                    onChange={(e) => {
                      setNodes((p) => p.map((nd) =>
                        nd.id === node.id ? { ...nd, folderGuid: e.target.value || undefined } : nd
                      ))
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      width: '100%', fontSize: 9, padding: '2px 4px',
                      border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)',
                      background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none'
                    }}
                  >
                    <option value="">Select folder...</option>
                    {folderOptions.map((f) => (
                      <option key={f.guid} value={f.guid}>{f.label}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* SetOp node: variable slots with operator dropdowns */}
              {node.kind === 'setOp' && (() => {
                const ops = node.setOps ?? [undefined]
                const slots = ops.length + 1
                const items: React.ReactNode[] = []
                for (let i = 0; i < slots; i++) {
                  const name = portLabel(i)
                  items.push(
                    <div
                      key={`slot-${i}`}
                      style={{
                        height: SLOT_H, lineHeight: `${SLOT_H}px`,
                        paddingLeft: PORT_R + 6, fontSize: 9,
                        color: name ? 'var(--text-primary)' : 'var(--text-secondary)',
                        fontWeight: name ? 600 : 400,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        pointerEvents: 'none'
                      }}
                    >
                      {name || `Input ${i + 1}`}
                    </div>
                  )
                  if (i < ops.length) {
                    const opIdx = i
                    const op = ops[opIdx]
                    items.push(
                      <div key={`op-${i}`} style={{ height: LABEL_H, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
                        <select
                          value={op || ''}
                          title={op ? SET_OP_TOOLTIP[op] : 'Select an operator'}
                          onChange={(e) => {
                            const val = e.target.value as SetOp | ''
                            setNodes((p) => p.map((nd) => {
                              if (nd.id !== node.id) return nd
                              const newOps = [...(nd.setOps ?? [undefined])]
                              newOps[opIdx] = val ? (val as SetOp) : undefined
                              return { ...nd, setOps: newOps }
                            }))
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            fontSize: 8, fontWeight: 700,
                            color: op ? SET_OP_COLOR[op] : 'var(--text-secondary)',
                            background: 'var(--bg-primary)',
                            border: `1px solid ${op ? SET_OP_COLOR[op] + '66' : 'var(--border-color)'}`,
                            borderRadius: 'var(--radius-sm)',
                            padding: '0 2px', cursor: 'pointer',
                            textAlign: 'center', letterSpacing: 0.5, fontStyle: 'italic', outline: 'none'
                          }}
                        >
                          <option value="" disabled>Operator...</option>
                          <option value="union">Union (1 + 2)</option>
                          <option value="intersect">Intersect (1 ∩ 2)</option>
                          <option value="subtract">Subtract (1 − 2)</option>
                        </select>
                        {ops.length > 1 && (
                          <span
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation()
                              const removedPort = opIdx === 0 ? 0 : opIdx + 1
                              setNodes((p) => p.map((nd) => {
                                if (nd.id !== node.id) return nd
                                const newOps = [...(nd.setOps ?? [undefined])]
                                newOps.splice(opIdx, 1)
                                return { ...nd, setOps: newOps }
                              }))
                              setConns((p) =>
                                p.filter((c) => !(c.to === node.id && c.toPort === removedPort))
                                  .map((c) => c.to === node.id && c.toPort > removedPort ? { ...c, toPort: c.toPort - 1 } : c)
                              )
                            }}
                            style={{ fontSize: 9, color: 'var(--text-muted)', cursor: 'pointer', lineHeight: 1, opacity: 0.6 }}
                          >
                            <Icon icon={faXmark} />
                          </span>
                        )}
                      </div>
                    )
                  }
                }
                items.push(
                  <div
                    key="add-btn"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      setNodes((p) => p.map((nd) => {
                        if (nd.id !== node.id) return nd
                        return { ...nd, setOps: [...(nd.setOps ?? [undefined]), undefined] }
                      }))
                    }}
                    style={{
                      height: ADD_BTN_H, lineHeight: `${ADD_BTN_H}px`,
                      textAlign: 'center', fontSize: 8,
                      color: 'var(--accent-primary)', cursor: 'pointer', opacity: 0.7
                    }}
                  >
                    + Add input...
                  </div>
                )
                return <div>{items}</div>
              })()}

              {/* ── Ports ── */}

              {/* Output port (not on result) */}
              {node.kind !== 'result' && (
                <div
                  onMouseDown={(e) => portDown(e, node.id, 'out', 0)}
                  style={{
                    position: 'absolute',
                    left: w - PORT_R - 6, top: h / 2 - PORT_R - 6,
                    width: PORT_R * 2 + 12, height: PORT_R * 2 + 12,
                    cursor: 'crosshair', zIndex: 10,
                    display: 'flex', alignItems: 'center', justifyContent: 'center'
                  }}
                >
                  <div style={{
                    width: PORT_R * 2, height: PORT_R * 2, borderRadius: '50%',
                    background: hasOut ? 'var(--text-muted)' : 'var(--bg-tertiary)',
                    border: '1.5px solid var(--text-muted)'
                  }} />
                </div>
              )}

              {/* Input ports */}
              {(node.kind === 'setOp' || node.kind === 'result') &&
                Array.from({ length: inputSlots(node) }).map((_, i) => {
                  const [, portY] = inPortXY(node, i)
                  const topPx = portY - node.y - PORT_R - 6
                  return (
                    <div
                      key={i}
                      onMouseDown={(e) => portDown(e, node.id, 'in', i)}
                      style={{
                        position: 'absolute',
                        left: -PORT_R - 6, top: topPx,
                        width: PORT_R * 2 + 12, height: PORT_R * 2 + 12,
                        cursor: 'crosshair', zIndex: 10,
                        display: 'flex', alignItems: 'center', justifyContent: 'center'
                      }}
                    >
                      <div style={{
                        width: PORT_R * 2, height: PORT_R * 2, borderRadius: '50%',
                        background: connectedIn.has(i) ? 'var(--text-muted)' : 'var(--bg-tertiary)',
                        border: '1.5px solid var(--text-muted)'
                      }} />
                    </div>
                  )
                })}
            </div>
          )
        })}

        {/* Marquee */}
        {marqueeRect && (
          <div style={{
            position: 'absolute',
            left: marqueeRect.x + pan.x, top: marqueeRect.y + pan.y,
            width: marqueeRect.w, height: marqueeRect.h,
            border: '1.5px dashed var(--accent-primary)',
            background: 'rgba(99, 102, 241, 0.08)',
            borderRadius: 2, pointerEvents: 'none', zIndex: 60
          }} />
        )}

        {/* Temp wire */}
        <svg style={{ position: 'absolute', inset: 0, width: 4000, height: 4000, pointerEvents: 'none', zIndex: 50 }}>
          <path ref={wireRef} fill="none" stroke="#a78bfa" strokeWidth={3} strokeDasharray="8,5" style={{ display: 'none' }} />
        </svg>
        </div>{/* end pan wrapper */}

        {/* Re-centre button — always visible so the user can snap back
            even when the canvas hasn't been panned far enough to trip
            the showRecentre heuristic. */}
        <button
          onClick={(e) => { e.stopPropagation(); handleCentre() }}
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            zIndex: 70,
            fontSize: 10,
            padding: '3px 8px',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border-color)',
            background: 'var(--bg-panel)',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            opacity: 0.85
          }}
        >
          Re-centre
        </button>
      </div>

      {/* ── Selected Documents pane ── */}
      <div style={{
        width: 170,
        flexShrink: 0,
        height: CANVAS_H,
        border: '1px solid var(--border-color)',
        borderRadius: 'var(--radius-md)',
        display: 'flex',
        flexDirection: 'column'
      }}>
        <div style={{
          padding: '6px 8px',
          fontSize: 11,
          fontWeight: 600,
          borderBottom: '1px solid var(--border-color)',
          background: 'var(--bg-secondary)',
          borderRadius: 'var(--radius-md) var(--radius-md) 0 0'
        }}>
          Selected Documents
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 4 }}>
          {resolvedGuids.length === 0 ? (
            <div className="empty-state" style={{ padding: '8px 6px', fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic' }}>
              No documents selected. Connect nodes to Result.
            </div>
          ) : (
            <>
              {resolvedGuids.map((guid) => {
                const scope = surveyScopeByGuid.get(guid)
                const narrowed = scope && (scope.respondents.length > 0 || scope.questions.length > 0)
                return (
                  <div key={guid} style={{ padding: '2px 0' }}>
                    <div
                      style={{
                        padding: '0 6px',
                        fontSize: 10,
                        color: 'var(--text-primary)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                      }}
                    >
                      {sourceMap.get(guid) || '(deleted document)'}
                    </div>
                    {narrowed && (
                      <div style={{ padding: '1px 6px 0 16px', fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.5, whiteSpace: 'normal' }}>
                        {scope!.respondents.length > 0 && (
                          <div>
                            <div style={{ fontWeight: 600 }}>Respondents ({scope!.respondents.length}):</div>
                            {scopeListItems(scope!.respondents).map((label, i) => (
                              <div key={i} style={{ paddingLeft: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>• {label}</div>
                            ))}
                          </div>
                        )}
                        {scope!.questions.length > 0 && (
                          <div style={{ marginTop: scope!.respondents.length > 0 ? 2 : 0 }}>
                            <div style={{ fontWeight: 600 }}>Questions ({scope!.questions.length}):</div>
                            {scopeListItems(scope!.questions).map((label, i) => (
                              <div key={i} style={{ paddingLeft: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>• {label}</div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
              <div style={{ padding: '4px 6px', fontSize: 9, color: 'var(--text-muted)', borderTop: '1px solid var(--border-color)', marginTop: 4 }}>
                {resolvedGuids.length} document{resolvedGuids.length !== 1 ? 's' : ''}
              </div>
            </>
          )}
        </div>
      </div>
      </div>

      {/* ── Status bar ── */}
      <div style={{ marginTop: 6, fontSize: 10, color: 'var(--text-muted)' }}>
        {selNodes.size > 1
          ? `${selNodes.size} selected — ⌘C copy · ⌘V paste · Delete to remove`
          : 'Drag documents & tags onto canvas · Connect nodes to Result'}
      </div>
    </div>
  )
}
