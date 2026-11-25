import { describe, expect, it } from 'vitest'
import { moveCaret, type Caret } from '../../src/renderer/utils/text-caret'

const text = 'Diet and health.\nSleep matters too.\nShort.'
const cps = Array.from(text)
const lineStarts = [0, 17, 36]
const key = (k: string, mods: Partial<{ shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) => ({
  key: k, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...mods
})
const at = (n: number): Caret => ({ anchor: n, focus: n })
const sel = (c: Caret) => cps.slice(Math.min(c.anchor, c.focus), Math.max(c.anchor, c.focus)).join('')

describe('moveCaret', () => {
  it('moves by a character and by a word', () => {
    expect(moveCaret(at(0), key('ArrowRight'), cps, lineStarts)!.caret).toEqual(at(1))
    expect(moveCaret(at(0), key('ArrowRight', { altKey: true }), cps, lineStarts)!.caret).toEqual(at(4))
    expect(moveCaret(at(8), key('ArrowLeft', { altKey: true }), cps, lineStarts)!.caret).toEqual(at(5))
  })

  it('selects with Shift, and says what it selected', () => {
    let c = at(0)
    for (let i = 0; i < 2; i++) c = moveCaret(c, key('ArrowRight', { shiftKey: true, altKey: true }), cps, lineStarts)!.caret
    expect(sel(c)).toBe('Diet and')
    const r = moveCaret(c, key('ArrowRight', { shiftKey: true, altKey: true }), cps, lineStarts)!
    expect(r.passed).toBe(' health')
  })

  it('keeps the column between lines, within the line', () => {
    expect(moveCaret(at(5), key('ArrowDown'), cps, lineStarts)!.caret).toEqual(at(22))
    // "Short." is shorter: the end of it.
    expect(moveCaret(at(30), key('ArrowDown'), cps, lineStarts)!.caret).toEqual(at(42))
    expect(moveCaret(at(22), key('ArrowUp'), cps, lineStarts)!.passed).toBe('Diet and health.')
  })

  it('goes to the ends of the line and the text', () => {
    expect(moveCaret(at(20), key('Home'), cps, lineStarts)!.caret).toEqual(at(17))
    expect(moveCaret(at(20), key('End'), cps, lineStarts)!.caret).toEqual(at(35))
    expect(moveCaret(at(20), key('End', { metaKey: true }), cps, lineStarts)!.caret).toEqual(at(42))
    expect(moveCaret(at(20), key('ArrowUp', { metaKey: true }), cps, lineStarts)!.caret).toEqual(at(0))
  })

  it('collapses a selection to its near end without Shift', () => {
    expect(moveCaret({ anchor: 2, focus: 8 }, key('ArrowLeft'), cps, lineStarts)!.caret).toEqual(at(2))
    expect(moveCaret({ anchor: 2, focus: 8 }, key('ArrowRight'), cps, lineStarts)!.caret).toEqual(at(8))
  })

  it('moves forward on ← in a right-to-left text', () => {
    expect(moveCaret(at(3), key('ArrowLeft'), cps, lineStarts, true)!.caret).toEqual(at(4))
  })

  it('ignores keys that aren’t moves', () => {
    expect(moveCaret(at(3), key('a'), cps, lineStarts)).toBeNull()
  })
})
