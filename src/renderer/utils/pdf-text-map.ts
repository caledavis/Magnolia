/**
 * Where a PDF's text is drawn on its pages, for the PDF viewer.
 *
 * A PDF's text in Magnolia is the plain-text representation its project
 * file carries (REFI-QDA §10.3: text selections are positions in that
 * text), so every passage, memo and quote is exactly where the file says.
 * The viewer, though, draws pages with pdf.js, whose reading of the same
 * text can differ in small ways (line breaks, spacing, hyphens, headers).
 * This maps positions between the two readings, for drawing only: a
 * highlight is drawn on the characters of the page that correspond to the
 * passage's, and text selected on the page is turned back into positions
 * in the PDF's text. Stored positions are never changed by it.
 *
 * The correspondence is found on letters and digits alone (where the two
 * readings of the same page agree): runs of them that occur once in each
 * text anchor it, in order, and grow while the texts go on agreeing.
 * Positions are Unicode code points.
 */

export interface PdfTextMap {
  /** A position in the PDF's text → the drawn (pdf.js) text. `side` says
   *  whether it starts or ends a span, so a span keeps to its letters. */
  toView(cp: number, side: 'start' | 'end'): number
  /** A position in the drawn text → the PDF's text. */
  toDoc(cp: number, side: 'start' | 'end'): number
}

const IDENTITY: PdfTextMap = { toView: (cp) => cp, toDoc: (cp) => cp }

interface Letters {
  text: string
  /** The code-point index each character of `text` came from. */
  at: number[]
  length: number
}

const WORD_CHAR = /[\p{L}\p{N}]/u

function letters(text: string): Letters {
  const chars = Array.from(text)
  let out = ''
  const at: number[] = []
  chars.forEach((c, i) => {
    for (const n of c.normalize('NFKC').toLowerCase()) {
      if (!WORD_CHAR.test(n)) continue
      out += n
      for (let k = 0; k < n.length; k++) at.push(i)
    }
  })
  return { text: out, at, length: chars.length }
}

/** Runs this long that occur once in each text anchor the correspondence. */
const ANCHOR = 12

/** Letter-to-letter correspondence: for each letter of `a`, the matching
 *  letter of `b`, or -1. */
function correspond(a: string, b: string): Int32Array {
  const out = new Int32Array(a.length).fill(-1)
  const count = (s: string) => {
    const m = new Map<string, number>()
    for (let i = 0; i + ANCHOR <= s.length; i++) {
      const g = s.slice(i, i + ANCHOR)
      m.set(g, m.has(g) ? -1 : i)
    }
    return m
  }
  const inA = count(a)
  const inB = count(b)
  const pairs: [number, number][] = []
  for (const [g, i] of inA) {
    if (i < 0) continue
    const j = inB.get(g)
    if (j !== undefined && j >= 0) pairs.push([i, j])
  }
  pairs.sort((x, y) => x[0] - y[0])
  // The longest run of anchors in the same order in both (patience sort).
  const tails: number[] = []
  const prev = new Int32Array(pairs.length).fill(-1)
  const tailIdx: number[] = []
  pairs.forEach(([, j], k) => {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (tails[mid] < j) lo = mid + 1
      else hi = mid
    }
    tails[lo] = j
    tailIdx[lo] = k
    prev[k] = lo > 0 ? tailIdx[lo - 1] : -1
  })
  const chain: [number, number][] = []
  for (let k = tailIdx[tails.length - 1] ?? -1; k !== -1; k = prev[k]) chain.push(pairs[k])
  chain.reverse()
  // Grow each anchor both ways while the letters agree, keeping order.
  let lastA = -1
  let lastB = -1
  for (let c = 0; c < chain.length; c++) {
    const [i0, j0] = chain[c]
    if (i0 <= lastA || j0 <= lastB) continue
    let i = i0
    let j = j0
    while (i - 1 > lastA && j - 1 > lastB && a[i - 1] === b[j - 1]) {
      i--
      j--
    }
    for (; i < a.length && j < b.length && a[i] === b[j]; i++, j++) out[i] = j
    lastA = i - 1
    lastB = j - 1
  }
  return out
}

/** For a position in `from` (code points), the position in `to`. */
function mapper(from: Letters, to: Letters, match: Int32Array) {
  const n = from.at.length
  // Nearest matched letter at or after / at or before each letter.
  const next = new Int32Array(n + 1).fill(-1)
  for (let i = n - 1; i >= 0; i--) next[i] = match[i] >= 0 ? i : next[i + 1]
  const prev = new Int32Array(n).fill(-1)
  for (let i = 0; i < n; i++) prev[i] = match[i] >= 0 ? i : i > 0 ? prev[i - 1] : -1
  /** Index of the first letter at or after code point `cp`. */
  const firstAtOrAfter = (cp: number) => {
    let lo = 0
    let hi = n
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (from.at[mid] < cp) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  // Where letter m of `to` is drawn, and the bounds non-letters next to it
  // may reach (up to the neighbouring letters).
  const after = (m: number) => (m + 1 < to.at.length ? to.at[m + 1] : to.length)
  const before = (m: number) => (m > 0 ? to.at[m - 1] + 1 : 0)
  return (cp: number, side: 'start' | 'end'): number => {
    const i = firstAtOrAfter(cp)
    if (side === 'start') {
      if (i < n && match[i] >= 0) {
        // Keep what comes before its first letter (an opening quote).
        const m = match[i]
        return Math.max(before(m), to.at[m] - (from.at[i] - cp))
      }
      const j = next[i]
      if (j >= 0) return to.at[match[j]]
      const k = i > 0 ? prev[i - 1] : -1
      return k >= 0 ? to.at[match[k]] + 1 : 0
    }
    const k = i - 1
    if (k >= 0 && match[k] >= 0) {
      // Keep what follows its last letter (a full stop).
      const m = match[k]
      return Math.min(after(m), to.at[m] + 1 + (cp - from.at[k] - 1))
    }
    const p = k >= 0 ? prev[k] : -1
    if (p >= 0) return to.at[match[p]] + 1
    const j = next[i]
    return j >= 0 ? to.at[match[j]] : 0
  }
}

/** The map between a PDF's text (`doc`) and pdf.js's reading of it
 *  (`view`): the identity when they're the same. */
export function buildPdfTextMap(doc: string, view: string): PdfTextMap {
  if (doc === view) return IDENTITY
  const a = letters(doc)
  const b = letters(view)
  const ab = correspond(a.text, b.text)
  const ba = new Int32Array(b.text.length).fill(-1)
  ab.forEach((j, i) => {
    if (j >= 0) ba[j] = i
  })
  const toView = mapper(a, b, ab)
  const toDoc = mapper(b, a, ba)
  return { toView, toDoc }
}

// ── The maps for the open project's PDFs ──
// Made when a project's PDFs are read (platform/tauri-api.ts), kept for the
// viewer and the coded-PDF export. A PDF with none draws its text as is.

interface Drawn {
  map: PdfTextMap
  /** Where each page's text starts in the drawn text. */
  pageOffsets: number[]
}
const drawn = new Map<string, Drawn>()

export function setDrawnText(sourceGuid: string, map: PdfTextMap, pageOffsets: number[]): void {
  if (map === IDENTITY) drawn.delete(sourceGuid)
  else drawn.set(sourceGuid, { map, pageOffsets })
}

export function forgetDrawnText(sourceGuid?: string): void {
  if (sourceGuid === undefined) drawn.clear()
  else drawn.delete(sourceGuid)
}

/** The map for a PDF, and where its pages start in the drawn text; the
 *  identity and the PDF's own page offsets when they're the same text. */
export function drawnText(sourceGuid: string, pageOffsets: number[]): Drawn {
  return drawn.get(sourceGuid) ?? { map: IDENTITY, pageOffsets }
}
