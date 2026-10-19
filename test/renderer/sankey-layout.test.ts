import { describe, it, expect } from 'vitest'
import { layoutSankey, sankeyLinkPath } from '../../src/renderer/components/Analysis/sankey-layout'

const opts = { width: 600, height: 200, nodeWidth: 10, nodePadding: 10, leftX: 100, rightX: 500 }

describe('layoutSankey', () => {
  it('makes one band per non-zero cell and sizes nodes by their totals', () => {
    const l = layoutSankey([[3, 1], [0, 2]], opts)
    expect(l.links.map((x) => [x.left, x.right, x.value])).toEqual([[0, 0, 3], [0, 1, 1], [1, 1, 2]])
    expect(l.left.map((n) => n.total)).toEqual([4, 2])
    expect(l.right.map((n) => n.total)).toEqual([3, 3])
    // Same scale on both sides: a band is equally thick at both ends.
    const k = l.left[0].height / 4
    expect(l.right[0].height).toBeCloseTo(3 * k)
    expect(l.links[1].thickness).toBeCloseTo(k)
  })

  it('stacks bands within a node without gaps or overlap', () => {
    const l = layoutSankey([[3, 1], [0, 2]], opts)
    const [a, b, c] = l.links
    expect(a.y0).toBeCloseTo(l.left[0].y)
    expect(b.y0).toBeCloseTo(a.y0 + a.thickness)
    // Right node 1 receives left 0's band first, then left 1's.
    expect(b.y1).toBeCloseTo(l.right[1].y)
    expect(c.y1).toBeCloseTo(b.y1 + b.thickness)
  })

  it('fits within the height and centres the columns', () => {
    const l = layoutSankey([[5], [5], [5]], opts)
    const last = l.left[2]
    expect(l.left[0].y).toBeGreaterThanOrEqual(0)
    expect(last.y + last.height).toBeLessThanOrEqual(opts.height + 1e-9)
    expect(l.right[0].y).toBeCloseTo((opts.height - l.right[0].height) / 2)
  })

  it('hides items with no flow and leaves out excluded columns', () => {
    const l = layoutSankey([[1, 0, 9], [0, 0, 9]], { ...opts, excludeRight: new Set([2]) })
    expect(l.left.map((n) => n.index)).toEqual([0])
    expect(l.right.map((n) => n.index)).toEqual([0])
    expect(l.hiddenLeft).toEqual([1])
    // Excluded columns aren't reported as hidden — they were never items.
    expect(l.hiddenRight).toEqual([1])
  })

  it('returns an empty layout for an all-zero or empty grid', () => {
    expect(layoutSankey([[0, 0]], opts).links).toEqual([])
    expect(layoutSankey([], opts).links).toEqual([])
    expect(layoutSankey([[], []], opts).left).toEqual([])
  })
})

describe('sankeyLinkPath', () => {
  it('draws a closed band between the two columns', () => {
    const d = sankeyLinkPath({ left: 0, right: 0, value: 1, y0: 10, y1: 50, thickness: 4 }, 110, 490)
    expect(d.startsWith('M110,10')).toBe(true)
    expect(d).toContain('L490,54')
    expect(d.endsWith('Z')).toBe(true)
  })
})
