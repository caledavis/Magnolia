/**
 * Word Combinations — which words go together. Three views over the same
 * text (the selected documents, the passages coded with chosen codes, or
 * the results of chosen saved queries):
 *   - Phrases: sequences of two to five words that repeat, as a list or
 *     as a network of the words that follow each other in them (see
 *     phrase-network.ts);
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
  queryPassageTexts,
  countPhrases,
  wordAssociations,
  wordFilter,
  type SourceText,
  type WordQueryCodes
} from './word-counts'
import {
  type TextSource,
  type QueryRun,
  useCodeSets,
  allCodes,
  useQueryRuns,
  allResults,
  CountWordsIn,
  CodesSection,
  QueriesSection
} from './word-sources'
import { generateGuid } from '../../utils/guid'
import { useLiveAnalysisData } from './use-live-analysis-data'
import { EditableTitleSuffix } from '../EditableTitleSuffix'
import { renameSavedAnalysis } from '../../utils/rename-saved-analysis'
import { useToolDirtyState } from '../../hooks/use-tool-dirty-state'
import { useRegisterToolSave } from '../../hooks/use-register-tool-save'
import { SegmentedControl } from './SegmentedControl'
import { buildWordTree, connectedNodes, flattenWordTree, layoutWordTree, type TreeLayout } from './word-tree'
import { useThemeSvgColors, SVG_FONT_FAMILY } from '../../utils/use-theme-svg-colors'
import { buildPhraseNetwork, layoutPhraseNetwork, linkTitle, neighbours, LABEL_GAP, type NetworkLayout } from './phrase-network'

export type CombinationsView = 'phrases' | 'associations' | 'tree'
/** How Phrases are shown. */
export type PhraseDisplay = 'list' | 'network'

export interface WordCombinationsConfig {
  docFilter: DocumentFilterState
  textSource: TextSource
  codeGuids: string[]
  includeSubcodes: boolean
  /** Saved queries whose results are read when textSource is 'query'. */
  queryGuids: string[]
  includeWords: string
  excludeWords: string
  view: CombinationsView
  phraseLength: PhraseLength
  phraseDisplay: PhraseDisplay
  minCount: number
  /** Empty uses the most frequent word. */
  focusWord: string
  minTogether: number
}

/** How many words a phrase has. */
export type PhraseLength = 2 | 3 | 4 | 5
const PHRASE_LENGTHS: PhraseLength[] = [2, 3, 4, 5]

/** A saved phrase length, or 2 if it isn't one the tool offers. */
export function phraseLengthOf(n: unknown): PhraseLength {
  return PHRASE_LENGTHS.includes(n as PhraseLength) ? (n as PhraseLength) : 2
}

export function defaultCombinationsConfig(): WordCombinationsConfig {
  return {
    docFilter: emptyDocumentFilter(),
    textSource: 'documents',
    codeGuids: [],
    includeSubcodes: true,
    queryGuids: [],
    includeWords: '',
    excludeWords: Array.from(STOP_WORDS).join(', '),
    view: 'phrases',
    phraseLength: 2,
    phraseDisplay: 'list',
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
  codeSets: Map<string, Set<string>>,
  queryRuns: Map<string, QueryRun>
): { passages: SourceText[]; boxCount: number } {
  if (textSource === 'coded') return codedPassageTexts(data, sourceGuids, allCodes(codeSets))
  if (textSource === 'query') return queryPassageTexts(data, allResults(queryRuns))
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

/** The phrase network. Hovering a word lights up the words it's joined
 *  to; clicking a line searches for its phrase, and clicking a word
 *  opens it in the Word Tree. */
function PhraseNetworkChart({ layout, svgRef, onSearch, onWord }: {
  layout: NetworkLayout
  svgRef: React.Ref<SVGSVGElement>
  onSearch: (phrase: string) => void
  onWord: (word: string) => void
}) {
  const colors = useThemeSvgColors()
  const [hovered, setHovered] = useState<{ node: number } | { link: number } | null>(null)
  const lit = useMemo(() => {
    if (!hovered) return null
    if ('node' in hovered) return neighbours(layout, hovered.node)
    const l = layout.links[hovered.link]
    return new Set([l.source, l.target])
  }, [layout, hovered])
  const linkLit = (i: number) => {
    if (!hovered) return false
    if ('link' in hovered) return hovered.link === i
    const l = layout.links[i]
    return l.source === hovered.node || l.target === hovered.node
  }
  return (
    <svg ref={svgRef} viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width} height={layout.height} fontFamily={SVG_FONT_FAMILY} style={{ display: 'block' }}>
      {layout.links.map((l, i) => {
        const s = layout.nodes[l.source], t = layout.nodes[l.target]
        const on = linkLit(i)
        return (
          <g key={i} style={{ cursor: 'pointer' }}
            onMouseEnter={() => setHovered({ link: i })}
            onMouseLeave={() => setHovered(null)}
            onClick={() => onSearch(l.phrases[0].phrase)}
          >
            <title>{`${linkTitle(l)}\nClick to search for “${l.phrases[0].phrase}”`}</title>
            <line x1={s.x} y1={s.y} x2={t.x} y2={t.y} stroke={on ? colors.accent : colors.borderColor} strokeWidth={l.strokeWidth} strokeLinecap="round" opacity={hovered && !on ? 0.4 : 1} />
            {/* A wider invisible line, so thin lines are easy to hover. */}
            <line x1={s.x} y1={s.y} x2={t.x} y2={t.y} stroke="transparent" strokeWidth={Math.max(8, l.strokeWidth)} />
          </g>
        )
      })}
      {layout.nodes.map((n, i) => {
        const on = lit?.has(i)
        return (
          <g key={n.word} style={{ cursor: 'pointer' }}
            opacity={lit && !on ? 0.35 : 1}
            onMouseEnter={() => setHovered({ node: i })}
            onMouseLeave={() => setHovered(null)}
            onClick={() => onWord(n.word)}
          >
            <title>{`“${n.word}”: in phrases ${n.count} time${n.count === 1 ? '' : 's'}. Click to see it in the Word Tree`}</title>
            <circle cx={n.x} cy={n.y} r={n.r} fill={colors.accent} />
            {/* Outlined in the background colour, so lines pass behind the words. */}
            <text x={n.x} y={n.y + n.r + LABEL_GAP} textAnchor="middle" dominantBaseline="hanging" fontSize={n.fontSize} fill={on ? colors.accent : colors.textPrimary}
              stroke={colors.bgPanel} strokeWidth={3} strokeLinejoin="round" paintOrder="stroke">{n.word}</text>
          </g>
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
  const [queryGuids, setQueryGuids] = useState<string[]>(initial.queryGuids)
  const [includeWords, setIncludeWords] = useState(initial.includeWords)
  const [excludeWords, setExcludeWords] = useState(initial.excludeWords)
  const [view, setView] = useState<CombinationsView>(initial.view)
  const [phraseLength, setPhraseLength] = useState<PhraseLength>(phraseLengthOf(initial.phraseLength))
  const [phraseDisplay, setPhraseDisplay] = useState<PhraseDisplay>(initial.phraseDisplay === 'network' ? 'network' : 'list')
  const [minCount, setMinCount] = useState(initial.minCount)
  const [focusWord, setFocusWord] = useState(initial.focusWord)
  const [minTogether, setMinTogether] = useState(initial.minTogether)
  const live = useLiveAnalysisData()
  // Saved queries choose their own documents and survey cells, so the
  // Document Selector's scope doesn't apply to them.
  const byQuery = textSource === 'query'
  const data = useMemo(() => {
    return applySurveyCellScope({ ...propData, ...live }, byQuery ? {} : docFilter)
  }, [propData, live, docFilter, byQuery])
  const [analysisGuid] = useState(savedConfig?.guid ?? generateGuid())
  const [analysisName, setAnalysisName] = useState(savedConfig?.name ?? '')
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const isExisting = !!savedConfig?.guid
  const coded = textSource === 'coded'

  // Dirty tracking (see useToolDirtyState).
  const currentConfig: WordCombinationsConfig = useMemo(
    () => ({ docFilter, textSource, codeGuids, includeSubcodes, queryGuids, includeWords, excludeWords, view, phraseLength, phraseDisplay, minCount, focusWord, minTogether }),
    [docFilter, textSource, codeGuids, includeSubcodes, queryGuids, includeWords, excludeWords, view, phraseLength, phraseDisplay, minCount, focusWord, minTogether]
  )
  const { dirty, baseline, setBaseline } = useToolDirtyState(currentConfig, initial, inTab)

  const handleDiscard = useCallback(() => {
    setDocFilter(baseline.docFilter)
    setTextSource(baseline.textSource)
    setCodeGuids(baseline.codeGuids)
    setIncludeSubcodes(baseline.includeSubcodes)
    setQueryGuids(baseline.queryGuids)
    setIncludeWords(baseline.includeWords)
    setExcludeWords(baseline.excludeWords)
    setView(baseline.view)
    setPhraseLength(baseline.phraseLength)
    setPhraseDisplay(baseline.phraseDisplay)
    setMinCount(baseline.minCount)
    setFocusWord(baseline.focusWord)
    setMinTogether(baseline.minTogether)
  }, [baseline])

  const filteredSourceGuids = useMemo(
    () => resolveFilteredSources(data, docFilter.sourceGuids, docFilter.tagGuids, docFilter.tagExcludeGuids, docFilter.typeInclude, docFilter.typeExclude),
    [data, docFilter]
  )
  const codeSets = useCodeSets(data.codes, codeGuids, includeSubcodes)
  const queryRuns = useQueryRuns(data, queryGuids, byQuery)
  const filter = useMemo(() => wordFilter(includeWords, excludeWords), [includeWords, excludeWords])

  const { passages, boxCount } = useMemo(
    () => combinationsPassages(data, filteredSourceGuids, textSource, codeSets, queryRuns),
    [data, filteredSourceGuids, textSource, codeSets, queryRuns]
  )
  const texts = useMemo(() => passages.map((p) => p.text), [passages])

  const phrases = useMemo(
    () => (view === 'phrases' ? countPhrases(texts, phraseLength, filter, Math.max(1, minCount)) : []),
    [view, texts, phraseLength, filter, minCount]
  )

  const networkShown = view === 'phrases' && phraseDisplay === 'network'
  const network = useMemo(
    () => (networkShown ? buildPhraseNetwork(phrases, filter.exclude) : null),
    [networkShown, phrases, filter]
  )
  const networkLayout = useMemo(() => (network && network.links.length > 0 ? layoutPhraseNetwork(network) : null), [network])
  const networkRef = useRef<SVGSVGElement>(null)

  // A word clicked in the network opens in the Word Tree.
  const showInTree = useCallback((word: string) => {
    setFocusWord(word)
    setView('tree')
  }, [])

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
  // counting coded passages) codes as the analysis, or inside the chosen
  // queries' results, which carry their own documents.
  const surveyScope = useCallback((): SurveyCellScopeArgs | undefined => (
    !byQuery && (docFilter.questionScope?.length || docFilter.respondentScope?.length)
      ? { questionScope: docFilter.questionScope, respondentScope: docFilter.respondentScope }
      : undefined
  ), [docFilter, byQuery])
  const queryCodes = useCallback((): WordQueryCodes | undefined => (
    coded ? { codeGuids: [...codeSets.keys()], includeSubcodes } : undefined
  ), [coded, codeSets, includeSubcodes])
  const searchSources = byQuery ? [] : filteredSourceGuids
  const withinGuids = byQuery ? [...queryRuns.keys()] : undefined

  const searchFor = useCallback((text: string) => {
    window.api.sendAnalysisAction('run-word-query', text, searchSources, surveyScope(), queryCodes(), withinGuids)
  }, [searchSources, surveyScope, queryCodes, withinGuids])

  // The sentences where the focus word and an associated word appear together.
  const searchSentences = useCallback((word: string) => {
    window.api.sendAnalysisAction('run-sentence-query', focus, word, searchSources, surveyScope(), queryCodes(), withinGuids)
  }, [focus, searchSources, surveyScope, queryCodes, withinGuids])

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
    if (networkShown) {
      if (networkRef.current) window.api.exportSvg(networkRef.current.outerHTML, `phrase-network-${phraseLength}-words.svg`)
      return
    }
    if (!treeRef.current) return
    window.api.exportSvg(treeRef.current.outerHTML, `word-tree-${focus}.svg`)
  }, [focus, networkShown, phraseLength])

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

  const readingWhat = coded ? 'coded passages' : byQuery ? 'query results' : 'selected documents'
  const emptyMessage = coded && codeSets.size === 0
    ? 'Drag codes into Coded with to look at the words in their passages'
    : byQuery && queryRuns.size === 0
      ? 'Drag saved queries into the From these queries box to look at the words in their results'
      : view === 'phrases'
      ? 'No phrases repeat often enough. Try a lower number in Appears at least.'
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
        <div className="modal-overlay">
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
        <CountWordsIn
          value={textSource}
          onChange={setTextSource}
          codedTitle="Look only at the passages coded with the chosen codes."
          queryTitle="Look only at the results of the chosen saved queries. Each query searches the documents chosen in it."
        />
        {byQuery ? (
          <QueriesSection runs={queryRuns} onChangeQueries={setQueryGuids} boxCount={boxCount} />
        ) : (
          <DocumentsSection data={data} filter={docFilter} onChange={setDocFilter} filteredSourceGuids={filteredSourceGuids} />
        )}
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
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--text-muted)' }}>
                    Phrase length:
                    <SegmentedControl
                      label="Phrase length"
                      value={String(phraseLength)}
                      onChange={(v) => setPhraseLength(phraseLengthOf(Number(v)))}
                      options={PHRASE_LENGTHS.map((n) => ({ value: String(n), label: String(n), title: `Look for phrases of ${n} words.` }))}
                    />
                    words
                  </span>
                  <SegmentedControl
                    label="Show phrases as"
                    value={phraseDisplay}
                    onChange={setPhraseDisplay}
                    options={[
                      { value: 'list', label: 'List', title: 'Show the phrases as a list, commonest first.' },
                      { value: 'network', label: 'Network', title: 'Show the words that follow each other in the phrases, joined by lines.' }
                    ]}
                  />
                  <label style={{ fontSize: 10, color: 'var(--text-muted)' }} title="Show only the phrases that appear at least this many times.">Appears at least:
                    <input type="number" min={1} max={1000} value={minCount} onChange={(e) => setMinCount(Number(e.target.value))}
                      style={{ width: 50, margin: '0 4px' }}
                    />
                    times
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
              {((view === 'tree' && treeLayout) || (networkShown && networkLayout)) && (
                <button className="secondary" style={{ fontSize: 10, padding: '3px 8px' }} onClick={handleExportSvg}>Export SVG</button>
              )}
            </div>
          </div>

          {networkShown ? (
            !networkLayout || !network ? (
              <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
                {phrases.length === 0 ? emptyMessage : 'Every phrase is made of left-out words, so there is nothing to join.'}
              </div>
            ) : (
              <>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                  {`${network.phraseCount === phrases.length ? `${phrases.length} phrase${phrases.length === 1 ? '' : 's'}` : `The ${network.phraseCount} commonest of ${phrases.length} phrases`}`}
                </div>
                <div style={{ maxHeight: 620, overflow: 'auto' }}>
                  <PhraseNetworkChart layout={networkLayout} svgRef={networkRef} onSearch={searchFor} onWord={showInTree} />
                </div>
              </>
            )
          ) : view === 'phrases' ? (
            phrases.length === 0 ? (
              <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>{emptyMessage}</div>
            ) : (
              <>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                  {phrases.length} phrase{phrases.length === 1 ? '' : 's'}{phrases.length > PHRASE_ROWS ? ` (showing the top ${PHRASE_ROWS})` : ''}
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
                        <tr key={phrase} onClick={() => searchFor(phrase)} style={{ cursor: 'pointer' }} title={`Search for "${phrase}"`}>
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
                {tree ? `“${focus}” doesn’t appear in the ${readingWhat}.` : emptyMessage}
              </div>
            ) : (
              <>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                  {`“${focus}” appears ${tree.count} time${tree.count === 1 ? '' : 's'}`}
                </div>
                <div style={{ maxHeight: 560, overflow: 'auto' }}>
                  <WordTreeChart layout={treeLayout} svgRef={treeRef} onSearch={(phrase) => searchFor(phrase)} />
                </div>
              </>
            )
          ) : !associations || associations.rows.length === 0 ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
              {associations && associations.focusSentences === 0
                ? `“${focus}” doesn’t appear in the ${readingWhat}.`
                : associations
                  ? `No word shares enough sentences with “${focus}”. Try a lower minimum.`
                  : emptyMessage}
            </div>
          ) : (
            <>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                {`“${focus}” appears in ${associations.focusSentences} of ${associations.sentences} sentences`}
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
