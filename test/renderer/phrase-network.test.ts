import { describe, it, expect } from 'vitest'
import { buildPhraseNetwork, layoutPhraseNetwork, neighbours, phraseNetworkSvg, linkTitle } from '../../src/renderer/components/Analysis/phrase-network'
import { countPhrases, wordFilter } from '../../src/renderer/components/Analysis/word-counts'

const rows = (...pairs: [string, number][]) => pairs.map(([phrase, count]) => ({ phrase, count }))
const links = (net: ReturnType<typeof buildPhraseNetwork>) => net.links.map((l) => `${l.a}-${l.b} ${l.weight}`)

describe('buildPhraseNetwork', () => {
  it('joins the words that follow each other, weighted by the phrase counts', () => {
    const net = buildPhraseNetwork(rows(['mental health', 4], ['health services', 2]), new Set())
    expect(links(net)).toEqual(['mental-health 4', 'health-services 2'])
    expect(net.words).toEqual([{ word: 'mental', count: 4 }, { word: 'health', count: 6 }, { word: 'services', count: 2 }])
    expect(net.phraseCount).toBe(2)
  })

  it('joins the words either side of a left-out word, for the whole phrase', () => {
    const net = buildPhraseNetwork(rows(['quality of life', 3]), new Set(['of']))
    expect(links(net)).toEqual(['quality-life 3'])
    expect(net.links[0].phrases[0].phrase).toBe('quality of life')
    expect(net.words.map((w) => w.word)).toEqual(['quality', 'life'])
  })

  it('draws a longer phrase as a path, and merges the same pair either way round', () => {
    const net = buildPhraseNetwork(rows(['cost of living crisis', 2], ['crisis living', 1]), new Set(['of']))
    expect(links(net)).toEqual(['cost-living 2', 'living-crisis 3'])
    expect(net.links[1].phrases.map((p) => p.phrase)).toEqual(['cost of living crisis', 'crisis living'])
  })

  it('leaves out phrases with fewer than two words to draw, without counting them', () => {
    const net = buildPhraseNetwork(rows(['of the', 9], ['the same', 5], ['very very', 4], ['work load', 2]), new Set(['of', 'the']))
    expect(links(net)).toEqual(['work-load 2'])
    expect(net.phraseCount).toBe(1)
  })

  it('stops at the limit', () => {
    const net = buildPhraseNetwork(rows(['a b', 3], ['c d', 2], ['e f', 1]), new Set(), 2)
    expect(net.phraseCount).toBe(2)
    expect(net.words).toHaveLength(4)
  })

  it('takes the phrases Phrases counts', () => {
    const text = 'Mental health matters. Good mental health helps. Mental health services help too.'
    const filter = wordFilter('', 'too')
    const net = buildPhraseNetwork(countPhrases([text], 2, filter, 2), filter.exclude)
    expect(links(net)).toEqual(['mental-health 3'])
  })
})

describe('layoutPhraseNetwork', () => {
  const net = buildPhraseNetwork(rows(['mental health', 6], ['health services', 3], ['student debt', 2], ['debt stress', 2]), new Set())

  it('fits the dots and labels inside its size, no wider than asked', () => {
    const layout = layoutPhraseNetwork(net, 400)
    expect(layout.width).toBeLessThanOrEqual(400)
    for (const n of layout.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0)
      expect(n.x).toBeLessThanOrEqual(layout.width)
      expect(n.y).toBeGreaterThanOrEqual(0)
      expect(n.y).toBeLessThanOrEqual(layout.height)
    }
  })

  it('lays the same network out the same way each time', () => {
    expect(layoutPhraseNetwork(net)).toEqual(layoutPhraseNetwork(net))
  })

  it('makes commoner words bigger and commoner phrases thicker', () => {
    const layout = layoutPhraseNetwork(net)
    const node = (w: string) => layout.nodes.find((n) => n.word === w)!
    expect(node('health').r).toBeGreaterThan(node('stress').r)
    expect(layout.links[0].strokeWidth).toBeGreaterThan(layout.links[2].strokeWidth)
  })

  it('finds the words joined to a word', () => {
    const layout = layoutPhraseNetwork(net)
    const i = layout.nodes.findIndex((n) => n.word === 'health')
    expect([...neighbours(layout, i)].map((j) => layout.nodes[j].word).sort()).toEqual(['health', 'mental', 'services'])
  })
})

describe('phraseNetworkSvg and linkTitle', () => {
  it('escapes the words', () => {
    const layout = layoutPhraseNetwork(buildPhraseNetwork(rows(['r&d <budget>', 2]), new Set()))
    const svg = phraseNetworkSvg(layout, { text: '#333', line: '#ccc', node: '#36c', background: '#fff' })
    expect(svg).toContain('r&amp;d')
    expect(svg).toContain('&lt;budget&gt;')
    expect(svg.match(/<line /g)).toHaveLength(1)
  })

  it('lists the phrases a line stands for', () => {
    const net = buildPhraseNetwork(rows(['quality of life', 3], ['quality life', 1]), new Set(['of']))
    expect(linkTitle(net.links[0])).toBe('“quality of life”: 3 times\n“quality life”: 1 time')
  })
})
