import { describe, it, expect } from 'vitest'
import { executeQuery } from '../../src/renderer/utils/query-engine'
import type { CodeCondition, TextSource } from '../../src/renderer/models/types'

// Case-insensitive search folds the text's case to compare. Some letters
// change length when lowercased ("İ" becomes two UTF-16 units), so where a
// match is in the folded text isn't where it is in the original: matches
// after such a letter must still be placed on the right characters.

function run(content: string, cond: CodeCondition) {
  const source = { guid: 'doc', name: 'Doc.txt', plainTextContent: content, selections: [] } as unknown as TextSource
  return executeQuery({ documentFilter: {}, codeCondition: cond }, [source], {}, [], [])
}

const search = (searchText: string, extra: Partial<Extract<CodeCondition, { type: 'text' }>> = {}): CodeCondition =>
  ({ type: 'text', searchText, ...extra }) as CodeCondition

describe('case-insensitive text search', () => {
  it('places matches after a Turkish dotted capital I correctly', () => {
    const text = 'İstanbul ve İzmir: kedi, kedi.'
    const results = run(text, search('kedi'))
    expect(results.map((r) => r.matchedText)).toEqual(['kedi', 'kedi'])
    const cps = Array.from(text)
    for (const r of results) expect(cps.slice(r.startPosition, r.endPosition).join('')).toBe('kedi')
  })

  it('finds a word that starts with a dotted capital I, whole', () => {
    const results = run('Biz İzmir’deyiz. İzmir güzel.', search('İzmir'))
    expect(results.map((r) => r.matchedText)).toEqual(['İzmir', 'İzmir'])
  })

  it('matches German sharp s, and words after it', () => {
    const text = 'STRASSE und Straße, dann Fuß und FUSS: Haus.'
    expect(run(text, search('straße')).map((r) => r.matchedText)).toEqual(['Straße'])
    expect(run(text, search('haus')).map((r) => r.matchedText)).toEqual(['Haus'])
    expect(run('ẞ Fuß Haus', search('haus')).map((r) => r.matchedText)).toEqual(['Haus'])
  })

  it('matches a final sigma however it is typed', () => {
    expect(run('Ο ΔΡΟΜΟΣ είναι εδώ.', search('δρομος')).map((r) => r.matchedText)).toEqual(['ΔΡΟΜΟΣ'])
  })

  it('still finds whole words only when asked, after a length-changing letter', () => {
    const text = 'İİİ cat concat cat'
    const results = run(text, search('cat', { wholeWord: true }))
    expect(results.map((r) => [r.startPosition, r.endPosition])).toEqual([[4, 7], [15, 18]])
  })
})
