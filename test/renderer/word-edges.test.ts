import { describe, it, expect } from 'vitest'
import { executeQuery } from '../../src/renderer/utils/query-engine'
import { wordTokens } from '../../src/renderer/utils/words'
import type { Code, TextSource } from '../../src/renderer/models/types'

// A whole-word search must find a word wherever the word tools count it:
// an apostrophe is part of a word only between letters ("don't"), as the
// word-break rules (which the tools count by) have it.

const find = (text: string, word: string) => {
  const source = { guid: 'd', name: 'd.txt', plainTextContent: text, selections: [] } as unknown as TextSource
  return executeQuery(
    { documentFilter: {}, codeCondition: { type: 'text', searchText: word, caseSensitive: false, wholeWord: true } },
    [source], {}, [] as Code[], []
  ).map((r) => r.matchedText)
}

describe('whole-word search and apostrophes', () => {
  it('finds a word before a possessive or closing apostrophe', () => {
    expect(find("the international students' union", 'international students')).toEqual(['international students'])
    expect(find('the students’ union', 'students')).toEqual(['students'])
    expect(find("she said 'students' twice", 'students')).toEqual(['students'])
  })

  it('keeps an inner apostrophe inside its word, straight or curly', () => {
    expect(find("I don't know", 'don')).toEqual([])
    expect(find('I don’t know', 'don')).toEqual([])
    expect(find("I don't know", "don't")).toEqual(["don't"])
    expect(find('I don’t know', 'don’t')).toEqual(['don’t'])
  })

  it('finds a word as often as the word tools count it', () => {
    const text = "Students' fees, students’ rent; the students said 'students' and don't-students."
    const counted = wordTokens(text).filter((t) => t.word.toLowerCase() === 'students').length
    expect(find(text, 'students').length).toBe(counted)
  })
})
