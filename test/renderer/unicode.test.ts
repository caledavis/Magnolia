import { describe, it, expect } from 'vitest'
import { codepointCount, codepointLength } from '../../src/renderer/utils/unicode'

describe('codepointCount', () => {
  it('counts plain text one per character', () => {
    expect(codepointCount('hello world', 0, 11)).toBe(11)
    expect(codepointCount('hello world', 6, 11)).toBe(5)
  })

  it('counts a surrogate pair once', () => {
    const text = 'a😀b😀c'
    expect(codepointCount(text, 0, text.length)).toBe(codepointLength(text))
    expect(codepointCount(text, 1, 3)).toBe(1)
  })

  it('counts a pair split by the range end as one codepoint', () => {
    const text = 'a😀'
    expect(codepointCount(text, 0, 2)).toBe(2)
  })
})
