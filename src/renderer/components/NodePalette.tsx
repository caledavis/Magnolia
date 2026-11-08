/**
 * Shared palette UI for the node-graph editors (Query Builder content
 * query and Document Selector). Three pieces:
 *
 *  - <PaletteGroup label>      one labeled column (small uppercase header
 *                              with its buttons in a wrapping row beneath)
 *  - <PaletteDivider>          thin vertical rule between groups
 *  - <PaletteButton …/>        single draggable button — the colored left
 *                              stripe carries the kind's identity colour
 *
 * Both editors render their palettes the same way; this file is the one
 * source of truth for layout, sizing, and drag-data wiring.
 */
import type { ReactNode } from 'react'

export function PaletteGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <span
        style={{
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: 0.5,
          color: 'var(--text-muted)',
          textTransform: 'uppercase'
        }}
      >
        {label}
      </span>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{children}</div>
    </div>
  )
}

export function PaletteDivider() {
  return (
    <span
      style={{
        width: 1,
        alignSelf: 'stretch',
        background: 'var(--border-color)',
        flexShrink: 0,
        marginTop: 14
      }}
    />
  )
}

interface PaletteButtonProps {
  kind: string
  label: string
  color: string
  tooltip: string
  onClick: () => void
  /** Drag-data MIME type. Defaults to the QueryBuilder's operator type;
   *  DocumentSelector passes its own (`application/x-magnolia-ds-node`). */
  dragMimeType?: string
}

export function PaletteButton({
  kind,
  label,
  color,
  tooltip,
  onClick,
  dragMimeType = 'application/x-magnolia-operator'
}: PaletteButtonProps) {
  return (
    <button
      className="secondary"
      title={tooltip}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(dragMimeType, JSON.stringify({ kind }))
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onClick={onClick}
      style={{
        fontSize: 11,
        padding: '3px 10px',
        borderInlineStart: `3px solid ${color}`,
        cursor: 'grab',
        // Match the canvas surface so a chip dropped onto the canvas
        // visually "lands" on the same colour. Overrides the
        // .secondary class's default bg-primary.
        background: 'var(--canvas-bg)'
      }}
    >
      + {label}
    </button>
  )
}
