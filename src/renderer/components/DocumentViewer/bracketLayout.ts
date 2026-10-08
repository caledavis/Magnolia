/**
 * bracketLayout — shared placement algorithm for code-bracket overlays in
 * the right-hand margin column. Used by both the plain-text / rich-text /
 * transcript viewers (CodedTextView) and the PDF viewer
 * (RichMarginColumn) so the visual treatment of nested codings is
 * identical everywhere.
 *
 * The function is pure: callers measure their own DOM positions, feed in
 * { top, bottom, color, codeName, ...metadata } entries, and get back the
 * same entries enriched with column, label, and cap-extension fields.
 * Rendering is each caller's responsibility.
 */

/** Width of a single bracket column. */
export const COL_W = 10
/** Rendered height of a single code-name label. */
export const LABEL_H = 14
/** Vertical gap required between two brackets sharing a column — matches
 *  the 4-px cap inset drawn at each end of a bracket bar. */
export const BAR_GAP = 4
/** Horizontal gap between the rightmost overlapping bracket column and
 *  the start of a label. */
export const LABEL_GAP = 4

export interface BracketInput {
  top: number
  bottom: number
  color: string
  codeName: string
}

export interface BracketPlacement {
  /** Column index, 0 = innermost (closest to the text). */
  column: number
  /** Y offset (in the caller's coordinate space) where the label renders. */
  labelTop: number
  /** X offset for the label, measured from the same origin the caller used
   *  for column 0's bar-X. Does NOT include the caller's own left padding —
   *  add it if needed when rendering. */
  labelLeft: number
  /** Column the top cap extends leftward to (== column when no extension). */
  topCapTargetCol: number
  /** Column the bottom cap extends leftward to (== column when no extension). */
  bottomCapTargetCol: number
}

/**
 * Compute bracket placements for a set of coded regions.
 *
 * Algorithm:
 *  1. Group entries into overlap clusters by Y-overlap (with BAR_GAP slack).
 *  2. Within each cluster, pack shortest-first so the shortest bracket
 *     takes column 0 (innermost) and longer ones nest outward.
 *  3. For each bracket, scan inward column-by-column and compute the
 *     innermost-empty column at each cap's Y — the cap extends there.
 *  4. Stagger labels vertically. When two brackets share a top Y, the
 *     LONGER one's label stacks first (on top).
 *  5. Place each label immediately after the rightmost bracket column
 *     at the label's Y range.
 *  6. Within a staggered stack (labels pushed down because they share a
 *     top Y), align every label to the stack's max labelLeft so names
 *     line up vertically.
 */
export function layoutBrackets<T extends BracketInput>(entries: T[]): (T & BracketPlacement)[] {
  // ---- 1. Cluster by Y-overlap -----------------------------------------
  const sortedByTop = [...entries].sort((a, b) => a.top - b.top)
  const clusters: T[][] = []
  {
    let current: T[] = []
    let currentMaxBottom = -Infinity
    for (const entry of sortedByTop) {
      if (current.length === 0 || entry.top <= currentMaxBottom + BAR_GAP) {
        current.push(entry)
        if (entry.bottom > currentMaxBottom) currentMaxBottom = entry.bottom
      } else {
        clusters.push(current)
        current = [entry]
        currentMaxBottom = entry.bottom
      }
    }
    if (current.length > 0) clusters.push(current)
  }

  // ---- 2. Shortest-first packing within each cluster -------------------
  type Placed = T & BracketPlacement
  const placed: Placed[] = []
  for (const cluster of clusters) {
    cluster.sort((a, b) => (a.bottom - a.top) - (b.bottom - b.top) || a.top - b.top)
    const columnEndYs: number[] = []
    for (const entry of cluster) {
      let col = 0
      while (col < columnEndYs.length && columnEndYs[col] + BAR_GAP > entry.top) col++
      if (col >= columnEndYs.length) columnEndYs.push(0)
      columnEndYs[col] = entry.bottom
      placed.push({
        ...entry,
        column: col,
        labelTop: 0,
        labelLeft: 0,
        topCapTargetCol: col,
        bottomCapTargetCol: col
      })
    }
  }

  // ---- 3. Cap extension ------------------------------------------------
  // For each bracket, walk leftward and extend its top/bottom cap into
  // every empty neighbouring column until something blocks the way.
  // Visually links nested brackets to the parent bar so the
  // parent/child relationship reads at a glance.
  const coveredAt = (col: number, y: number): boolean =>
    placed.some((a) => a.column === col && a.top <= y && y <= a.bottom)
  for (const b of placed) {
    let topTarget = b.column
    for (let c = b.column - 1; c >= 0; c--) {
      if (coveredAt(c, b.top)) break
      topTarget = c
    }
    let botTarget = b.column
    for (let c = b.column - 1; c >= 0; c--) {
      if (coveredAt(c, b.bottom)) break
      botTarget = c
    }
    b.topCapTargetCol = topTarget
    b.bottomCapTargetCol = botTarget
  }

  // Align extending caps at the SAME cap Y to a common leftmost target
  // column, so every extending cap in a stack shares the same left edge.
  // Non-extending brackets (target == own column) are unaffected.
  const alignGroup = (
    groupBy: (b: Placed) => number,
    getTarget: (b: Placed) => number,
    setTarget: (b: Placed, v: number) => void
  ): void => {
    const groups = new Map<number, Placed[]>()
    for (const b of placed) {
      const key = Math.round(groupBy(b))
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(b)
    }
    for (const [, group] of groups) {
      const extending = group.filter((b) => getTarget(b) < b.column)
      if (extending.length < 2) continue
      const minTarget = Math.min(...extending.map(getTarget))
      for (const b of extending) setTarget(b, minTarget)
    }
  }
  alignGroup((b) => b.top, (b) => b.topCapTargetCol, (b, v) => { b.topCapTargetCol = v })
  alignGroup((b) => b.bottom, (b) => b.bottomCapTargetCol, (b, v) => { b.bottomCapTargetCol = v })

  // ---- 4. Label stagger ------------------------------------------------
  placed.sort((a, b) =>
    a.top - b.top || (b.bottom - b.top) - (a.bottom - a.top) || a.column - b.column
  )
  {
    let labelEndY = -Infinity
    for (const b of placed) {
      const baseTop = b.top + 2
      b.labelTop = baseTop < labelEndY ? labelEndY : baseTop
      labelEndY = b.labelTop + LABEL_H
    }
  }

  // ---- 5. Per-label left offset ---------------------------------------
  for (const b of placed) {
    const labelY1 = b.labelTop
    const labelY2 = b.labelTop + LABEL_H
    let maxCol = b.column
    for (const other of placed) {
      if (other.bottom >= labelY1 && other.top <= labelY2 && other.column > maxCol) {
        maxCol = other.column
      }
    }
    b.labelLeft = (maxCol + 1) * COL_W + LABEL_GAP
  }

  // ---- 6. Align labels within a staggered stack ------------------------
  {
    const byLabelTop = [...placed].sort((a, b) => a.labelTop - b.labelTop)
    let stackEnd = -Infinity
    let stack: Placed[] = []
    const flushStack = (): void => {
      if (stack.length > 1) {
        const maxLeft = Math.max(...stack.map((s) => s.labelLeft))
        for (const s of stack) s.labelLeft = maxLeft
      }
      stack = []
    }
    for (const b of byLabelTop) {
      if (b.labelTop <= stackEnd + 0.5) {
        stack.push(b)
      } else {
        flushStack()
        stack = [b]
      }
      stackEnd = b.labelTop + LABEL_H
    }
    flushStack()
  }

  return placed
}

/**
 * Geometry helper: compute the left/width of a bracket cap given its
 * target column. When targetCol === column the cap uses its default
 * 3-px tick; otherwise it extends leftward to the target column's bar.
 */
export function capGeometry(
  column: number,
  targetCol: number,
  columnOriginX: number
): { left: number; width: number } {
  const barX = columnOriginX + column * COL_W
  const capLeft = barX - 3
  if (targetCol >= column) return { left: capLeft, width: 3 }
  const targetBarX = columnOriginX + targetCol * COL_W
  return { left: targetBarX, width: barX - targetBarX + 2 }
}

/** Outer radius of a bracket's rounded corners, in px. */
export const BRACKET_CORNER_RADIUS = 4

/** Absolute-positioning styles for one piece of a drawn bracket. Values
 *  are px strings so they can go straight into a React `style` or be
 *  assigned onto an element's `style` imperatively. */
export interface BracketPieceStyle {
  position: 'absolute'
  boxSizing: 'border-box'
  left: string
  top: string
  width: string
  height: string
  borderStyle: 'solid'
  borderColor: string
  borderWidth: string
  borderRadius: string
}

/**
 * The pieces that draw one "]" bracket with rounded corners: a top corner
 * (top cap curving into the bar), the straight bar between, and a bottom
 * corner. `top` / `height` span the whole bracket; `barLeft` is the bar's
 * left edge; the caps come from capGeometry. Line thickness is 2 px, as
 * before. Short brackets get smaller corners so the two never overlap.
 */
export function bracketPieces(
  barLeft: number,
  top: number,
  height: number,
  topCap: { left: number; width: number },
  bottomCap: { left: number; width: number },
  color: string
): BracketPieceStyle[] {
  const px = (n: number): string => `${n}px`
  const right = barLeft + 2
  const cornerH = Math.max(2, Math.min(BRACKET_CORNER_RADIUS + 2, Math.floor(height / 2)))
  const piece = (left: number, y: number, w: number, h: number, borderWidth: string, borderRadius: string): BracketPieceStyle => ({
    position: 'absolute',
    boxSizing: 'border-box',
    left: px(left),
    top: px(y),
    width: px(w),
    height: px(h),
    borderStyle: 'solid',
    borderColor: color,
    borderWidth,
    borderRadius
  })
  const radius = (capWidth: number): number => Math.min(BRACKET_CORNER_RADIUS, cornerH, capWidth)
  const topW = Math.max(2, right - topCap.left)
  const botW = Math.max(2, right - bottomCap.left)
  const pieces = [
    piece(right - topW, top, topW, cornerH, '2px 2px 0 0', `0 ${px(radius(topW))} 0 0`),
    piece(right - botW, top + height - cornerH, botW, cornerH, '0 2px 2px 0', `0 0 ${px(radius(botW))} 0`)
  ]
  const barH = height - 2 * cornerH
  if (barH > 0) pieces.push(piece(barLeft, top + cornerH, 2, barH, '0 2px 0 0', '0'))
  return pieces
}
