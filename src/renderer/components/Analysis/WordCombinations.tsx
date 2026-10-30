/**
 * Word Combinations — which words go together. Three views over the same
 * text (the selected documents, or the passages coded with chosen codes):
 *   - Phrases: sequences of two or three words that repeat;
 *   - Associations: the words that share sentences with a focus word more
 *     often than chance would explain, scored by log-likelihood (G²); and
 *   - Word Tree: the words that come before and after the focus word,
 *     merged into branches (see word-tree.ts).
 */
import { useState, useMemo, useCallback, useRef } from 'react'
import type { AnalysisInitData, SurveyCellScopeArgs } from '../../models/types'
import { Icon, faWholeWord } from '../Icon'
import {
  emptyDocumentFilter,
  type DocumentFilterState
} from '../DocumentSelector/DocumentSelector'
import { DocumentsSection } from './DocumentsSection'
import { toCsv, resolveFilteredSources, STOP_WORDS, applySurveyCellScope } from './analysis-helpers'
import {
  countWords,
  sourceTexts,
  codedPassageTexts,
  countPhrases,
  wordAssociations,
  wordFilter,
  type SourceText,
  type WordQueryCodes
} from './word-counts'
import { type TextSource, useCodeSets, allCodes, CountWordsIn, CodesSection } from './word-sources'
import { generateGuid } from '../../utils/guid'
import { useLiveAnalysisData } from './use-live-analysis-data'
import { EditableTitleSuffix } from '../EditableTitleSuffix'
import { renameSavedAnalysis } from '../../utils/rename-saved-analysis'
import { useToolDirtyState } from '../../hooks/use-tool-dirty-state'
import { useRegisterToolSave } from '../../hooks/use-register-tool-save'
import { SegmentedControl } from './SegmentedControl'
import { buildWordTree, connectedNodes, flattenWordTree, layoutWordTree, type TreeLayout } from './word-tree'
import { useThemeSvgColors, SVG_FONT_FAMILY } from '../../utils/use-theme-svg-colors'

export type CombinationsView = 'phrases' | 'associations' | 'tree'

export interface WordCombinationsConfig {
  docFilter: DocumentFilterState
  textSource: TextSource
  codeGuids: string[]
  includeSubcodes: boolean
  includeWords: string
  excludeWords: string
  view: CombinationsView
  phraseLength: 2 | 3
  minCount: number
  /** Empty uses the most frequent word. */
  focusWord: string
  minTogether: number
}

export function defaultCombinationsConfig(): WordCombinationsConfig {
  return {
    docFilter: emptyDocumentFilter(),
    textSource: 'documents',
    codeGuids: [],
    includeSubcodes: true,
    includeWords: '',
    excludeWords: Array.from(STOP_WORDS).join(', '),
    view: 'phrases',
    phraseLength: 2,
    minCount: 2,
    focusWord: '',
    minTogether: 3
  }
}

/** The passages a Word Combinations analysis reads, for the tool and its
 *  report section alike. */
export function combinationsPassages(
  data: AnalysisInitData,
  sourceGuids: string[],
  textSource: TextSource,
  codeSets: Map<string, Set<string>>
): { passages: SourceText[]; boxCount: number } {
  if (textSource === 'coded') return codedPassageTexts(data, sourceGuids, allCodes(codeSets))
  return { passages: sourceGuids.flatMap((g) => sourceTexts(data, g).map((text) => ({ sourceGuid: g, text }))), boxCount: 0 }
}

/** The focus word: the one typed, or else the most frequent word. */
export function effectiveFocus(focusWord: string, passages: SourceText[], filter: ReturnType<typeof wordFilter>): string {
  const typed = focusWord.trim().toLowerCase()
  if (typed) return typed
  let best = ''
  let bestCount = 0
  for (const [w, c] of countWords(passages.map((p) => p.text), filter)) {
    if (c > bestCount) { best = w; bestCount = c }
  }
  return best
}

const PHRASE_ROWS = 200
const ASSOCIATION_ROWS = 50

interface Props {
  data: AnalysisInitData
  savedConfig?: Partial<WordCombinationsConfig> & { guid: string; name: string }
  inTab?: {
    onClose: () => void
    onSaved: (savedGuid: string, name: string) => void
    onDirtyChange?: (dirty: boolean) => void
    tabId?: string
  }
}

/** The word tree, with each branch searchable. Hovering a branch
 *  highlights the sentences running through it, on both sides. */
function WordTreeChart({ layout, svgRef, onSearch }: {
  layout: TreeLayout
  svgRef: React.Ref<SVGSVGElement>
  onSearch: (phrase: string) => void
}) {
  const colors = useThemeSvgColors()
  const [hovered, setHovered] = useState<number | null>(null)
  const lit = useMemo(() => (hovered === null ? null : connectedNodes(layout, hovered)), [layout, hovered])
  const litEdges = useMemo(() => new Set(lit ? [...lit].map((i) => layout.nodes[i].edge) : []), [layout, lit])
  return (
    <svg ref={svgRef} viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width} height={layout.height} fontFamily={SVG_FONT_FAMILY} style={{ display: 'block' }}>
      {layout.edges.map((d, i) => (
        <path key={i} d={d} fill="none" stroke={litEdges.has(i) ? colors.accent : colors.borderColor} strokeWidth={litEdges.has(i) ? 1.5 : 1} />
      ))}
      {layout.nodes.map((n, i) => {
        const b = n.branch
        const phrase = b ? b.phrase : n.text
        return (
          <text
            key={i}
            x={n.x}
            y={n.y}
            textAnchor={n.anchor}
            dominantBaseline="middle"
            fontSize={n.fontSize}
            fontWeight={n.fontWeight}
            fill={lit?.has(i) ? colors.accent : colors.textPrimary}
            style={{ cursor: 'pointer' }}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
            onClick={() => onSearch(phrase)}
          >
            <title>{`“${phrase}”: ${b ? b.count : 'every'} time${b?.count === 1 ? '' : 's'}. Click to search`}</title>
            {n.text}
          </text>
        )
      })}
    </svg>
  )
}

const thStyle: React.CSSProperties = { padding: '3px 6px', borderBottom: '1px solid var(--border-color)', textAlign: 'left' }
const tdStyle: React.CSSProperties = { padding: '2px 6px', borderBottom: '1px solid var(--border-color)' }

export function WordCombinations({ data: propData, savedConfig, inTab }: Props) {
  const initial = useMemo((): WordCombinationsConfig => {
    const { guid: _guid, name: _name, ...saved } = savedConfig ?? { guid: '', name: '' }
    return { ...defaultCombinationsConfig(), ...saved }
  }, [])
  const [docFilter, setDocFilter] = useState<DocumentFilterState>(initial.docFilter)
  const [textSource, setTextSource] = useState<TextSource>(initial.textSource)
  const [codeGuids, setCodeGuids] = useState<string[]>(initial.codeGuids)
  const [includeSubcodes, setIncludeSubcodes] = useState(initial.includeSubcodes)
  const [includeWords, setIncludeWords] = useState(initial.includeWords)
  const [excludeWords, setExcludeWords] = useState(initial.excludeWords)
  const [view, setView] = useState<CombinationsView>(initial.view)
  const [phraseLength, setPhraseLength] = useState<2 | 3>(initial.phraseLength)
  const [minCount, setMinCount] = useState(initial.minCount)
  const [focusWord, setFocusWord] = useState(initial.focusWord)
  const [minTogether, setMinTogether] = useState(initial.minTogether)
  const live = useLiveAnalysisData()
  const data = useMemo(() => {
    return applySurveyCellScope({ ...propData, ...live }, docFilter)
  }, [propData, live, docFilter])
  const [analysisGuid] = useState(savedConfig?.guid ?? generateGuid())
  const [analysisName, setAnalysisName] = useState(savedConfig?.name ?? '')
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const isExisting = !!savedConfig?.guid
  const coded = textSource === 'coded'

  // Dirty tracking (see useToolDirtyState).
  const currentConfig: WordCombinationsConfig = useMemo(
    () => ({ docFilter, textSource, codeGuids, includeSubcodes, includeWords, excludeWords, view, phraseLength, minCount, focusWord, minTogether }),
    [docFilter, textSource, codeGuids, includeSubcodes, includeWords, excludeWords, view, phraseLength, minCount, focusWord, minTogether]
  )
  const { dirty, baseline, setBaseline } = useToolDirtyState(currentConfig, initial, inTab)

  const handleDiscard = useCallback(() => {
    setDocFilter(baseline.docFilter)
    setTextSource(baseline.textSource)
    setCodeGuids(baseline.codeGuids)
    setIncludeSubcodes(baseline.includeSubcodes)
    setIncludeWords(baseline.includeWords)
    setExcludeWords(baseline.excludeWords)
    setView(baseline.view)
    setPhraseLength(baseline.phraseLength)
    setMinCount(baseline.minCount)
    setFocusWord(baseline.focusWord)
    setMinTogether(baseline.minTogether)
  }, [baseline])

  const filteredSourceGuids = useMemo(
    () => resolveFilteredSources(data, docFilter.sourceGuids, docFilter.tagGuids, docFilter.tagExcludeGuids, docFilter.typeInclude, docFilter.typeExclude),
    [data, docFilter]
  )
  const codeSets = useCodeSets(data.codes, codeGuids, includeSubcodes)
  const filter = useMemo(() => wordFilter(includeWords, excludeWords), [includeWords, excludeWords])

  const { passages, boxCount } = useMemo(
    () => combinationsPassages(data, filteredSourceGuids, textSource, codeSets),
    [data, filteredSourceGuids, textSource, codeSets]
  )
  const texts = useMemo(() => passages.map((p) => p.text), [passages])

  const phrases = useMemo(
    () => (view === 'phrases' ? countPhrases(texts, phraseLength, filter, Math.max(1, minCount)) : []),
    [view, texts, phraseLength, filter, minCount]
  )

  const focus = useMemo(
    () => (view !== 'phrases' ? effectiveFocus(focusWord, passages, filter) : ''),
    [view, focusWord, passages, filter]
  )
  const associations = useMemo(
    () => (view === 'associations' && focus ? wordAssociations(texts, focus, filter, Math.max(1, minTogether)) : null),
    [view, focus, texts, filter, minTogether]
  )
  const tree = useMemo(
    () => (view === 'tree' && focus ? buildWordTree(passages, focus) : null),
    [view, focus, passages]
  )
  const treeLayout = useMemo(() => (tree && tree.count > 0 ? layoutWordTree(tree) : null), [tree])
  const treeRef = useRef<SVGSVGElement>(null)

  // Searches run in the same documents, survey questions and (when
  // counting coded passages) codes as the analysis.
  const surveyScope = useCallback((): SurveyCellScopeArgs | undefined => (
    docFilter.questionScope?.length || docFilter.respondentScope?.length
      ? { questionScope: docFilter.questionScope, respondentScope: docFilter.respondentScope }
      : undefined
  ), [docFilter])
  const queryCodes = useCallback((): WordQueryCodes | undefined => (
    coded ? { codeGuids: [...codeSets.keys()], includeSubcodes } : undefined
  ), [coded, codeSets, includeSubcodes])

  const searchFor = useCallback((text: string, sourceGuids: string[]) => {
    window.api.sendAnalysisAction('run-word-query', text, sourceGuids, surveyScope(), queryCodes())
  }, [surveyScope, queryCodes])

  // The sentences where the focus word and an associated word appear together.
  const searchSentences = useCallback((word: string) => {
    window.api.sendAnalysisAction('run-sentence-query', focus, word, filteredSourceGuids, surveyScope(), queryCodes())
  }, [focus, filteredSourceGuids, surveyScope, queryCodes])

  const handleExportCsv = useCallback(() => {
    if (view === 'phrases') {
      const rows = [['Phrase', 'Count'], ...phrases.map((p) => [p.phrase, String(p.count)])]
      window.api.exportCsv(toCsv(rows), 'word-combinations-phrases.csv')
    } else if (view === 'tree') {
      if (!tree) return
      const rows = [
        ['Side', 'Branch', 'Count'],
        ...flattenWordTree(tree).map(({ side, branch }) => [side === 'before' ? 'Before' : 'After', branch.phrase, String(branch.count)])
      ]
      window.api.exportCsv(toCsv(rows), `word-tree-${focus}.csv`)
    } else if (associations) {
      const rows = [
        ['Word', `Sentences with "${focus}"`, `% of "${focus}" sentences`, 'G2'],
        ...associations.rows.map((r) => [r.word, String(r.together), (r.share * 100).toFixed(1), r.g2.toFixed(2)])
      ]
      window.api.exportCsv(toCsv(rows), `word-combinations-${focus}.csv`)
    }
  }, [view, phrases, associations, tree, focus])

  const handleExportSvg = useCallback(() => {
    if (!treeRef.current) return
    window.api.exportSvg(treeRef.current.outerHTML, `word-tree-${focus}.svg`)
  }, [focus])

  const handleRename = useCallback((newName: string) => {
    setAnalysisName(newName)
    renameSavedAnalysis(analysisGuid, newName)
    if (inTab) inTab.onSaved('', newName)
  }, [analysisGuid, inTab])

  const handleSave = useCallback((name: string) => {
    setAnalysisName(name)
    setShowSaveDialog(false)
    window.api.sendAnalysisAction('save-analysis', {
      guid: analysisGuid,
      toolType: 'word-combinations',
      name,
      config: currentConfig
    })
    setBaseline(currentConfig)
    if (inTab) inTab.onSaved(analysisGuid, name)
    else setTimeout(() => window.close(), 200)
  }, [analysisGuid, currentConfig, inTab, setBaseline])

  useRegisterToolSave(inTab?.tabId, () => {
    if (isExisting) {
      handleSave(analysisName)
      return true
    }
    setShowSaveDialog(true)
    return false
  })

  const emptyMessage = coded && codeSets.size === 0
    ? 'Drag codes into Coded with to look at the words in their passages'
    : view === 'phrases'
      ? 'No phrases repeat often enough. Try a lower minimum count.'
      : 'No words to show'

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '14px 20px 6px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)' }}>
          <Icon icon={faWholeWord} className="analysis-header-icon" style={{ fontSize: 16 }} />
          Word Combinations{isExisting ? ':' : ''}
          {isExisting && <EditableTitleSuffix name={analysisName} onRename={handleRename} />}
        </h2>
        <div style={{ flex: 1 }} />
        <button className="secondary" style={{ fontSize: 11, padding: '4px 14px' }} onClick={() => inTab ? inTab.onClose() : window.close()}>
          Close
        </button>
        {isExisting && dirty && (
          <button className="secondary" style={{ fontSize: 11, padding: '4px 14px' }} onClick={handleDiscard}>
            Discard Changes
          </button>
        )}
        {isExisting ? (
          <button
            style={{ fontSize: 11, padding: '4px 14px' }}
            disabled={!dirty}
            onClick={() => { handleSave(analysisName) }}
          >
            {dirty ? 'Update Analysis' : 'Saved'}
          </button>
        ) : (
          <button style={{ fontSize: 11, padding: '4px 14px' }} onClick={() => setShowSaveDialog(true)}>
            Save Analysis
          </button>
        )}
        {/* Clearance for the floating MemoFab. */}
        <div style={{ width: 36, flexShrink: 0 }} />
      </div>

      {showSaveDialog && (
        <div className="modal-overlay" onClick={() => setShowSaveDialog(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Save Analysis</h2>
            <input
              autoFocus
              type="text"
              defaultValue={analysisName}
              placeholder="Analysis name"
              style={{ width: '100%' }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave((e.target as HTMLInputElement).value.trim() || 'Untitled')
                if (e.key === 'Escape') setShowSaveDialog(false)
              }}
            />
            <div className="modal-actions">
              <button className="secondary" onClick={() => setShowSaveDialog(false)}>Cancel</button>
              <button onClick={(e) => {
                const input = (e.target as HTMLElement).parentElement!.parentElement!.querySelector('input') as HTMLInputElement
                handleSave(input.value.trim() || 'Untitled')
              }}>Save</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: '14px 20px' }}>
        <DocumentsSection data={data} filter={docFilter} onChange={setDocFilter} filteredSourceGuids={filteredSourceGuids} />

        <CountWordsIn
          value={textSource}
          onChange={setTextSource}
          codedTitle="Look only at the passages coded with the chosen codes."
        />
        {coded && (
          <CodesSection
            codes={data.codes}
            codeSets={codeSets}
            onChangeCodes={setCodeGuids}
            includeSubcodes={includeSubcodes}
            onChangeIncludeSubcodes={setIncludeSubcodes}
            boxCount={boxCount}
          />
        )}

        {/* Include/Exclude words. Hidden for the word tree, which shows
            every word so its branches read as sentences. */}
        {view !== 'tree' && <div style={{ display: 'flex', gap: 14, marginBottom: 14 }}>
          <div className="analysis-section" style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--text-secondary)' }}>Only these words</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>Leave empty to include all words. Otherwise, phrases must contain, and associations must be, one of these words</div>
            <textarea
              value={includeWords}
              onChange={(e) => setIncludeWords(e.target.value)}
              placeholder="word1, word2, ..."
              style={{ width: '100%', height: 60, resize: 'vertical' }}
            />
          </div>
          <div className="analysis-section" style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--text-secondary)' }}>Leave out these words</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>Phrases can't start or end with these words, and they aren't shown as associations. Common English stop words are left out by default</div>
            <textarea
              value={excludeWords}
              onChange={(e) => setExcludeWords(e.target.value)}
              style={{ width: '100%', height: 60, resize: 'vertical' }}
            />
          </div>
        </div>}

        {/* Results */}
        <div className="analysis-section">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 10, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--text-secondary)' }}>Results</span>
              <SegmentedControl
                label="View"
                value={view}
                onChange={setView}
                options={[
                  { value: 'phrases', label: 'Phrases', title: 'Show sequences of words that repeat.' },
                  { value: 'associations', label: 'Associations', title: 'Show the words that appear in the same sentences as a chosen word.' },
                  { value: 'tree', label: 'Word Tree', title: 'Show the words that come before and after a chosen word.' }
                ]}
              />
              {view === 'phrases' ? (
                <>
                  <SegmentedControl
                    label="Phrase length"
                    value={String(phraseLength) as '2' | '3'}
                    onChange={(v) => setPhraseLength(v === '3' ? 3 : 2)}
                    options={[
                      { value: '2', label: '2 Words' },
                      { value: '3', label: '3 Words' }
                    ]}
                  />
                  <label style={{ fontSize: 10, color: 'var(--text-muted)' }}>Minimum count:
                    <input type="number" min={1} max={1000} value={minCount} onChange={(e) => setMinCount(Number(e.target.value))}
                      style={{ width: 50, marginLeft: 4 }}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label style={{ fontSize: 10, color: 'var(--text-muted)' }}>Word:
                    <input type="text" value={focusWord} onChange={(e) => setFocusWord(e.target.value)}
                      placeholder={focus && !focusWord.trim() ? focus : 'word'}
                      style={{ width: 120, marginLeft: 4 }}
                    />
                  </label>
                  {view === 'associations' && (
                    <label style={{ fontSize: 10, color: 'var(--text-muted)' }} title="How many sentences a word must share with the chosen word to be shown.">Minimum together:
                      <input type="number" min={1} max={100} value={minTogether} onChange={(e) => setMinTogether(Number(e.target.value))}
                        style={{ width: 50, marginLeft: 4 }}
                      />
                    </label>
                  )}
                </>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="secondary" style={{ fontSize: 10, padding: '3px 8px' }} onClick={handleExportCsv}>Export CSV</button>
              {view === 'tree' && treeLayout && (
                <button className="secondary" style={{ fontSize: 10, padding: '3px 8px' }} onClick={handleExportSvg}>Export SVG</button>
              )}
            </div>
          </div>

          {view === 'phrases' ? (
            phrases.length === 0 ? (
              <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>{emptyMessage}</div>
            ) : (
              <>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                  {phrases.length} phrase{phrases.length === 1 ? '' : 's'}{phrases.length > PHRASE_ROWS ? ` (showing the top ${PHRASE_ROWS})` : ''}. Click a phrase to search for it.
                </div>
                <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                  <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%', maxWidth: 520 }}>
                    <thead>
                      <tr>
                        <th style={thStyle}>Phrase</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {phrases.slice(0, PHRASE_ROWS).map(({ phrase, count }) => (
                        <tr key={phrase} onClick={() => searchFor(phrase, filteredSourceGuids)} style={{ cursor: 'pointer' }} title={`Search for "${phrase}"`}>
                          <td style={tdStyle}>{phrase}</td>
                          <td style={{ ...tdStyle, textAlign: 'right' }}>{count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )
          ) : view === 'tree' ? (
            !tree || !treeLayout ? (
              <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
                {tree ? `“${focus}” doesn’t appear in the ${coded ? 'coded passages' : 'selected documents'}.` : emptyMessage}
              </div>
            ) : (
              <>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                  {`“${focus}” appears ${tree.count} time${tree.count === 1 ? '' : 's'}. Click a branch to search for it.`}
                </div>
                <div style={{ maxHeight: 560, overflow: 'auto' }}>
                  <WordTreeChart layout={treeLayout} svgRef={treeRef} onSearch={(phrase) => searchFor(phrase, filteredSourceGuids)} />
                </div>
              </>
            )
          ) : !associations || associations.rows.length === 0 ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
              {associations && associations.focusSentences === 0
                ? `“${focus}” doesn’t appear in the ${coded ? 'coded passages' : 'selected documents'}.`
                : associations
                  ? `No word shares enough sentences with “${focus}”. Try a lower minimum.`
                  : emptyMessage}
            </div>
          ) : (
            <>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                {`“${focus}” appears in ${associations.focusSentences} of ${associations.sentences} sentences. Click a word to find the sentences with both words.`}
              </div>
              <div style={{ maxHeight: 420, overflowY: 'auto', maxWidth: 520 }}>
                <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%' }}>
                  <thead>
                    <tr>
                      <th style={thStyle}>Word</th>
                      <th style={{ ...thStyle, textAlign: 'right' }} title={`Sentences containing both this word and “${focus}”`}>Together</th>
                      <th style={{ ...thStyle, textAlign: 'right' }} title={`Share of the sentences with “${focus}” that also contain this word`}>% of Sentences</th>
                      <th style={{ ...thStyle, textAlign: 'right' }} title="Log-likelihood: how unlikely it is that the words share this many sentences by chance">G²</th>
                    </tr>
                  </thead>
                  <tbody>
                    {associations.rows.slice(0, ASSOCIATION_ROWS).map((r) => (
                      <tr key={r.word} onClick={() => searchSentences(r.word)} style={{ cursor: 'pointer' }} title={`Find the sentences with “${focus}” and “${r.word}”`}>
                        <td style={tdStyle}>{r.word}</td>
                        <td style={{ ...tdStyle, textAlign: 'right' }}>{r.together}</td>
                        <td style={{ ...tdStyle, textAlign: 'right' }}>{(r.share * 100).toFixed(1)}%</td>
                        <td style={{ ...tdStyle, textAlign: 'right', color: r.g2 < 3.84 ? 'var(--text-muted)' : undefined }}>{r.g2.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
                  G² above 3.84 means the words share sentences more often than chance at p &lt; 0.05; above 10.83, at p &lt; 0.001. Greyed values are below 3.84.
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
