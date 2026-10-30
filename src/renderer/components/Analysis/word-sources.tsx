/**
 * The "Count words in" controls shared by the word analysis tools (Word
 * Frequencies, Word Combinations): read whole documents, or only the
 * passages coded with the codes dropped into the Codes box.
 */
import { useMemo, useState } from 'react'
import type { AnalysisInitData } from '../../models/types'
import { Icon, faXmark } from '../Icon'
import { SegmentedControl } from './SegmentedControl'
import { codeSet } from './word-counts'

/** What the words are counted in: whole documents, or the passages coded
 *  with the chosen codes. */
export type TextSource = 'documents' | 'coded'

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

export function CountWordsIn({ value, onChange, codedTitle }: {
  value: TextSource
  onChange: (value: TextSource) => void
  /** Tooltip for the Coded Passages button. */
  codedTitle: string
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
          { value: 'coded', label: 'Coded Passages', title: codedTitle }
        ]}
      />
    </div>
  )
}

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
  const [dropOver, setDropOver] = useState(false)
  const codeMap = useMemo(() => new Map(codes.map((c) => [c.guid, c])), [codes])
  return (
    <div
      className="analysis-section"
      style={{ marginBottom: 14, position: 'relative' }}
      onDragOver={(e) => {
        if (isCodeDrag(e)) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setDropOver(true)
        }
      }}
      onDragLeave={() => setDropOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDropOver(false)
        const dropped = parseDraggedCodes(e)
        if (dropped.length > 0) onChangeCodes((p) => [...p, ...dropped.filter((g) => !p.includes(g))])
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 8, position: 'relative', zIndex: 1 }}>
        <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--text-secondary)' }}>Coded with</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          Drag codes here
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', position: 'relative', zIndex: 1 }}>
        {[...codeSets.keys()].map((g) => {
          const code = codeMap.get(g)!
          return (
            <span key={g} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, background: 'var(--bg-tertiary)', padding: '2px 8px', borderRadius: 'var(--radius-sm)' }}>
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
      {boxCount > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, position: 'relative', zIndex: 1 }}>
          {boxCount === 1
            ? '1 box coded on a PDF or image has no text, so it isn’t counted.'
            : `${boxCount} boxes coded on PDFs or images have no text, so they aren’t counted.`}
        </div>
      )}
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
