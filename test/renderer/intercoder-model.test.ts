import { describe, it, expect } from 'vitest'
import {
  matchDocuments,
  matchCodes,
  computeAgreement,
  syncExtents,
  cohensKappa,
  percentAgreement,
  krippendorffAlpha,
  pooledKappa,
  brennanPredigerKappa,
  passagesFor,
  codeSegments,
  type CoderProject,
  type Segment
} from '../../src/renderer/components/Analysis/intercoder/intercoder-model'
import type { PlainTextSelection, TextSource, Code } from '../../src/renderer/models/types'

const TEXT = 'x'.repeat(100)

function sel(guid: string, start: number, end: number, codeGuid: string, extra: Partial<PlainTextSelection> = {}): PlainTextSelection {
  return { guid, startPosition: start, endPosition: end, codings: [{ guid: `${guid}-c`, codeGuid }], ...extra }
}

function project(id: string, sources: TextSource[], codes: Code[] = [{ guid: 'code1', name: 'Theme', isCodable: true, children: [] }], contents: Record<string, string> = { doc1: TEXT }): CoderProject {
  return { id, label: id, fileName: `${id}.qdpx`, filePath: id, codes, sources, sourceContents: contents }
}

function textDoc(selections: PlainTextSelection[], guid = 'doc1', name = 'Interview'): TextSource {
  return { guid, name, sourceType: 'text', selections }
}

function run(projects: CoderProject[], threshold = 0.9, extents?: Record<string, any>) {
  const docs = matchDocuments(projects)
  const codes = matchCodes(projects)
  const ext = extents ?? Object.fromEntries(docs.map((d) => [d.key, syncExtents(projects.find((p) => d.members[p.id])!, d)]))
  return computeAgreement({ projects, docs, codes, extents: ext, threshold })
}

describe('inter-coder agreement: characters', () => {
  it('builds the 2×2 table, % agreement and Cohen’s kappa', () => {
    const r = run([
      project('A', [textDoc([sel('s1', 0, 20, 'code1')])]),
      project('B', [textDoc([sel('s2', 10, 30, 'code1')])])
    ])
    // Counts in characters (100 in all).
    const t = r.cells.code1.doc1.chars[0]!
    expect(t).toEqual({ a: 10, b: 10, c: 10, d: 70 })
    expect(percentAgreement(t)).toBeCloseTo(0.8)
    expect(cohensKappa(t)).toBeCloseTo(0.375)
  })

  it('matches published worked examples', () => {
    // Cohen's kappa: 50 items, yes/yes 20, yes/no 5, no/yes 10, no/no 15
    // → po 0.70, pe 0.50, κ 0.40 (the standard textbook example).
    expect(cohensKappa({ a: 20, b: 5, c: 10, d: 15 })).toBeCloseTo(0.4, 10)
    expect(percentAgreement({ a: 20, b: 5, c: 10, d: 15 })).toBeCloseTo(0.7, 10)
    // Scale-free: the same table as proportions gives the same kappa.
    expect(cohensKappa({ a: 0.4, b: 0.1, c: 0.2, d: 0.3 })).toBeCloseTo(0.4, 10)
    // Krippendorff (2011), binary data, 2 coders × 10 units: 4 units
    // disagree; n0 = 14, n1 = 6 → α = 1 − 19·4/84 = 0.095.
    expect(krippendorffAlpha({ o01: 4, n0: 14, n1: 6 })).toBeCloseTo(1 - 76 / 84, 10)
    expect(krippendorffAlpha({ o01: 4, n0: 14, n1: 6 })).toBeCloseTo(0.095, 3)
  })

  it('counts Krippendorff’s coincidences per character for three coders', () => {
    // 10 characters. A codes 0–6, B 2–6, C 4–8.
    const r = run([
      project('A', [textDoc([sel('a', 0, 6, 'code1')])], undefined, { doc1: 'x'.repeat(10) }),
      project('B', [textDoc([sel('b', 2, 6, 'code1')])], undefined, { doc1: 'x'.repeat(10) }),
      project('C', [textDoc([sel('c', 4, 8, 'code1')])], undefined, { doc1: 'x'.repeat(10) })
    ])
    // Units by how many coders coded them: 0–2 one (A), 2–4 two (A,B),
    // 4–6 three, 6–8 one (C), 8–10 none. o01 per unit = k(3−k)/2.
    const o01 = 2 * 1 + 2 * 1 + 2 * 0 + 2 * 1 + 0
    const n1 = 2 * 1 + 2 * 2 + 2 * 3 + 2 * 1
    const n0 = 30 - n1
    expect(r.cells.code1.doc1.alpha).toEqual({ o01, n0, n1 })
    expect(krippendorffAlpha(r.cells.code1.doc1.alpha!)).toBeCloseTo(1 - (o01 * 29) / (n0 * n1), 10)
  })

  it('merges a coder’s own overlapping segments', () => {
    const r = run([
      project('A', [textDoc([sel('s1', 0, 20, 'code1'), sel('s3', 10, 20, 'code1')])]),
      project('B', [textDoc([sel('s2', 0, 20, 'code1')])])
    ])
    expect(percentAgreement(r.cells.code1.doc1.chars[0]!)).toBeCloseTo(1)
  })

  it('leaves kappa undefined when neither coder used the code', () => {
    const r = run([project('A', [textDoc([])]), project('B', [textDoc([])])])
    const t = r.cells.code1.doc1.chars[0]!
    expect(percentAgreement(t)).toBeCloseTo(1)
    expect(cohensKappa(t)).toBeNull()
  })

  it('computes Krippendorff’s alpha for three coders', () => {
    const r = run([
      project('A', [textDoc([sel('s1', 0, 20, 'code1')])]),
      project('B', [textDoc([sel('s2', 0, 20, 'code1')])]),
      project('C', [textDoc([])])
    ])
    expect(r.pairs).toEqual([[0, 1], [0, 2], [1, 2]])
    // 20 characters coded by two of three: o01 = 20·(2·1)/2; n1 = 40, n0 = 260.
    expect(krippendorffAlpha(r.cells.code1.doc1.alpha!)).toBeCloseTo(1 - (299 * 20) / (260 * 40), 10)
  })

  it('compares image regions by area', () => {
    const img = (x: number): TextSource => ({
      guid: 'img', name: 'Photo', sourceType: 'image',
      selections: [sel(`r${x}`, 0, 0, 'code1', { pdfRegion: { page: 1, x, y: 0, width: 50, height: 50 } })]
    })
    const r = run(
      [project('A', [img(0)], undefined, {}), project('B', [img(25)], undefined, {})],
      0.9,
      { img: { region: { p1: 10000 } } }
    )
    // Areas: 50×50 boxes 25 apart on a 10,000 px² image.
    const t = r.cells.code1.img.chars[0]!
    expect(t).toEqual({ a: 1250, b: 1250, c: 1250, d: 6250 })
    expect(r.approxDocs).toEqual([])
  })

  it('compares audio time ranges against the duration', () => {
    const av = (start: number, end: number): TextSource => ({
      guid: 'av', name: 'Recording', sourceType: 'audio', formatData: { duration: 100 },
      selections: [sel(`t${start}`, 0, 0, 'code1', { timeRange: { startTime: start, endTime: end } })]
    })
    const r = run([project('A', [av(0, 50)], undefined, {}), project('B', [av(0, 50)], undefined, {})])
    const t = r.cells.code1.av.chars[0]!
    expect(t).toEqual({ a: 50000, b: 0, c: 0, d: 50000 })
    expect(cohensKappa(t)).toBeCloseTo(1)
  })

  // A 4-line transcript, 25 characters a line (24 + newline), with each
  // line's start time.
  const TRANSCRIPT = ['a'.repeat(24), 'b'.repeat(24), 'c'.repeat(24), 'd'.repeat(24)].join('\n')
  const LINE_TIMES = { '0': 0, '1': 10, '2': 20, '3': 30 }
  const video = (selections: PlainTextSelection[]): TextSource => ({
    guid: 'av', name: 'Clip', sourceType: 'video', formatData: { duration: 40, lineTimes: LINE_TIMES }, selections
  })

  it('compares transcript codings by their text, not their derived line times', () => {
    // Both are within line 1, so a load gives both the range 10–20 s;
    // their characters differ.
    const derived = { timeRange: { startTime: 10, endTime: 20 } }
    const r = run([
      project('A', [video([sel('a', 25, 49, 'code1', derived)])], undefined, { av: TRANSCRIPT }),
      project('B', [video([sel('b', 25, 37, 'code1', derived)])], undefined, { av: TRANSCRIPT })
    ])
    // 99 characters of transcript.
    expect(r.cells.code1.av.chars[0]).toEqual({ a: 12, b: 12, c: 0, d: 75 })
  })

  it('compares timeline codings by time, whatever their transcript anchors', () => {
    // Made on the timeline: line numbers 1–2 as anchors (not characters),
    // and a range that isn't what those offsets would derive.
    const r = run([
      project('A', [video([sel('a', 1, 2, 'code1', { timeRange: { startTime: 10, endTime: 30 } })])], undefined, { av: TRANSCRIPT }),
      project('B', [video([sel('b', 1, 2, 'code1', { timeRange: { startTime: 10, endTime: 20 } })])], undefined, { av: TRANSCRIPT })
    ])
    // 40 s in ms: both 10–20, only A 20–30, neither 0–10 and 30–40.
    expect(r.cells.code1.av.chars[0]).toEqual({ a: 10000, b: 10000, c: 0, d: 20000 })
  })

  it('clips codings that run past the end of the document', () => {
    const r = run([
      project('A', [textDoc([sel('a', 80, 130, 'code1')])]),
      project('B', [textDoc([sel('b', 80, 100, 'code1')])])
    ])
    expect(r.cells.code1.doc1.chars[0]).toEqual({ a: 20, b: 0, c: 0, d: 80 })
  })
})

describe('inter-coder agreement: totals', () => {
  it('pools a code over documents by units, not by document', () => {
    // A 100-character document where the coders disagree on 10, and a
    // 1,000-character one where they agree on 100.
    const long = 'z'.repeat(1000)
    const a = project('A', [textDoc([sel('a1', 0, 20, 'code1')]), textDoc([sel('a2', 0, 100, 'code1')], 'doc2', 'Long')], undefined, { doc1: TEXT, doc2: long })
    const b = project('B', [textDoc([sel('b1', 0, 10, 'code1')]), textDoc([sel('b2', 0, 100, 'code1')], 'doc2', 'Long')], undefined, { doc1: TEXT, doc2: long })
    const r = run([a, b])
    expect(r.codeTotals.code1.chars[0]).toEqual({ a: 110, b: 10, c: 0, d: 980 })
  })

  it('pools all codes with de Vries et al.’s pooled kappa', () => {
    const codes = [
      { guid: 'code1', name: 'One', isCodable: true, children: [] },
      { guid: 'code2', name: 'Two', isCodable: true, children: [] }
    ]
    const r = run([
      project('A', [textDoc([sel('a1', 0, 20, 'code1'), sel('a2', 50, 60, 'code2')])], codes),
      project('B', [textDoc([sel('b1', 10, 30, 'code1'), sel('b2', 50, 70, 'code2')])], codes)
    ])
    // code1: a 10 b 10 c 10 d 70 → po .8, pe .2·.2+.8·.8 = .68
    // code2: a 10 b 0 c 10 d 80 → po .9, pe .1·.2+.9·.8 = .74
    const p = r.overall.pooled![0]!
    expect(p.po).toBeCloseTo(0.85, 10)
    expect(p.pe).toBeCloseTo(0.71, 10)
    expect(pooledKappa(p)).toBeCloseTo((0.85 - 0.71) / 0.29, 10)
  })
})

describe('inter-coder agreement: segments', () => {
  it('matches segments by overlap ratio against the threshold', () => {
    const projects = [
      project('A', [textDoc([sel('s1', 0, 20, 'code1')])]),
      project('B', [textDoc([sel('s2', 10, 30, 'code1')])])
    ]
    expect(run(projects, 0.9).cells.code1.doc1.segs[0]).toEqual({ agree: 0, total: 2 })
    expect(run(projects, 0.3).cells.code1.doc1.segs[0]).toEqual({ agree: 2, total: 2 })
  })

  it('Brennan & Prediger kappa needs at least two codes', () => {
    expect(brennanPredigerKappa({ agree: 8, total: 10 }, 1)).toBeNull()
    expect(brennanPredigerKappa({ agree: 8, total: 10 }, 2)).toBeCloseTo(0.6)
  })
})

describe('inter-coder agreement: matching', () => {
  it('matches documents by name when guids differ, and codes by path', () => {
    const a = project('A', [textDoc([sel('s1', 0, 20, 'codeA')], 'docA')], [{ guid: 'codeA', name: 'Theme', isCodable: true, children: [] }], { docA: TEXT })
    const b = project('B', [textDoc([sel('s2', 0, 20, 'codeB')], 'docB')], [{ guid: 'codeB', name: 'Theme', isCodable: true, children: [] }], { docB: TEXT })
    const docs = matchDocuments([a, b])
    expect(docs).toHaveLength(1)
    expect(docs[0].members).toEqual({ A: 'docA', B: 'docB' })
    const codes = matchCodes([a, b])
    expect(codes).toHaveLength(1)
    const r = run([a, b])
    expect(percentAgreement(r.cells.codeA.docA.chars[0]!)).toBeCloseTo(1)
  })

  it('flags documents whose text differs and skips their text codings', () => {
    const a = project('A', [textDoc([sel('s1', 0, 20, 'code1')])])
    const b = project('B', [textDoc([sel('s2', 0, 20, 'code1')])], undefined, { doc1: 'y'.repeat(100) })
    const r = run([a, b])
    expect(matchDocuments([a, b])[0].textDiffers).toBe(true)
    expect(r.skippedDocs).toEqual([{ key: 'doc1', reason: 'textDiffers' }])
  })
})

describe('inter-coder agreement: passages', () => {
  it('groups overlapping segments and marks disagreement', () => {
    const a: Segment[] = [{ ch: 'text', line: '', start: 0, end: 20 }, { ch: 'text', line: '', start: 50, end: 60 }]
    const b: Segment[] = [{ ch: 'text', line: '', start: 0, end: 20 }, { ch: 'text', line: '', start: 55, end: 70 }]
    const ps = passagesFor(a, b, 'characters', 0.9)
    expect(ps.map((p) => [p.start, p.end, p.agreed])).toEqual([[0, 20, true], [50, 70, false]])
  })
})

describe('inter-coder agreement: kinds of unit', () => {
  it('a document nobody coded with a code adds no kind of unit of its own to that code', () => {
    // Theme is applied only to text. A photo nobody coded with it must not
    // add an all-agreement "area" half to Theme's total.
    const photo = (selections: PlainTextSelection[] = []): TextSource => ({ guid: 'img', name: 'Photo', sourceType: 'image', selections })
    const codes: Code[] = [
      { guid: 'code1', name: 'Theme', isCodable: true, children: [] },
      { guid: 'code2', name: 'Place', isCodable: true, children: [] }
    ]
    const box = (g: string) => sel(g, 0, 0, 'code2', { pdfRegion: { page: 1, x: 0, y: 0, width: 5, height: 5 } })
    const r = run([
      project('A', [textDoc([sel('s1', 0, 20, 'code1')]), photo([box('r1')])], codes),
      project('B', [textDoc([sel('s2', 10, 30, 'code1')]), photo([box('r2')])], codes)
    ], 0.9, { doc1: { text: { '': 100 } }, img: { region: { p1: 400 } } })
    expect(Object.keys(r.codeTotals.code1.units)).toEqual(['text'])
    expect(cohensKappa(r.codeTotals.code1.chars[0]!)).toBeCloseTo(0.375)
    expect(percentAgreement(r.codeTotals.code1.chars[0]!)).toBeCloseTo(0.8)
  })
})

describe('inter-coder agreement: transcript and timeline', () => {
  // Lines start at 0, 10, 19; timed 0 s, 3 s, 6 s; the recording is 9 s.
  const transcript = 'line zero\nline one\nline two'
  const video = (selections: PlainTextSelection[]): TextSource =>
    ({ guid: 'v', name: 'Clip', sourceType: 'video', formatData: { duration: 9, lineTimes: { '0': 0, '1': 3, '2': 6 } }, selections }) as TextSource
  const coder = (id: string, s: PlainTextSelection) => project(id, [video([s])], undefined, { v: transcript })
  // Coded on the transcript: "line one" (the load gives it 3–6 s).
  const onText = (g: string, start = 10, end = 18, from = 3, to = 6) => sel(g, start, end, 'code1', { timeRange: { startTime: from, endTime: to } })
  // Coded on the timeline.
  const onTimeline = (g: string, from: number, to: number) => sel(g, 10, 19, 'code1', { timeRange: { startTime: from, endTime: to } })

  it('compares a transcript coding with a timeline coding by time', () => {
    const r = run([coder('A', onText('a')), coder('B', onTimeline('b', 2.9, 6.1))])
    const cell = r.cells.code1.v
    expect(Object.keys(cell.units)).toEqual(['time'])
    // A 3000–6000 ms, B 2900–6100 ms of 9000.
    expect(cell.chars[0]).toEqual({ a: 3000, b: 0, c: 200, d: 5800 })
    expect(r.cells.code1.v.segs[0]).toEqual({ agree: 2, total: 2 })
  })

  it('keeps comparing by characters when everyone coded the transcript', () => {
    const r = run([coder('A', onText('a')), coder('B', onText('b', 12, 18))])
    expect(Object.keys(r.cells.code1.v.units)).toEqual(['text'])
    expect(r.cells.code1.v.chars[0]).toMatchObject({ a: 6, b: 2, c: 0 })
  })

  it('runs a coded last line to the end of the recording', () => {
    const r = run([coder('A', onText('a', 19, 27, 6, 6)), coder('B', onTimeline('b', 6, 9))])
    expect(r.cells.code1.v.chars[0]).toEqual({ a: 3000, b: 0, c: 0, d: 6000 })
  })

  it('shows the same comparison in the passages', () => {
    const projects = [coder('A', onText('a')), coder('B', onTimeline('b', 3, 6.5))]
    const [doc] = matchDocuments(projects)
    const [code] = matchCodes(projects)
    const per = codeSegments(projects, doc, code)
    const [p] = passagesFor(per[0], per[1], 'segments', 0.8)
    expect(p.ch).toBe('time')
    expect(p.agreed).toBe(true)
  })
})

describe('inter-coder agreement: the all-coders column', () => {
  it('comes first: alpha for Characters, the pairs’ average agreement for Segments', async () => {
    const { metricColumns, metricValue } = await import('../../src/renderer/components/Analysis/intercoder/intercoder-tables')
    expect(metricColumns('characters', 3)[0]).toEqual({ pair: null, metric: 'alpha' })
    const cols = metricColumns('segments', 3)
    expect(cols[0]).toEqual({ pair: null, metric: 'avgAgreement' })
    expect(metricColumns('segments', 2).some((c) => c.pair === null)).toBe(false)
    // Pairs at 50%, 100% and one with nothing to compare: (0.5 + 1) ÷ 2.
    const cell = { units: {}, chars: [], alpha: null, segs: [{ agree: 2, total: 4 }, { agree: 3, total: 3 }, null] }
    expect(metricValue(cell, cols[0], 'segments')).toBeCloseTo(0.75)
  })
})

describe('inter-coder agreement: by coder', () => {
  // 20 characters, four coders, plus a second document where coder D
  // isn't present.
  const T = 'x'.repeat(20)
  const four = () => [
    project('A', [textDoc([sel('a', 0, 10, 'code1')]), textDoc([sel('a2', 0, 5, 'code1')], 'doc2', 'Second')], undefined, { doc1: T, doc2: T }),
    project('B', [textDoc([sel('b', 2, 10, 'code1')]), textDoc([sel('b2', 0, 6, 'code1')], 'doc2', 'Second')], undefined, { doc1: T, doc2: T }),
    project('C', [textDoc([sel('c', 0, 12, 'code1')]), textDoc([sel('c2', 10, 15, 'code1')], 'doc2', 'Second')], undefined, { doc1: T, doc2: T }),
    project('D', [textDoc([sel('d', 8, 18, 'code1')])], undefined, { doc1: T })
  ]

  it('alpha without a coder is the alpha of the others alone', () => {
    const all = run(four())
    for (let k = 0; k < 4; k++) {
      const others = run(four().filter((_, i) => i !== k))
      if (others.coders.length >= 3) {
        expect(all.codeTotals.code1.alphaWithout![k]).toEqual(others.codeTotals.code1.alpha)
        expect(all.cells.code1.doc1.alphaWithout![k]).toEqual(others.cells.code1.doc1.alpha)
      }
    }
  })

  it('with two others left, it is the two coders’ own alpha', () => {
    // A, B, C on 20 characters; without C: A 0–10, B 2–10 → a 8, b 2, c 0, d 10.
    const r = run(four().slice(0, 3).map((p) => ({ ...p, sources: p.sources.slice(0, 1) })))
    const tab = r.cells.code1.doc1.alphaWithout![2]!
    // Binary, two coders: n1 = 2a + b + c, n0 = 2d + b + c, o01 = b + c.
    expect(tab).toEqual({ o01: 2, n1: 18, n0: 22 })
    expect(krippendorffAlpha(tab)).toBeCloseTo(1 - (39 * 2) / (22 * 18), 10)
  })

  it('a document one coder lacks counts only among those who have it', () => {
    const r = run(four())
    // Without A, only B and C have the second document.
    expect(r.cells.code1.doc2.alphaWithout![0]).toEqual({ o01: 11, n1: 11, n0: 29 })
    // Without D, it's A, B and C, as with everyone.
    expect(r.cells.code1.doc2.alphaWithout![3]).toEqual(r.cells.code1.doc2.alpha)
  })

  it('averages the coder’s pairs, and pools all codes', async () => {
    const { metricColumns, metricValue } = await import('../../src/renderer/components/Analysis/intercoder/intercoder-tables')
    const r = run(four())
    const cols = metricColumns('characters', 4, 'coders')
    expect(cols[0]).toEqual({ pair: null, metric: 'alpha' })
    const forA = cols.filter((c) => c.coder === 0)
    // No average % agreement for Characters: uncoded text makes it read high.
    expect(forA.map((c) => c.metric)).toEqual(['coderKappa', 'alphaWithout'])
    // A is in pairs 0 (A–B), 1 (A–C), 2 (A–D).
    expect(forA[0].coderPairs).toEqual([0, 1, 2])
    const cell = r.codeTotals.code1
    const kappas = [0, 1, 2].map((p) => cohensKappa(cell.chars[p]!)!)
    expect(metricValue(cell, forA[0], 'characters')).toBeCloseTo((kappas[0] + kappas[1] + kappas[2]) / 3, 10)
    expect(metricValue(cell, forA[1], 'characters')).toBeCloseTo(krippendorffAlpha(cell.alphaWithout![0]!)!, 10)
    // All codes (one code here): the pooled form gives the code's own value.
    expect(metricValue(r.overall, forA[1], 'characters')).toBeCloseTo(krippendorffAlpha(cell.alphaWithout![0]!)!, 10)
    // Segments: one column per coder, the mean of the coder's pairs.
    const segCol = metricColumns('segments', 4, 'coders').filter((c) => c.coder === 0)
    expect(segCol.map((c) => c.metric)).toEqual(['coderAgreement'])
    const segs = [0, 1, 2].map((p) => cell.segs[p]!.agree / cell.segs[p]!.total)
    expect(metricValue(cell, segCol[0], 'segments')).toBeCloseTo((segs[0] + segs[1] + segs[2]) / 3, 10)
    // Two coders: always by pair.
    expect(metricColumns('characters', 2, 'coders').every((c) => c.pair !== null)).toBe(true)
  })
})

describe('inter-coder agreement: shading', () => {
  it('shades kappa, alpha and segment agreement, but not Characters’ % agreement', async () => {
    const { tintScale } = await import('../../src/renderer/components/Analysis/intercoder/intercoder-tables')
    expect(tintScale('agreement', 'characters')).toBeNull()
    expect(tintScale('agreement', 'segments')).toBe('segments')
    expect(tintScale('coderAgreement', 'segments')).toBe('segments')
    expect(tintScale('avgAgreement', 'segments')).toBe('segments')
    expect(tintScale('coderKappa', 'characters')).toBe('kappa')
    expect(tintScale('alphaWithout', 'characters')).toBe('alpha')
    expect(tintScale('agreed', 'segments')).toBeNull()
  })
})

describe('inter-coder agreement: alpha without, as a change', () => {
  it('is the difference of the two values as shown', async () => {
    const { alphaChange, formatChange, metricColumns } = await import('../../src/renderer/components/Analysis/intercoder/intercoder-tables')
    const col = metricColumns('characters', 3, 'coders').find((c) => c.metric === 'alphaWithout')!
    // alpha 0.5649 shows as 0.56 and without 0.8251 as 0.83 → +0.27,
    // not the unrounded 0.2602 (0.26).
    const a = (o01: number, n0: number, n1: number) => ({ o01, n0, n1 })
    const n = 100
    // Pick tables with the alphas wanted: alpha = 1 − (n−1)·o01/(n0·n1), n0 = n1 = 50.
    const tab = (alpha: number) => a(((1 - alpha) * 2500) / (n - 1), 50, 50)
    const cell = { units: {}, chars: [], segs: [], alpha: tab(0.5649), alphaWithout: [tab(0.8251), null, null] }
    expect(alphaChange(cell, col, 'characters')).toBeCloseTo(0.27, 10)
    expect(formatChange(0.27)).toBe('+0.27')
    expect(formatChange(-0.05)).toBe('−0.05')
    expect(formatChange(0)).toBe('0.00')
    // Where the coder's alpha can't be computed: no change.
    expect(alphaChange({ ...cell, alphaWithout: [null, null, null] }, col, 'characters')).toBeNull()
    // Only for Alpha without.
    expect(alphaChange(cell, { pair: null, metric: 'alpha' }, 'characters')).toBeNull()
  })
})

describe('inter-coder agreement: the change’s colour and the headings’ tooltips', () => {
  it('flags a coder agreement is clearly higher without', async () => {
    const { changeLevel } = await import('../../src/renderer/components/Analysis/intercoder/intercoder-tables')
    expect(changeLevel(0.26)).toBe('clear')
    expect(changeLevel(0.1)).toBe('clear')
    expect(changeLevel(0.09)).toBe('some')
    expect(changeLevel(0.05)).toBe('some')
    expect(changeLevel(0.04)).toBeNull()
    expect(changeLevel(-0.3)).toBeNull()
  })

  it('describes agreement for the measure in use, and every column group', async () => {
    const { metricTitle, metricColumns, headerGroups } = await import('../../src/renderer/components/Analysis/intercoder/intercoder-tables')
    expect(metricTitle('agreement', 'segments')).not.toBe(metricTitle('agreement', 'characters'))
    const snap = { coders: [{ label: 'Ana' }, { label: 'Ben' }, { label: 'Chloe' }], results: { pairs: [[0, 1], [0, 2], [1, 2]] } } as any
    for (const view of ['pairs', 'coders'] as const) {
      const groups = headerGroups(snap, metricColumns('characters', 3, view))
      expect(groups.every((g) => g.title && g.title !== g.label)).toBe(true)
    }
  })
})

describe('inter-coder agreement: rounding as shown', () => {
  it('rounds exactly as the numbers are displayed, halves away from zero', async () => {
    const { asShown, alphaChange, metricColumns } = await import('../../src/renderer/components/Analysis/intercoder/intercoder-tables')
    const fmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    for (let i = -100000; i <= 100000; i += 7) {
      const x = i / 100000
      expect(asShown(x, 2)).toBe(Number(fmt.format(x)) || 0)
    }
    // Where Math.round goes the other way.
    expect(asShown(-0.125, 2)).toBe(-0.13)
    expect(asShown(0.015, 2)).toBe(0.02)
    // The change is the difference of the two values on screen: alpha
    // −0.125 shows as −0.13, alpha without 0.20 → +0.33.
    const col = metricColumns('characters', 3, 'coders').find((c) => c.metric === 'alphaWithout')!
    const tabFor = (alpha: number) => ({ o01: ((1 - alpha) * 2500) / 99, n0: 50, n1: 50 })
    const cell = { units: {}, chars: [], segs: [], alpha: tabFor(-0.125), alphaWithout: [tabFor(0.2), null, null] }
    expect(alphaChange(cell, col, 'characters')).toBeCloseTo(0.33, 10)
  })
})
