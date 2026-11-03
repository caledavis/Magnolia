/**
 * The "Count words in" controls shared by the word analysis tools (Word
 * Frequencies, Word Combinations): read whole documents, only the
 * passages coded with the codes dropped into the Coded with box, or the
 * results of the saved queries dropped into the From these queries box.
 */
import { useMemo, useState } from 'react'
import type { AnalysisInitData, QueryResult } from '../../models/types'
import { Icon, faXmark } from '../Icon'
import { SegmentedControl } from './SegmentedControl'
import { codeSet } from './word-counts'
import { runQueryLive, useQueryStore } from '../../stores/query-store'

/** What the words are counted in: whole documents, the passages coded
 *  with the chosen codes, or the results of the chosen saved queries
 *  (which choose their own documents, so the Document Selector is hidden). */
export type TextSource = 'documents' | 'coded' | 'query'

/** One chosen saved query and its current results. */
export interface QueryRun {
  name: string
  results: QueryResult[]
}

/** Each chosen query still in the project, run live as the Query Results
 *  pane runs it. Queries deleted since the analysis was saved drop out.
 *  `data` and the saved queries are dependencies, so results refresh when
 *  the project or a query changes. */
export function useQueryRuns(data: AnalysisInitData, queryGuids: string[], active: boolean): Map<string, QueryRun> {
  const savedQueries = useQueryStore((s) => s.savedQueries)
  return useMemo(() => (active ? runQueries(queryGuids) : new Map()), [data, savedQueries, queryGuids, active])
}

/** Run the chosen saved queries (read from the query store, which is
 *  where an analysis or report runs). */
export function runQueries(queryGuids: string[]): Map<string, QueryRun> {
  const saved = new Map(useQueryStore.getState().savedQueries.map((q) => [q.guid, q]))
  const m = new Map<string, QueryRun>()
  for (const g of queryGuids) {
    const sq = saved.get(g)
    if (sq?.query) m.set(g, { name: sq.name, results: runQueryLive(sq.query).results })
  }
  return m
}

/** Every result of the chosen queries. */
export function allResults(runs: Map<string, QueryRun>): QueryResult[] {
  return [...runs.values()].flatMap((r) => r.results)
}

function parseDraggedQueries(e: React.DragEvent): string[] {
  const json = e.dataTransfer.getData('application/x-magnolia-query')
  if (!json) return []
  try {
    const parsed = JSON.parse(json) as { guid: string } | { guid: string }[]
    return (Array.isArray(parsed) ? parsed : [parsed]).map((q) => q.guid)
  } catch { return [] }
}

function isQueryDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes('application/x-magnolia-query')
}

function parseDraggedCodes(e: React.DragEvent): string[] {
  const multiJson = e.dataTransfer.getData('application/x-magnolia-codes')
  const singleJson = e.dataTransfer.getData('application/x-magnolia-code')
  try {
    if (multiJson) return (JSON.parse(multiJson) as { guid: string }[]).map((c) => c.guid)
    if (singleJson) return [(JSON.parse(singleJson) as { guid: string }).guid]
  } catch { /* not a code drag */ }
  return []
}

function isCodeDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes('application/x-magnolia-code') ||
    e.dataTransfer.types.includes('application/x-magnolia-codes')
}

/** Each chosen code still in the project, mapped to the codes whose
 *  passages it reads (itself plus, when included, its subcodes). Codes
 *  deleted since the analysis was saved drop out. */
export function useCodeSets(codes: AnalysisInitData['codes'], codeGuids: string[], includeSubcodes: boolean): Map<string, Set<string>> {
  return useMemo(() => {
    const known = new Set(codes.map((c) => c.guid))
    const m = new Map<string, Set<string>>()
    for (const g of codeGuids) if (known.has(g)) m.set(g, codeSet(codes, g, includeSubcodes))
    return m
  }, [codes, codeGuids, includeSubcodes])
}

/** Every code read by any of the chosen codes. */
export function allCodes(codeSets: Map<string, Set<string>>): Set<string> {
  const all = new Set<string>()
  for (const set of codeSets.values()) for (const g of set) all.add(g)
  return all
}

export function CountWordsIn({ value, onChange, codedTitle, queryTitle }: {
  value: TextSource
  onChange: (value: TextSource) => void
  /** Tooltip for the Coded Passages button. */
  codedTitle: string
  /** Tooltip for the Query Results button. */
  queryTitle: string
}) {
  return (
    <div className="analysis-section" style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--text-secondary)' }}>Count words in</span>
      <SegmentedControl
        label="Count words in"
        value={value}
        onChange={onChange}
        options={[
          { value: 'documents', label: 'Documents', title: 'Count the words in the selected documents.' },
          { value: 'coded', label: 'Coded Passages', title: codedTitle },
          { value: 'query', label: 'Query Results', title: queryTitle }
        ]}
      />
    </div>
  )
}

/** The note under a box of codes or queries when box codings (regions on
 *  PDFs and images) were left out of the count. */
function BoxNote({ boxCount, one, many }: { boxCount: number; one: string; many: (n: number) => string }) {
  if (boxCount === 0) return null
  return (
    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, position: 'relative', zIndex: 1 }}>
      {boxCount === 1 ? one : many(boxCount)}
    </div>
  )
}

/** A section that's wholly a drop target, with a title, a hint and an
 *  accent outline while something droppable is over it. */
function DropSection({ title, hint, accepts, onDrop, children }: {
  title: string
  hint: string
  accepts: (e: React.DragEvent) => boolean
  onDrop: (e: React.DragEvent) => void
  children: React.ReactNode
}) {
  const [dropOver, setDropOver] = useState(false)
  return (
    <div
      className="analysis-section"
      style={{ marginBottom: 14, position: 'relative' }}
      onDragOver={(e) => {
        if (accepts(e)) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setDropOver(true)
        }
      }}
      onDragLeave={() => setDropOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDropOver(false)
        onDrop(e)
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 8, position: 'relative', zIndex: 1 }}>
        <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--text-secondary)' }}>{title}</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{hint}</span>
      </div>
      {children}
      {dropOver && (
        <div style={{
          position: 'absolute', inset: 0,
          background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
          border: '2px dashed var(--accent)',
          borderRadius: 'var(--radius-md)',
          pointerEvents: 'none'
        }} />
      )}
    </div>
  )
}

const chipStyle: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, background: 'var(--bg-tertiary)', padding: '2px 8px', borderRadius: 'var(--radius-sm)' }
const chipRowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', position: 'relative', zIndex: 1 }

/** The Coded with box: the whole section is the drop target. */
export function CodesSection({ codes, codeSets, onChangeCodes, includeSubcodes, onChangeIncludeSubcodes, boxCount }: {
  codes: AnalysisInitData['codes']
  codeSets: Map<string, Set<string>>
  onChangeCodes: (update: (prev: string[]) => string[]) => void
  includeSubcodes: boolean
  onChangeIncludeSubcodes: (value: boolean) => void
  /** Box codings left out of the count, for the note under the codes. */
  boxCount: number
}) {
  const codeMap = useMemo(() => new Map(codes.map((c) => [c.guid, c])), [codes])
  return (
    <DropSection
      title="Coded with"
      hint="Drag codes here"
      accepts={isCodeDrag}
      onDrop={(e) => {
        const dropped = parseDraggedCodes(e)
        if (dropped.length > 0) onChangeCodes((p) => [...p, ...dropped.filter((g) => !p.includes(g))])
      }}
    >
      <div style={chipRowStyle}>
        {[...codeSets.keys()].map((g) => {
          const code = codeMap.get(g)!
          return (
            <span key={g} style={chipStyle}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: code.color || 'var(--text-muted)', flexShrink: 0 }} />
              {code.name}
              <span onClick={() => onChangeCodes((p) => p.filter((x) => x !== g))} style={{ fontSize: 9, color: 'var(--text-muted)', cursor: 'pointer' }}><Icon icon={faXmark} /></span>
            </span>
          )
        })}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-secondary)', cursor: 'pointer', marginLeft: codeSets.size > 0 ? 6 : 0 }}>
          <input type="checkbox" checked={includeSubcodes} onChange={(e) => onChangeIncludeSubcodes(e.target.checked)} style={{ margin: 0 }} />
          And subcodes
        </label>
      </div>
      <BoxNote
        boxCount={boxCount}
        one="1 box coded on a PDF or image has no text, so it isn’t counted."
        many={(n) => `${n} boxes coded on PDFs or images have no text, so they aren’t counted.`}
      />
    </DropSection>
  )
}

/** The From these queries box: saved queries dragged from the Queries panel. Each
 *  query's own document filter decides which documents it searches. */
export function QueriesSection({ runs, onChangeQueries, boxCount }: {
  runs: Map<string, QueryRun>
  onChangeQueries: (update: (prev: string[]) => string[]) => void
  /** Box results left out of the count, for the note under the queries. */
  boxCount: number
}) {
  return (
    <DropSection
      title="From these queries"
      hint="Drag saved queries here"
      accepts={isQueryDrag}
      onDrop={(e) => {
        const dropped = parseDraggedQueries(e)
        if (dropped.length > 0) onChangeQueries((p) => [...p, ...dropped.filter((g) => !p.includes(g))])
      }}
    >
      <div style={chipRowStyle}>
        {runs.size === 0 && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Each query searches the documents chosen in it.</span>
        )}
        {[...runs].map(([g, run]) => (
          <span key={g} style={chipStyle}>
            {run.name}
            <span style={{ color: 'var(--text-muted)' }}>({run.results.length})</span>
            <span onClick={() => onChangeQueries((p) => p.filter((x) => x !== g))} style={{ fontSize: 9, color: 'var(--text-muted)', cursor: 'pointer' }}><Icon icon={faXmark} /></span>
          </span>
        ))}
      </div>
      <BoxNote
        boxCount={boxCount}
        one="1 result is a box on a PDF or image, which has no text, so it isn’t counted."
        many={(n) => `${n} results are boxes on PDFs or images, which have no text, so they aren’t counted.`}
      />
    </DropSection>
  )
}
