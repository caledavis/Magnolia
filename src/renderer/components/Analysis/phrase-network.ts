/**
 * Phrase networks — Word Combinations' Phrases, drawn as a network: each
 * word is a dot, and the words that follow each other in a repeated
 * phrase are joined by a line as thick as the phrase is common. Phrase
 * length 2 gives the bigram network of IRaMuTeQ-style tools, length 3
 * the trigram one.
 *
 * Words left out (Leave out these words, so stop words by default) can
 * sit inside a phrase ("quality of life") but aren't drawn: the line
 * runs between the words either side of them (quality — life), and
 * still stands for, and searches, the whole phrase. Otherwise a few
 * small words would become hubs joining unrelated phrases.
 *
 * Laid out with d3-force, run to a fixed number of ticks before drawing,
 * so a network looks the same each time (d3's simulation starts from a
 * fixed spiral and seeds its own random source).
 */
import { forceSimulation, forceLink, forceManyBody, forceCollide, forceX, forceY, type SimulationNodeDatum } from 'd3-force'
import type { PhraseRow } from './word-counts'
import { SVG_FONT_FAMILY } from '../../utils/use-theme-svg-colors'
import { t } from '../../i18n'

/** The most phrases drawn: past this the network turns into a tangle. */
export const NETWORK_PHRASES = 80

export interface NetworkLink {
  a: string
  b: string
  /** The counts of the phrases the line stands for, added up. */
  weight: number
  /** Those phrases, commonest first. Clicking the line searches the first. */
  phrases: PhraseRow[]
}

export interface PhraseNetwork {
  /** Each word drawn, with the counts of the phrases it's in added up. */
  words: { word: string; count: number }[]
  links: NetworkLink[]
  /** How many phrases the network draws (at most NETWORK_PHRASES). */
  phraseCount: number
}

/** The network of the commonest `limit` phrases. `phrases` comes from
 *  countPhrases, commonest first; `leaveOut` holds the words not drawn. */
export function buildPhraseNetwork(phrases: PhraseRow[], leaveOut: Set<string>, limit = NETWORK_PHRASES): PhraseNetwork {
  const counts = new Map<string, number>()
  const links = new Map<string, NetworkLink>()
  let phraseCount = 0
  for (const row of phrases) {
    if (phraseCount >= limit) break
    const words = row.phrase.split(' ').filter((w) => !leaveOut.has(w))
    let joined = false
    for (let i = 0; i + 1 < words.length; i++) {
      const [a, b] = [words[i], words[i + 1]]
      if (a === b) continue
      const key = a < b ? `${a} ${b}` : `${b} ${a}`
      let link = links.get(key)
      if (!link) links.set(key, (link = { a, b, weight: 0, phrases: [] }))
      link.weight += row.count
      if (!link.phrases.includes(row)) link.phrases.push(row)
      joined = true
    }
    if (!joined) continue
    phraseCount++
    for (const w of new Set(words)) counts.set(w, (counts.get(w) ?? 0) + row.count)
  }
  return {
    words: [...counts].map(([word, count]) => ({ word, count })),
    links: [...links.values()],
    phraseCount
  }
}

export interface NetworkNodeLayout {
  word: string
  count: number
  x: number
  y: number
  r: number
  fontSize: number
}

export interface NetworkLinkLayout extends NetworkLink {
  source: number
  target: number
  strokeWidth: number
}

export interface NetworkLayout {
  width: number
  height: number
  nodes: NetworkNodeLayout[]
  links: NetworkLinkLayout[]
}

const MARGIN = 16
/** Space between a dot and its label. */
export const LABEL_GAP = 3

interface SimNode extends SimulationNodeDatum {
  index: number
  r: number
  fontSize: number
  labelWidth: number
}

/** Rough width of a label: SVG text can't be measured outside the DOM,
 *  and the report needs the same layout as the tool. */
function labelWidth(word: string, fontSize: number): number {
  return word.length * fontSize * 0.56
}

/** Lays the network out to fit `maxWidth`, with each word's label below
 *  its dot. */
export function layoutPhraseNetwork(net: PhraseNetwork, maxWidth = 860): NetworkLayout {
  const index = new Map(net.words.map((w, i) => [w.word, i]))
  const maxCount = Math.max(1, ...net.words.map((w) => w.count))
  const maxWeight = Math.max(1, ...net.links.map((l) => l.weight))
  const nodes: SimNode[] = net.words.map((w, i) => {
    const share = Math.sqrt(w.count / maxCount)
    const fontSize = 10 + 4 * share
    return { index: i, r: 3 + 6 * share, fontSize, labelWidth: labelWidth(w.word, fontSize) }
  })
  const links = net.links.map((l) => ({ source: index.get(l.a)!, target: index.get(l.b)!, link: l }))

  const sim = forceSimulation(nodes)
    .force('link', forceLink<SimNode, { source: number; target: number }>(links.map((l) => ({ source: l.source, target: l.target }))).distance(70))
    .force('charge', forceManyBody().strength(-160))
    // Room for each dot and the label under it.
    .force('collide', forceCollide<SimNode>((n) => Math.max(n.r, n.labelWidth / 2) + 4))
    // Keep separate clusters near each other rather than drifting apart.
    .force('x', forceX(0).strength(0.06))
    .force('y', forceY(0).strength(0.09))
    .stop()
  for (let i = 0; i < 300; i++) sim.tick()

  // Fit the dots and their labels to the width, never enlarging.
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity
  for (const n of nodes) {
    left = Math.min(left, n.x! - Math.max(n.r, n.labelWidth / 2))
    right = Math.max(right, n.x! + Math.max(n.r, n.labelWidth / 2))
    top = Math.min(top, n.y! - n.r)
    bottom = Math.max(bottom, n.y! + n.r + LABEL_GAP + n.fontSize)
  }
  if (nodes.length === 0) left = right = top = bottom = 0
  const scale = Math.min(1, (maxWidth - 2 * MARGIN) / Math.max(1, right - left))
  const place = (v: number, from: number) => MARGIN + (v - from) * scale

  return {
    width: Math.round(Math.max(right - left, 0) * scale + 2 * MARGIN),
    height: Math.round(Math.max(bottom - top, 0) * scale + 2 * MARGIN),
    nodes: nodes.map((n) => ({
      word: net.words[n.index].word,
      count: net.words[n.index].count,
      x: place(n.x!, left),
      y: place(n.y!, top),
      r: n.r,
      fontSize: n.fontSize
    })),
    links: links.map(({ source, target, link }) => ({
      ...link,
      source,
      target,
      strokeWidth: 1 + 4 * (link.weight / maxWeight)
    }))
  }
}

/** The words joined to node `i`, and `i` itself. */
export function neighbours(layout: NetworkLayout, i: number): Set<number> {
  const out = new Set([i])
  for (const l of layout.links) {
    if (l.source === i) out.add(l.target)
    if (l.target === i) out.add(l.source)
  }
  return out
}

/** A line's tooltip: the phrases it stands for. */
export function linkTitle(link: NetworkLink): string {
  const lines = link.phrases.slice(0, 5).map((p) => t('combos.linkPhrase', { phrase: p.phrase, count: p.count }))
  if (link.phrases.length > 5) lines.push(t('combos.andMore', { count: link.phrases.length - 5 }))
  return lines.join('\n')
}

function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The network as a standalone SVG, for reports. */
export function phraseNetworkSvg(layout: NetworkLayout, colors: { text: string; line: string; node: string; background: string }): string {
  const lines = layout.links.map((l) => {
    const s = layout.nodes[l.source], t = layout.nodes[l.target]
    return `<line x1="${s.x.toFixed(1)}" y1="${s.y.toFixed(1)}" x2="${t.x.toFixed(1)}" y2="${t.y.toFixed(1)}" stroke="${colors.line}" stroke-width="${l.strokeWidth.toFixed(1)}" stroke-linecap="round"/>`
  }).join('')
  const dots = layout.nodes.map((n) =>
    `<circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r.toFixed(1)}" fill="${colors.node}"/>` +
    `<text x="${n.x.toFixed(1)}" y="${(n.y + n.r + LABEL_GAP).toFixed(1)}" text-anchor="middle" dominant-baseline="hanging" font-size="${n.fontSize.toFixed(1)}" fill="${colors.text}" stroke="${colors.background}" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${escXml(n.word)}</text>`
  ).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" width="100%" style="max-width:${layout.width}px;height:auto" font-family="${escXml(SVG_FONT_FAMILY)}">${lines}${dots}</svg>`
}

