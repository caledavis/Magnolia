import { describe, expect, it } from 'vitest'
import { twoLineWidth } from '../../src/renderer/components/Toolbar/Ribbon'

// Character counts stand in for text widths.
const chars = (s: string): number => s.length

describe('ribbon button widths', () => {
  it('splits a label as evenly as its word breaks allow', () => {
    expect(twoLineWidth('Resultaten in documenten', chars)).toBe('in documenten'.length)
    expect(twoLineWidth('Code-co-occurrences', chars)).toBe('occurrences'.length)
  })

  it('never breaks inside a word', () => {
    expect(twoLineWidth('Woordfrequenties', chars)).toBe('Woordfrequenties'.length)
  })
})
