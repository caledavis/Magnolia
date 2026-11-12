import { describe, it, expect } from 'vitest'
import { joinPageText, type PageTextContent } from '../../src/renderer/utils/pdf-page-text'

const item = (str: string, y: number, hasEOL = false) => ({
  str, dir: 'ltr', transform: [12, 0, 0, 12, 0, y], width: 10, height: 12, fontName: 'f', hasEOL
})

describe('joinPageText', () => {
  it('breaks pdf.js text where the baseline jumps or a line ends', () => {
    const content = { items: [item('Hello ', 700), item('world', 700, true), item('next', 680), item('line', 660)], styles: {}, lang: null } as PageTextContent
    const { text, items } = joinPageText(content)
    expect(text).toBe('Hello world\nnext\nline')
    expect(items.map((p) => [p.item.str, p.start, p.length])).toEqual([['Hello ', 0, 6], ['world', 6, 5], ['next', 12, 4], ['line', 17, 4]])
  })

  it('breaks an embedded text layer only where it marks a line end', () => {
    // A raised footnote marker sits off the baseline but on the same line.
    const content = { embedded: true, items: [item('يعني ', 700), item('١', 704), item(' أنا', 700, true), item('ام', 680)], styles: {}, lang: null } as PageTextContent
    const { text, items } = joinPageText(content)
    expect(text).toBe('يعني ١ أنا\nام')
    expect(items.map((p) => p.start)).toEqual([0, 5, 6, 11])
  })
})
