import { useState, useRef, useEffect } from 'react'
import type { MapConnection as MapConnectionType, MapElement, MapElementKind, FreeTextElement } from './types'
import {
  bezPathFromPorts,
  distributePortsForElement,
  computeRoundedPortPosition,
  computeOutwardNormal,
  parseBezPath,
  bezierPoint
} from './bezier-utils'

/** Chip kinds render as pills, so their connection outline is a
 *  capsule — corner radius equals half their height. Cards (memo,
 *  quote, query-result) are plain rounded rects at 6px. */
const CHIP_KINDS: Set<MapElementKind> = new Set([
  'document', 'code', 'query', 'tag', 'tag-category', 'analysis', 'folder'
])
export function cornerRadiusFor(el: MapElement): number {
  if (CHIP_KINDS.has(el.kind)) return el.height / 2
  if (el.kind === 'memo' || el.kind === 'quote' || el.kind === 'query-result') return 6
  return 0
}

/** Freetext nodes render with a 4 px border radius (see FreeTextNode's
 *  container style). Connection ports follow the same outline so the
 *  arrow lands on the visible edge of the box. */
const FREE_TEXT_CORNER_RADIUS = 4

/** Unified geometry record for connection endpoints. Lets a single
 *  lookup table cover both MapElement and FreeTextElement endpoints
 *  without dragging the kind-specific MapElement/FreeTextElement
 *  shapes through the bezier code (which only needs x/y/width/height
 *  and a corner radius). */
type Endpoint = {
  id: string
  x: number
  y: number
  width: number
  height: number
  cornerRadius: number
}

function buildEndpoints(elements: MapElement[], freeTexts: FreeTextElement[]): Map<string, Endpoint> {
  const out = new Map<string, Endpoint>()
  for (const el of elements) {
    out.set(el.id, {
      id: el.id,
      x: el.x,
      y: el.y,
      width: el.width,
      height: el.height,
      cornerRadius: cornerRadiusFor(el)
    })
  }
  for (const ft of freeTexts) {
    out.set(ft.id, {
      id: ft.id,
      x: ft.x,
      y: ft.y,
      width: ft.width,
      height: ft.height,
      cornerRadius: FREE_TEXT_CORNER_RADIUS
    })
  }
  return out
}

interface Props {
  connection: MapConnectionType
  elements: MapElement[]
  freeTexts: FreeTextElement[]
  allConnections: MapConnectionType[]
  selected: boolean
  /** 'lines' = just the arc path (behind boxes), 'overlay' = arrowheads, labels, hit targets (in front) */
  layer: 'lines' | 'overlay'
  /** Focus-fade state: emphasised = this connection touches a hovered/
   *  selected node; dimmed = focus mode is active but this connection
   *  isn't part of it; undefined = no focus mode, render neutrally. */
  focusState?: 'emphasised' | 'dimmed'
  onSelect: (id: string, e: React.MouseEvent) => void
  onHoverChange?: (id: string, hovered: boolean) => void
  onToggleArrow: (id: string, end: 'from' | 'to') => void
  onUpdateLabel: (id: string, label: string) => void
}

/** Compute path and edge points for a connection. Simple: edge to edge arc.
 *  Looks up endpoints from a unified {id → Endpoint} map so the same
 *  function handles MapElement-only, FreeText-only, and mixed
 *  connections without changing call sites. */
function computeConnectionPath(
  conn: MapConnectionType,
  elements: MapElement[],
  freeTexts: FreeTextElement[],
  allConnections: MapConnectionType[]
): {
  path: string
  fromEdge: { x: number; y: number }
  toEdge: { x: number; y: number }
  fromCenter: { x: number; y: number }
  toCenter: { x: number; y: number }
} | null {
  const endpoints = buildEndpoints(elements, freeTexts)
  const fromEl = endpoints.get(conn.fromId)
  const toEl = endpoints.get(conn.toId)
  if (!fromEl || !toEl) return null

  const fromCenter = { x: fromEl.x + fromEl.width / 2, y: fromEl.y + fromEl.height / 2 }
  const toCenter = { x: toEl.x + toEl.width / 2, y: toEl.y + toEl.height / 2 }

  // Distribute ports for multi-connection spread
  const fromConns = allConnections.filter((c) => c.fromId === conn.fromId || c.toId === conn.fromId)
  const fromTargets = new Map<string, { x: number; y: number }>()
  for (const c of fromConns) {
    const otherId = c.fromId === conn.fromId ? c.toId : c.fromId
    const other = endpoints.get(otherId)
    if (other) fromTargets.set(c.id, { x: other.x + other.width / 2, y: other.y + other.height / 2 })
  }
  const fromRadius = fromEl.cornerRadius
  const toRadius = toEl.cornerRadius
  const fromPorts = distributePortsForElement(fromEl, fromConns.map((c) => c.id), fromTargets, fromRadius)

  const toConns = allConnections.filter((c) => c.fromId === conn.toId || c.toId === conn.toId)
  const toTargets = new Map<string, { x: number; y: number }>()
  for (const c of toConns) {
    const otherId = c.fromId === conn.toId ? c.toId : c.fromId
    const other = endpoints.get(otherId)
    if (other) toTargets.set(c.id, { x: other.x + other.width / 2, y: other.y + other.height / 2 })
  }
  const toPorts = distributePortsForElement(toEl, toConns.map((c) => c.id), toTargets, toRadius)

  // Edge to edge — no inset, ports on the rounded outline
  const fromEdge = fromPorts.get(conn.id) || computeRoundedPortPosition(fromEl, toCenter, fromRadius)
  const toEdge = toPorts.get(conn.id) || computeRoundedPortPosition(toEl, fromCenter, toRadius)

  // Outward normals at each port — used by bezPathFromPorts so the line
  // leaves and arrives perpendicular to the box outlines.
  const fromNormal = computeOutwardNormal(fromEl, fromEdge, fromRadius)
  const toNormal = computeOutwardNormal(toEl, toEdge, toRadius)

  // Parallel connections between the same pair of nodes get a
  // perpendicular offset so they fan out instead of overlapping.
  const siblings = allConnections
    .filter((c) =>
      (c.fromId === conn.fromId && c.toId === conn.toId) ||
      (c.fromId === conn.toId && c.toId === conn.fromId)
    )
    .sort((a, b) => a.id.localeCompare(b.id))
  const n = siblings.length
  const idx = siblings.findIndex((c) => c.id === conn.id)
  const siblingOffset = n > 1 ? (idx - (n - 1) / 2) * 18 : 0

  const path = bezPathFromPorts(fromEdge, fromNormal, toEdge, toNormal, siblingOffset)
  return { path, fromEdge, toEdge, fromCenter, toCenter }
}

export { computeConnectionPath }

export function MapConnectionComponent({
  connection,
  elements,
  freeTexts,
  allConnections,
  selected,
  layer,
  focusState,
  onSelect,
  onHoverChange,
  onToggleArrow,
  onUpdateLabel
}: Props) {
  const [editingLabel, setEditingLabel] = useState(false)
  const [labelText, setLabelText] = useState(connection.label)
  const [hovered, setHovered] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setLabelText(connection.label)
  }, [connection.label])

  useEffect(() => {
    if (editingLabel && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingLabel])

  const pathRef = useRef<SVGPathElement>(null)
  const [chevrons, setChevrons] = useState<{ from: string; to: string }>({ from: '', to: '' })

  const result = computeConnectionPath(connection, elements, freeTexts, allConnections)

  const path = result?.path || ''
  const fromEdge = result?.fromEdge || { x: 0, y: 0 }
  const toEdge = result?.toEdge || { x: 0, y: 0 }
  const parsedBez = result ? parseBezPath(path) : null
  const midpoint = parsedBez
    ? bezierPoint(parsedBez.p0, parsedBez.p1, parsedBez.p2, parsedBez.p3, 0.5)
    : { x: (fromEdge.x + toEdge.x) / 2, y: (fromEdge.y + toEdge.y) / 2 }

  // Thin warm-grey default; emphasised on focus; blue on selection.
  // Dimmed connections keep their colour but read through stroke-opacity
  // so they drop into the background layer without disappearing.
  const isEmphasised = focusState === 'emphasised' || hovered
  const isDimmed = focusState === 'dimmed' && !selected
  const strokeColor = selected
    ? '#3b82f6'
    : isEmphasised
      ? '#3b3a36'
      : '#9a9288'
  const sw = selected ? 2 : isEmphasised ? 1.6 : 1.25
  const strokeOpacity = isDimmed ? 0.18 : 1
  // The arrowheads' inputs as plain values: `result` is a new object every
  // render, so the effect below can't depend on it without rerunning (and
  // setting state) every time.
  const hasResult = !!result
  const fromX = result?.fromEdge.x ?? 0
  const fromY = result?.fromEdge.y ?? 0
  const toX = result?.toEdge.x ?? 0
  const toY = result?.toEdge.y ?? 0
  const CHEV_SIZE = selected ? 7 : 6

  // After the path mounts, compute chevron positions from the actual SVG path geometry
  useEffect(() => {
    const p = pathRef.current
    if (!p || !hasResult) { setChevrons({ from: '', to: '' }); return }
    const len = p.getTotalLength()
    if (len < 1) { setChevrons({ from: '', to: '' }); return }

    function tangentAt(dist: number, dir: 'forward' | 'backward'): { x: number; y: number } {
      const tip = p!.getPointAtLength(dist)
      const near = dir === 'forward'
        ? p!.getPointAtLength(Math.min(dist + 1, len))
        : p!.getPointAtLength(Math.max(dist - 1, 0))
      const dx = dir === 'forward' ? near.x - tip.x : tip.x - near.x
      const dy = dir === 'forward' ? near.y - tip.y : tip.y - near.y
      const d = Math.hypot(dx, dy)
      return d > 0.01 ? { x: dx / d, y: dy / d } : { x: 1, y: 0 }
    }

    function makeChev(tip: { x: number; y: number }, tang: { x: number; y: number }): string {
      const bx = -tang.x, by = -tang.y
      const px = -by, py = bx
      // Narrower opening angle → pointier arrowhead. Perpendicular spread
      // is 55% of the backward length instead of 100%.
      const spread = CHEV_SIZE * 0.55
      return [
        `${tip.x + bx * CHEV_SIZE + px * spread},${tip.y + by * CHEV_SIZE + py * spread}`,
        `${tip.x},${tip.y}`,
        `${tip.x + bx * CHEV_SIZE - px * spread},${tip.y + by * CHEV_SIZE - py * spread}`
      ].join(' ')
    }

    const fe = { x: fromX, y: fromY }
    const te = { x: toX, y: toY }

    // Tangent at start: direction line LEAVES from-box (forward along arc)
    const fromTang = tangentAt(0, 'forward')
    // Arrow at from-end points INTO from-box → flip tangent
    const fromChev = makeChev(fe, { x: -fromTang.x, y: -fromTang.y })

    // Tangent at end: direction line ARRIVES at to-box (forward along arc)
    const toTang = tangentAt(len, 'backward')
    // Arrow at to-end points INTO to-box → use tangent as-is
    const toChev = makeChev(te, toTang)

    setChevrons({ from: fromChev, to: toChev })
  }, [path, hasResult, fromX, fromY, toX, toY, CHEV_SIZE])

  if (!result) return null

  // ── Lines layer: just the arc path (renders BEHIND element boxes) ──
  if (layer === 'lines') {
    // If this connection has a label, carve a small rectangle out of the
    // line under the label text via a per-connection SVG mask. That way
    // the canvas (dots included) shows through where the label sits —
    // no opaque halo painting over it.
    const hasLabel = !!connection.label
    // Matches the text rendering below: fontSize 11, fontWeight 400 —
    // same type spec as the memo/quote card snippet.
    const labelCharW = 6.2
    const labelW = hasLabel
      ? Math.max(16, connection.label.length * labelCharW + 10)
      : 0
    const labelH = 16
    const maskId = `map-line-mask-${connection.id}`
    return (
      <g>
        {hasLabel && (
          <defs>
            <mask id={maskId} maskUnits="userSpaceOnUse" x={-99999} y={-99999} width={199998} height={199998}>
              <rect x={-99999} y={-99999} width={199998} height={199998} fill="white" />
              <rect
                x={midpoint.x - labelW / 2}
                y={midpoint.y - labelH / 2}
                width={labelW}
                height={labelH}
                fill="black"
              />
            </mask>
          </defs>
        )}
        <path
          ref={pathRef}
          d={path}
          fill="none"
          stroke={strokeColor}
          strokeWidth={sw}
          strokeOpacity={strokeOpacity}
          mask={hasLabel ? `url(#${maskId})` : undefined}
          style={{ transition: 'stroke-opacity 0.12s, stroke 0.12s' }}
        />
      </g>
    )
  }

  // ── Overlay layer: arrowheads, hit targets, labels (renders IN FRONT of boxes) ──
  return (
    <g
      opacity={isDimmed ? 0.18 : 1}
      style={{ transition: 'opacity 0.12s' }}
      onMouseEnter={() => { setHovered(true); onHoverChange?.(connection.id, true) }}
      onMouseLeave={() => { setHovered(false); onHoverChange?.(connection.id, false) }}
    >
      {/* Hidden path for tangent measurement via getPointAtLength */}
      <path ref={pathRef} d={path} fill="none" stroke="none" />
      {/* Invisible fat path for click/hover target */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        style={{ cursor: 'pointer' }}
        onClick={(e) => onSelect(connection.id, e)}
      />

      {/* Arrowhead chevrons */}
      {connection.arrowFrom && chevrons.from && (
        <polyline
          points={chevrons.from}
          fill="none"
          stroke={strokeColor}
          strokeWidth={sw}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {connection.arrowTo && chevrons.to && (
        <polyline
          points={chevrons.to}
          fill="none"
          stroke={strokeColor}
          strokeWidth={sw}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}

      {/* Endpoint hit targets — visible dot only on hover */}
      <circle
        cx={fromEdge.x} cy={fromEdge.y} r={8}
        fill="transparent" stroke="none"
        style={{ cursor: 'pointer' }}
        onClick={(e) => { e.stopPropagation(); onToggleArrow(connection.id, 'from') }}
      />
      {hovered && (
        <circle
          cx={fromEdge.x} cy={fromEdge.y} r={4}
          fill={connection.arrowFrom ? strokeColor : 'var(--bg-primary, #fff)'}
          stroke={strokeColor} strokeWidth={1.5}
          style={{ pointerEvents: 'none' }}
        />
      )}
      <circle
        cx={toEdge.x} cy={toEdge.y} r={8}
        fill="transparent" stroke="none"
        style={{ cursor: 'pointer' }}
        onClick={(e) => { e.stopPropagation(); onToggleArrow(connection.id, 'to') }}
      />
      {hovered && (
        <circle
          cx={toEdge.x} cy={toEdge.y} r={4}
          fill={connection.arrowTo ? strokeColor : 'var(--bg-primary, #fff)'}
          stroke={strokeColor} strokeWidth={1.5}
          style={{ pointerEvents: 'none' }}
        />
      )}

      {/* Label / add-label indicator at midpoint */}
      {editingLabel ? (
        <foreignObject
          x={midpoint.x - 70}
          y={midpoint.y - 12}
          width={140}
          height={26}
          style={{ overflow: 'visible', pointerEvents: 'auto' }}
        >
          <input
            ref={inputRef}
            value={labelText}
            onChange={(e) => setLabelText(e.target.value)}
            onBlur={() => {
              setEditingLabel(false)
              onUpdateLabel(connection.id, labelText)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setEditingLabel(false)
                onUpdateLabel(connection.id, labelText)
              }
              if (e.key === 'Escape') {
                setEditingLabel(false)
                setLabelText(connection.label)
              }
            }}
            style={{
              width: '100%',
              textAlign: 'center',
              fontSize: 11,
              fontWeight: 400,
              border: `1px solid ${strokeColor}`,
              borderRadius: 4,
              padding: '2px 6px',
              outline: 'none',
              background: 'var(--bg-primary, #fff)',
              color: 'var(--text-primary, #1d1d1f)'
            }}
          />
        </foreignObject>
      ) : connection.label ? (
        /* Plain text with a canvas-coloured halo so the label stays
           legible where it crosses a line — no pill, no border. */
        <g
          style={{ cursor: 'text', pointerEvents: 'auto' }}
          onClick={(e) => { e.stopPropagation(); setEditingLabel(true) }}
        >
          <text
            x={midpoint.x}
            y={midpoint.y + 4}
            textAnchor="middle"
            fontSize={11}
            fontWeight={400}
            fill={strokeColor}
            style={{ fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif' }}
          >
            {connection.label}
          </text>
        </g>
      ) : hovered ? (
        /* No label — FA square-plus icon, visible only on hover, painted last (on top) */
        <g
          style={{ cursor: 'text', pointerEvents: 'auto' }}
          onClick={(e) => { e.stopPropagation(); setEditingLabel(true) }}
        >
          {/* White background circle to ensure visibility over the line */}
          <circle cx={midpoint.x} cy={midpoint.y} r={8} fill="var(--bg-primary, #fff)" />
          <path
            d="M64 32C28.7 32 0 60.7 0 96L0 416c0 35.3 28.7 64 64 64l320 0c35.3 0 64-28.7 64-64l0-320c0-35.3-28.7-64-64-64L64 32zM200 344l0-64-64 0c-13.3 0-24-10.7-24-24s10.7-24 24-24l64 0 0-64c0-13.3 10.7-24 24-24s24 10.7 24 24l0 64 64 0c13.3 0 24 10.7 24 24s-10.7 24-24 24l-64 0 0 64c0 13.3-10.7 24-24 24s-24-10.7-24-24z"
            fill={strokeColor}
            transform={`translate(${midpoint.x - 6}, ${midpoint.y - 7}) scale(${12 / 448}, ${14 / 512})`}
          />
        </g>
      ) : null}
    </g>
  )
}
