/**
 * ImagePageRenderer — renders an image source with box-coding overlays.
 *
 * Sister component to PdfPageRenderer but trimmed to image needs:
 *   - No canvas / pdfjs / text layer
 *   - One <img> at scale * naturalSize
 *   - Same coding-rectangle, hover-highlight, box-drag preview, pending-
 *     box outline overlays
 *   - data-pdf-page="1" and data-pdf-scale on the root so the existing
 *     RichMarginColumn.getPdfRegionYBounds works without changes
 *
 * The reused MEMO_WAVE / MEMO_WAVE_V data-URLs are duplicated here rather
 * than imported, matching the lightweight "render is local" pattern of the
 * PDF renderer.
 */
import { useEffect, useRef, useState } from 'react'
import type { PlainTextSelection, Code, Memo } from '../../models/types'
import { Icon, MEMO_POINT_ICON } from '../Icon'

const MEMO_WAVE = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='2.25'%3E%3Cpath d='M0 2.25 L3 0 L6 2.25 L9 0 L12 2.25' fill='none' stroke='%234a90d9' stroke-width='1'/%3E%3C/svg%3E")`
const MEMO_WAVE_V = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='2.25' height='12'%3E%3Cpath d='M2.25 0 L0 3 L2.25 6 L0 9 L2.25 12' fill='none' stroke='%234a90d9' stroke-width='1'/%3E%3C/svg%3E")`

interface Props {
  /** Object URL pointing at the image bytes loaded via the renderer IPC. */
  imageUrl: string
  scale: number
  selections: PlainTextSelection[]
  codeMap: Map<string, Code>
  contentMemos?: Memo[]
  hoveredSelGuid?: string | null
  /** Highlight overlay drawn when the user hovers a memo / quote icon
   *  whose underlying item has a pdfRegion. Same visual treatment as a
   *  hovered selection box. */
  hoveredRegion?: import('../../models/types').PdfRegionSelection | null
  /** Brief pulse overlay for "jump to quote" clicks on a box region. */
  pulseRegion?: import('../../models/types').PdfRegionSelection | null
  /** Live drag-preview rectangle (image-pixel coords, top-origin). */
  boxDragPreview?: { startX: number; startY: number; currentX: number; currentY: number } | null
  /** Completed pending box selection awaiting coding. */
  pendingBoxRegion?: import('../../models/types').PdfRegionSelection | null
  /** Double-click on a point memo's circular icon overlay opens its editor. */
  onMemoDoubleClick?: (memoGuid: string) => void
  /** Click-and-drag a point memo's icon to reposition it. (x, y) are in
   *  image-pixel coordinates. */
  onMemoMove?: (memoGuid: string, x: number, y: number) => void
  onLoad?: (naturalWidth: number, naturalHeight: number) => void
}

export function ImagePageRenderer({
  imageUrl, scale, selections, codeMap, contentMemos, hoveredSelGuid, hoveredRegion, pulseRegion,
  boxDragPreview, pendingBoxRegion, onMemoDoubleClick, onMemoMove, onLoad
}: Props) {
  const imgRef = useRef<HTMLImageElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  // Active drag of a point-memo icon. While set, we track mousemove on
  // window and reposition by feeding the parent the new (x, y).
  const [memoDrag, setMemoDrag] = useState<{ guid: string; startClientX: number; startClientY: number; origX: number; origY: number } | null>(null)

  useEffect(() => {
    if (!memoDrag) return
    const onMove = (e: MouseEvent) => {
      const dx = (e.clientX - memoDrag.startClientX) / scale
      const dy = (e.clientY - memoDrag.startClientY) / scale
      onMemoMove?.(memoDrag.guid, memoDrag.origX + dx, memoDrag.origY + dy)
    }
    const onUp = () => setMemoDrag(null)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [memoDrag, scale, onMemoMove])

  // Render coding-rectangle, hover, and memo-wave overlays. Mirrors the
  // region-overlay code in PdfPageRenderer's main effect, trimmed to box
  // selections only (no character-offset highlights).
  useEffect(() => {
    const overlay = overlayRef.current
    if (!overlay || naturalSize.w === 0) return
    overlay.innerHTML = ''

    interface RegionKey { left: number; top: number; width: number; height: number; colors: string[] }
    const regionGroups = new Map<string, RegionKey>()
    for (const sel of selections) {
      if (!sel.pdfRegion) continue
      const left = sel.pdfRegion.x * scale
      const top = sel.pdfRegion.y * scale
      const width = sel.pdfRegion.width * scale
      const height = sel.pdfRegion.height * scale
      const key = `${Math.round(left)}:${Math.round(top)}:${Math.round(width)}:${Math.round(height)}`
      const group = regionGroups.get(key) || { left, top, width, height, colors: [] }
      for (const coding of sel.codings) {
        const code = codeMap.get(coding.codeGuid)
        if (!code) continue
        const color = code.color || '#888'
        if (!group.colors.includes(color)) group.colors.push(color)
      }
      regionGroups.set(key, group)
    }

    for (const group of regionGroups.values()) {
      if (group.colors.length === 0) continue
      const div = document.createElement('div')
      const BORDER_W = 2
      if (group.colors.length === 1) {
        // Global `box-sizing: border-box` means `width` is the outer edge
        // and the border sits inside — match the multi-colour branch and
        // the hover-highlight overlay so the box and highlight align.
        div.style.cssText = `
          position: absolute;
          left: ${group.left}px;
          top: ${group.top}px;
          width: ${group.width}px;
          height: ${group.height}px;
          pointer-events: none;
          border: ${BORDER_W}px solid ${group.colors[0]};
          border-radius: 2px;
        `
      } else {
        const segWidth = 4
        const stops = group.colors
          .map((c, i) => `${c} ${i * segWidth}px, ${c} ${(i + 1) * segWidth}px`)
          .join(', ')
        const totalWidth = group.colors.length * segWidth
        const hGradient = `repeating-linear-gradient(90deg, ${stops})`
        const vGradient = `repeating-linear-gradient(0deg, ${stops})`
        div.style.cssText = `
          position: absolute;
          left: ${group.left}px;
          top: ${group.top}px;
          width: ${group.width}px;
          height: ${group.height}px;
          pointer-events: none;
          border-radius: 2px;
          background:
            ${hGradient} top left / ${totalWidth}px ${BORDER_W}px repeat-x,
            ${hGradient} bottom left / ${totalWidth}px ${BORDER_W}px repeat-x,
            ${vGradient} top left / ${BORDER_W}px ${totalWidth}px repeat-y,
            ${vGradient} top right / ${BORDER_W}px ${totalWidth}px repeat-y;
        `
      }
      overlay.appendChild(div)
    }

    // Hover highlight for region-based selections
    if (hoveredSelGuid) {
      for (const sel of selections) {
        if (!sel.pdfRegion || sel.guid !== hoveredSelGuid) continue
        const left = sel.pdfRegion.x * scale
        const top = sel.pdfRegion.y * scale
        const width = sel.pdfRegion.width * scale
        const height = sel.pdfRegion.height * scale
        const div = document.createElement('div')
        div.style.cssText = `
          position: absolute;
          left: ${left}px;
          top: ${top}px;
          width: ${width}px;
          height: ${height}px;
          pointer-events: none;
          background: rgba(60, 100, 240, 0.18);
          border: 1.5px solid rgba(60, 100, 240, 0.5);
          border-radius: 2px;
        `
        overlay.appendChild(div)
      }
    }

    // Hover highlight for region-anchored memos / quotes when the user
    // mouses over the matching icon in the margin column.
    if (hoveredRegion) {
      const left = hoveredRegion.x * scale
      const top = hoveredRegion.y * scale
      const width = hoveredRegion.width * scale
      const height = hoveredRegion.height * scale
      const div = document.createElement('div')
      div.style.cssText = `
        position: absolute;
        left: ${left}px;
        top: ${top}px;
        width: ${width}px;
        height: ${height}px;
        pointer-events: none;
        background: rgba(60, 100, 240, 0.18);
        border: 1.5px solid rgba(60, 100, 240, 0.5);
        border-radius: 2px;
      `
      overlay.appendChild(div)
    }

    // Memo wave borders for pdfRegion memos. 0×0 regions are point
    // memos — skipped here and rendered as a circular icon below.
    if (contentMemos) {
      for (const memo of contentMemos) {
        if (!memo.pdfRegion) continue
        if (memo.pdfRegion.width === 0 && memo.pdfRegion.height === 0) continue
        const left = memo.pdfRegion.x * scale
        const top = memo.pdfRegion.y * scale
        const width = memo.pdfRegion.width * scale
        const height = memo.pdfRegion.height * scale
        const WAVE_H = 2.25
        const t = document.createElement('div')
        t.style.cssText = `position:absolute;left:${left}px;top:${top - WAVE_H}px;width:${width}px;height:${WAVE_H}px;pointer-events:none;background-image:${MEMO_WAVE};background-size:12px ${WAVE_H}px;background-repeat:repeat-x;`
        overlay.appendChild(t)
        const b = document.createElement('div')
        b.style.cssText = `position:absolute;left:${left}px;top:${top + height}px;width:${width}px;height:${WAVE_H}px;pointer-events:none;background-image:${MEMO_WAVE};background-size:12px ${WAVE_H}px;background-repeat:repeat-x;`
        overlay.appendChild(b)
        const l = document.createElement('div')
        l.style.cssText = `position:absolute;left:${left - WAVE_H}px;top:${top}px;width:${WAVE_H}px;height:${height}px;pointer-events:none;background-image:${MEMO_WAVE_V};background-size:${WAVE_H}px 12px;background-repeat:repeat-y;`
        overlay.appendChild(l)
        const r = document.createElement('div')
        r.style.cssText = `position:absolute;left:${left + width}px;top:${top}px;width:${WAVE_H}px;height:${height}px;pointer-events:none;background-image:${MEMO_WAVE_V};background-size:${WAVE_H}px 12px;background-repeat:repeat-y;`
        overlay.appendChild(r)
      }
    }

    // Quote-click pulse (box region) — fades in and out via quote-pulse
    // keyframes, then disappears. Parent clears the prop shortly after.
    if (pulseRegion) {
      const left = pulseRegion.x * scale
      const top = pulseRegion.y * scale
      const width = pulseRegion.width * scale
      const height = pulseRegion.height * scale
      const div = document.createElement('div')
      div.style.cssText = `
        position: absolute;
        left: ${left}px; top: ${top}px;
        width: ${width}px; height: ${height}px;
        pointer-events: none;
        border-radius: 2px;
        background: rgba(60, 100, 240, 0.25);
        border: 2px solid rgba(60, 100, 240, 0.75);
        animation: quote-pulse 1.5s ease-out forwards;
      `
      overlay.appendChild(div)
    }
  }, [selections, codeMap, contentMemos, hoveredSelGuid, hoveredRegion, pulseRegion, scale, naturalSize])

  const handleLoad = () => {
    if (!imgRef.current) return
    const w = imgRef.current.naturalWidth
    const h = imgRef.current.naturalHeight
    setNaturalSize({ w, h })
    onLoad?.(w, h)
  }

  return (
    <div
      data-pdf-page={1}
      data-pdf-scale={scale}
      style={{
        position: 'relative',
        width: naturalSize.w * scale || 'auto',
        height: naturalSize.h * scale || 'auto',
        boxShadow: '0 1px 4px rgba(0,0,0,0.12)',
        background: 'white',
        borderRadius: 2,
        overflow: 'hidden'
      }}
    >
      <img
        ref={imgRef}
        src={imageUrl}
        onLoad={handleLoad}
        // draggable={false} prevents the browser's native image drag —
        // box-coding drags from the codebook still arrive at the container's
        // onDrop because they originate elsewhere.
        draggable={false}
        style={{
          display: 'block',
          width: naturalSize.w * scale || 'auto',
          height: naturalSize.h * scale || 'auto',
          userSelect: 'none',
          pointerEvents: 'none'  // mouse events pass through to the page-el container for box-drag
        }}
      />
      <div
        ref={overlayRef}
        style={{
          position: 'absolute',
          top: 0, left: 0,
          width: '100%', height: '100%',
          pointerEvents: 'none'
        }}
      />
      {/* Box drag preview — dashed rectangle during active drag */}
      {boxDragPreview && (() => {
        const x = Math.min(boxDragPreview.startX, boxDragPreview.currentX) * scale
        const y = Math.min(boxDragPreview.startY, boxDragPreview.currentY) * scale
        const w = Math.abs(boxDragPreview.currentX - boxDragPreview.startX) * scale
        const h = Math.abs(boxDragPreview.currentY - boxDragPreview.startY) * scale
        return (
          <div style={{
            position: 'absolute', left: x, top: y, width: w, height: h,
            border: '2px dashed rgba(60, 100, 240, 0.7)',
            background: 'rgba(60, 100, 240, 0.08)',
            pointerEvents: 'none', zIndex: 10, borderRadius: 2
          }} />
        )
      })()}
      {/* Point-memo icons — rendered via React (not the imperative
          overlay) so they're clickable. A 0×0 pdfRegion encodes a point
          memo pinned to the page; double-click opens the memo editor. */}
      {contentMemos && contentMemos.filter((m) =>
        m.pdfRegion && m.pdfRegion.width === 0 && m.pdfRegion.height === 0
      ).map((m) => {
        const r = m.pdfRegion!
        const SIZE = 22
        return (
          <div
            key={`pt-memo-${m.guid}`}
            title={m.title || 'Memo'}
            onMouseDown={(e) => {
              if (e.button !== 0) return
              e.stopPropagation()
              e.preventDefault()
              setMemoDrag({ guid: m.guid, startClientX: e.clientX, startClientY: e.clientY, origX: r.x, origY: r.y })
            }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              onMemoDoubleClick?.(m.guid)
            }}
            style={{
              position: 'absolute',
              left: r.x * scale - SIZE / 2,
              top: r.y * scale - SIZE / 2,
              width: SIZE, height: SIZE,
              borderRadius: '50%',
              background: 'rgba(255, 255, 255, 0.9)',
              border: '1.5px solid #4a90d9',
              color: '#4a90d9',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: memoDrag?.guid === m.guid ? 'grabbing' : 'grab',
              boxShadow: '0 1px 3px rgba(0, 0, 0, 0.18)',
              zIndex: 11,
              userSelect: 'none'
            }}
          >
            <Icon icon={MEMO_POINT_ICON} style={{ fontSize: 11 }} />
          </div>
        )
      })}
      {/* Pending box selection — thin solid border until coded or dismissed */}
      {pendingBoxRegion && (() => {
        const x = pendingBoxRegion.x * scale
        const y = pendingBoxRegion.y * scale
        const w = pendingBoxRegion.width * scale
        const h = pendingBoxRegion.height * scale
        return (
          <div data-pending-box style={{
            position: 'absolute', left: x, top: y, width: w, height: h,
            border: '2px solid rgba(60, 100, 240, 0.6)',
            background: 'rgba(60, 100, 240, 0.06)',
            pointerEvents: 'none', zIndex: 10, borderRadius: 2
          }} />
        )
      })()}
    </div>
  )
}
