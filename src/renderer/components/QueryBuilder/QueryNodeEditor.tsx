import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import type { CodeCondition } from '../../models/types'
import { validateCondition } from '../../utils/query-engine'
import { Icon, faExclamationTriangle, faCircle, faXmark } from '../Icon'
import { PaletteGroup, PaletteDivider, PaletteButton } from '../NodePalette'

/* ═══════════════════════════════════════════════════
   Types
   ═══════════════════════════════════════════════════ */

type NodeKind = 'code' | 'any' | 'text' | 'logical' | 'overlap' | 'inside' | 'outside' | 'before' | 'followedBy' | 'result'

type LogicalOp = 'and' | 'or' | 'not' | 'xor'

interface GNode {
  id: string
  kind: NodeKind
  x: number
  y: number
  codeGuid?: string
  codeName?: string
  codeColor?: string
  includeSubcodes?: boolean
  searchText?: string
  caseSensitive?: boolean
  wholeWord?: boolean
  /** For logical nodes: the single operator type */
  logicalOp?: LogicalOp
  /** @deprecated — old multi-op array, migrated to logicalOp on load */
  logicalOps?: (LogicalOp | undefined)[]
  /** For multi-input operators (and/or): how many input slots */
  inputCount?: number
  /** Inline NOT toggle — wraps this node's condition in { type: 'not' } */
  isNegated?: boolean
}

interface GConn {
  id: string
  from: string
  to: string
  toPort: number
}

type DragState =
  | null
  | { t: 'node'; id: string; ox: number; oy: number }
  | { t: 'wire'; fromId: string }
  | { t: 'marquee'; sx: number; sy: number; cx: number; cy: number }

/* ═══════════════════════════════════════════════════
   Constants
   ═══════════════════════════════════════════════════ */

const CODE_W = 140
const TEXT_W = 160
const OP_W = 140
const PORT_R = 6
const SLOT_H = 22
const HDR_H = 24
const CODE_H = 34
const TEXT_H = 82
const RESULT_H = 36
const LABEL_H = 20 // height of the operator echo/dropdown between slots
const ADD_BTN_H = 20 // height of the "+ Add condition" button row
const CANVAS_H = 400

const KIND_COLOR: Record<NodeKind, string> = {
  code: '#6b7280',
  any: '#8b5cf6',
  text: '#d97706',
  logical: '#6366f1',
  overlap: '#ef4444',
  inside: '#f59e0b',
  outside: '#eab308',
  before: '#22c55e',
  followedBy: '#06b6d4',
  result: '#8b5cf6'
}

const KIND_LABEL: Record<NodeKind, string> = {
  code: '',
  any: 'Any code',
  text: 'Text',
  logical: 'Logical',
  overlap: 'Overlapping',
  inside: 'Inside',
  outside: 'Outside',
  before: 'Before',
  followedBy: 'Followed by',
  result: 'Result'
}

const LOGICAL_OP_LABEL: Record<LogicalOp, string> = {
  and: 'AND',
  or: 'OR',
  not: 'NOT',
  xor: 'XOR'
}

const LOGICAL_OP_COLOR: Record<LogicalOp, string> = {
  and: '#6366f1',
  or: '#10b981',
  not: '#f43f5e',
  xor: '#0ea5e9'
}

const LOGICAL_OP_TOOLTIP: Record<LogicalOp, string> = {
  and: 'AND — all inputs must be true for the same selection',
  or: 'OR — at least one input must be true',
  not: 'NOT — inverts the input (all segments that do NOT match)',
  xor: 'XOR — exactly one input must be true, but not both'
}

/** How many input slots each operator accepts */
const LOGICAL_OP_SLOTS: Record<LogicalOp, { min: number; max: number }> = {
  and: { min: 2, max: 10 },
  or: { min: 2, max: 10 },
  not: { min: 1, max: 1 },
  xor: { min: 2, max: 2 }
}

const SPATIAL_KINDS: NodeKind[] = ['overlap', 'inside', 'outside', 'before', 'followedBy']
const DUAL_CODE_KINDS: NodeKind[] = ['logical', ...SPATIAL_KINDS]

const KIND_TOOLTIP: Record<NodeKind, string> = {
  code: '',
  any: 'Matches any coded selection (wildcard)',
  text: 'Search for a word or phrase in the document text',
  logical: 'Combine inputs with AND, OR, NOT, or XOR',
  overlap: 'The text where a Code 1 selection and a Code 2 selection physically overlap',
  inside: 'Code 1 selections that are fully contained within a Code 2 selection',
  outside: 'Code 1 selections that do not overlap with any Code 2 selection',
  before: 'Input 1 selections that end before an Input 2 selection starts, with no overlap between them',
  followedBy: 'Input 1 selections that start after an Input 2 selection ends, with no overlap between them',
  result: 'The final query output'
}

/* ═══════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════ */

let _uid = 1
const uid = () => `qn${_uid++}`

/** Advance _uid past any numeric IDs already used in a graph */
function advanceUidPast(nodes: GNode[], conns: GConn[]): void {
  let max = 0
  for (const n of nodes) {
    const m = n.id.match(/^qn(\d+)$/)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  for (const c of conns) {
    const m = c.id.match(/^qn(\d+)$/)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  if (max >= _uid) _uid = max + 1
}

/**
 * Clamp pan so content always stays substantially visible.
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
  const clampedX = Math.max(cw * 0.25 - maxX, Math.min(cw * 0.75 - minX, nx))
  const clampedY = Math.max(ch * 0.25 - maxY, Math.min(ch * 0.75 - minY, ny))
  return { x: clampedX, y: clampedY }
}

function nodeW(n: GNode) {
  if (n.kind === 'code' || n.kind === 'any') return CODE_W
  if (n.kind === 'text') return TEXT_W
  return OP_W
}

/** Extra height a code node needs when its name wraps to multiple lines.
 *  The label sits in a row with an 8px dot, a 32px NOT button, and padding;
 *  divide the remaining width by an approximate char width at fontSize 11. */
function codeLabelLineHeight(name: string): number {
  const usable = CODE_W - 16 /* padding */ - 12 /* dot + gap */ - 36 /* NOT button + gap */
  const charsPerLine = Math.max(1, Math.floor(usable / 6.5))
  const lines = Math.max(1, Math.ceil(name.length / charsPerLine))
  return (lines - 1) * 14
}

function logicalSlotCount(n: GNode): number {
  const op = n.logicalOp
  if (!op) return 2 // default
  const slots = LOGICAL_OP_SLOTS[op]
  if (op === 'and' || op === 'or') return n.inputCount ?? slots.min
  return slots.min
}

function inputSlots(n: GNode): number {
  if (n.kind === 'code' || n.kind === 'any' || n.kind === 'text') return 0
  if (n.kind === 'result') return 1
  if (n.kind === 'logical') return logicalSlotCount(n)
  if (SPATIAL_KINDS.includes(n.kind)) return 2
  return 0
}

function nodeH(n: GNode): number {
  if (n.kind === 'any') return CODE_H
  if (n.kind === 'code') return CODE_H + codeLabelLineHeight(n.codeName || 'Code')
  if (n.kind === 'text') return TEXT_H
  if (n.kind === 'result') return RESULT_H
  if (n.kind === 'logical') {
    const slots = logicalSlotCount(n)
    const canAddMore = n.logicalOp && (n.logicalOp === 'and' || n.logicalOp === 'or')
    return HDR_H + SLOT_H /* op select */ + slots * SLOT_H + (canAddMore ? ADD_BTN_H : 0) + 6
  }
  if (SPATIAL_KINDS.includes(n.kind)) return HDR_H + 2 * SLOT_H + LABEL_H + 6
  return HDR_H
}

function outPortXY(n: GNode): [number, number] {
  return [n.x + nodeW(n), n.y + nodeH(n) / 2]
}

function inPortXY(n: GNode, i: number): [number, number] {
  if (n.kind === 'result') {
    return [n.x, n.y + nodeH(n) / 2]
  }
  if (SPATIAL_KINDS.includes(n.kind)) {
    // Spatial: HDR_H + i * (SLOT_H + LABEL_H) + SLOT_H/2
    return [n.x, n.y + HDR_H + i * (SLOT_H + LABEL_H) + SLOT_H / 2]
  }
  if (n.kind === 'logical') {
    // Logical: HDR_H + operator_select(SLOT_H) + i * SLOT_H + SLOT_H/2
    return [n.x, n.y + HDR_H + SLOT_H + i * SLOT_H + SLOT_H / 2]
  }
  return [n.x, n.y + HDR_H + i * SLOT_H + SLOT_H / 2]
}

function bezPath(x1: number, y1: number, x2: number, y2: number): string {
  const d = Math.max(Math.abs(x2 - x1) * 0.4, 40)
  return `M${x1},${y1} C${x1 + d},${y1} ${x2 - d},${y2} ${x2},${y2}`
}

function wouldCycle(fromId: string, toId: string, cc: GConn[]): boolean {
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

/* Graph → CodeCondition */

function graphToCondition(nodes: GNode[], cc: GConn[], codes?: CodeInfo[]): CodeCondition | null {
  const res = nodes.find((n) => n.kind === 'result')
  if (!res) return null
  const inp = cc.find((c) => c.to === res.id)
  if (!inp) return null
  return walkNode(inp.from, nodes, cc, new Set(), codes)
}

function walkNode(
  id: string,
  nodes: GNode[],
  cc: GConn[],
  visited: Set<string>,
  codes?: CodeInfo[]
): CodeCondition | null {
  if (visited.has(id)) return null
  visited.add(id)
  const n = nodes.find((nd) => nd.id === id)
  if (!n) return null

  let result: CodeCondition | null = null

  if (n.kind === 'code') {
    if (!n.codeGuid) return null
    // Store the compact intent: a single code condition carrying the
    // includeSubcodes flag. The query engine expands it to the code + its
    // descendants at run time, so the saved condition (and the name derived
    // from it) stays readable as "<code> (incl. subcodes)" instead of a long
    // OR of every subcode.
    result = n.includeSubcodes
      ? { type: 'code', codeGuid: n.codeGuid, includeSubcodes: true }
      : { type: 'code', codeGuid: n.codeGuid }
  } else if (n.kind === 'any') {
    result = { type: 'any' }
  } else if (n.kind === 'text') {
    result = n.searchText ? { type: 'text', searchText: n.searchText, caseSensitive: n.caseSensitive || undefined, wholeWord: n.wholeWord || undefined } : null
  } else if (n.kind === 'logical') {
    const op = n.logicalOp
    if (!op) return null
    const ins = cc
      .filter((c) => c.to === id)
      .sort((a, b) => a.toPort - b.toPort)
    const children = ins.map((conn) => walkNode(conn.from, nodes, cc, visited, codes)).filter(Boolean) as CodeCondition[]

    if (op === 'not') {
      return children[0] ? { type: 'not', condition: children[0] } : null
    }
    if (children.length < 2) return children[0] || null
    return { type: op, conditions: children }
  } else if (DUAL_CODE_KINDS.includes(n.kind)) {
    const ins = cc
      .filter((c) => c.to === id)
      .sort((a, b) => a.toPort - b.toPort)
    if (ins.length < 2) return null
    const ch1 = walkNode(ins[0].from, nodes, cc, visited, codes)
    const ch2 = walkNode(ins[1].from, nodes, cc, visited, codes)
    if (!ch1 || !ch2) return null
    result = {
      type: n.kind as 'overlap' | 'inside' | 'outside' | 'before' | 'followedBy',
      condition1: ch1,
      condition2: ch2
    }
  }

  // Inline NOT toggle: wrap the result in a NOT condition
  if (result && n.isNegated) {
    result = { type: 'not', condition: result }
  }

  return result
}

/* ═══════════════════════════════════════════════════
   Condition → Graph (for editing saved queries)
   ═══════════════════════════════════════════════════ */

interface CodeInfo {
  guid: string
  name: string
  color?: string
  isCodable: boolean
  parentGuid?: string
}

/** Detect a saved "And subcodes" expansion: an OR whose members are exactly
 *  a parent code plus all of its descendant codes. graphToCondition flattens
 *  an includeSubcodes node into precisely that OR, so a query saved WITHOUT a
 *  graphLayout (older saves, or saves made from the results-panel "Save
 *  Query" dialog) has only the expanded OR to rebuild from. Returns the
 *  parent guid to collapse back to, or null when the OR isn't a clean
 *  subcode expansion (a genuine multi-code OR, mixed types, etc.). */
function detectSubcodeExpansion(
  conditions: CodeCondition[],
  codeMap: Map<string, CodeInfo>
): string | null {
  if (conditions.length < 2) return null
  if (!conditions.every((c) => c.type === 'code')) return null
  const guids = new Set((conditions as { type: 'code'; codeGuid: string }[]).map((c) => c.codeGuid))
  if (guids.size !== conditions.length) return null // duplicate members → not a clean expansion
  // For each member, compute {itself + all descendants} (matching how
  // graphToCondition collects them) and see if it equals the member set.
  for (const parentGuid of guids) {
    const expected = new Set<string>([parentGuid])
    const stack = [parentGuid]
    while (stack.length) {
      const p = stack.pop()!
      for (const code of codeMap.values()) {
        if (code.parentGuid === p && !expected.has(code.guid)) {
          expected.add(code.guid)
          stack.push(code.guid)
        }
      }
    }
    if (expected.size === guids.size && [...expected].every((g) => guids.has(g))) {
      return parentGuid
    }
  }
  return null
}

function conditionToGraph(
  cond: CodeCondition,
  codes: CodeInfo[]
): { nodes: GNode[]; conns: GConn[] } {
  const codeMap = new Map<string, CodeInfo>()
  for (const c of codes) codeMap.set(c.guid, c)

  const nodes: GNode[] = []
  const conns: GConn[] = []

  const COL_W = 200
  const ROW_GAP = 24
  let yCursor = 30

  // Build subtree; returns { id, yMin, yMax } for centering parent nodes
  function buildNode(
    c: CodeCondition,
    col: number
  ): { id: string; yMin: number; yMax: number } {
    if (c.type === 'code') {
      const code = codeMap.get(c.codeGuid)
      const id = uid()
      const y = yCursor
      nodes.push({
        id,
        kind: 'code',
        x: col * COL_W,
        y,
        codeGuid: c.codeGuid,
        codeName: code?.name || 'Code',
        codeColor: code?.color,
        // Restore the "And subcodes" checkbox straight from the condition
        // (new compact form). Legacy OR-expanded queries are handled by the
        // detectSubcodeExpansion collapse in the and/or/xor branch below.
        ...(c.includeSubcodes ? { includeSubcodes: true } : {})
      })
      yCursor += CODE_H + ROW_GAP
      return { id, yMin: y, yMax: y + CODE_H }
    }

    if (c.type === 'any') {
      const id = uid()
      const y = yCursor
      nodes.push({ id, kind: 'any', x: col * COL_W, y })
      yCursor += CODE_H + ROW_GAP
      return { id, yMin: y, yMax: y + CODE_H }
    }

    if (c.type === 'text') {
      const id = uid()
      const y = yCursor
      nodes.push({
        id,
        kind: 'text',
        x: col * COL_W,
        y,
        searchText: c.searchText,
        caseSensitive: c.caseSensitive,
        wholeWord: c.wholeWord
      })
      yCursor += TEXT_H + ROW_GAP
      return { id, yMin: y, yMax: y + TEXT_H }
    }

    if (c.type === 'not') {
      // For simple child conditions, use inline isNegated toggle instead of a separate NOT node
      const ct = c.condition.type
      if (ct === 'code' || ct === 'any' || ct === 'text' || DUAL_CODE_KINDS.includes(ct as any)) {
        const child = buildNode(c.condition, col)
        const childNode = nodes.find((nd) => nd.id === child.id)
        if (childNode) childNode.isNegated = true
        return child
      }
      // For compound children (and/or/xor/not), use a dedicated NOT logical node
      const child = buildNode(c.condition, col)
      const id = uid()
      const stub: GNode = { id, kind: 'logical', x: 0, y: 0, logicalOp: 'not', inputCount: 1 }
      const h = nodeH(stub)
      const cy = (child.yMin + child.yMax) / 2 - h / 2
      stub.x = (col + 1) * COL_W
      stub.y = cy
      nodes.push(stub)
      conns.push({ id: uid(), from: child.id, to: id, toPort: 0 })
      return { id, yMin: Math.min(child.yMin, cy), yMax: Math.max(child.yMax, cy + h) }
    }

    if (c.type === 'and' || c.type === 'or' || c.type === 'xor') {
      // Backward-compat: an OR that is exactly a parent code + all its
      // subcodes is a saved "And subcodes" expansion. Collapse it to one
      // includeSubcodes node so queries without a graphLayout don't reopen
      // as one node per subcode. (Newer saves carry a graphLayout, which
      // takes precedence over this whole reconstruction.)
      if (c.type === 'or') {
        const parentGuid = detectSubcodeExpansion(c.conditions, codeMap)
        if (parentGuid) {
          const code = codeMap.get(parentGuid)
          const id = uid()
          const y = yCursor
          nodes.push({
            id,
            kind: 'code',
            x: col * COL_W,
            y,
            codeGuid: parentGuid,
            codeName: code?.name || 'Code',
            codeColor: code?.color,
            includeSubcodes: true
          })
          yCursor += CODE_H + ROW_GAP
          return { id, yMin: y, yMax: y + CODE_H }
        }
      }
      // Flatten: if AND contains NOT children, expand them as separate inputs
      // (the user wires NOT nodes into AND to get AND NOT behavior)
      const directChildren: CodeCondition[] = c.conditions

      const childResults = directChildren.map((ch) => buildNode(ch, col))
      const yMin = Math.min(...childResults.map((r) => r.yMin))
      const yMax = Math.max(...childResults.map((r) => r.yMax))

      const id = uid()
      const stub: GNode = { id, kind: 'logical', x: 0, y: 0, logicalOp: c.type as LogicalOp, inputCount: directChildren.length }
      const h = nodeH(stub)
      stub.x = (col + 1) * COL_W
      stub.y = (yMin + yMax) / 2 - h / 2
      nodes.push(stub)

      for (let i = 0; i < childResults.length; i++) {
        conns.push({ id: uid(), from: childResults[i].id, to: id, toPort: i })
      }
      return { id, yMin: Math.min(yMin, stub.y), yMax: Math.max(yMax, stub.y + h) }
    }

    // Legacy butnot — map to outside spatial node
    if (c.type === 'butnot' as any) {
      const cAny = c as any
      const child1 = buildNode(cAny.condition1, col)
      const child2 = buildNode(cAny.condition2, col)
      const yMin = Math.min(child1.yMin, child2.yMin)
      const yMax = Math.max(child1.yMax, child2.yMax)
      const id = uid()
      const stub: GNode = { id, kind: 'outside', x: 0, y: 0 }
      const h = nodeH(stub)
      stub.x = (col + 1) * COL_W
      stub.y = (yMin + yMax) / 2 - h / 2
      nodes.push(stub)
      conns.push({ id: uid(), from: child1.id, to: id, toPort: 0 })
      conns.push({ id: uid(), from: child2.id, to: id, toPort: 1 })
      return { id, yMin: Math.min(yMin, stub.y), yMax: Math.max(yMax, stub.y + h) }
    }

    // Spatial dual-input kinds: overlap, inside, outside, before, followedBy
    if ('condition1' in c && 'condition2' in c) {
      const child1 = buildNode(c.condition1, col)
      const child2 = buildNode(c.condition2, col)
      const yMin = Math.min(child1.yMin, child2.yMin)
      const yMax = Math.max(child1.yMax, child2.yMax)

      const id = uid()
      const kind = c.type as NodeKind
      const stub: GNode = { id, kind, x: 0, y: 0 }
      const h = nodeH(stub)
      stub.x = (col + 1) * COL_W
      stub.y = (yMin + yMax) / 2 - h / 2
      nodes.push(stub)

      conns.push({ id: uid(), from: child1.id, to: id, toPort: 0 })
      conns.push({ id: uid(), from: child2.id, to: id, toPort: 1 })
      return { id, yMin: Math.min(yMin, stub.y), yMax: Math.max(yMax, stub.y + h) }
    }

    // Fallback
    const id = uid()
    nodes.push({ id, kind: 'code', x: col * COL_W, y: yCursor })
    yCursor += CODE_H + ROW_GAP
    return { id, yMin: yCursor - CODE_H - ROW_GAP, yMax: yCursor - ROW_GAP }
  }

  const root = buildNode(cond, 0)

  // Add result node to the right of the tree
  const maxX = nodes.reduce((mx, n) => Math.max(mx, n.x + nodeW(n)), 0)
  const resY = (root.yMin + root.yMax) / 2 - RESULT_H / 2
  nodes.push({ id: 'result', kind: 'result', x: maxX + 100, y: resY })
  conns.push({ id: uid(), from: root.id, to: 'result', toPort: 0 })

  return { nodes, conns }
}

/* ═══════════════════════════════════════════════════
   Component
   ═══════════════════════════════════════════════════ */

interface Props {
  onChange: (condition: CodeCondition | null) => void
  onGraphChange?: (graph: { nodes: any[]; conns: any[] }) => void
  initialCondition?: CodeCondition
  initialGraphLayout?: { nodes: any[]; conns: any[] }
  codes?: CodeInfo[]
}

export function QueryNodeEditor({ onChange, onGraphChange, initialCondition, initialGraphLayout, codes }: Props) {
  const canvasRef = useRef<HTMLDivElement>(null)
  const wireRef = useRef<SVGPathElement>(null)

  // Build initial graph ONCE so node IDs in conns match the node IDs in nodes
  const computedGraph = useRef((() => {
    const g = initialGraphLayout
      ? initialGraphLayout
      : initialCondition && codes
        ? conditionToGraph(initialCondition, codes)
        : null
    if (g) advanceUidPast(g.nodes as GNode[], g.conns as GConn[])
    return g
  })())
  const [nodes, setNodes] = useState<GNode[]>(
    () => {
      const loaded = (computedGraph.current?.nodes as GNode[]) ?? [{ id: 'result', kind: 'result', x: 580, y: 170 }]
      // Migrate old logicalOps array to new logicalOp single-operator model
      return loaded.map((n) => {
        if (n.kind === 'logical' && n.logicalOps && !n.logicalOp) {
          // Take the first defined op from the old array
          const firstOp = n.logicalOps.find((o) => o != null)
          const legacy = firstOp as string | undefined
          const op: LogicalOp = legacy === 'andnot' || legacy === 'not'
            ? 'and'
            : legacy === 'butnot'
              ? 'or'
              : (firstOp || 'and')
          const count = (n.logicalOps.length ?? 0) + 1
          return { ...n, logicalOp: op, inputCount: count, logicalOps: undefined }
        }
        return n
      })
    }
  )
  const [conns, setConns] = useState<GConn[]>(
    () => (computedGraph.current?.conns as GConn[]) ?? []
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
  const selNodesRef = useRef(selNodes)
  selNodesRef.current = selNodes

  /* --- canvas coords (adjusted for pan) --- */
  const cpos = useCallback(
    (e: MouseEvent | React.MouseEvent): [number, number] => {
      const r = canvasRef.current?.getBoundingClientRect()
      return r ? [e.clientX - r.left - panRef.current.x, e.clientY - r.top - panRef.current.y] : [0, 0]
    },
    []
  )

  /* --- set drag + update wire visibility --- */
  const setDrag = useCallback((d: DragState) => {
    dragRef.current = d
    if (wireRef.current) {
      wireRef.current.style.display = d?.t === 'wire' ? '' : 'none'
    }
    if (d?.t !== 'marquee') setMarqueeRect(null)
  }, [])

  /* --- update the temp wire path directly in DOM --- */
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
  const addOp = useCallback((kind: NodeKind) => {
    setNodes((p) => [
      ...p,
      {
        id: uid(),
        kind,
        x: -panRef.current.x + 260 + Math.random() * 60,
        y: -panRef.current.y + 50 + ((p.length * 55) % 300),
        ...(kind === 'logical' ? { logicalOp: undefined, inputCount: 2 } : {})
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
      toDelete.delete('result') // never delete the result node
      if (toDelete.size === 0) return
      setConns((p) =>
        p.filter((c) => !toDelete.has(c.from) && !toDelete.has(c.to))
      )
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
    const payload = JSON.stringify({ _magnoliaNodes: true, nodes: copyNodes, conns: copyConns })
    navigator.clipboard.writeText(payload).catch(() => {})
  }, [selNodes])

  const doPaste = useCallback(() => {
    navigator.clipboard.readText().then((text) => {
      try {
        const data = JSON.parse(text)
        if (!data._magnoliaNodes || !Array.isArray(data.nodes)) return
        const pastedNodes = data.nodes as GNode[]
        const pastedConns = data.conns as GConn[]
        if (pastedNodes.length === 0) return

        // Remap IDs
        const idMap = new Map<string, string>()
        for (const n of pastedNodes) {
          idMap.set(n.id, uid())
        }
        const newNodes = pastedNodes.map((n) => ({
          ...n,
          id: idMap.get(n.id)!,
          x: n.x + 30,
          y: n.y + 30
        }))
        const newConns = pastedConns
          .filter((c) => idMap.has(c.from) && idMap.has(c.to))
          .map((c) => ({
            ...c,
            id: uid(),
            from: idMap.get(c.from)!,
            to: idMap.get(c.to)!
          }))

        setNodes((p) => [...p, ...newNodes])
        setConns((p) => [...p, ...newConns])
        setSelNodes(new Set(newNodes.map((n) => n.id)))
      } catch { /* ignore non-magnolia clipboard */ }
    }).catch(() => {})
  }, [])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      // Exclude contentEditable too (TipTap editors), else this window
      // handler steals Delete/Backspace from rich-text editing.
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        doDelete()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
        doCopy()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
        doPaste()
      }
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
    const cy = (minY + maxY) / 2
    // When the Result node is the only thing on the canvas, anchor it
    // to the right edge — the user builds queries left-to-right, so the
    // empty canvas should leave room on the left for incoming nodes.
    if (ns.length === 1 && ns[0].kind === 'result') {
      const rightMargin = 80
      setPan({ x: el.clientWidth - rightMargin - maxX, y: el.clientHeight / 2 - cy })
    } else {
      const cx = (minX + maxX) / 2
      setPan({ x: el.clientWidth / 2 - cx, y: el.clientHeight / 2 - cy })
    }
    setShowRecentre(false)
  }, [])

  // Auto-centre the canvas on the loaded graph the first time the
  // editor mounts. Queries authored outside the Query tool (e.g.
  // Magnolia-generated drilldowns from Codes in Documents) place
  // their nodes near the origin, so without this they appear stuck
  // in the top-left corner of the canvas.
  useEffect(() => {
    handleCentre()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* --- notify parent --- */
  useEffect(() => {
    onChange(graphToCondition(nodes, conns, codes))
    onGraphChange?.({ nodes, conns })
  }, [nodes, conns])

  /*
   * Document-level mousemove/mouseup for reliable drag tracking.
   * The temp wire is updated via direct DOM manipulation (wireRef)
   * to avoid any React rendering/closure issues.
   */
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      const [mx, my] = cpos(e)

      if (d.t === 'node') {
        // Multi-drag: only if multiple nodes are selected (via Alt/Meta-click or marquee)
        if (selNodesRef.current.size > 1 && selNodesRef.current.has(d.id)) {
          const dx = mx - d.ox - nodesRef.current.find((n) => n.id === d.id)!.x
          const dy = my - d.oy - nodesRef.current.find((n) => n.id === d.id)!.y
          setNodes((p) =>
            p.map((n) =>
              selNodesRef.current.has(n.id)
                ? { ...n, x: n.x + dx, y: n.y + dy }
                : n
            )
          )
        } else {
          setNodes((p) =>
            p.map((n) =>
              n.id === d.id
                ? { ...n, x: mx - d.ox, y: my - d.oy }
                : n
            )
          )
        }
      } else if (d.t === 'wire') {
        updateWire(mx, my)
      } else if (d.t === 'marquee') {
        dragRef.current = { ...d, cx: mx, cy: my }
        const x1 = Math.min(d.sx, mx)
        const y1 = Math.min(d.sy, my)
        const x2 = Math.max(d.sx, mx)
        const y2 = Math.max(d.sy, my)
        setMarqueeRect({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 })
        // Live-preview selection while dragging
        const hit = new Set<string>()
        for (const n of nodesRef.current) {
          const nx2 = n.x + nodeW(n)
          const ny2 = n.y + nodeH(n)
          if (n.x < x2 && nx2 > x1 && n.y < y2 && ny2 > y1) {
            hit.add(n.id)
          }
        }
        setSelNodes(hit)
      }
    }

    const onUp = (e: MouseEvent) => {
      const d = dragRef.current
      if (!d) return

      if (d.t === 'wire') {
        const [mx, my] = cpos(e)
        const cn = connsRef.current
        const nd = nodesRef.current

        for (const n of nd) {
          if (n.kind === 'code' || n.id === d.fromId) continue
          const ic = inputSlots(n)
          for (let i = 0; i < ic; i++) {
            const [px, py] = inPortXY(n, i)
            if (Math.hypot(mx - px, my - py) < 18) {
              if (wouldCycle(d.fromId, n.id, cn)) break
              const cleaned = cn.filter(
                (c) => !(c.to === n.id && c.toPort === i)
              )
              setConns([
                ...cleaned,
                { id: uid(), from: d.fromId, to: n.id, toPort: i }
              ])
              setDrag(null)
              return
            }
          }
        }
      } else if (d.t === 'marquee') {
        // Select all nodes within the marquee rectangle
        const x1 = Math.min(d.sx, d.cx)
        const y1 = Math.min(d.sy, d.cy)
        const x2 = Math.max(d.sx, d.cx)
        const y2 = Math.max(d.sy, d.cy)
        const hit = new Set<string>()
        for (const n of nodesRef.current) {
          const nx2 = n.x + nodeW(n)
          const ny2 = n.y + nodeH(n)
          // Node overlaps marquee
          if (n.x < x2 && nx2 > x1 && n.y < y2 && ny2 > y1) {
            hit.add(n.id)
          }
        }
        if (e.altKey || e.metaKey) {
          // Additive selection
          setSelNodes((prev) => {
            const next = new Set(prev)
            for (const id of hit) next.add(id)
            return next
          })
        } else {
          setSelNodes(hit)
        }
        setMarqueeRect(null)
        lastMarqueeTime.current = Date.now()
      }
      setDrag(null)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [cpos, setDrag, updateWire])

  /* --- port mousedown --- */
  const portDown = useCallback(
    (
      e: React.MouseEvent,
      nodeId: string,
      side: 'out' | 'in',
      idx: number
    ) => {
      e.stopPropagation()
      e.preventDefault()
      const [mx, my] = cpos(e)
      if (side === 'in') {
        const existing = connsRef.current.find(
          (c) => c.to === nodeId && c.toPort === idx
        )
        if (existing) {
          setConns((p) => p.filter((c) => c.id !== existing.id))
          setDrag({ t: 'wire', fromId: existing.from })
          updateWire(mx, my)
        }
        return
      }
      setDrag({ t: 'wire', fromId: nodeId })
      updateWire(mx, my)
    },
    [cpos, setDrag, updateWire]
  )

  /* --- node mousedown --- */
  const nodeDown = useCallback(
    (e: React.MouseEvent, nodeId: string) => {
      e.stopPropagation()
      const [mx, my] = cpos(e)
      const n = nodesRef.current.find((nd) => nd.id === nodeId)
      if (!n) return
      setSelConn(null)

      // Option/Alt-click: toggle in multi-selection
      if (e.altKey || e.metaKey) {
        setSelNodes((prev) => {
          const next = new Set(prev)
          if (next.has(nodeId)) next.delete(nodeId)
          else next.add(nodeId)
          return next
        })
        return
      }

      // If clicking the right third → start a wire
      const localX = mx - n.x
      const w = nodeW(n)
      if (localX > w * 0.65 && n.kind !== 'result') {
        setDrag({ t: 'wire', fromId: nodeId })
        updateWire(mx, my)
        return
      }

      // Select just this node for dragging (unless already multi-selected)
      if (!selNodes.has(nodeId)) {
        setSelNodes(new Set([nodeId]))
      }

      setDrag({ t: 'node', id: nodeId, ox: mx - n.x, oy: my - n.y })
    },
    [cpos, setDrag, updateWire, selNodes]
  )

  /* --- connection click — directly delete the connection --- */
  const connClick = useCallback(
    (e: React.MouseEvent, connId: string) => {
      e.stopPropagation()
      setConns((p) => p.filter((c) => c.id !== connId))
      setSelConn(null)
      setSelNodes(new Set())
    },
    []
  )

  /* --- deselect --- */
  const lastMarqueeTime = useRef(0)
  const canvasClick = useCallback(() => {
    // Don't clear selection if a marquee drag just finished (click fires right after mouseup)
    if (Date.now() - lastMarqueeTime.current < 100) return
    setSelNodes(new Set())
    setSelConn(null)
  }, [])

  /* --- marquee start on canvas mousedown --- */
  const canvasMouseDown = useCallback((e: React.MouseEvent) => {
    // Only start marquee if clicking on the canvas background (not a node or interactive element).
    // Nodes call e.stopPropagation() so their clicks don't reach here.
    // Any click that does reach here is on the canvas background, grid SVG, or pan wrapper.
    const [mx, my] = cpos(e)
    setSelNodes(new Set())
    setSelConn(null)
    setDrag({ t: 'marquee', sx: mx, sy: my, cx: mx, cy: my })
  }, [cpos, setDrag])

  /* --- HTML5 drag-and-drop: accept codes + operators --- */
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (
      e.dataTransfer.types.includes('application/x-magnolia-code') ||
      e.dataTransfer.types.includes('application/x-magnolia-codes') ||
      e.dataTransfer.types.includes('application/x-magnolia-operator')
    ) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      // Drop code node(s) — check for multi-code first
      const multiJson = e.dataTransfer.getData('application/x-magnolia-codes')
      const codeJson = e.dataTransfer.getData('application/x-magnolia-code')
      if (multiJson || codeJson) {
        e.preventDefault()
        try {
          const [mx, my] = cpos(e)
          let codeList: { guid: string; name: string; color?: string }[]
          if (multiJson) {
            codeList = JSON.parse(multiJson)
          } else {
            codeList = [JSON.parse(codeJson)]
          }
          setNodes((p) => [
            ...p,
            ...codeList.map((data, i) => ({
              id: uid(),
              kind: 'code' as NodeKind,
              x: mx - CODE_W / 2,
              y: my - CODE_H / 2 + i * (CODE_H + 10),
              codeGuid: data.guid,
              codeName: data.name,
              codeColor: data.color
            }))
          ])
        } catch {
          // ignore bad data
        }
        return
      }

      // Drop an operator node
      const opJson = e.dataTransfer.getData('application/x-magnolia-operator')
      if (opJson) {
        e.preventDefault()
        try {
          const data = JSON.parse(opJson) as { kind: NodeKind }
          const [mx, my] = cpos(e)
          const dropW = data.kind === 'text' ? TEXT_W : OP_W
          setNodes((p) => [
            ...p,
            {
              id: uid(),
              kind: data.kind,
              x: mx - dropW / 2,
              y: my - 20,
              ...(data.kind === 'logical' ? { logicalOp: undefined, inputCount: 2 } : {}),
              ...(data.kind === 'text' ? { searchText: '' } : {})
            }
          ])
        } catch {
          // ignore bad data
        }
      }
    },
    [cpos]
  )

  /* ═══ Render ═══ */

  const condition = graphToCondition(nodes, conns, codes)
  const validationError = useMemo(() => condition ? validateCondition(condition) : null, [condition])

  return (
    <div>
      {/* ── Toolbar ── three labeled groups laid out as columns. The
          label sits above its buttons so each group reads as a unit;
          a thin divider separates them. Buttons inside a group still
          wrap if the window is narrow. */}
      <div
        style={{
          display: 'flex',
          gap: 14,
          marginBottom: 8,
          alignItems: 'flex-start',
          flexWrap: 'wrap'
        }}
      >
        <PaletteGroup label="Logical">
          <PaletteButton
            kind="logical"
            label={KIND_LABEL.logical}
            color={KIND_COLOR.logical}
            tooltip={KIND_TOOLTIP.logical}
            onClick={() => addOp('logical')}
          />
        </PaletteGroup>

        <PaletteDivider />

        <PaletteGroup label="Input">
          <PaletteButton
            kind="text"
            label={KIND_LABEL.text}
            color={KIND_COLOR.text}
            tooltip={KIND_TOOLTIP.text}
            onClick={() => {
              setNodes((p) => [
                ...p,
                {
                  id: uid(),
                  kind: 'text' as NodeKind,
                  x: -panRef.current.x + 40 + Math.random() * 60,
                  y: -panRef.current.y + 50 + ((p.length * 55) % 300),
                  searchText: ''
                }
              ])
            }}
          />
          <PaletteButton
            kind="any"
            label={KIND_LABEL.any}
            color={KIND_COLOR.any}
            tooltip="Any code — matches any coded selection"
            onClick={() => {
              setNodes((p) => [
                ...p,
                {
                  id: uid(),
                  kind: 'any' as NodeKind,
                  x: -panRef.current.x + 40 + Math.random() * 60,
                  y: -panRef.current.y + 50 + ((p.length * 55) % 300)
                }
              ])
            }}
          />
        </PaletteGroup>

        <PaletteDivider />

        <PaletteGroup label="Spatial">
          {(['overlap', 'inside', 'outside', 'before', 'followedBy'] as NodeKind[]).map((k) => (
            <PaletteButton
              key={k}
              kind={k}
              label={KIND_LABEL[k]}
              color={KIND_COLOR[k]}
              tooltip={KIND_TOOLTIP[k]}
              onClick={() => addOp(k)}
            />
          ))}
        </PaletteGroup>
      </div>

      {/* ── Canvas ── */}
      <div
        ref={canvasRef}
        onClick={canvasClick}
        onMouseDown={canvasMouseDown}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        style={{
          position: 'relative',
          width: '100%',
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
        <svg
          style={{
            position: 'absolute',
            left: -pan.x,
            top: -pan.y,
            width: 4000,
            height: 4000,
            pointerEvents: 'none'
          }}
        >
          <defs>
            <pattern
              id="qgrid"
              width="20"
              height="20"
              patternUnits="userSpaceOnUse"
              x={pan.x % 20}
              y={pan.y % 20}
            >
              <circle
                cx="10"
                cy="10"
                r="0.8"
                fill="var(--text-muted)"
                opacity="0.15"
              />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#qgrid)" />
        </svg>

        {/* Connections SVG (behind nodes) */}
        <svg
          style={{
            position: 'absolute',
            inset: 0,
            width: 4000,
            height: 4000,
            pointerEvents: 'none',
            overflow: 'visible'
          }}
        >
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
                  fill="none"
                  stroke="transparent"
                  strokeWidth={14}
                  style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                  onClick={(e) => connClick(e, conn.id)}
                />
                <path
                  d={bezPath(x1, y1, x2, y2)}
                  fill="none"
                  stroke={
                    selected
                      ? 'var(--accent-primary)'
                      : 'var(--text-secondary)'
                  }
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
          const firstOp = node.kind === 'logical' ? node.logicalOp : undefined
          const NOT_COLOR = '#f43f5e'
          const baseColor =
            node.kind === 'code' && node.codeColor
              ? node.codeColor
              : node.kind === 'logical' && firstOp
                ? LOGICAL_OP_COLOR[firstOp]
                : KIND_COLOR[node.kind]
          const color = node.isNegated ? NOT_COLOR : baseColor
          const inConns = conns.filter((c) => c.to === node.id)
          const connectedIn = new Set(inConns.map((c) => c.toPort))
          const hasOut = conns.some((c) => c.from === node.id)

          // For dual-code nodes, resolve connected input label per port
          const portLabel = (port: number): string | null => {
            const conn = inConns.find((c) => c.toPort === port)
            if (!conn) return null
            const src = nodes.find((n) => n.id === conn.from)
            if (!src) return null
            if (src.kind === 'code') return src.codeName || 'Code'
            if (src.kind === 'any') return 'Any Code'
            if (src.kind === 'text') return src.searchText ? `"${src.searchText}"` : 'Text'
            if (src.kind === 'logical') return 'LOGICAL input'
            if (SPATIAL_KINDS.includes(src.kind)) return KIND_LABEL[src.kind] + ' input'
            return 'Input'
          }

          return (
            <div
              key={node.id}
              title={KIND_TOOLTIP[node.kind] || undefined}
              onMouseDown={(e) => nodeDown(e, node.id)}
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'absolute',
                left: node.x,
                top: node.y,
                width: w,
                height: node.kind === 'code' ? undefined : h,
                minHeight: node.kind === 'code' ? h : undefined,
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
              {/* Label */}
              <div
                style={{
                  padding:
                    node.kind === 'code' || node.kind === 'text' || node.kind === 'result' ? '7px 8px' : '3px 6px',
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                  fontSize: node.kind === 'code' || node.kind === 'text' || node.kind === 'result' ? 11 : 10,
                  whiteSpace: node.kind === 'code' ? 'normal' : 'nowrap',
                  overflow: node.kind === 'code' ? 'visible' : 'hidden',
                  textOverflow: node.kind === 'code' ? undefined : 'ellipsis',
                  pointerEvents: node.kind === 'text' ? 'auto' : 'none',
                  display: 'flex',
                  alignItems: node.kind === 'code' ? 'flex-start' : 'center',
                  gap: 4
                }}
              >
                {node.kind === 'code' && (
                  <span
                    style={{
                      display: 'inline-block',
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: node.codeColor || '#888',
                      flexShrink: 0,
                      marginTop: 4
                    }}
                  />
                )}
                {node.kind === 'any' && (
                  <span style={{ color: KIND_COLOR.any, fontSize: 10, flexShrink: 0 }}>✱</span>
                )}
                {node.kind === 'text' && (
                  <span style={{ color: KIND_COLOR.text, fontSize: 10, flexShrink: 0 }}>Aa</span>
                )}
                {node.kind === 'result' && (
                  <span style={{ color: KIND_COLOR.result }}>
                    &#9654;
                  </span>
                )}
                {node.kind === 'code'
                  ? (
                    <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word', lineHeight: '14px' }}>
                      {node.codeName || 'Code'}
                    </span>
                  )
                  : node.kind === 'any'
                    ? 'Any Code'
                    : node.kind === 'text'
                      ? 'TEXT'
                      : KIND_LABEL[node.kind]}
                {/* Inline NOT toggle button */}
                {node.kind !== 'logical' && node.kind !== 'result' && (
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      setNodes((p) => p.map((nd) => nd.id === node.id ? { ...nd, isNegated: !nd.isNegated } : nd))
                    }}
                    title={node.isNegated ? 'Remove NOT (click to un-negate)' : 'Apply NOT (click to negate)'}
                    style={{
                      marginLeft: 'auto',
                      fontSize: 7,
                      fontWeight: 700,
                      padding: '1px 4px',
                      borderRadius: 3,
                      border: node.isNegated ? '1px solid #f43f5e' : '1px solid var(--border-color)',
                      background: node.isNegated ? '#f43f5e' : 'transparent',
                      color: node.isNegated ? '#fff' : 'var(--text-muted)',
                      cursor: 'pointer',
                      lineHeight: 1,
                      flexShrink: 0,
                      pointerEvents: 'auto',
                    }}
                  >
                    NOT
                  </button>
                )}
              </div>

              {/* Code node: "And Subcodes" checkbox (only if code has children) */}
              {node.kind === 'code' && node.codeGuid && codes && codes.some((c) => c.parentGuid === node.codeGuid) && (
                <label
                  style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '2px 6px 6px 20px', fontSize: 9, color: 'var(--text-secondary)', cursor: 'pointer' }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={!!node.includeSubcodes}
                    onChange={(e) => {
                      const checked = e.target.checked
                      setNodes((p) => p.map((nd) => nd.id === node.id ? { ...nd, includeSubcodes: checked } : nd))
                    }}
                    style={{ margin: 0, width: 10, height: 10 }}
                  />
                  And subcodes
                </label>
              )}

              {/* Text node: editable search field + case-sensitive checkbox */}
              {node.kind === 'text' && (
                <div style={{ padding: '0 6px 4px' }}>
                  <input
                    type="text"
                    value={node.searchText || ''}
                    placeholder="word or phrase..."
                    onChange={(e) => {
                      const val = e.target.value
                      setNodes((p) =>
                        p.map((nd) =>
                          nd.id === node.id ? { ...nd, searchText: val } : nd
                        )
                      )
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      width: '100%',
                      fontSize: 10,
                      padding: '2px 4px',
                      border: '1px solid var(--border-color)',
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--bg-input)',
                      color: 'var(--text-primary)',
                      outline: 'none',
                      boxSizing: 'border-box'
                    }}
                  />
                  <label
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 3,
                      marginTop: 3,
                      fontSize: 8,
                      color: 'var(--text-secondary)',
                      cursor: 'pointer',
                      userSelect: 'none'
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={node.caseSensitive || false}
                      onChange={(e) => {
                        const val = e.target.checked
                        setNodes((p) =>
                          p.map((nd) =>
                            nd.id === node.id ? { ...nd, caseSensitive: val } : nd
                          )
                        )
                      }}
                      style={{ margin: 0, width: 10, height: 10 }}
                    />
                    Case sensitive
                  </label>
                  <label
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 3,
                      marginTop: 3,
                      fontSize: 8,
                      color: 'var(--text-secondary)',
                      cursor: 'pointer',
                      userSelect: 'none'
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={node.wholeWord || false}
                      onChange={(e) => {
                        const val = e.target.checked
                        setNodes((p) =>
                          p.map((nd) =>
                            nd.id === node.id ? { ...nd, wholeWord: val } : nd
                          )
                        )
                      }}
                      style={{ margin: 0, width: 10, height: 10 }}
                    />
                    Whole word
                  </label>
                </div>
              )}

              {/* Logical node: operator select + input slots */}
              {node.kind === 'logical' && (() => {
                const op = node.logicalOp
                const slots = logicalSlotCount(node)
                const canAdd = op === 'and' || op === 'or'
                const canRemove = canAdd && slots > 2

                return (
                  <div>
                    {/* Operator selector */}
                    <div style={{ height: SLOT_H, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <select
                        value={op || ''}
                        onChange={(e) => {
                          const val = e.target.value as LogicalOp | ''
                          if (!val) return
                          const newOp = val as LogicalOp
                          const newSlots = LOGICAL_OP_SLOTS[newOp]
                          setNodes((p) =>
                            p.map((nd) => {
                              if (nd.id !== node.id) return nd
                              const newCount = Math.max(newSlots.min, Math.min(nd.inputCount ?? 2, newSlots.max))
                              return { ...nd, logicalOp: newOp, inputCount: newCount }
                            })
                          )
                          // Remove excess connections if shrinking
                          const maxPort = LOGICAL_OP_SLOTS[newOp].max
                          setConns((p) => p.filter((c) => !(c.to === node.id && c.toPort >= maxPort)))
                        }}
                        title={op ? LOGICAL_OP_TOOLTIP[op] : 'Select an operator'}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          fontSize: 9,
                          fontWeight: 700,
                          color: op ? LOGICAL_OP_COLOR[op] : 'var(--text-secondary)',
                          background: 'var(--bg-input)',
                          border: `1px solid ${op ? LOGICAL_OP_COLOR[op] + '66' : 'var(--border-color)'}`,
                          borderRadius: 'var(--radius-sm)',
                          padding: '1px 4px',
                          cursor: 'pointer',
                          outline: 'none'
                        }}
                      >
                        <option value="" disabled>Operator...</option>
                        <option value="and">AND</option>
                        <option value="or">OR</option>
                        <option value="not">NOT</option>
                        <option value="xor">XOR</option>
                      </select>
                    </div>
                    {/* Input slots */}
                    {Array.from({ length: slots }, (_, i) => {
                      const name = portLabel(i)
                      return (
                        <div
                          key={`slot-${i}`}
                          style={{
                            height: SLOT_H,
                            lineHeight: `${SLOT_H}px`,
                            paddingLeft: PORT_R + 6,
                            paddingRight: canRemove ? 16 : 0,
                            fontSize: 9,
                            color: name ? 'var(--text-primary)' : 'var(--text-secondary)',
                            fontWeight: name ? 600 : 400,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            pointerEvents: 'none',
                            position: 'relative'
                          }}
                        >
                          {name || `Input ${i + 1}`}
                          {canRemove && (
                            <span
                              onMouseDown={(ev) => ev.stopPropagation()}
                              onClick={(ev) => {
                                ev.stopPropagation()
                                setNodes((p) =>
                                  p.map((nd) => {
                                    if (nd.id !== node.id) return nd
                                    return { ...nd, inputCount: Math.max(2, (nd.inputCount ?? 2) - 1) }
                                  })
                                )
                                setConns((p) =>
                                  p
                                    .filter((c) => !(c.to === node.id && c.toPort === i))
                                    .map((c) =>
                                      c.to === node.id && c.toPort > i
                                        ? { ...c, toPort: c.toPort - 1 }
                                        : c
                                    )
                                )
                              }}
                              style={{
                                position: 'absolute',
                                right: 4,
                                top: 0,
                                fontSize: 10,
                                color: 'var(--text-muted)',
                                cursor: 'pointer',
                                lineHeight: `${SLOT_H}px`,
                                pointerEvents: 'auto',
                                opacity: 0.5
                              }}
                              title="Remove this input"
                            >
                              <Icon icon={faXmark} />
                            </span>
                          )}
                        </div>
                      )
                    })}
                    {/* Add input button (only for and/or) */}
                    {canAdd && (
                      <div
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          setNodes((p) =>
                            p.map((nd) => {
                              if (nd.id !== node.id) return nd
                              const max = LOGICAL_OP_SLOTS[nd.logicalOp!]?.max ?? 10
                              return { ...nd, inputCount: Math.min(max, (nd.inputCount ?? 2) + 1) }
                            })
                          )
                        }}
                        style={{
                          height: ADD_BTN_H,
                          lineHeight: `${ADD_BTN_H}px`,
                          textAlign: 'center',
                          fontSize: 8,
                          color: 'var(--accent-primary)',
                          cursor: 'pointer',
                          opacity: 0.7
                        }}
                      >
                        + Add input
                      </div>
                    )}
                  </div>
                )
              })()}

              {/* Spatial nodes: fixed 2 slots with static operator label */}
              {SPATIAL_KINDS.includes(node.kind) && (
                <div style={{ pointerEvents: 'none' }}>
                  <div
                    style={{
                      height: SLOT_H,
                      lineHeight: `${SLOT_H}px`,
                      paddingLeft: PORT_R + 6,
                      fontSize: 9,
                      color: portLabel(0) ? 'var(--text-primary)' : 'var(--text-secondary)',
                      fontWeight: portLabel(0) ? 600 : 400,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis'
                    }}
                  >
                    {portLabel(0) || 'Input 1'}
                  </div>
                  <div
                    style={{
                      height: LABEL_H,
                      lineHeight: `${LABEL_H}px`,
                      paddingLeft: PORT_R + 6,
                      fontSize: 8,
                      fontWeight: 700,
                      color: KIND_COLOR[node.kind],
                      letterSpacing: 0.5
                    }}
                  >
                    {KIND_LABEL[node.kind]}
                  </div>
                  <div
                    style={{
                      height: SLOT_H,
                      lineHeight: `${SLOT_H}px`,
                      paddingLeft: PORT_R + 6,
                      fontSize: 9,
                      color: portLabel(1) ? 'var(--text-primary)' : 'var(--text-secondary)',
                      fontWeight: portLabel(1) ? 600 : 400,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis'
                    }}
                  >
                    {portLabel(1) || 'Input 2'}
                  </div>
                </div>
              )}

              {/* ── Ports ── */}

              {/* Output port */}
              {node.kind !== 'result' && (
                <div
                  onMouseDown={(e) =>
                    portDown(e, node.id, 'out', 0)
                  }
                  style={{
                    position: 'absolute',
                    left: w - PORT_R - 6,
                    top: h / 2 - PORT_R - 6,
                    width: PORT_R * 2 + 12,
                    height: PORT_R * 2 + 12,
                    cursor: 'crosshair',
                    zIndex: 10,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                >
                  <div
                    style={{
                      width: PORT_R * 2,
                      height: PORT_R * 2,
                      borderRadius: '50%',
                      background: hasOut
                        ? 'var(--text-muted)'
                        : 'var(--bg-tertiary)',
                      border: '1.5px solid var(--text-muted)'
                    }}
                  />
                </div>
              )}

              {/* Input ports — use inPortXY for correct positioning */}
              {node.kind !== 'code' &&
                Array.from({ length: inputSlots(node) }).map((_, i) => {
                  const [, portY] = inPortXY(node, i)
                  const topPx = portY - node.y - PORT_R - 6
                  return (
                    <div
                      key={i}
                      onMouseDown={(e) =>
                        portDown(e, node.id, 'in', i)
                      }
                      style={{
                        position: 'absolute',
                        left: -PORT_R - 6,
                        top: topPx,
                        width: PORT_R * 2 + 12,
                        height: PORT_R * 2 + 12,
                        cursor: 'crosshair',
                        zIndex: 10,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}
                    >
                      <div
                        style={{
                          width: PORT_R * 2,
                          height: PORT_R * 2,
                          borderRadius: '50%',
                          background: connectedIn.has(i)
                            ? 'var(--text-muted)'
                            : 'var(--bg-tertiary)',
                          border: '1.5px solid var(--text-muted)'
                        }}
                      />
                    </div>
                  )
                })}

              {/* Validation warning below Result node */}
              {node.kind === 'result' && validationError && (
                <div
                  onMouseDown={(e) => e.stopPropagation()}
                  style={{
                    position: 'absolute',
                    top: h + 4,
                    left: -60,
                    width: w + 120,
                    padding: '5px 8px',
                    fontSize: 9,
                    lineHeight: 1.4,
                    color: '#fbbf24',
                    background: 'rgba(120, 80, 0, 0.85)',
                    border: '1px solid #92400e',
                    borderRadius: 'var(--radius-sm)',
                    pointerEvents: 'auto',
                    textAlign: 'center',
                    zIndex: 20
                  }}
                >
                  <Icon icon={faExclamationTriangle} style={{ marginRight: 4 }} />{validationError}
                </div>
              )}
            </div>
          )
        })}

        {/* Marquee selection rectangle */}
        {marqueeRect && (
          <div
            style={{
              position: 'absolute',
              left: marqueeRect.x + pan.x,
              top: marqueeRect.y + pan.y,
              width: marqueeRect.w,
              height: marqueeRect.h,
              border: '1.5px dashed var(--accent-primary)',
              background: 'rgba(99, 102, 241, 0.08)',
              borderRadius: 2,
              pointerEvents: 'none',
              zIndex: 60
            }}
          />
        )}

        {/* Temp wire SVG – above everything, updated via direct DOM manipulation */}
        <svg
          style={{
            position: 'absolute',
            inset: 0,
            width: 4000,
            height: 4000,
            pointerEvents: 'none',
            zIndex: 50,
            overflow: 'visible'
          }}
        >
          <path
            ref={wireRef}
            fill="none"
            stroke="#a78bfa"
            strokeWidth={3}
            strokeDasharray="8,5"
            style={{ display: 'none' }}
          />
        </svg>
        </div>{/* end pan wrapper */}

        {/* Re-centre button */}
        {(
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
        )}
      </div>

      {/* ── Status bar ── */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginTop: 6,
          fontSize: 10,
          color: 'var(--text-muted)'
        }}
      >
        <span>
          {selNodes.size > 1
            ? `${selNodes.size} selected — ⌘C copy · ⌘V paste · Delete to remove`
            : 'Drag codes & operators onto canvas · Drag to select · ⌥-click to multi-select'}
        </span>
        <span
          style={{
            color: condition
              ? (validationError ? '#f59e0b' : '#22c55e')
              : '#ef4444',
            fontWeight: 600
          }}
        >
          {condition
            ? (validationError ? <><Icon icon={faCircle} style={{ fontSize: 6, marginRight: 4 }} />Error</> : <><Icon icon={faCircle} style={{ fontSize: 6, marginRight: 4 }} />Query ready</>)
            : <><Icon icon={faCircle} style={{ fontSize: 6, marginRight: 4 }} />Connect nodes to Result</>}
        </span>
      </div>
    </div>
  )
}

