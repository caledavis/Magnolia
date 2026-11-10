import { describe, expect, it } from 'vitest'
import { codedTextHtml, colourWithAlpha, pageFigureHtml, type CodeRef } from '../../src/renderer/utils/coded-pdf/coded-html'

const red: CodeRef = { guid: 'r', name: 'Red', color: '#ff0000' }
const blue: CodeRef = { guid: 'b', name: 'Blue <b>', color: '#00f' }

/** The text with all markup removed, labels and timestamps included. */
const plain = (html: string) => html.replace(/<[^>]+>/g, '')
const labels = (html: string) => [...html.matchAll(/<span class="cl">(.*?)<\/span><\/span>/g)].length
/** The text with labels and highlights removed. */
const text = (html: string) => plain(html.replace(/<span class="cl">.*?<\/span><\/span>/g, ''))

describe('colourWithAlpha', () => {
  it('converts hex colours', () => {
    expect(colourWithAlpha('#ff8000', 0.5)).toBe('rgba(255, 128, 0, 0.5)')
    expect(colourWithAlpha('#00f', 1)).toBe('rgba(0, 0, 255, 1)')
  })
  it('falls back to grey', () => {
    expect(colourWithAlpha('teal', 1)).toBe('rgba(136, 136, 136, 1)')
  })
})

describe('codedTextHtml', () => {
  it('keeps the text and highlights the coded part', () => {
    const html = codedTextHtml('one two three', [{ start: 4, end: 7, codes: [red] }])
    expect(text(html)).toBe('one two three')
    expect(html).toContain('<span class="hl" style="background:rgba(255, 0, 0, 0.22)">wo</span>')
  })

  it('counts offsets in codepoints', () => {
    const html = codedTextHtml('😀 ab', [{ start: 2, end: 4, codes: [red] }])
    expect(html).toContain('>a</span>')
    expect(html).toContain('>b</span>')
  })

  it('nests highlights where codes overlap and labels each start once', () => {
    const html = codedTextHtml('abcdef', [
      { start: 0, end: 4, codes: [red] },
      { start: 2, end: 6, codes: [blue] }
    ])
    expect(labels(html)).toBe(2)
    // "c" and "d" (split by Blue's label) carry both backgrounds.
    for (const ch of ['c', 'd']) {
      expect(html).toContain(`rgba(0, 0, 255, 0.22)"><span class="hl" style="background:rgba(255, 0, 0, 0.22)">${ch}<`)
    }
  })

  it('merges segments that start together into one label', () => {
    const html = codedTextHtml('abc', [
      { start: 0, end: 2, codes: [red] },
      { start: 0, end: 3, codes: [blue, red] }
    ])
    expect(labels(html)).toBe(1)
    expect(html.match(/cl-code/g)).toHaveLength(2)
  })

  it('escapes text and code names', () => {
    const html = codedTextHtml('<script>', [{ start: 0, end: 8, codes: [blue] }])
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('Blue <b>')
  })

  it('adds line prefixes without moving offsets', () => {
    const html = codedTextHtml('first\nsecond', [{ start: 6, end: 12, codes: [red] }], new Map([[0, '00:00:01'], [1, '00:00:05']]))
    expect(plain(html)).toBe('00:00:01first\n00:00:05sRedecond')
    expect(html).toContain('>econd</span>')
  })

  it('clamps segments to the text and ignores uncoded ones', () => {
    const html = codedTextHtml('abc', [{ start: 1, end: 99, codes: [red] }, { start: 0, end: 1, codes: [] }])
    expect(labels(html)).toBe(1)
    expect(text(html)).toBe('abc')
    expect(html).toContain('>c</span>')
  })

  it('puts each label after the first character, so it stays on that line', () => {
    expect(plain(codedTextHtml('ab cd', [{ start: 2, end: 5, codes: [red] }]))).toBe('ab cRedd')
    // Leading white space is skipped, and a character is never split.
    expect(plain(codedTextHtml('a 👍🏽x', [{ start: 1, end: 6, codes: [red] }]))).toBe('a 👍🏽Redx')
    // The first word is kept on one line around its label.
    expect(codedTextHtml('ab cd ef', [{ start: 3, end: 8, codes: [red] }])).toMatch(/ <span class="cw"><span class="hl"[^>]*>c<\/span><span class="cl">.*<\/span><span class="hl"[^>]*>d<\/span><\/span><span class="hl"[^>]*> ef</)
    // …but not a long run without spaces, which keeps only its first word.
    const run = '中文没有空格所以整段都是一个很长的词语我们不能让它不换行否则会溢出页面'
    expect(codedTextHtml(run, [{ start: 0, end: 10, codes: [red] }])).toMatch(/>文<\/span><\/span><span class="hl"[^>]*>没有/)
    expect(plain(codedTextHtml(run, [{ start: 0, end: 10, codes: [red] }]))).toBe(run.slice(0, 1) + 'Red' + run.slice(1))
    // A segment of only white space keeps its label at the start.
    expect(plain(codedTextHtml('a  b', [{ start: 1, end: 3, codes: [red] }]))).toBe('aRed  b')
  })

  it('shows a detail line, such as a time range', () => {
    const html = codedTextHtml('abc', [{ start: 0, end: 3, codes: [red], detail: '00:00:01–00:00:04' }])
    expect(html).toContain('<span class="cl-detail">00:00:01–00:00:04</span>')
  })
})

describe('pageFigureHtml', () => {
  it('keeps labels in order without overlapping', () => {
    const html = pageFigureHtml('data:,', 1.4, [
      { y: 0.5, codes: [red] },
      { y: 0.1, codes: [blue] },
      { y: 0.1001, codes: [red, blue] }
    ], 'Page 1', false)
    const tops = [...html.matchAll(/top:([\d.]+)%/g)].map((m) => parseFloat(m[1]))
    // The two labels at 10% merge; the one at 50% stays put.
    expect(tops).toHaveLength(2)
    expect(tops[0]).toBeCloseTo(10, 1)
    expect(tops[1]).toBeCloseTo(50, 1)
  })

  it('pushes a crowded label down', () => {
    const html = pageFigureHtml('data:,', 1.4, [
      { y: 0.2, codes: [red] },
      { y: 0.205, codes: [blue] }
    ], '', true)
    const tops = [...html.matchAll(/top:([\d.]+)%/g)].map((m) => parseFloat(m[1]))
    expect(tops[1]).toBeGreaterThan(tops[0] + 1)
    expect(html).toContain('pg-break')
  })
})

describe('pageFigureHtml wrapping', () => {
  it('leaves room for a code name that wraps', () => {
    const long: CodeRef = { guid: 'l', name: 'A very long code name that will surely wrap onto more lines', color: '#123456' }
    const tops = (codes: CodeRef[]) => {
      const html = pageFigureHtml('data:,', 1.4, [{ y: 0.2, codes }, { y: 0.205, codes: [red] }], '', false)
      return [...html.matchAll(/top:([\d.]+)%/g)].map((m) => parseFloat(m[1]))
    }
    expect(tops([long])[1]).toBeGreaterThan(tops([red])[1])
  })
})
