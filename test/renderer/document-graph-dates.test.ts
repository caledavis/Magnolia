/**
 * Document Selector: a tag node's Between / Not Between on dates, with
 * the ends typed or picked from the category's dates.
 */
import { describe, expect, it } from 'vitest'
import { dateSpan, newestFirst, resolveDocGraph, type DNode, type DocGraphData } from '../../src/renderer/utils/document-graph'

const dates = ['03/05/2019', '2019', '12/2020', '15/01/2021', '2022']
const data: DocGraphData = {
  sources: dates.map((_, i) => ({ guid: `D${i}`, name: `Doc ${i}` })),
  tags: dates.map((value, i) => ({ guid: `T${i}`, name: `Date:${value}`, categoryGuid: 'CAT', value })),
  tagMembers: Object.fromEntries(dates.map((_, i) => [`T${i}`, [`D${i}`]])),
  folders: [],
  sourceFolder: {},
  respondentTagMembers: {},
  questionTagMembers: {}
}
const run = (tag: Partial<DNode>): string[] => {
  const nodes: DNode[] = [
    { id: 'tag', kind: 'tag', x: 0, y: 0, tagCategoryGuid: 'CAT', ...tag },
    { id: 'res', kind: 'result', x: 0, y: 0 }
  ]
  return resolveDocGraph(nodes, [{ id: 'c', from: 'tag', to: 'res', fromPort: 0, toPort: 0 } as any], data).sort()
}

describe('dates', () => {
  it('cover a day, a month or a year', () => {
    expect(dateSpan('03/05/2019')).toEqual([Date.UTC(2019, 4, 3), Date.UTC(2019, 4, 4) - 1])
    expect(dateSpan('12/2020')).toEqual([Date.UTC(2020, 11, 1), Date.UTC(2021, 0, 1) - 1])
    expect(dateSpan('2019-05-03')).toEqual(dateSpan('3/5/2019'))
    for (const bad of ['31/02/2019', '13/2019', 'soon', '']) expect(dateSpan(bad)).toBeNull()
  })

  it('are listed newest first', () => {
    expect([...dates, 'undated'].sort(newestFirst)).toEqual(['2022', '15/01/2021', '12/2020', '03/05/2019', '2019', 'undated'])
  })
})

describe('a date range', () => {
  it('takes in the documents dated wholly inside it, typed either way round', () => {
    expect(run({ betweenMode: 'between', rangeFrom: '01/01/2019', rangeTo: '31/12/2020' })).toEqual(['D0', 'D1', 'D2'])
    expect(run({ betweenMode: 'between', rangeFrom: '2020', rangeTo: '2019' })).toEqual(['D0', 'D1', 'D2'])
    expect(run({ betweenMode: 'between', rangeFrom: '01/06/2019', rangeTo: '2021' })).toEqual(['D2', 'D3'])
  })

  it('leaves them out for Not Between', () => {
    expect(run({ betweenMode: 'not-between', rangeFrom: '01/01/2019', rangeTo: '31/12/2020' })).toEqual(['D3', 'D4'])
  })

  it('is open at an end left empty', () => {
    expect(run({ betweenMode: 'between', rangeFrom: '2021', rangeTo: '' })).toEqual(['D3', 'D4'])
    expect(run({ betweenMode: 'between', rangeFrom: '', rangeTo: '05/2019' })).toEqual(['D0'])
  })

  it('takes in nothing until its ends are dates', () => {
    expect(run({ betweenMode: 'between', rangeFrom: '', rangeTo: '' })).toEqual([])
    expect(run({ betweenMode: 'between', rangeFrom: '2019', rangeTo: 'next year' })).toEqual([])
  })

  it('still works with two dates picked before typing existed', () => {
    expect(run({ betweenMode: 'between', tagGuid: 'T1', tagGuid2: 'T3' })).toEqual(['D0', 'D1', 'D2', 'D3'])
  })
})
