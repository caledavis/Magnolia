import { useState, useRef, useCallback, useEffect } from 'react'
import type { MapElement as MapElementType, MapConnection as MapConnectionType, FreeTextElement } from './types'
import { clampPan, computeRoundedPortPosition, computeOutwardNormal, bezPathFromPorts } from './bezier-utils'
import { cornerRadiusFor } from './MapConnection'
import { MapElement } from './MapElement'
import { MapConnectionComponent } from './MapConnection'
import { FreeTextNode } from './FreeTextNode'
import { Icon, MEMO_RANGED_ICON } from '../../Icon'
import { useTranslation } from 'react-i18next'

interface Props {
  elements: MapElementType[]
  freeTexts: FreeTextElement[]
  connections: MapConnectionType[]
  pan: { x: number; y: number }
  zoom: number
  selectedElementIds: Set<string>
  selectedConnectionIds: Set<string>
  selectedFreeTextIds: Set<string>
  /** When true, next click on canvas creates a free text node */
  addTextMode: boolean
  onPanChange: (pan: { x: number; y: number }) => void
  onZoomChange: (zoom: number) => void
  onElementMove: (id: string, x: number, y: number) => void
  onMultiElementMove: (ids: string[], dx: number, dy: number) => void
  onSelectElements: (ids: Set<string>, additive?: boolean) => void
  onSelectConnections: (ids: Set<string>) => void
  onSelectFreeTexts: (ids: Set<string>) => void
  onCreateConnection: (fromId: string, toId: string) => void
  onToggleArrow: (connId: string, end: 'from' | 'to') => void
  onUpdateConnectionLabel: (connId: string, label: string) => void
  onDropElement: (kind: string, data: any, x: number, y: number) => void
  onCreateFreeText: (x: number, y: number) => void
  onUpdateFreeText: (id: string, content: any) => void
  onMoveFreeText: (id: string, x: number, y: number) => void
  onDeleteSelected: () => void
  onFocusFreeText: (id: string | null) => void
  focusedFreeTextId: string | null
  onElementDoubleClick: (element: MapElementType) => void
  onEditorReady: (id: string, editor: any) => void
  onResizeFreeText: (id: string, update: { x: number; y: number; width: number; height: number }) => void
  onElementRenderedHeight: (id: string, height: number) => void
  /** Right-click "Add Memo" on a node box: attach an analysis memo to
   *  this element on this map. */
  onAddMemoToElement: (elementId: string) => void
  /** Right-click "Add Memo" on empty canvas at the given canvas-space
   *  position: create an analysis memo as a new memo element. */
  onAddMemoOnCanvas: (x: number, y: number) => void
  /** Click handler for a node's paperclip memo badge. */
  onOpenAttachedMemo: (elementId: string) => void
  /** Optional ref to the pan-wrapper div (the element whose subtree
   *  contains every node, free text, and connection layer). Exposed so
   *  parents can clone the live rendered DOM for image export. */
  panWrapperRef?: React.MutableRefObject<HTMLDivElement | null>
}

type DragState =
  | null
  | { t: 'node'; id: string; ox: number; oy: number; startX: number; startY: number; kind: 'element' | 'freetext' }
  | { t: 'wire'; fromId: string }
  | { t: 'marquee'; sx: number; sy: number; cx: number; cy: number }

const GRID_SIZE = 20

export function MapCanvas({
  elements,
  freeTexts,
  connections,
  pan,
  zoom,
  selectedElementIds,
  selectedConnectionIds,
  selectedFreeTextIds,
  addTextMode,
  onPanChange,
  onZoomChange,
  onElementMove,
  onMultiElementMove,
  onSelectElements,
  onSelectConnections,
  onSelectFreeTexts,
  onCreateConnection,
  onToggleArrow,
  onUpdateConnectionLabel,
  onDropElement,
  onCreateFreeText,
  onUpdateFreeText,
  onMoveFreeText,
  onDeleteSelected,
  onFocusFreeText,
  focusedFreeTextId,
  onElementDoubleClick,
  onEditorReady,
  onResizeFreeText,
  onElementRenderedHeight,
  onAddMemoToElement,
  onAddMemoOnCanvas,
  onOpenAttachedMemo,
  panWrapperRef
}: Props) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const wireRef = useRef<SVGPathElement>(null)
  const [drag, setDrag] = useState<DragState>(null)
  const dragRef = useRef<DragState>(null)
  const [marqueeRect, setMarqueeRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  // Right-click menu state. `canvasPos` is in canvas (pre-pan/zoom)
  // coordinates so canvas-level Add Memo can place the memo at the
  // exact click point; `screenPos` is in viewport pixels for menu
  // positioning.
  const [contextMenu, setContextMenu] = useState<{
    screenPos: { x: number; y: number }
    canvasPos: { x: number; y: number }
    elementId: string | null
  } | null>(null)
  // Focus-fade: track which element / connection the mouse is currently
  // over. Combined with the selection sets, this drives the "emphasise
  // the focused subset, dim everything else" behaviour.
  const [hoveredElementId, setHoveredElementId] = useState<string | null>(null)
  const [hoveredConnectionId, setHoveredConnectionId] = useState<string | null>(null)

  const handleElementHover = useCallback((id: string, isHover: boolean) => {
    setHoveredElementId((cur) => (isHover ? id : cur === id ? null : cur))
  }, [])
  const handleConnectionHover = useCallback((id: string, isHover: boolean) => {
    setHoveredConnectionId((cur) => (isHover ? id : cur === id ? null : cur))
  }, [])

  // Compute the focused subset. If there's no selection and nothing is
  // hovered, focus mode is OFF and everything renders neutrally.
  const focusActive =
    hoveredElementId !== null ||
    hoveredConnectionId !== null ||
    selectedElementIds.size > 0 ||
    selectedConnectionIds.size > 0
  const focusedElementIds = new Set<string>()
  const focusedConnectionIds = new Set<string>()
  if (focusActive) {
    for (const id of selectedElementIds) focusedElementIds.add(id)
    if (hoveredElementId) focusedElementIds.add(hoveredElementId)
    // Snapshot the directly-focused elements (hovered + selected) so the
    // connection loop only matches first-level neighbours. Without the
    // snapshot, any endpoint we added on a previous iteration would
    // count as a "focused element" on later iterations, producing a
    // transitive (multi-level) walk that pulled in unrelated nodes
    // depending on the order connections happen to be stored.
    const directlyFocusedElements = new Set(focusedElementIds)
    for (const c of connections) {
      const touchesEl = directlyFocusedElements.has(c.fromId) || directlyFocusedElements.has(c.toId)
      const isSel = selectedConnectionIds.has(c.id)
      const isHov = hoveredConnectionId === c.id
      if (touchesEl || isSel || isHov) {
        focusedConnectionIds.add(c.id)
        // Pull both endpoints of the connection into focus, but only
        // for emphasis — they don't extend the search any further.
        focusedElementIds.add(c.fromId)
        focusedElementIds.add(c.toId)
      }
    }
  }

  dragRef.current = drag

  // All nodes for pan clamping
  const allNodes = [
    ...elements.map((e) => ({ x: e.x, y: e.y, width: e.width, height: e.height })),
    ...freeTexts.map((f) => ({ x: f.x, y: f.y, width: f.width, height: f.height }))
  ]

  // Convert mouse event to canvas coordinates
  const cpos = useCallback(
    (e: MouseEvent | React.MouseEvent): { x: number; y: number } => {
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return { x: 0, y: 0 }
      return { x: (e.clientX - rect.left - pan.x) / zoom, y: (e.clientY - rect.top - pan.y) / zoom }
    },
    [pan, zoom]
  )

  // Wheel handler for panning and zooming
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e: WheelEvent): void => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        // Zoom: Ctrl/Cmd + scroll or pinch-to-zoom (which reports ctrlKey)
        const delta = -e.deltaY * 0.005
        const newZoom = Math.max(0.25, Math.min(3, zoom + delta))
        onZoomChange(newZoom)
      } else {
        // Pan
        const np = clampPan(pan.x - e.deltaX, pan.y - e.deltaY, allNodes, el)
        onPanChange(np)
      }
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  })

  // Keyboard handler
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (
          document.activeElement?.tagName === 'INPUT' ||
          document.activeElement?.tagName === 'TEXTAREA' ||
          (document.activeElement as HTMLElement)?.isContentEditable
        )
          return
        onDeleteSelected()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        // Don't intercept if focus is in an input, textarea, or contenteditable
        if (
          document.activeElement?.tagName === 'INPUT' ||
          document.activeElement?.tagName === 'TEXTAREA' ||
          (document.activeElement as HTMLElement)?.isContentEditable
        ) return
        e.preventDefault()
        onSelectElements(new Set(elements.map((el) => el.id)))
        onSelectFreeTexts(new Set(freeTexts.map((f) => f.id)))
      }
      if (e.key === 'Escape') {
        onSelectElements(new Set())
        onSelectConnections(new Set())
        onSelectFreeTexts(new Set())
        onFocusFreeText(null)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [elements, freeTexts, onDeleteSelected, onSelectElements, onSelectConnections, onSelectFreeTexts, onFocusFreeText])

  // Global mousemove/mouseup for drag
  useEffect(() => {
    const handleMove = (e: MouseEvent): void => {
      const d = dragRef.current
      if (!d) return
      const pos = cpos(e)

      if (d.t === 'node') {
        const nx = pos.x - d.ox
        const ny = pos.y - d.oy
        if (
          d.kind === 'element' &&
          selectedElementIds.size > 1 &&
          selectedElementIds.has(d.id)
        ) {
          const el = elements.find((el) => el.id === d.id)
          if (el) {
            const dx = nx - el.x
            const dy = ny - el.y
            onMultiElementMove([...selectedElementIds], dx, dy)
          }
        } else if (d.kind === 'element') {
          onElementMove(d.id, nx, ny)
        } else {
          onMoveFreeText(d.id, nx, ny)
        }
      } else if (d.t === 'wire') {
        // Update temporary wire via DOM. Source can be either a
        // MapElement or a FreeTextNode — both expose the same
        // x/y/width/height geometry the bezier code needs. Freetexts
        // get a 4 px corner radius to match their rendered outline.
        if (wireRef.current) {
          const fromMapEl = elements.find((el) => el.id === d.fromId)
          const fromFt = fromMapEl ? null : freeTexts.find((f) => f.id === d.fromId)
          const fromEl = fromMapEl ?? fromFt
          if (fromEl) {
            const radius = fromMapEl ? cornerRadiusFor(fromMapEl) : 4
            const fromPort = computeRoundedPortPosition(fromEl, pos, radius)
            const fromNormal = computeOutwardNormal(fromEl, fromPort, radius)
            // For the loose (cursor) end, pretend the line arrives along
            // the vector from cursor toward the source port — gives the
            // temporary curve the same feel as the final connection.
            const backDx = fromPort.x - pos.x
            const backDy = fromPort.y - pos.y
            const bLen = Math.hypot(backDx, backDy)
            const toNormal = bLen > 0.01
              ? { x: backDx / bLen, y: backDy / bLen }
              : { x: -fromNormal.x, y: -fromNormal.y }
            const path = bezPathFromPorts(fromPort, fromNormal, pos, toNormal)
            wireRef.current.setAttribute('d', path)
            wireRef.current.style.display = ''
          }
        }
      } else if (d.t === 'marquee') {
        const cx = pos.x
        const cy = pos.y
        setDrag({ ...d, cx, cy })
        const x1 = Math.min(d.sx, cx)
        const y1 = Math.min(d.sy, cy)
        const x2 = Math.max(d.sx, cx)
        const y2 = Math.max(d.sy, cy)
        setMarqueeRect({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 })
        // Live-preview selection while dragging
        const hitEls = new Set<string>()
        const hitFts = new Set<string>()
        for (const el of elements) {
          if (el.x + el.width > x1 && el.x < x2 && el.y + el.height > y1 && el.y < y2) {
            hitEls.add(el.id)
          }
        }
        for (const ft of freeTexts) {
          if (ft.x + ft.width > x1 && ft.x < x2 && ft.y + ft.height > y1 && ft.y < y2) {
            hitFts.add(ft.id)
          }
        }
        onSelectElements(hitEls)
        onSelectFreeTexts(hitFts)
      }
    }

    const handleUp = (e: MouseEvent): void => {
      const d = dragRef.current
      if (!d) return

      if (d.t === 'wire') {
        if (wireRef.current) wireRef.current.style.display = 'none'
        const pos = cpos(e)
        // Hit test: find element OR freetext under mouse. Iterate
        // elements first then freetexts; the first hit wins. Both
        // categories are valid wire endpoints since the connection
        // model only stores ids and the geometry resolves either kind.
        let hitId: string | null = null
        for (const el of elements) {
          if (el.id === d.fromId) continue
          if (
            pos.x >= el.x &&
            pos.x <= el.x + el.width &&
            pos.y >= el.y &&
            pos.y <= el.y + el.height
          ) {
            hitId = el.id
            break
          }
        }
        if (!hitId) {
          for (const ft of freeTexts) {
            if (ft.id === d.fromId) continue
            if (
              pos.x >= ft.x &&
              pos.x <= ft.x + ft.width &&
              pos.y >= ft.y &&
              pos.y <= ft.y + ft.height
            ) {
              hitId = ft.id
              break
            }
          }
        }
        if (hitId) onCreateConnection(d.fromId, hitId)
      } else if (d.t === 'marquee') {
        const rect = marqueeRect
        if (rect) {
          const hitEls = new Set<string>()
          const hitFts = new Set<string>()
          for (const el of elements) {
            if (
              el.x + el.width > rect.x &&
              el.x < rect.x + rect.w &&
              el.y + el.height > rect.y &&
              el.y < rect.y + rect.h
            ) {
              hitEls.add(el.id)
            }
          }
          for (const ft of freeTexts) {
            if (
              ft.x + ft.width > rect.x &&
              ft.x < rect.x + rect.w &&
              ft.y + ft.height > rect.y &&
              ft.y < rect.y + rect.h
            ) {
              hitFts.add(ft.id)
            }
          }
          onSelectElements(hitEls, e.altKey || e.metaKey)
          onSelectFreeTexts(hitFts)
        }
        setMarqueeRect(null)
      }

      setDrag(null)
      dragRef.current = null
    }

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [elements, freeTexts, pan, selectedElementIds, cpos, marqueeRect, onElementMove, onMultiElementMove, onMoveFreeText, onCreateConnection, onSelectElements, onSelectFreeTexts])

  /** Header drag → move element */
  const handleHeaderMouseDown = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation()
      const pos = cpos(e)
      const el = elements.find((el) => el.id === id)
      if (!el) return

      if (!e.shiftKey && !selectedElementIds.has(id)) {
        onSelectElements(new Set([id]))
        onSelectConnections(new Set())
        onSelectFreeTexts(new Set())
      } else if (e.shiftKey) {
        const next = new Set(selectedElementIds)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        onSelectElements(next)
      }

      setDrag({ t: 'node', id, ox: pos.x - el.x, oy: pos.y - el.y, startX: el.x, startY: el.y, kind: 'element' })
      dragRef.current = { t: 'node', id, ox: pos.x - el.x, oy: pos.y - el.y, startX: el.x, startY: el.y, kind: 'element' }
    },
    [elements, selectedElementIds, cpos, onSelectElements, onSelectConnections, onSelectFreeTexts]
  )

  /** Body drag → draw connection wire */
  const handleBodyMouseDown = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation()
      onSelectElements(new Set([id]))
      onSelectConnections(new Set())
      onSelectFreeTexts(new Set())
      setDrag({ t: 'wire', fromId: id })
      dragRef.current = { t: 'wire', fromId: id }
    },
    [onSelectElements, onSelectConnections, onSelectFreeTexts]
  )

  /** FreeText connector-handle drag → draw wire (mirror of
   *  handleBodyMouseDown for MapElement). Lets the user originate a
   *  connection from a free-text node by dragging its connector
   *  handle. handleUp's wire-end hit-test then resolves the drop
   *  against both elements and freetexts. */
  const handleFreeTextConnectorMouseDown = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation()
      onSelectFreeTexts(new Set([id]))
      onSelectElements(new Set())
      onSelectConnections(new Set())
      setDrag({ t: 'wire', fromId: id })
      dragRef.current = { t: 'wire', fromId: id }
    },
    [onSelectElements, onSelectConnections, onSelectFreeTexts]
  )

  const handleFreeTextMouseDown = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation()
      const pos = cpos(e)
      const ft = freeTexts.find((f) => f.id === id)
      if (!ft) return

      onSelectFreeTexts(new Set([id]))
      onSelectElements(new Set())
      onSelectConnections(new Set())

      setDrag({ t: 'node', id, ox: pos.x - ft.x, oy: pos.y - ft.y, startX: ft.x, startY: ft.y, kind: 'freetext' })
      dragRef.current = { t: 'node', id, ox: pos.x - ft.x, oy: pos.y - ft.y, startX: ft.x, startY: ft.y, kind: 'freetext' }
    },
    [freeTexts, cpos, onSelectElements, onSelectConnections, onSelectFreeTexts]
  )

  const handleCanvasMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Nodes call e.stopPropagation(), so any click reaching here is on the background.
      const pos = cpos(e)

      if (addTextMode) {
        onCreateFreeText(pos.x, pos.y)
        return
      }

      // Start marquee
      onSelectElements(new Set())
      onSelectConnections(new Set())
      onSelectFreeTexts(new Set())
      onFocusFreeText(null)
      setDrag({ t: 'marquee', sx: pos.x, sy: pos.y, cx: pos.x, cy: pos.y })
      dragRef.current = { t: 'marquee', sx: pos.x, sy: pos.y, cx: pos.x, cy: pos.y }
    },
    [cpos, addTextMode, onSelectElements, onSelectConnections, onSelectFreeTexts, onCreateFreeText, onFocusFreeText]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const json = e.dataTransfer.getData('application/json')
      if (!json) return
      try {
        const data = JSON.parse(json)
        const pos = cpos(e as unknown as React.MouseEvent)
        // Multi-select drop: fan out each selected item with a small
        // diagonal cascade so they don't land on top of each other.
        if (data.kind === 'multi' && Array.isArray(data.items)) {
          data.items.forEach((item: any, i: number) => {
            const dx = i * 18
            const dy = i * 18
            onDropElement(item.kind, item, pos.x + dx, pos.y + dy)
          })
        } else {
          onDropElement(data.kind, data, pos.x, pos.y)
        }
      } catch {}
    },
    [cpos, onDropElement]
  )

  const handleRecentre = useCallback(() => {
    if (!containerRef.current || allNodes.length === 0) return
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const n of allNodes) {
      minX = Math.min(minX, n.x)
      minY = Math.min(minY, n.y)
      maxX = Math.max(maxX, n.x + n.width)
      maxY = Math.max(maxY, n.y + n.height)
    }
    const cw = containerRef.current.clientWidth
    const ch = containerRef.current.clientHeight
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    onPanChange({ x: cw / 2 - cx, y: ch / 2 - cy })
  }, [allNodes, onPanChange])

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const pos = cpos(e)
      // Hit-test elements (newest-on-top last, so iterate in reverse).
      // Memos and freetexts can't host an attached analysis memo — fall
      // through to the canvas-level action in that case.
      let hitId: string | null = null
      for (let i = elements.length - 1; i >= 0; i--) {
        const el = elements[i]
        if (el.kind === 'memo') continue
        if (
          pos.x >= el.x && pos.x <= el.x + el.width &&
          pos.y >= el.y && pos.y <= el.y + el.height
        ) {
          hitId = el.id
          break
        }
      }
      setContextMenu({
        screenPos: { x: e.clientX, y: e.clientY },
        canvasPos: pos,
        elementId: hitId
      })
    },
    [cpos, elements]
  )

  // Dismiss the context menu on any click elsewhere or Escape.
  useEffect(() => {
    if (!contextMenu) return
    const onDown = (): void => setContextMenu(null)
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setContextMenu(null) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [contextMenu])

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Viewer toolbar — matches PDF/image viewers. Connected zoom strip
          on the left, map meta label on the right. */}
      <div className="viewer-toolbar">
        <div className="zoom-strip">
          <button
            onClick={() => onZoomChange(Math.max(0.25, zoom * 0.9))}
            title={t('map.zoomOut')}
          >
            −
          </button>
          <button onClick={() => onZoomChange(1)} title={t('map.resetZoom')}>
            100%
          </button>
          <button
            onClick={() => onZoomChange(Math.min(3, zoom * 1.1))}
            title={t('map.zoomIn')}
          >
            +
          </button>
          <button onClick={handleRecentre} title={t('map.recentreTitle')}>
            {t('queryBuilder.recentre')}
          </button>
        </div>
        <span className="viewer-spacer" />
        <span className="viewer-meta">{t('map.map')}</span>
      </div>
    <div
      ref={containerRef}
      onMouseDown={handleCanvasMouseDown}
      onContextMenu={handleContextMenu}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
      style={{
        flex: 1,
        position: 'relative',
        overflow: 'hidden',
        cursor: addTextMode ? 'text' : 'default'
      }}
    >
      {/* Grid background */}
      <svg
        className="map-canvas-bg"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      >
        <defs>
          <pattern
            id="grid-dots"
            width={GRID_SIZE}
            height={GRID_SIZE}
            patternUnits="userSpaceOnUse"
            x={pan.x % GRID_SIZE}
            y={pan.y % GRID_SIZE}
          >
            <circle cx={GRID_SIZE / 2} cy={GRID_SIZE / 2} r={0.8} fill="var(--border-color, #d0d0d0)" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid-dots)" />
      </svg>

      {/* Pan wrapper */}
      <div
        ref={(el) => { if (panWrapperRef) panWrapperRef.current = el }}
        style={{ position: 'absolute', left: 0, top: 0, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0' }}
      >
        {/* SVG layer 1: connection LINES (behind elements) */}
        <svg
          style={{
            position: 'absolute', left: 0, top: 0, width: 1, height: 1,
            overflow: 'visible', pointerEvents: 'none', zIndex: 0
          }}
        >
          <g>
            {connections.map((conn) => (
              <MapConnectionComponent
                key={`line-${conn.id}`}
                connection={conn}
                elements={elements}
                freeTexts={freeTexts}
                allConnections={connections}
                selected={selectedConnectionIds.has(conn.id)}
                layer="lines"
                focusState={
                  !focusActive
                    ? undefined
                    : focusedConnectionIds.has(conn.id)
                      ? 'emphasised'
                      : 'dimmed'
                }
                onSelect={() => {}}
                onToggleArrow={() => {}}
                onUpdateLabel={() => {}}
              />
            ))}
            {/* Temporary wire during drag */}
            <path
              ref={wireRef}
              fill="none"
              stroke="#a78bfa"
              strokeWidth={2}
              strokeDasharray="8 5"
              style={{ display: 'none' }}
            />
          </g>
        </svg>

        {/* HTML layer: element boxes and free text (middle z-index) */}
        {elements.map((el) => (
          <MapElement
            key={el.id}
            element={el}
            selected={selectedElementIds.has(el.id)}
            dimmed={focusActive && !focusedElementIds.has(el.id)}
            onHeaderMouseDown={handleHeaderMouseDown}
            onBodyMouseDown={handleBodyMouseDown}
            onDoubleClick={onElementDoubleClick}
            onRenderedHeight={onElementRenderedHeight}
            onHoverChange={handleElementHover}
          />
        ))}
        {freeTexts.map((ft) => (
          <FreeTextNode
            key={ft.id}
            freeText={ft}
            selected={selectedFreeTextIds.has(ft.id)}
            focused={focusedFreeTextId === ft.id}
            zoom={zoom}
            onMouseDown={handleFreeTextMouseDown}
            onConnectorMouseDown={handleFreeTextConnectorMouseDown}
            onFocus={() => onFocusFreeText(ft.id)}
            onUpdate={(content) => onUpdateFreeText(ft.id, content)}
            onEditorReady={(editor) => onEditorReady(ft.id, editor)}
            onResize={onResizeFreeText}
          />
        ))}

        {/* Analysis-memo badges: a small circular paperclip button in the
            top-right corner of any element that has an attached analysis
            memo. Rendered as its own layer so it sits outside the
            element's overflow:hidden clip. */}
        {elements
          .filter((el) => el.memoGuid && el.kind !== 'memo')
          .map((el) => {
            const BADGE = 20
            return (
              <div
                key={`memo-badge-${el.id}`}
                title={t('map.openMemo')}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  onOpenAttachedMemo(el.id)
                }}
                style={{
                  position: 'absolute',
                  left: el.x + el.width - BADGE / 2,
                  top: el.y - BADGE / 2,
                  width: BADGE,
                  height: BADGE,
                  borderRadius: '50%',
                  background: 'rgba(255,255,255,0.95)',
                  border: '1.5px solid var(--memo-icon-color, #6e6e6e)',
                  color: 'var(--memo-icon-color, #6e6e6e)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.18)',
                  cursor: 'pointer',
                  userSelect: 'none',
                  zIndex: 10
                }}
              >
                <Icon icon={MEMO_RANGED_ICON} style={{ fontSize: 11 }} />
              </div>
            )
          })}

        {/* SVG layer 2: arrowheads, labels, hit targets (in front of elements) */}
        <svg
          style={{
            position: 'absolute', left: 0, top: 0, width: 1, height: 1,
            overflow: 'visible', pointerEvents: 'none', zIndex: 20
          }}
        >
          <g style={{ pointerEvents: 'auto' }}>
            {connections.map((conn) => (
              <MapConnectionComponent
                key={`overlay-${conn.id}`}
                connection={conn}
                elements={elements}
                freeTexts={freeTexts}
                allConnections={connections}
                selected={selectedConnectionIds.has(conn.id)}
                layer="overlay"
                focusState={
                  !focusActive
                    ? undefined
                    : focusedConnectionIds.has(conn.id)
                      ? 'emphasised'
                      : 'dimmed'
                }
                onSelect={(id, e) => {
                  e.stopPropagation()
                  onSelectConnections(new Set([id]))
                  onSelectElements(new Set())
                  onSelectFreeTexts(new Set())
                }}
                onHoverChange={handleConnectionHover}
                onToggleArrow={onToggleArrow}
                onUpdateLabel={onUpdateConnectionLabel}
              />
            ))}
          </g>
        </svg>
      </div>

      {/* Marquee selection rectangle */}
      {marqueeRect && (
        <div
          style={{
            position: 'absolute',
            left: marqueeRect.x * zoom + pan.x,
            top: marqueeRect.y * zoom + pan.y,
            width: marqueeRect.w * zoom,
            height: marqueeRect.h * zoom,
            border: '1px solid #3b82f6',
            background: 'rgba(59,130,246,0.08)',
            pointerEvents: 'none'
          }}
        />
      )}

      {/* Right-click context menu (positioned in viewport coords). */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.screenPos.x, top: contextMenu.screenPos.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div
            className="context-menu-item"
            onClick={() => {
              if (contextMenu.elementId) {
                onAddMemoToElement(contextMenu.elementId)
              } else {
                onAddMemoOnCanvas(contextMenu.canvasPos.x, contextMenu.canvasPos.y)
              }
              setContextMenu(null)
            }}
          >
            {t('common.addMemo')}
          </div>
        </div>
      )}

    </div>
    </div>
  )
}
