/**
 * Layout for the two-column Sankey view shared by the grid analysis
 * tools (Codes in Documents, Results in Documents, Code Co-Occurrences).
 * A grid of `values[left][right]` becomes left nodes, right nodes and
 * one band per non-zero cell. Pure geometry — no DOM — so it can be
 * unit-tested and reused by exporters.
 */

export interface SankeyNodeLayout {
  /** Index into the caller's left or right item list. */
  index: number
  side: 'left' | 'right'
  total: number
  x: number
  y: number
  height: number
}

export interface SankeyLinkLayout {
  left: number
  right: number
  value: number
  /** Top/bottom of the band where it leaves the left node. */
  y0: number
  /** Top/bottom of the band where it enters the right node. */
  y1: number
  thickness: number
}

export interface SankeyLayout {
  left: SankeyNodeLayout[]
  right: SankeyNodeLayout[]
  links: SankeyLinkLayout[]
  /** Left/right item indices left out because they have no flow. */
  hiddenLeft: number[]
  hiddenRight: number[]
}

export interface SankeyLayoutOptions {
  width: number
  height: number
  nodeWidth: number
  nodePadding: number
  /** x of the left node column's left edge. */
  leftX: number
  /** x of the right node column's right edge. */
  rightX: number
  /** Right-side indices to leave out entirely (e.g. subtotal columns). */
  excludeRight?: Set<number>
}

export function layoutSankey(values: number[][], opts: SankeyLayoutOptions): SankeyLayout {
  const nLeft = values.length
  const nRight = nLeft > 0 ? values[0].length : 0
  const excluded = opts.excludeRight ?? new Set<number>()
  const cell = (i: number, j: number): number => (excluded.has(j) ? 0 : Math.max(0, values[i][j] || 0))

  const leftTotals = Array.from({ length: nLeft }, (_, i) => {
    let s = 0
    for (let j = 0; j < nRight; j++) s += cell(i, j)
    return s
  })
  const rightTotals = Array.from({ length: nRight }, (_, j) => {
    let s = 0
    for (let i = 0; i < nLeft; i++) s += cell(i, j)
    return s
  })

  const shownLeft = leftTotals.map((t, i) => (t > 0 ? i : -1)).filter((i) => i >= 0)
  const shownRight = rightTotals.map((t, j) => (t > 0 ? j : -1)).filter((j) => j >= 0)
  const hiddenLeft = leftTotals.map((t, i) => (t > 0 ? -1 : i)).filter((i) => i >= 0)
  const hiddenRight = rightTotals
    .map((t, j) => (t > 0 || excluded.has(j) ? -1 : j))
    .filter((j) => j >= 0)

  const total = shownLeft.reduce((s, i) => s + leftTotals[i], 0)
  if (total === 0) return { left: [], right: [], links: [], hiddenLeft, hiddenRight }

  // One scale for both sides (their totals are equal) so a band is the
  // same thickness at both ends; the side with more padding sets it.
  const usable = (count: number) => opts.height - opts.nodePadding * Math.max(0, count - 1)
  const k = Math.max(0, Math.min(usable(shownLeft.length), usable(shownRight.length)) / total)

  const stack = (indices: number[], totals: number[], side: 'left' | 'right', x: number): SankeyNodeLayout[] => {
    const span = indices.reduce((s, i) => s + totals[i] * k, 0) + opts.nodePadding * Math.max(0, indices.length - 1)
    let y = (opts.height - span) / 2
    return indices.map((index) => {
      const height = totals[index] * k
      const node = { index, side, total: totals[index], x, y, height }
      y += height + opts.nodePadding
      return node
    })
  }
  const left = stack(shownLeft, leftTotals, 'left', opts.leftX)
  const right = stack(shownRight, rightTotals, 'right', opts.rightX - opts.nodeWidth)

  // Bands leave each left node ordered by right-node position and enter
  // each right node ordered by left-node position, which keeps crossings
  // to the minimum the node order allows.
  const leftCursor = new Map(left.map((n) => [n.index, n.y]))
  const rightCursor = new Map(right.map((n) => [n.index, n.y]))
  const links: SankeyLinkLayout[] = []
  for (const ln of left) {
    for (const rn of right) {
      const value = cell(ln.index, rn.index)
      if (value <= 0) continue
      links.push({ left: ln.index, right: rn.index, value, y0: 0, y1: 0, thickness: value * k })
    }
  }
  for (const link of links) {
    link.y0 = leftCursor.get(link.left)!
    leftCursor.set(link.left, link.y0 + link.thickness)
  }
  const byRight = [...links].sort((a, b) => a.right - b.right || shownLeft.indexOf(a.left) - shownLeft.indexOf(b.left))
  for (const link of byRight) {
    link.y1 = rightCursor.get(link.right)!
    rightCursor.set(link.right, link.y1 + link.thickness)
  }

  return { left, right, links, hiddenLeft, hiddenRight }
}

/** Closed SVG path for a band between two node columns. */
export function sankeyLinkPath(link: SankeyLinkLayout, x0: number, x1: number): string {
  const xm = (x0 + x1) / 2
  const t = link.thickness
  return [
    `M${x0},${link.y0}`,
    `C${xm},${link.y0} ${xm},${link.y1} ${x1},${link.y1}`,
    `L${x1},${link.y1 + t}`,
    `C${xm},${link.y1 + t} ${xm},${link.y0 + t} ${x0},${link.y0 + t}`,
    'Z'
  ].join(' ')
}
