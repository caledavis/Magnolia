/**
 * DOM-driven SVG exporter for the Relationship Map.
 *
 * Walks the live pan-wrapper DOM and emits **native SVG primitives**
 * (rect, circle, text, image, plus inner-svg fragments copied
 * through). The earlier hand-coded exporter (svg-export.ts) drifted
 * from the live render because it re-implemented every visual
 * detail; an attempt to use `<foreignObject>` rendered correctly in
 * browsers but vector editors (Affinity, Illustrator, Inkscape)
 * don't support foreignObject and showed an empty rectangle.
 *
 * This walker reads the source of truth — DOM positions via
 * `getBoundingClientRect`, styling via `getComputedStyle`, line
 * breaks via `Range.getClientRects` — and converts each visual
 * element to SVG primitives. The output opens in any SVG viewer or
 * vector editor.
 *
 * Limitations:
 *  - Text inside wrapped runs is split by proportional character
 *    distribution per line rect, which is an approximation and may
 *    misplace characters on edge cases (very narrow last line, mixed
 *    glyph widths).
 *  - CSS effects without SVG analogs (box-shadow, filter blur,
 *    backdrop-filter) are dropped.
 *  - Images embedded via data: URLs export cleanly; same-origin
 *    file paths depend on the viewer.
 */
import type { MapElement, FreeTextElement } from './types'
import { t } from '../../../i18n'

interface BBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function escapeAttr(str: string): string {
  return escapeXml(str)
}

/** Strip 'rgb(...)' or 'rgba(...)' / hex / named colours; if alpha is
 *  zero, return null so the caller can omit the fill/stroke entirely
 *  (otherwise Affinity may still create an invisible filled shape
 *  that gets in the way during editing). */
function normaliseColour(value: string): string | null {
  if (!value || value === 'none' || value === 'transparent') return null
  const m = value.match(/rgba?\(([^)]+)\)/)
  if (m) {
    const parts = m[1].split(',').map((p) => p.trim())
    if (parts.length === 4 && parseFloat(parts[3]) === 0) return null
    if (parts.length === 4 && parseFloat(parts[3]) < 1) {
      // Keep alpha — emit as rgba
      return `rgba(${parts.join(', ')})`
    }
    if (parts.length >= 3) {
      return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`
    }
  }
  return value
}

function computeContentBBox(
  elements: MapElement[],
  freeTexts: FreeTextElement[]
): BBox | null {
  if (elements.length === 0 && freeTexts.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const el of elements) {
    minX = Math.min(minX, el.x)
    minY = Math.min(minY, el.y)
    maxX = Math.max(maxX, el.x + el.width)
    maxY = Math.max(maxY, el.y + el.height)
  }
  for (const ft of freeTexts) {
    minX = Math.min(minX, ft.x)
    minY = Math.min(minY, ft.y)
    maxX = Math.max(maxX, ft.x + ft.width)
    maxY = Math.max(maxY, ft.y + ft.height)
  }
  return { minX, minY, maxX, maxY }
}

/** Parse the matrix from a `transform: matrix(a, b, c, d, e, f)`
 *  string; returns a uniform-scale factor (assumes the user hasn't
 *  separately scaled X and Y). */
function getZoomFromTransform(transformValue: string): number {
  if (!transformValue || transformValue === 'none') return 1
  const m = transformValue.match(/matrix\(([^)]+)\)/)
  if (!m) return 1
  const parts = m[1].split(',').map((p) => parseFloat(p.trim()))
  return parts[0] || 1
}

interface WalkContext {
  panRect: DOMRect
  zoom: number
  /** Add to a canvas-space coordinate to land in the SVG viewBox
   *  (which is anchored at 0,0 in the positive quadrant). */
  offsetX: number
  offsetY: number
  parts: string[]
}

function viewToOutput(
  rect: DOMRect | { left: number; top: number; width: number; height: number },
  ctx: WalkContext
): { x: number; y: number; w: number; h: number } {
  return {
    x: (rect.left - ctx.panRect.left) / ctx.zoom + ctx.offsetX,
    y: (rect.top - ctx.panRect.top) / ctx.zoom + ctx.offsetY,
    w: rect.width / ctx.zoom,
    h: rect.height / ctx.zoom
  }
}

function emitBox(el: Element, computed: CSSStyleDeclaration, ctx: WalkContext) {
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return

  const fill = normaliseColour(computed.backgroundColor)
  // Use border-top as the canonical border (the relationship-map
  // boxes are drawn with uniform borders). Falls back gracefully if
  // sides differ — only visible top side gets emitted.
  const borderTopWidth = parseFloat(computed.borderTopWidth) || 0
  const borderColour = borderTopWidth > 0 ? normaliseColour(computed.borderTopColor) : null
  const borderRadius = parseFloat(computed.borderTopLeftRadius) || 0

  if (!fill && !borderColour) return  // pure container with no visuals

  const cv = viewToOutput(rect, ctx)
  const attrs: string[] = [
    `x="${cv.x.toFixed(2)}"`,
    `y="${cv.y.toFixed(2)}"`,
    `width="${cv.w.toFixed(2)}"`,
    `height="${cv.h.toFixed(2)}"`
  ]
  if (borderRadius > 0) attrs.push(`rx="${borderRadius.toFixed(2)}"`)
  attrs.push(fill ? `fill="${fill}"` : `fill="none"`)
  if (borderColour) {
    attrs.push(`stroke="${borderColour}"`)
    attrs.push(`stroke-width="${borderTopWidth.toFixed(2)}"`)
  }
  ctx.parts.push(`<rect ${attrs.join(' ')}/>`)
}

function emitTextNode(
  parentEl: Element,
  textNode: Text,
  computed: CSSStyleDeclaration,
  ctx: WalkContext
) {
  const text = textNode.textContent
  if (!text || !text.trim()) return

  const range = document.createRange()
  try {
    range.selectNode(textNode)
  } catch {
    return
  }
  const rects = Array.from(range.getClientRects())
  range.detach?.()
  if (rects.length === 0) return

  const fontFamily = computed.fontFamily
  const fontSize = parseFloat(computed.fontSize) || 14
  const fontWeight = computed.fontWeight
  const fontStyle = computed.fontStyle
  const colour = normaliseColour(computed.color) || 'rgb(0,0,0)'
  const textAlign = computed.textAlign
  // Skip fully-transparent text (e.g. caret-only nodes inside
  // ContentEditable that ProseMirror leaves around).
  if (!normaliseColour(computed.color)) return

  const emitLine = (lineText: string, rect: DOMRect) => {
    if (!lineText.trim()) return
    const cv = viewToOutput(rect, ctx)
    // Place the SVG text baseline at the line-box centre + ~30% of
    // font size. This works for both tight line-height (line box ≈
    // font size) and loose line-height (text vertically centred in
    // a taller line box, e.g. the relationship-map header band
    // where 9 px text sits inside an 18 px line). Using a fixed
    // `top + fontSize*0.8` would put text too high in tall lines.
    const baseline = cv.y + cv.h / 2 + fontSize * 0.3
    let xPos = cv.x
    let anchor = 'start'
    if (textAlign === 'center') {
      xPos = cv.x + cv.w / 2
      anchor = 'middle'
    } else if (textAlign === 'right' || textAlign === 'end') {
      xPos = cv.x + cv.w
      anchor = 'end'
    }
    const attrs = [
      `x="${xPos.toFixed(2)}"`,
      `y="${baseline.toFixed(2)}"`,
      `font-family="${escapeAttr(fontFamily)}"`,
      `font-size="${(fontSize).toFixed(2)}"`,
      `fill="${colour}"`
    ]
    if (fontWeight && fontWeight !== '400' && fontWeight !== 'normal') {
      attrs.push(`font-weight="${fontWeight}"`)
    }
    if (fontStyle && fontStyle !== 'normal') {
      attrs.push(`font-style="${fontStyle}"`)
    }
    if (anchor !== 'start') {
      attrs.push(`text-anchor="${anchor}"`)
    }
    ctx.parts.push(`<text ${attrs.join(' ')}>${escapeXml(lineText)}</text>`)
  }

  if (rects.length === 1) {
    emitLine(text, rects[0])
    return
  }

  // Multi-line wrapping: distribute the source text across rects in
  // proportion to each rect's width. This is an approximation —
  // exact per-line splits would require measuring each character
  // (binary-search via Range), which is too slow for the export.
  // For the kinds of text the relationship map shows (short labels,
  // paragraph free-text), proportional split lands close enough.
  const totalWidth = rects.reduce((s, r) => s + r.width, 0)
  if (totalWidth === 0) return
  let charIdx = 0
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]
    const fraction = r.width / totalWidth
    const isLast = i === rects.length - 1
    const lineLen = isLast
      ? text.length - charIdx
      : Math.max(1, Math.round(text.length * fraction))
    const lineText = text.substr(charIdx, lineLen)
    charIdx += lineLen
    emitLine(lineText, r)
  }
}

function emitInnerSvgFragment(svgEl: SVGSVGElement, ctx: WalkContext) {
  // Two cases handled here:
  //   1. Lucide icons — small <svg viewBox="0 0 24 24" width=11
  //      height=11 fill="none" stroke="currentColor"> with paths in
  //      0-24 viewBox coordinates. Emit as a NESTED <svg> so the
  //      viewBox-driven scaling is preserved and the icon renders at
  //      the right pixel size in the output.
  //   2. Connection-line / arrow layers — <svg width=1 height=1
  //      overflow=visible> with paths in canvas-pixel coordinates.
  //      Emit as <g transform="translate(...)"> with innerHTML so
  //      paths render in canvas-coord space.
  //
  // For both cases, copy the source <svg>'s presentation attributes
  // (fill, stroke, etc.) onto the wrapping element and resolve
  // `currentColor` to the live computed colour. Without this step,
  // Lucide icons render as solid black filled shapes because the
  // root <svg>'s fill="none" stroke="currentColor" attributes are
  // dropped when we emit only innerHTML.
  const inner = svgEl.innerHTML
  if (!inner.trim()) return

  const computed = window.getComputedStyle(svgEl)
  const colour = normaliseColour(computed.color) || 'rgb(0, 0, 0)'

  const presentationAttrs: string[] = []
  for (const name of [
    'fill',
    'stroke',
    'stroke-width',
    'stroke-linecap',
    'stroke-linejoin',
    'fill-rule'
  ]) {
    const v = svgEl.getAttribute(name)
    if (v != null) {
      const resolved = v === 'currentColor' ? colour : v
      presentationAttrs.push(`${name}="${escapeAttr(resolved)}"`)
    }
  }

  const rect = svgEl.getBoundingClientRect()
  const cv = viewToOutput(rect, ctx)
  const viewBox = svgEl.getAttribute('viewBox')

  if (viewBox) {
    ctx.parts.push(
      `<svg x="${cv.x.toFixed(2)}" y="${cv.y.toFixed(2)}" width="${cv.w.toFixed(2)}" height="${cv.h.toFixed(2)}" viewBox="${escapeAttr(viewBox)}" ${presentationAttrs.join(' ')}>${inner}</svg>`
    )
  } else {
    ctx.parts.push(
      `<g transform="translate(${cv.x.toFixed(2)}, ${cv.y.toFixed(2)})" ${presentationAttrs.join(' ')}>${inner}</g>`
    )
  }
}

function emitImage(imgEl: HTMLImageElement, ctx: WalkContext) {
  const rect = imgEl.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return
  const src = imgEl.src
  if (!src) return
  const cv = viewToOutput(rect, ctx)
  ctx.parts.push(
    `<image x="${cv.x.toFixed(2)}" y="${cv.y.toFixed(2)}" width="${cv.w.toFixed(2)}" height="${cv.h.toFixed(2)}" href="${escapeAttr(src)}" preserveAspectRatio="xMidYMid meet"/>`
  )
}

function isHidden(computed: CSSStyleDeclaration): boolean {
  return (
    computed.display === 'none' ||
    computed.visibility === 'hidden' ||
    parseFloat(computed.opacity) === 0
  )
}

function walk(el: Element, ctx: WalkContext) {
  if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) return
  const computed = window.getComputedStyle(el)
  if (isHidden(computed)) return

  const tag = el.tagName.toLowerCase()

  // Inner SVG layers (connection lines, arrows, icon bodies) — copy
  // their content as native SVG so vector editors can manipulate
  // every path.
  if (tag === 'svg') {
    emitInnerSvgFragment(el as SVGSVGElement, ctx)
    return
  }

  // Image elements (PDF region thumbnails etc.).
  if (tag === 'img') {
    emitImage(el as HTMLImageElement, ctx)
    return
  }

  // Box (background + border). Emitted before children so they paint
  // on top in document order, matching the live render's z-order.
  emitBox(el, computed, ctx)

  // Walk children: element children recurse, text nodes get emitted
  // here (they need the parent's computed style for font/colour).
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      emitTextNode(el, child as Text, computed, ctx)
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      walk(child as Element, ctx)
    }
  }
}

export function buildExportSvgFromDom(
  panWrapperEl: HTMLElement,
  elements: MapElement[],
  freeTexts: FreeTextElement[]
): string {
  const bbox = computeContentBBox(elements, freeTexts)
  if (!bbox) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="400" height="300"><rect width="400" height="300" fill="#ffffff"/><text x="200" y="150" text-anchor="middle" fill="#999" font-family="-apple-system, BlinkMacSystemFont, sans-serif">${t('map.empty').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text></svg>`
  }

  const PAD = 40
  const w = bbox.maxX - bbox.minX + PAD * 2
  const h = bbox.maxY - bbox.minY + PAD * 2
  const offsetX = -bbox.minX + PAD
  const offsetY = -bbox.minY + PAD

  const panRect = panWrapperEl.getBoundingClientRect()
  const zoom = getZoomFromTransform(window.getComputedStyle(panWrapperEl).transform)

  const ctx: WalkContext = {
    panRect,
    zoom,
    offsetX,
    offsetY,
    parts: []
  }

  // Walk children of the pan-wrapper (skip the wrapper itself — it's
  // a positioning container with no visual styling we want).
  for (const child of Array.from(panWrapperEl.children)) {
    walk(child, ctx)
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(2)}" height="${h.toFixed(2)}" viewBox="0 0 ${w.toFixed(2)} ${h.toFixed(2)}">`,
    `<rect width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="#ffffff"/>`,
    ctx.parts.join('\n'),
    `</svg>`
  ].join('\n')
}
