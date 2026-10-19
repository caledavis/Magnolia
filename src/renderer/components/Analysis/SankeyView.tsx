import { useEffect, useMemo, useRef, useState } from 'react'
import { truncate } from './analysis-helpers'
import { layoutSankey, sankeyLinkPath, type SankeyLinkLayout, type SankeyNodeLayout } from './sankey-layout'

export interface SankeyItem {
  id: string
  label: string
  color?: string
}

interface Props {
  /** Left-hand items (one per grid row). */
  left: SankeyItem[]
  /** Right-hand items (one per grid column). */
  right: SankeyItem[]
  /** values[leftIndex][rightIndex] — the same grid the table shows. */
  values: number[][]
  leftTitle: string
  rightTitle: string
  /** Right-hand indices to leave out (e.g. subtotal columns, which
   *  would double-count the flows of their child columns). */
  excludeRight?: Set<number>
  /** Drill-downs — the same actions as clicking a cell / row total /
   *  column total in the table view. */
  onLinkClick?: (leftIndex: number, rightIndex: number) => void
  onLeftClick?: (leftIndex: number) => void
  onRightClick?: (rightIndex: number) => void
}

type Hover =
  | { kind: 'node'; side: 'left' | 'right'; index: number }
  | { kind: 'link'; left: number; right: number }
  | null

const NODE_WIDTH = 12
const NODE_PADDING = 8
const LABEL_GUTTER = 170
const ROW_HEIGHT = 26
const TITLE_HEIGHT = 20
const FALLBACK_LEFT = 'var(--accent)'
const FALLBACK_RIGHT = 'var(--text-muted)'

/**
 * Interactive two-column Sankey of an analysis grid. Hovering a node or
 * band highlights its flows; clicking runs the same drill-down query as
 * the matching table cell. Rendered inside the tool's Results section,
 * so drag-and-drop onto the section keeps adding rows/columns.
 */
export function SankeyView({ left, right, values, leftTitle, rightTitle, excludeRight, onLinkClick, onLeftClick, onRightClick }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(640)
  const [hover, setHover] = useState<Hover>(null)
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(420, entry.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const height = Math.max(220, Math.max(left.length, right.length) * ROW_HEIGHT)
  const leftX = LABEL_GUTTER
  const rightX = width - LABEL_GUTTER

  const layout = useMemo(
    () => layoutSankey(values, { width, height, nodeWidth: NODE_WIDTH, nodePadding: NODE_PADDING, leftX, rightX, excludeRight }),
    [values, width, height, leftX, rightX, excludeRight]
  )

  const leftColor = (i: number) => left[i]?.color || FALLBACK_LEFT
  const rightColor = (j: number) => right[j]?.color || FALLBACK_RIGHT

  const linkActive = (l: SankeyLinkLayout): boolean => {
    if (!hover) return true
    if (hover.kind === 'link') return hover.left === l.left && hover.right === l.right
    return hover.side === 'left' ? l.left === hover.index : l.right === hover.index
  }
  const nodeActive = (n: SankeyNodeLayout): boolean => {
    if (!hover) return true
    if (hover.kind === 'node') {
      if (hover.side === n.side) return hover.index === n.index
      return layout.links.some((l) => (hover.side === 'left' ? l.left === hover.index && l.right === n.index : l.right === hover.index && l.left === n.index))
    }
    return n.side === 'left' ? n.index === hover.left : n.index === hover.right
  }

  const showTip = (e: React.MouseEvent, text: string) => {
    const box = wrapRef.current?.getBoundingClientRect()
    if (!box) return
    setTip({ x: e.clientX - box.left + 12, y: e.clientY - box.top + 12, text })
  }
  const clearHover = () => { setHover(null); setTip(null) }

  const hiddenCount = layout.hiddenLeft.length + layout.hiddenRight.length

  const renderNode = (n: SankeyNodeLayout) => {
    const item = n.side === 'left' ? left[n.index] : right[n.index]
    const color = n.side === 'left' ? leftColor(n.index) : rightColor(n.index)
    const active = nodeActive(n)
    const labelX = n.side === 'left' ? n.x - 6 : n.x + NODE_WIDTH + 6
    const onClick = n.side === 'left' ? onLeftClick : onRightClick
    return (
      <g
        key={`${n.side}:${item.id}`}
        style={{ cursor: onClick ? 'pointer' : 'default', opacity: active ? 1 : 0.35, transition: 'opacity 0.12s' }}
        onMouseEnter={() => setHover({ kind: 'node', side: n.side, index: n.index })}
        onMouseMove={(e) => showTip(e, `${item.label}: ${n.total}`)}
        onMouseLeave={clearHover}
        onClick={() => onClick?.(n.index)}
      >
        <rect x={n.x} y={n.y} width={NODE_WIDTH} height={Math.max(1, n.height)} rx={2} fill={color} />
        <text
          x={labelX}
          y={n.y + n.height / 2}
          dy="0.35em"
          textAnchor={n.side === 'left' ? 'end' : 'start'}
          fontSize={11}
          fill="var(--text-primary)"
        >
          {truncate(item.label, 24)}
          <tspan fill="var(--text-muted)" dx={4}>{n.total}</tspan>
        </text>
      </g>
    )
  }

  return (
    // The wrapper is always mounted so the ResizeObserver keeps tracking
    // the same element as the diagram appears and disappears.
    <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
      {layout.links.length === 0 ? (
        <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
          Nothing to show — every cell in the grid is 0
        </div>
      ) : (
      <svg width={width} height={height + TITLE_HEIGHT} style={{ display: 'block', overflow: 'visible' }}>
        <text x={leftX + NODE_WIDTH} y={10} textAnchor="end" fontSize={10} fontWeight={700} fill="var(--text-secondary)">{leftTitle}</text>
        <text x={rightX - NODE_WIDTH} y={10} textAnchor="start" fontSize={10} fontWeight={700} fill="var(--text-secondary)">{rightTitle}</text>
        <g transform={`translate(0,${TITLE_HEIGHT})`}>
        <g>
          {layout.links.map((l) => {
            const active = linkActive(l)
            return (
              <path
                key={`${l.left}:${l.right}`}
                d={sankeyLinkPath(l, leftX + NODE_WIDTH, rightX - NODE_WIDTH)}
                fill={leftColor(l.left)}
                fillOpacity={hover && active ? 0.6 : active ? 0.35 : 0.08}
                style={{ cursor: onLinkClick ? 'pointer' : 'default', transition: 'fill-opacity 0.12s' }}
                onMouseEnter={() => setHover({ kind: 'link', left: l.left, right: l.right })}
                onMouseMove={(e) => showTip(e, `${left[l.left].label} → ${right[l.right].label}: ${l.value}`)}
                onMouseLeave={clearHover}
                onClick={() => onLinkClick?.(l.left, l.right)}
              />
            )
          })}
        </g>
        <g>{layout.left.map(renderNode)}</g>
        <g>{layout.right.map(renderNode)}</g>
        </g>
      </svg>
      )}
      {hiddenCount > 0 && (
        <div style={{ marginTop: 6, fontSize: 10, color: 'var(--text-muted)' }}>
          {hiddenCount} item{hiddenCount !== 1 ? 's' : ''} with no results not shown
        </div>
      )}
      {tip && (
        <div style={{
          position: 'absolute', left: tip.x, top: tip.y, pointerEvents: 'none',
          background: 'var(--bg-panel)', color: 'var(--text-primary)',
          border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)',
          padding: '4px 8px', fontSize: 11, whiteSpace: 'nowrap', zIndex: 2,
          boxShadow: '0 2px 8px rgba(0,0,0,0.15)'
        }}>
          {tip.text}
        </div>
      )}
    </div>
  )
}
