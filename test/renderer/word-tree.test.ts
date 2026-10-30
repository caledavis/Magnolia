import { describe, it, expect } from 'vitest'
import { buildWordTree, connectedNodes, flattenWordTree, layoutWordTree, TREE_DEPTH, type TreeBranch } from '../../src/renderer/components/Analysis/word-tree'
import { wordCondition } from '../../src/renderer/components/Analysis/word-counts'
import { executeQuery } from '../../src/renderer/utils/query-engine'
import type { TextSource } from '../../src/renderer/models/types'

const passages = (...texts: string[]) => texts.map((text, i) => ({ sourceGuid: `doc${i}`, text }))
const labels = (bs: TreeBranch[]) => bs.map((b) => `${b.label} (${b.count})`)

describe('buildWordTree', () => {
  const text = 'I trust my teachers. I trust my friends, mostly. We trust nobody. Trust grows slowly.'

  it('branches the words after and before the word, commonest first', () => {
    const tree = buildWordTree(passages(text), 'Trust')
    expect(tree.count).toBe(4)
    expect(labels(tree.after)).toEqual(['my (2)', 'nobody. (1)', 'grows slowly. (1)'])
    expect(labels(tree.after[0].children)).toEqual(['teachers. (1)', 'friends, mostly. (1)'])
    expect(labels(tree.before)).toEqual(['I (2)', 'We (1)'])
  })

  it('merges words every occurrence goes on with', () => {
    const tree = buildWordTree(passages('the quality of life matters', 'the quality of life suffers'), 'quality')
    expect(labels(tree.after)).toEqual(['of life (2)'])
    expect(labels(tree.after[0].children)).toEqual(['matters (1)', 'suffers (1)'])
    expect(labels(tree.before)).toEqual(['the (2)'])
  })

  it('keeps branches within a sentence', () => {
    const tree = buildWordTree(passages('Ask why.\nWhy not'), 'why')
    expect(labels(tree.after)).toEqual(['. (1)', 'not (1)'])
    expect(labels(tree.before)).toEqual(['Ask (1)'])
  })

  it('gives each branch the text to search for', () => {
    const tree = buildWordTree(passages(text), 'trust')
    expect(tree.after[0].children[1].phrase).toBe('trust my friends, mostly.')
    expect(tree.before[0].phrase).toBe('I trust')
  })

  it('stops branches at the depth limit and marks them', () => {
    const long = 'go ' + Array.from({ length: TREE_DEPTH + 3 }, (_, i) => `w${i}`).join(' ')
    const [branch] = buildWordTree(passages(long), 'go').after
    expect(branch.label.split(' ')).toHaveLength(TREE_DEPTH)
    expect(branch.continues).toBe(true)
  })

  it('shows every branch', () => {
    const many = Array.from({ length: 12 }, (_, i) => `seen x${i}.`).join(' ')
    const tree = buildWordTree(passages(many, 'seen often a b.', 'seen often c d.'), 'seen')
    expect(tree.after).toHaveLength(13)
    expect(labels(tree.after[0].children)).toEqual(['a b. (1)', 'c d. (1)'])
  })

  it('finds every branch again with a text search', () => {
    const source = { guid: 'doc', name: 'Doc.txt', plainTextContent: text, selections: [] } as unknown as TextSource
    const tree = buildWordTree(passages(text), 'trust')
    for (const { branch } of flattenWordTree(tree)) {
      const hits = executeQuery({ documentFilter: {}, codeCondition: wordCondition(branch.phrase) }, [source], {}, [], [])
      expect(hits, branch.phrase).toHaveLength(branch.count)
    }
  })
})

describe('layoutWordTree', () => {
  it('puts the word between its two sides', () => {
    const tree = buildWordTree(passages('I trust my teachers. We trust nobody.'), 'trust')
    const layout = layoutWordTree(tree)
    const root = layout.nodes.find((n) => n.branch === null)!
    for (const n of layout.nodes) {
      if (n.branch && tree.after.includes(n.branch)) expect(n.x).toBeGreaterThan(root.x)
      if (n.branch && tree.before.includes(n.branch)) expect(n.x).toBeLessThan(root.x)
    }
    expect(layout.edges).toHaveLength(layout.nodes.length - 1)
    expect(Math.min(...layout.nodes.map((n) => n.y))).toBeGreaterThan(0)
  })
})

describe('whole-word search with punctuation at an end', () => {
  const content = 'Teachers, trust me. I distrust, mostly.'
  const source = { guid: 'doc', name: 'Doc.txt', plainTextContent: content, selections: [] } as unknown as TextSource
  const find = (text: string) => executeQuery({ documentFilter: {}, codeCondition: wordCondition(text) }, [source], {}, [], [])

  it('needs a word boundary only where the search text has a word', () => {
    expect(find(', trust')).toHaveLength(1)
    expect(find('trust,')).toHaveLength(0)
    expect(find('distrust,')).toHaveLength(1)
  })
})

describe('whole-word search inside coded passages', () => {
  const content = 'The cost of rent, not a student loan, is the pressure. I love the café.'
  //               0                       24                         54
  const source = {
    guid: 'doc', name: 'Doc.txt', plainTextContent: content,
    selections: [{ guid: 's1', startPosition: 0, endPosition: 54, codings: [{ guid: 'c1', codeGuid: 'A' }] },
      { guid: 's2', startPosition: 55, endPosition: 71, codings: [{ guid: 'c2', codeGuid: 'A' }] }]
  } as unknown as TextSource
  const codes = [{ guid: 'A', name: 'A', children: [] }] as any
  const find = (text: string) =>
    executeQuery({ documentFilter: {}, codeCondition: wordCondition(text, { codeGuids: ['A'], includeSubcodes: false }) }, [source], {}, codes, [])

  it('matches the same text as a search of the whole document', () => {
    expect(find('student loan, is the pressure.')).toHaveLength(1)
    expect(find('student loan,')).toHaveLength(1)
    expect(find('café')).toHaveLength(1)
    expect(find('caf')).toHaveLength(0)
  })

  it('finds every branch of a word tree built from coded passages', () => {
    const tree = buildWordTree(passages(content.slice(0, 54)), 'loan')
    for (const { branch } of flattenWordTree(tree)) {
      expect(find(branch.phrase), branch.phrase).toHaveLength(branch.count)
    }
  })
})

describe('connectedNodes', () => {
  it('lights the sentences running through a branch, on both sides', () => {
    const tree = buildWordTree(passages('I trust my teachers. I trust my friends. We trust nobody.'), 'trust')
    const layout = layoutWordTree(tree)
    const at = (label: string) => layout.nodes.findIndex((n) => n.text === label)
    const text = (set: Set<number>) => [...set].map((i) => layout.nodes[i].text).sort()
    expect(text(connectedNodes(layout, at('my')))).toEqual(['I', 'friends.', 'my', 'teachers.', 'trust'])
    expect(text(connectedNodes(layout, at('friends.')))).toEqual(['I', 'friends.', 'my', 'trust'])
    expect(text(connectedNodes(layout, at('We')))).toEqual(['We', 'nobody.', 'trust'])
    expect(text(connectedNodes(layout, at('trust')))).toEqual(['trust'])
  })

  it('gives each branch the line leading to it', () => {
    const layout = layoutWordTree(buildWordTree(passages('I trust my teachers.'), 'trust'))
    const edges = layout.nodes.filter((n) => n.edge !== -1).map((n) => n.edge).sort()
    expect(edges).toEqual(layout.edges.map((_, i) => i))
  })
})
