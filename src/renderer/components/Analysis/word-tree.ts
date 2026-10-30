/**
 * Word Tree: every context a word appears in, drawn as a tree. The words
 * that come after it branch to the right and the words before it branch
 * to the left, so shared phrasings merge into one branch and the tree
 * reads as sentences.
 *
 * Built here as data and a layout, then drawn by the Word Combinations
 * tool (as React, so branches are clickable) and by reports (as an SVG
 * string).
 */
import { sentencesOf, type SourceText } from './word-counts'
import { measureTextWidth } from '../../utils/measure-text'
import { SVG_FONT_FAMILY } from '../../utils/use-theme-svg-colors'

/** Words (letters and digits, with inner apostrophes) and single
 *  punctuation marks, so branches can run on past a comma. */
const TREE_TOKEN_RE = /[a-zÀ-ɏ\d]+(?:['’][a-zÀ-ɏ\d]+)*|[^\s]/giu

/** How far a branch reaches from the word, in words and marks. */
export const TREE_DEPTH = 12

interface Trie {
  count: number
  children: Map<string, Trie>
  /** Where this token first appeared, and the text from the word to it. */
  sentence: string
  start: number
  end: number
  phraseStart: number
  phraseEnd: number
  /** Some occurrence goes on past TREE_DEPTH. */
  cut: boolean
  /** The occurrences of the word (numbered in reading order) that run
   *  through this node. */
  occurrences: number[]
}

export interface TreeBranch {
  /** The words on the branch as they read, left to right. Several when
   *  every occurrence goes on the same way. */
  label: string
  count: number
  /** The text from the word to the end of this branch (or from its start
   *  to the word, before it) as it first appears, for searching. */
  phrase: string
  children: TreeBranch[]
  /** The sentence goes on past TREE_DEPTH. */
  continues: boolean
  /** The occurrences of the word running through this branch, numbered
   *  the same on both sides, so a branch after the word can be matched
   *  with the branches before it in the same sentences. */
  occurrences: number[]
}

export interface WordTree {
  focus: string
  /** Occurrences of the word. */
  count: number
  before: TreeBranch[]
  after: TreeBranch[]
}

function newTrie(): Trie {
  return { count: 0, children: new Map(), sentence: '', start: 0, end: 0, phraseStart: 0, phraseEnd: 0, cut: false, occurrences: [] }
}

interface Token { key: string; start: number; end: number }

function insert(root: Trie, toks: Token[], i: number, step: 1 | -1, sentence: string, occurrence: number) {
  const word = toks[i]
  let node = root
  node.count++
  for (let k = 1; k <= TREE_DEPTH; k++) {
    const t = toks[i + k * step]
    if (!t) return
    let child = node.children.get(t.key)
    if (!child) {
      child = {
        ...newTrie(),
        sentence,
        start: t.start,
        end: t.end,
        phraseStart: step > 0 ? word.start : t.start,
        phraseEnd: step > 0 ? t.end : word.end
      }
      node.children.set(t.key, child)
    }
    child.count++
    child.occurrences.push(occurrence)
    node = child
  }
  if (toks[i + (TREE_DEPTH + 1) * step]) node.cut = true
}

/** Turn one side's trie into branches, commonest first. */
function branches(trie: Trie, side: 'before' | 'after'): TreeBranch[] {
  // A stable sort keeps equal counts in the order they first appear.
  return [...trie.children.values()].sort((a, b) => b.count - a.count).map((kid) => {
    // Follow the branch while every occurrence goes on the same way.
    let end = kid
    while (end.children.size === 1) {
      const only = end.children.values().next().value!
      if (only.count !== end.count) break
      end = only
    }
    // Every occurrence through `kid` reaches `end`, so both were first
    // seen in the same sentence.
    return {
      label: side === 'after' ? kid.sentence.slice(kid.start, end.end) : kid.sentence.slice(end.start, kid.end),
      count: kid.count,
      phrase: end.sentence.slice(end.phraseStart, end.phraseEnd),
      children: branches(end, side),
      continues: end.cut,
      occurrences: kid.occurrences
    }
  })
}

/** The word tree for `focus` in the passages' sentences. */
export function buildWordTree(passages: Iterable<SourceText>, focus: string): WordTree {
  const target = focus.trim().toLowerCase()
  const before = newTrie()
  const after = newTrie()
  let count = 0
  for (const p of passages) {
    for (const sentence of sentencesOf(p.text)) {
      const toks: Token[] = []
      for (const m of sentence.matchAll(TREE_TOKEN_RE)) toks.push({ key: m[0].toLowerCase(), start: m.index!, end: m.index! + m[0].length })
      for (let i = 0; i < toks.length; i++) {
        if (toks[i].key !== target) continue
        insert(after, toks, i, 1, sentence, count)
        insert(before, toks, i, -1, sentence, count)
        count++
      }
    }
  }
  return { focus: target, count, before: branches(before, 'before'), after: branches(after, 'after') }
}

/** Every branch with the side it's on, for CSV export. */
export function flattenWordTree(tree: WordTree): { side: 'before' | 'after'; branch: TreeBranch }[] {
  const out: { side: 'before' | 'after'; branch: TreeBranch }[] = []
  const walk = (side: 'before' | 'after', bs: TreeBranch[]) => {
    for (const b of bs) {
      out.push({ side, branch: b })
      walk(side, b.children)
    }
  }
  walk('before', tree.before)
  walk('after', tree.after)
  return out
}

// ── Layout ─────────────────────────────────────────────────────────

export interface TreeLayoutNode {
  /** Text shown, with "…" when the sentence goes on past TREE_DEPTH. */
  text: string
  x: number
  y: number
  anchor: 'start' | 'middle' | 'end'
  fontSize: number
  fontWeight: number
  /** Null for the word itself. */
  branch: TreeBranch | null
  /** The line leading to this branch (an index into edges); -1 for the
   *  word itself. */
  edge: number
}

export interface TreeLayout {
  width: number
  height: number
  nodes: TreeLayoutNode[]
  /** SVG path data for the lines joining the branches. */
  edges: string[]
}

/** The app's normal text size (--font-size-base). */
const FONT_SIZE = 13
const ROW_H = FONT_SIZE + 8
/** Space between a label and the line leaving it. */
const PAD = 4
/** Horizontal room for the lines between columns. */
const GAP = 26
const MARGIN = 12

function fontFor(size: number, weight: number): string {
  return `${weight} ${size}px ${SVG_FONT_FAMILY}`
}


export function layoutWordTree(tree: WordTree, rootLabel = tree.focus): TreeLayout {
  const nodes: TreeLayoutNode[] = []
  const lines: [number, number, number, number][] = []
  const heights = new Map<TreeBranch, number>()
  const heightOf = (b: TreeBranch): number => {
    const own = ROW_H
    const kids = b.children.reduce((h, c) => h + heightOf(c), 0)
    const h = Math.max(own, kids)
    heights.set(b, h)
    return h
  }
  const blockHeight = (bs: TreeBranch[]) => bs.reduce((h, b) => h + heightOf(b), 0)


  // Place a column of branches: `edge` is where their labels start (after)
  // or end (before); `dir` is +1 rightwards, -1 leftwards.
  const place = (bs: TreeBranch[], edge: number, top: number, dir: 1 | -1, from: { x: number; y: number }) => {
    let y0 = top
    for (const b of bs) {
      const h = heights.get(b)!
      const y = y0 + h / 2
      const fontSize = FONT_SIZE
      const fontWeight = 400
      const text = b.continues ? `${b.label} …` : b.label
      nodes.push({ text, x: edge, y, anchor: dir > 0 ? 'start' : 'end', fontSize, fontWeight, branch: b, edge: lines.length })
      lines.push([from.x, from.y, edge - dir * PAD, y])
      if (b.children.length > 0) {
        const w = measureTextWidth(text, fontFor(fontSize, fontWeight))
        const kidsTop = y0 + (h - blockHeight(b.children)) / 2
        place(b.children, edge + dir * (w + GAP), kidsTop, dir, { x: edge + dir * (w + PAD), y })
      }
      y0 += h
    }
  }

  const hBefore = blockHeight(tree.before)
  const hAfter = blockHeight(tree.after)
  const height = Math.max(hBefore, hAfter, ROW_H)
  const mid = height / 2
  const rootW = measureTextWidth(rootLabel, fontFor(FONT_SIZE, 400))
  nodes.push({ text: rootLabel, x: 0, y: mid, anchor: 'middle', fontSize: FONT_SIZE, fontWeight: 400, branch: null, edge: -1 })
  place(tree.after, rootW / 2 + GAP, (height - hAfter) / 2, 1, { x: rootW / 2 + PAD, y: mid })
  place(tree.before, -(rootW / 2 + GAP), (height - hBefore) / 2, -1, { x: -(rootW / 2 + PAD), y: mid })

  // Shift everything right so the leftmost label starts at the margin.
  let minX = -rootW / 2
  let maxX = rootW / 2
  for (const n of nodes) {
    const w = measureTextWidth(n.text, fontFor(n.fontSize, n.fontWeight))
    const left = n.anchor === 'start' ? n.x : n.anchor === 'end' ? n.x - w : n.x - w / 2
    minX = Math.min(minX, left)
    maxX = Math.max(maxX, left + w)
  }
  const dx = MARGIN - minX
  for (const n of nodes) {
    n.x += dx
    n.y += MARGIN
  }
  const f = (v: number) => v.toFixed(1)
  const edges = lines.map(([x1, y1, x2, y2]) => {
    x1 += dx; x2 += dx; y1 += MARGIN; y2 += MARGIN
    const mx = (x1 + x2) / 2
    return `M${f(x1)},${f(y1)} C${f(mx)},${f(y1)} ${f(mx)},${f(y2)} ${f(x2)},${f(y2)}`
  })
  return { width: maxX - minX + MARGIN * 2, height: height + MARGIN * 2, nodes, edges }
}

/** The nodes in the sentences running through node `i`: on its own side,
 *  its branch back to the word and every branch that goes on from it; on
 *  the other side, the branches those same sentences take. The word itself
 *  stands alone, since every branch runs through it. */
export function connectedNodes(layout: TreeLayout, i: number): Set<number> {
  const out = new Set([i])
  const own = layout.nodes[i].branch?.occurrences
  if (!own) return out
  const mine = new Set(own)
  out.add(0)
  layout.nodes.forEach((n, j) => {
    if (n.branch?.occurrences.some((o) => mine.has(o))) out.add(j)
  })
  return out
}

function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The layout as a standalone SVG, for reports. */
export function wordTreeSvg(layout: TreeLayout, colors: { text: string; line: string }): string {
  const lines = layout.edges.map((d) => `<path d="${d}" fill="none" stroke="${colors.line}" stroke-width="1"/>`).join('')
  const labels = layout.nodes.map((n) =>
    `<text x="${n.x.toFixed(1)}" y="${n.y.toFixed(1)}" text-anchor="${n.anchor}" dominant-baseline="middle" font-size="${n.fontSize.toFixed(1)}" font-weight="${n.fontWeight}" fill="${colors.text}">${escXml(n.text)}</text>`
  ).join('')
  const w = layout.width.toFixed(0)
  const h = layout.height.toFixed(0)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px;height:auto" font-family="${escXml(SVG_FONT_FAMILY)}">${lines}${labels}</svg>`
}
