/**
 * Compute port position on an element's rectangle edge, pointing toward a target center.
 * Uses ray-rectangle intersection from the element center outward.
 */
/** The border width of element boxes. */
export const BORDER_WIDTH = 2

/**
 * Compute port position on an element's rectangle edge.
 * @param inset — pixels to inset from the edge toward center (e.g. BORDER_WIDTH for arrow endpoints)
 */
export function computePortPosition(
  el: { x: number; y: number; width: number; height: number },
  targetCenter: { x: number; y: number },
  inset: number = 0
): { x: number; y: number } {
  const cx = el.x + el.width / 2
  const cy = el.y + el.height / 2
  const dx = targetCenter.x - cx
  const dy = targetCenter.y - cy

  if (dx === 0 && dy === 0) return { x: el.x + el.width - inset, y: cy }

  const hw = el.width / 2
  const hh = el.height / 2
  const absDx = Math.abs(dx)
  const absDy = Math.abs(dy)

  const tx = absDx > 0 ? hw / absDx : Infinity
  const ty = absDy > 0 ? hh / absDy : Infinity
  const t = Math.min(tx, ty)

  const edgeX = cx + dx * t
  const edgeY = cy + dy * t

  if (inset === 0) return { x: edgeX, y: edgeY }

  const len = Math.hypot(dx, dy)
  if (len < 0.1) return { x: edgeX, y: edgeY }
  return {
    x: edgeX - (dx / len) * inset,
    y: edgeY - (dy / len) * inset
  }
}

/**
 * Compute port position on a rounded-rectangle edge. The shape is
 * modelled as a rectangle inset by `cornerRadius` plus four quarter-
 * circle corners of that same radius. Set cornerRadius to 0 for a plain
 * rectangle, or to height/2 for a pill / capsule.
 *
 * We trace the ray from the element centre toward the target and pick
 * the smallest positive t where it intersects any edge piece — so the
 * returned port always lands on the visible outline, including the
 * rounded ends of chip pills and the corner fillets of card boxes.
 */
export function computeRoundedPortPosition(
  el: { x: number; y: number; width: number; height: number },
  targetCenter: { x: number; y: number },
  cornerRadius: number
): { x: number; y: number } {
  const cx = el.x + el.width / 2
  const cy = el.y + el.height / 2
  const dx = targetCenter.x - cx
  const dy = targetCenter.y - cy
  const len = Math.hypot(dx, dy)
  if (len < 0.1) return { x: el.x + el.width, y: cy }

  const ux = dx / len
  const uy = dy / len

  const left = el.x
  const right = el.x + el.width
  const top = el.y
  const bot = el.y + el.height
  const r = Math.max(0, Math.min(cornerRadius, el.width / 2, el.height / 2))

  // Pill / capsule elements (r ≈ height/2) have a tangent problem on the
  // rounded end caps: a line whose ray from centre is nearly horizontal
  // exits the arc at a point where the outline is almost parallel to
  // the line, so the arrow appears to slide along the pill's outline.
  // Fix: force pill ports onto either the top/bottom straight edge
  // (for ordinary angles) or the exact left/right apex (when the line
  // is near-horizontal). Cards — with their 6px corner radius — don't
  // suffer the tangent issue and fall through to the general logic.
  const isPill = r > 0
    && Math.abs(r - el.height / 2) < 0.5
    && el.width >= 2 * r + 0.5
  if (isPill) {
    // Near-horizontal rays snap to the end-cap apex so lines meet the
    // pill face-on instead of glancing against the arc.
    if (Math.abs(uy) < 0.3) {
      return { x: ux >= 0 ? right : left, y: cy }
    }
    const yEdge = uy < 0 ? top : bot
    const t = (yEdge - cy) / uy
    const px = cx + t * ux
    const clampedX = Math.max(left + r, Math.min(right - r, px))
    return { x: clampedX, y: yEdge }
  }

  const candidates: number[] = []

  // Straight edges: only valid within the non-rounded stretch.
  if (uy < 0) {
    const t = (top - cy) / uy
    const px = cx + t * ux
    if (t > 0 && px >= left + r && px <= right - r) candidates.push(t)
  }
  if (uy > 0) {
    const t = (bot - cy) / uy
    const px = cx + t * ux
    if (t > 0 && px >= left + r && px <= right - r) candidates.push(t)
  }
  if (ux < 0) {
    const t = (left - cx) / ux
    const py = cy + t * uy
    if (t > 0 && py >= top + r && py <= bot - r) candidates.push(t)
  }
  if (ux > 0) {
    const t = (right - cx) / ux
    const py = cy + t * uy
    if (t > 0 && py >= top + r && py <= bot - r) candidates.push(t)
  }

  // Corner arcs: ray-circle intersection against each of the four corner
  // centres, accepting only hits that fall in the correct quadrant.
  if (r > 0) {
    const corners = [
      { x: left + r, y: top + r, q: (p: { x: number; y: number }) => p.x <= left + r + 0.001 && p.y <= top + r + 0.001 },
      { x: right - r, y: top + r, q: (p: { x: number; y: number }) => p.x >= right - r - 0.001 && p.y <= top + r + 0.001 },
      { x: left + r, y: bot - r, q: (p: { x: number; y: number }) => p.x <= left + r + 0.001 && p.y >= bot - r - 0.001 },
      { x: right - r, y: bot - r, q: (p: { x: number; y: number }) => p.x >= right - r - 0.001 && p.y >= bot - r - 0.001 }
    ]
    for (const c of corners) {
      const ex = cx - c.x
      const ey = cy - c.y
      const B = 2 * (ex * ux + ey * uy)
      const C = ex * ex + ey * ey - r * r
      const disc = B * B - 4 * C
      if (disc < 0) continue
      const sq = Math.sqrt(disc)
      for (const t of [(-B - sq) / 2, (-B + sq) / 2]) {
        if (t <= 0) continue
        const p = { x: cx + t * ux, y: cy + t * uy }
        if (c.q(p)) candidates.push(t)
      }
    }
  }

  // Fallback: plain rect intersection if somehow no piece was hit.
  if (candidates.length === 0) return computePortPosition(el, targetCenter)
  const tExit = Math.min(...candidates)
  return { x: cx + tExit * ux, y: cy + tExit * uy }
}

/**
 * Distribute port positions when multiple connections meet at one element.
 * Returns a map of connectionId -> port position.
 *
 * When `cornerRadius` is provided, ports land on the rounded-rect outline
 * (chip pills treat this as half their height). Spread bundles are
 * clamped to the straight part of whichever edge they sit on so they
 * don't leak into the rounded ends.
 */
export function distributePortsForElement(
  el: { x: number; y: number; width: number; height: number },
  connectionIds: string[],
  targetCenters: Map<string, { x: number; y: number }>,
  cornerRadius: number = 0
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>()
  if (connectionIds.length === 0) return result

  const cx = el.x + el.width / 2
  const cy = el.y + el.height / 2
  const r = Math.max(0, Math.min(cornerRadius, el.width / 2, el.height / 2))

  const portFor = (tc: { x: number; y: number }): { x: number; y: number } =>
    r > 0 ? computeRoundedPortPosition(el, tc, r) : computePortPosition(el, tc)

  // Compute base angles and sort by angle
  const entries = connectionIds.map((id) => {
    const tc = targetCenters.get(id) || { x: cx + 100, y: cy }
    const angle = Math.atan2(tc.y - cy, tc.x - cx)
    return { id, angle, targetCenter: tc }
  })
  entries.sort((a, b) => a.angle - b.angle)

  // Group connections that are close in angle (within ~12° ≈ 0.21 rad).
  // Slightly wider than before so near-parallel lines bundle instead of
  // fanning out into duplicate single-ports that visually overlap.
  const GROUP_THRESHOLD = 0.21
  const groups: typeof entries[] = []
  let currentGroup: typeof entries = []
  for (const entry of entries) {
    if (
      currentGroup.length > 0 &&
      Math.abs(entry.angle - currentGroup[currentGroup.length - 1].angle) > GROUP_THRESHOLD
    ) {
      groups.push(currentGroup)
      currentGroup = []
    }
    currentGroup.push(entry)
  }
  if (currentGroup.length > 0) groups.push(currentGroup)

  for (const group of groups) {
    if (group.length === 1) {
      result.set(group[0].id, portFor(group[0].targetCenter))
    } else {
      const avgAngle =
        group.reduce((sum, e) => sum + e.angle, 0) / group.length
      const basePort = portFor({
        x: cx + Math.cos(avgAngle) * 200,
        y: cy + Math.sin(avgAngle) * 200
      })

      // Decide which edge the bundle lives on so we can clamp the spread
      // to the straight stretch of that edge (avoids ports climbing onto
      // the rounded ends of a chip or the corner fillets of a card).
      const onVerticalEdge =
        Math.abs(basePort.x - el.x) < 0.5 || Math.abs(basePort.x - (el.x + el.width)) < 0.5
      const edgeLen = onVerticalEdge ? el.height - 2 * r : el.width - 2 * r
      const count = group.length
      // Slightly more generous spacing than before; also cap by the
      // available straight-edge length so huge bundles stay contained.
      const maxByEdge = edgeLen > 0 ? edgeLen / (count + 1) : 14
      const spacing = Math.min(18, Math.max(6, maxByEdge))
      const totalSpread = (count - 1) * spacing

      for (let i = 0; i < count; i++) {
        const offset = -totalSpread / 2 + i * spacing
        if (onVerticalEdge) {
          result.set(group[i].id, { x: basePort.x, y: basePort.y + offset })
        } else {
          result.set(group[i].id, { x: basePort.x + offset, y: basePort.y })
        }
      }
    }
  }

  return result
}

/**
 * Compute the outward-pointing unit normal at a port on a rounded-rect
 * element. Axis-aligned on the straight segments (±x / ±y), radial on
 * the corner arcs. Used by bezPathFromPorts so lines leave and enter
 * boxes perpendicular to their outline instead of at oblique angles.
 */
export function computeOutwardNormal(
  el: { x: number; y: number; width: number; height: number },
  port: { x: number; y: number },
  cornerRadius: number
): { x: number; y: number } {
  const left = el.x
  const right = el.x + el.width
  const top = el.y
  const bot = el.y + el.height
  const r = Math.max(0, Math.min(cornerRadius, el.width / 2, el.height / 2))
  const eps = 0.5

  // Straight edges — axis-aligned normals.
  if (Math.abs(port.x - left) < eps) return { x: -1, y: 0 }
  if (Math.abs(port.x - right) < eps) return { x: 1, y: 0 }
  if (Math.abs(port.y - top) < eps) return { x: 0, y: -1 }
  if (Math.abs(port.y - bot) < eps) return { x: 0, y: 1 }

  // Corner arcs — normal points radially out from the nearest corner centre.
  if (r > 0) {
    const corners = [
      { x: left + r, y: top + r },
      { x: right - r, y: top + r },
      { x: left + r, y: bot - r },
      { x: right - r, y: bot - r }
    ]
    let best = corners[0]
    let bestDist = Infinity
    for (const c of corners) {
      const d = Math.hypot(port.x - c.x, port.y - c.y)
      if (d < bestDist) { bestDist = d; best = c }
    }
    const dx = port.x - best.x, dy = port.y - best.y
    const len = Math.hypot(dx, dy)
    if (len > 0.01) return { x: dx / len, y: dy / len }
  }

  // Fallback: direction from element centre to the port.
  const cx = el.x + el.width / 2
  const cy = el.y + el.height / 2
  const dx = port.x - cx, dy = port.y - cy
  const len = Math.hypot(dx, dy)
  return len > 0.01 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 }
}

/**
 * Build a cubic bezier path between two ports where each control point
 * extends along the port's outward normal. Gives lines that leave the
 * source box perpendicular to its outline, arrive at the target box
 * perpendicular too, and curve organically in between.
 *
 * @param offset — perpendicular offset (in canvas units) applied to both
 *   control points. Used to fan out parallel connections between the
 *   same pair of nodes so they don't overlap.
 */
export function bezPathFromPorts(
  from: { x: number; y: number },
  fromNormal: { x: number; y: number },
  to: { x: number; y: number },
  toNormal: { x: number; y: number },
  offset: number = 0
): string {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dist = Math.hypot(dx, dy)
  if (dist < 1) return `M${from.x},${from.y} L${to.x},${to.y}`

  // Bend strength scales with distance but is clamped so short lines are
  // nearly straight and long lines stay civilised.
  const k = Math.min(180, Math.max(30, dist * 0.35))

  // Unit vector along the line direction + perpendicular (for offsetting
  // parallel connections).
  const ux = dx / dist
  const uy = dy / dist
  const perpX = -uy
  const perpY = ux
  const ox = perpX * offset
  const oy = perpY * offset

  // Collinear straight-line case: both normals aligned with the line
  // direction AND no perpendicular offset → drop the curve entirely.
  const fromAlign = fromNormal.x * ux + fromNormal.y * uy
  const toAlign = toNormal.x * -ux + toNormal.y * -uy
  const collinear = fromAlign > 0.95 && toAlign > 0.95 && Math.abs(offset) < 0.5
  if (collinear) {
    return `M${from.x},${from.y} L${to.x},${to.y}`
  }

  const cp1x = from.x + fromNormal.x * k + ox
  const cp1y = from.y + fromNormal.y * k + oy
  const cp2x = to.x + toNormal.x * k + ox
  const cp2y = to.y + toNormal.y * k + oy

  return `M${from.x},${from.y} C${cp1x},${cp1y} ${cp2x},${cp2y} ${to.x},${to.y}`
}

/**
 * Find the center of the circular arc defined by start, end, radius, sweep.
 */
export function arcCenter(
  from: { x: number; y: number },
  to: { x: number; y: number },
  r: number,
  sweepFlag: number
): { x: number; y: number } | null {
  const mx = (from.x + to.x) / 2
  const my = (from.y + to.y) / 2
  const dx = to.x - from.x
  const dy = to.y - from.y
  const halfChord = Math.hypot(dx, dy) / 2
  if (halfChord >= r || halfChord < 0.1) return null

  const dist = Math.sqrt(r * r - halfChord * halfChord)
  const len = Math.hypot(dx, dy)
  // "Right of" from→to in screen coords (y-down): 90° CW rotation = (dy/len, -dx/len)
  const px = dy / len, py = -dx / len
  // sweep=1 (CW): center to the right; sweep=0 (CCW): center to the left
  const sign = sweepFlag === 1 ? 1 : -1
  return { x: mx + sign * px * dist, y: my + sign * py * dist }
}

/**
 * Evaluate a point on the circular arc at parameter t (0=start, 1=end).
 */
export function arcPointAt(
  from: { x: number; y: number },
  to: { x: number; y: number },
  r: number,
  sweepFlag: number,
  t: number
): { x: number; y: number } {
  const c = arcCenter(from, to, r, sweepFlag)
  if (!c) {
    // Degenerate: interpolate linearly
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
  }
  const startAngle = Math.atan2(from.y - c.y, from.x - c.x)
  let endAngle = Math.atan2(to.y - c.y, to.x - c.x)

  // Adjust endAngle based on sweep direction.
  // In SVG (y-down), sweep=1 (clockwise) means angles INCREASE.
  if (sweepFlag === 1) {
    while (endAngle <= startAngle) endAngle += 2 * Math.PI
  } else {
    // Counter-clockwise: angles decrease
    while (endAngle >= startAngle) endAngle -= 2 * Math.PI
  }

  const angle = startAngle + (endAngle - startAngle) * t
  return { x: c.x + r * Math.cos(angle), y: c.y + r * Math.sin(angle) }
}

/**
 * Compute the midpoint of a circular arc defined by the SVG A command.
 * Given start, end, radius, and sweep direction.
 */
export function arcMidpoint(
  from: { x: number; y: number },
  to: { x: number; y: number },
  r: number,
  sweepFlag: number
): { x: number; y: number } {
  // Midpoint of the chord
  const mx = (from.x + to.x) / 2
  const my = (from.y + to.y) / 2
  const halfChord = Math.hypot(to.x - from.x, to.y - from.y) / 2

  if (halfChord >= r || halfChord < 0.1) {
    return { x: mx, y: my }
  }

  // Height of the arc above the chord midpoint
  const h = r - Math.sqrt(r * r - halfChord * halfChord)

  // Normal to the chord (perpendicular direction)
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.hypot(dx, dy)
  // For sweep=1 (clockwise), the arc bulges to the right of from→to
  const sign = sweepFlag === 1 ? -1 : 1
  const nx = sign * (-dy / len)
  const ny = sign * (dx / len)

  return { x: mx + nx * h, y: my + ny * h }
}

/** @deprecated — kept for compatibility but arcs use arcMidpoint now */
export function bezierPoint(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  t: number
): { x: number; y: number } {
  const mt = 1 - t
  const mt2 = mt * mt
  const mt3 = mt2 * mt
  const t2 = t * t
  const t3 = t2 * t
  return {
    x: mt3 * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t3 * p3.x,
    y: mt3 * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t3 * p3.y
  }
}

/**
 * Parse an SVG bezier path "M... C..." into the four control points.
 */
export function parseBezPath(
  d: string
): {
  p0: { x: number; y: number }
  p1: { x: number; y: number }
  p2: { x: number; y: number }
  p3: { x: number; y: number }
} | null {
  const m = d.match(
    /M([\d.\-e]+),([\d.\-e]+)\s*C([\d.\-e]+),([\d.\-e]+)\s+([\d.\-e]+),([\d.\-e]+)\s+([\d.\-e]+),([\d.\-e]+)/
  )
  if (!m) return null
  return {
    p0: { x: +m[1], y: +m[2] },
    p1: { x: +m[3], y: +m[4] },
    p2: { x: +m[5], y: +m[6] },
    p3: { x: +m[7], y: +m[8] }
  }
}

/**
 * Clamp pan so content stays within the 25–75% viewport band.
 * Matches the QueryNodeEditor pattern.
 */
export function clampPan(
  nx: number,
  ny: number,
  allNodes: { x: number; y: number; width: number; height: number }[],
  container: HTMLElement
): { x: number; y: number } {
  if (allNodes.length === 0) return { x: nx, y: ny }

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (const n of allNodes) {
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + n.width)
    maxY = Math.max(maxY, n.y + n.height)
  }
  const pad = 60
  minX -= pad
  minY -= pad
  maxX += pad
  maxY += pad

  const cw = container.clientWidth
  const ch = container.clientHeight
  const clampedX = Math.max(cw * 0.25 - maxX, Math.min(cw * 0.75 - minX, nx))
  const clampedY = Math.max(ch * 0.25 - maxY, Math.min(ch * 0.75 - minY, ny))
  return { x: clampedX, y: clampedY }
}
