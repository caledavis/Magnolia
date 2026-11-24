import { describe, expect, it } from 'vitest'
import { buildPdfTextMap } from '../../src/renderer/utils/pdf-text-map'

const cps = (s: string) => Array.from(s)
const cut = (text: string, a: number, b: number) => cps(text).slice(a, b).join('')
const at = (text: string, words: string) => {
  const start = cps(text.slice(0, text.indexOf(words))).length
  return [start, start + cps(words).length] as const
}

describe('buildPdfTextMap', () => {
  it('is the identity for the same text', () => {
    const m = buildPdfTextMap('abc', 'abc')
    expect([m.toView(2, 'start'), m.toDoc(1, 'end')]).toEqual([2, 1])
  })

  // As another program read a page, and as pdf.js draws it.
  const doc = 'supports President Barack Obama’s   23 strategy of protecting the Libyan people in their   24 struggle for freedom from the Qadhaffi tyranny.'
  const view = '(A) supports President Barack Obama’s22\n\nstrategy of protecting the Libyan people in their23\n\nstruggle for freedom from the Qadhaffi tyranny.'

  it('draws a passage on the same words of the page', () => {
    const m = buildPdfTextMap(doc, view)
    const [s, e] = at(doc, 'strategy of protecting the Libyan people')
    expect(cut(view, m.toView(s, 'start'), m.toView(e, 'end'))).toBe('strategy of protecting the Libyan people')
    const [s2, e2] = at(doc, 'Qadhaffi tyranny.')
    expect(cut(view, m.toView(s2, 'start'), m.toView(e2, 'end'))).toBe('Qadhaffi tyranny.')
  })

  it('turns text selected on the page back into positions in the PDF’s text', () => {
    const m = buildPdfTextMap(doc, view)
    const [s, e] = at(view, 'the Libyan people')
    expect(cut(doc, m.toDoc(s, 'start'), m.toDoc(e, 'end'))).toBe('the Libyan people')
  })

  it('round-trips a passage', () => {
    const m = buildPdfTextMap(doc, view)
    const [s, e] = at(doc, 'Barack Obama’s')
    expect([m.toDoc(m.toView(s, 'start'), 'start'), m.toDoc(m.toView(e, 'end'), 'end')]).toEqual([s, e])
  })

  it('stays in order when the drawn text has extra lines (headers)', () => {
    const d = 'First paragraph of the page goes here. Second paragraph follows it closely.'
    const v = 'Page 3 of 9 — Header text\nFirst paragraph of the page goes here.\nFooter line\nSecond paragraph follows it closely.'
    const m = buildPdfTextMap(d, v)
    const [s, e] = at(d, 'Second paragraph follows')
    expect(cut(v, m.toView(s, 'start'), m.toView(e, 'end'))).toBe('Second paragraph follows')
  })
})
