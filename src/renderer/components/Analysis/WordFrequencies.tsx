import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import type { AnalysisInitData, SurveyCellScopeArgs, SurveyEntityRef } from '../../models/types'
import { Icon, faFont } from '../Icon'
import { toolColors } from '../../utils/tool-colors'
import {
  emptyDocumentFilter,
  type DocumentFilterState
} from '../DocumentSelector/DocumentSelector'
import { DocumentsSection } from './DocumentsSection'
import { documentFilterFromConfig } from './documents-filter'
import { toCsv, resolveFilteredSources, STOP_WORDS, applySurveyCellScope } from './analysis-helpers'
import { countWords, sourceTexts, codedPassageTexts, wordFilter, type WordQueryCodes } from './word-counts'
import { type TextSource, useCodeSets, allCodes, CountWordsIn, CodesSection } from './word-sources'
import { generateGuid } from '../../utils/guid'
import {
  type GroupByEntry,
  parseGroupByDrop,
  isGroupByDrag,
  mergeGroupBy,
  groupByKey,
  migrateLegacyGroupBy,
  GroupByChips,
  useAutoGroupBy
} from './group-by'
import {
  buildSurveyAwareColumns,
  type AnalysisColumn,
  type QuestionScopeRef
} from './survey-grouping'
import { useLiveAnalysisData } from './use-live-analysis-data'
import { EditableTitleSuffix } from '../EditableTitleSuffix'
import { renameSavedAnalysis } from '../../utils/rename-saved-analysis'
import { useThemeSvgColors, SVG_FONT_FAMILY } from '../../utils/use-theme-svg-colors'
import { useToolDirtyState } from '../../hooks/use-tool-dirty-state'
import { useRegisterToolSave } from '../../hooks/use-register-tool-save'
import { SegmentedControl } from './SegmentedControl'

interface Props {
  data: AnalysisInitData
  savedConfig?: {
    docFilter: DocumentFilterState
    includeWords: string
    excludeWords: string
    wordCount: number
    groupByTags?: string[]
    groupBy?: GroupByEntry[]
    /** Up to 1.9; now in docFilter (see documentFilterFromConfig). */
    questionScope?: QuestionScopeRef[]
    textSource?: TextSource
    codeGuids?: string[]
    includeSubcodes?: boolean
    guid: string
    name: string
  }
  inTab?: {
    onClose: () => void
    onSaved: (savedGuid: string, name: string) => void
    onDirtyChange?: (dirty: boolean) => void
    tabId?: string
  }
}

type VizMode = 'bar' | 'cloud'

/** A chart series: a group-by column, or one code's passages. */
type Series = AnalysisColumn & { codeGuid?: string; color?: string }

/** Parse a CSS colour (#RGB / #RRGGBB / rgb(...)) into HSL. Returns
 *  null if the input doesn't match a supported syntax. */
function parseColorToHsl(input: string): { h: number; s: number; l: number } | null {
  const raw = input.trim()
  let r = 0, g = 0, b = 0
  if (raw.startsWith('#')) {
    const hex = raw.slice(1)
    if (hex.length === 3) {
      r = parseInt(hex[0] + hex[0], 16)
      g = parseInt(hex[1] + hex[1], 16)
      b = parseInt(hex[2] + hex[2], 16)
    } else if (hex.length === 6 || hex.length === 8) {
      r = parseInt(hex.slice(0, 2), 16)
      g = parseInt(hex.slice(2, 4), 16)
      b = parseInt(hex.slice(4, 6), 16)
    } else {
      return null
    }
  } else if (raw.startsWith('rgb')) {
    const m = raw.match(/(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)/)
    if (!m) return null
    r = +m[1]; g = +m[2]; b = +m[3]
  } else {
    return null
  }
  const rN = r / 255, gN = g / 255, bN = b / 255
  const max = Math.max(rN, gN, bN), min = Math.min(rN, gN, bN)
  const l = (max + min) / 2
  let h = 0, s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case rN: h = (gN - bN) / d + (gN < bN ? 6 : 0); break
      case gN: h = (bN - rN) / d + 2; break
      case bN: h = (rN - gN) / d + 4; break
    }
    h *= 60
  }
  return { h, s: s * 100, l: l * 100 }
}

/** Convert an HSL triple (h: 0-360, s/l: 0-100) to an `rgb(r, g, b)`
 *  string. Used at colour-generation time so SVG fill attributes
 *  saved via outerHTML (the chart export path) are valid SVG 1.1 —
 *  Affinity / Inkscape don't accept `hsl()` in attributes. */
function hslToRgb(h: number, s: number, l: number): string {
  const sN = s / 100
  const lN = l / 100
  const c = (1 - Math.abs(2 * lN - 1)) * sN
  const hp = h / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r1 = 0, g1 = 0, b1 = 0
  if (hp < 1)      { r1 = c; g1 = x }
  else if (hp < 2) { r1 = x; g1 = c }
  else if (hp < 3) { g1 = c; b1 = x }
  else if (hp < 4) { g1 = x; b1 = c }
  else if (hp < 5) { r1 = x; b1 = c }
  else             { r1 = c; b1 = x }
  const m = lN - c / 2
  const r = Math.round((r1 + m) * 255)
  const g = Math.round((g1 + m) * 255)
  const b = Math.round((b1 + m) * 255)
  return `rgb(${r}, ${g}, ${b})`
}

/** Read the active theme's --accent colour and re-render whenever the
 *  `data-theme` attribute on <html> changes. Returns the parsed HSL or
 *  a sensible fallback (macOS blue). */
function useThemeAccentHsl(): { h: number; s: number; l: number } {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const el = document.documentElement
    const obs = new MutationObserver(() => setTick((t) => t + 1))
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])
  return useMemo(() => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    return parseColorToHsl(raw) ?? { h: 211, s: 100, l: 50 }
  }, [tick])
}

export function WordFrequencies({ data: propData, savedConfig, inTab }: Props) {
  const [docFilter, setDocFilter] = useState<DocumentFilterState>(documentFilterFromConfig(savedConfig))
  const [groupBy, setGroupBy] = useState<GroupByEntry[]>(
    () => savedConfig?.groupBy ?? migrateLegacyGroupBy(savedConfig?.groupByTags)
  )
  const live = useLiveAnalysisData()
  const data = useMemo(() => {
    return applySurveyCellScope({ ...propData, ...live }, docFilter)
  }, [propData, live, docFilter])
  const [tagDropOver, setTagDropOver] = useState(false)
  const [textSource, setTextSource] = useState<TextSource>(savedConfig?.textSource ?? 'documents')
  const [codeGuids, setCodeGuids] = useState<string[]>(savedConfig?.codeGuids ?? [])
  const [includeSubcodes, setIncludeSubcodes] = useState(savedConfig?.includeSubcodes ?? true)
  const coded = textSource === 'coded'
  const [includeWords, setIncludeWords] = useState(savedConfig?.includeWords ?? '')
  const [excludeWords, setExcludeWords] = useState(savedConfig?.excludeWords ?? Array.from(STOP_WORDS).join(', '))
  const [vizMode, setVizMode] = useState<VizMode>('bar')
  const [wordCount, setWordCount] = useState(savedConfig?.wordCount ?? 30)
  const chartRef = useRef<SVGSVGElement>(null)
  const themeColors = useThemeSvgColors()
  const [analysisGuid] = useState(savedConfig?.guid ?? generateGuid())
  const [analysisName, setAnalysisName] = useState(savedConfig?.name ?? '')
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const isExisting = !!savedConfig?.guid

  // Dirty tracking (see useToolDirtyState).
  const currentConfig = useMemo(
    () => ({ docFilter, includeWords, excludeWords, wordCount, groupBy, textSource, codeGuids, includeSubcodes }),
    [docFilter, includeWords, excludeWords, wordCount, groupBy, textSource, codeGuids, includeSubcodes]
  )
  const initialBaseline = useMemo(() => ({
    docFilter: documentFilterFromConfig(savedConfig),
    includeWords: savedConfig?.includeWords ?? '',
    excludeWords: savedConfig?.excludeWords ?? Array.from(STOP_WORDS).join(', '),
    wordCount: savedConfig?.wordCount ?? 30,
    groupBy: savedConfig?.groupBy ?? migrateLegacyGroupBy(savedConfig?.groupByTags),
    textSource: savedConfig?.textSource ?? 'documents',
    codeGuids: savedConfig?.codeGuids ?? [],
    includeSubcodes: savedConfig?.includeSubcodes ?? true
  }), [])
  const { dirty, baseline, setBaseline } = useToolDirtyState(currentConfig, initialBaseline, inTab)

  const handleDiscard = useCallback(() => {
    setDocFilter(baseline.docFilter)
    setIncludeWords(baseline.includeWords)
    setExcludeWords(baseline.excludeWords)
    setWordCount(baseline.wordCount)
    setGroupBy(baseline.groupBy)
    setTextSource(baseline.textSource)
    setCodeGuids(baseline.codeGuids)
    setIncludeSubcodes(baseline.includeSubcodes)
  }, [baseline])

  const filteredSourceGuids = useMemo(
    () => resolveFilteredSources(data, docFilter.sourceGuids, docFilter.tagGuids, docFilter.tagExcludeGuids, docFilter.typeInclude, docFilter.typeExclude),
    [data, docFilter]
  )

  // Survey-cell scope carried into a generated word query: the survey
  // questions and respondents chosen in From these documents plus, for a
  // respondent / tagged series, that series'
  // narrowing.
  const surveyScope = useCallback((series?: { respondentRef?: SurveyEntityRef; tagScopeGuids?: string[] }): SurveyCellScopeArgs | undefined => {
    const s: SurveyCellScopeArgs = {}
    if (docFilter.questionScope?.length) s.questionScope = docFilter.questionScope
    if (docFilter.respondentScope?.length) s.respondentScope = docFilter.respondentScope
    if (series?.respondentRef) s.respondentScope = [series.respondentRef]
    if (series?.tagScopeGuids?.length) s.tagGuids = series.tagScopeGuids
    return s.questionScope || s.respondentScope || s.tagGuids ? s : undefined
  }, [docFilter.questionScope, docFilter.respondentScope])

  // Auto-add a Group-by chip for each survey and notebook in scope.
  const dismissAutoGroup = useAutoGroupBy(filteredSourceGuids, data, savedConfig, setGroupBy)

  const handleTagDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setTagDropOver(false)
    const fresh = parseGroupByDrop(e)
    if (fresh.length > 0) setGroupBy((p) => mergeGroupBy(p, fresh))
  }, [])

  const handleRemoveGroupBy = useCallback((entry: GroupByEntry) => {
    dismissAutoGroup(entry)
    const key = groupByKey(entry)
    setGroupBy((p) => p.filter((e) => groupByKey(e) !== key))
  }, [])

  const filter = useMemo(() => wordFilter(includeWords, excludeWords), [includeWords, excludeWords])

  // 8 distinct hues evenly spread around the active theme's accent
  // colour. Lightness is clamped to a readable mid-range so series stay
  // legible across light and dark themes; saturation tracks the
  // accent's own to keep the palette consistent with the theme's feel.
  //
  // Colours are emitted as `rgb(...)` (not `hsl(...)`): SVG fill
  // attributes saved via outerHTML need to open in vector editors
  // like Affinity Designer / Inkscape, whose SVG 1.1 parsers don't
  // accept `hsl()` and silently treat such fills as invalid (=
  // unfilled bars in the export).
  const accentHsl = useThemeAccentHsl()
  const SERIES_COLORS = useMemo(() => {
    const sat = Math.max(45, Math.min(85, accentHsl.s))
    const light = Math.max(40, Math.min(60, accentHsl.l))
    return Array.from({ length: 8 }, (_, i) => {
      const hue = (accentHsl.h + i * 45) % 360
      return hslToRgb(hue, sat, light)
    })
  }, [accentHsl])

  const sourceMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of data.sources) m.set(s.guid, s.name)
    return m
  }, [data.sources])

  const codeMap = useMemo(() => new Map(data.codes.map((c) => [c.guid, c])), [data.codes])

  const codeSets = useCodeSets(data.codes, codeGuids, includeSubcodes)

  // Series build. Counting coded passages makes one series per code.
  // Otherwise the default (no group-by) collapses to a single "All"
  // series across the filtered source set, and a group-by makes the
  // shared, survey-aware builder produce tag/category/folder bands and the
  // Respondents grouping (columns renamed → chart series here).
  const { series, seriesGroups } = useMemo(() => {
    if (coded) {
      const perCode: Series[] = [...codeSets.keys()].map((g) => ({
        id: g, label: codeMap.get(g)!.name, sourceGuids: filteredSourceGuids, codeGuid: g, color: codeMap.get(g)!.color
      }))
      return { series: perCode, seriesGroups: [] as { id: string; label: string | null; span: number }[] }
    }
    if (groupBy.length === 0) {
      const all: Series[] = [{ id: '__all', label: 'All', sourceGuids: filteredSourceGuids }]
      return { series: all, seriesGroups: [] as { id: string; label: string | null; span: number }[] }
    }
    const built = buildSurveyAwareColumns(groupBy, data, filteredSourceGuids, sourceMap, { includeSubtotals: true })
    return { series: built.columns as Series[], seriesGroups: built.headerGroups }
  }, [coded, codeSets, codeMap, groupBy, filteredSourceGuids, data, sourceMap])

  const seriesColor = useCallback(
    (si: number) => series[si]?.color || SERIES_COLORS[si % SERIES_COLORS.length],
    [series, SERIES_COLORS]
  )

  // Per-series frequency maps. A code series counts its coded passages;
  // a respondent series counts only that respondent's codable cells
  // (surveyCodableCells scoped to the respondent first); other series
  // read the shared data directly.
  const seriesFreqs = useMemo(() => {
    return series.map((s) => {
      if (s.codeGuid) return countWords(codedPassageTexts(data, s.sourceGuids, codeSets.get(s.codeGuid)!).passages.map((p) => p.text), filter)
      const sd = s.respondentRef ? applySurveyCellScope(data, { respondentScope: [s.respondentRef] }) : data
      return countWords(s.sourceGuids.flatMap((g) => sourceTexts(sd, g)), filter)
    })
  }, [series, data, codeSets, filter])

  // Every passage coded with any chosen code, overlaps merged.
  const allCodedPassages = useMemo(() => {
    if (!coded) return null
    return codedPassageTexts(data, filteredSourceGuids, allCodes(codeSets))
  }, [coded, codeSets, data, filteredSourceGuids])

  // Overall word frequencies for ranking + table, counted once over the
  // filtered sources (or once over all the chosen codes' passages).
  // Summing the series instead would count words twice: subtotal series
  // repeat their parts, a document tagged into two columns appears in
  // both, an expanded survey has a whole-survey subtotal beside its
  // respondents, and a passage can carry two of the chosen codes.
  const wordFreqs = useMemo(() => {
    const freq = allCodedPassages
      ? countWords(allCodedPassages.passages.map((p) => p.text), filter)
      : countWords(filteredSourceGuids.flatMap((g) => sourceTexts(data, g)), filter)
    return Array.from(freq.entries()).sort((a, b) => b[1] - a[1])
  }, [allCodedPassages, data, filteredSourceGuids, filter])

  const displayWords = useMemo(() => wordFreqs.slice(0, wordCount), [wordFreqs, wordCount])
  const maxFreq = useMemo(() => {
    // Max across all series for consistent scaling
    let mx = 1
    for (const [word] of displayWords) {
      for (const fm of seriesFreqs) {
        mx = Math.max(mx, fm.get(word) || 0)
      }
    }
    return mx
  }, [displayWords, seriesFreqs])

  const handleExportCsv = useCallback(() => {
    const rows: string[][] = [['Word', 'Frequency']]
    for (const [word, count] of wordFreqs) {
      rows.push([word, String(count)])
    }
    window.api.exportCsv(toCsv(rows), 'word-frequencies.csv')
  }, [wordFreqs])

  const handleExportChart = useCallback(() => {
    if (!chartRef.current) return
    window.api.exportSvg(chartRef.current.outerHTML, `word-frequencies-${vizMode}.svg`)
  }, [vizMode])

  // Search for a word: in a series' documents and passages when given,
  // otherwise across everything the tool counted.
  const handleWordClick = useCallback((word: string, s?: Series) => {
    const queryCodes = (guids: string[]): WordQueryCodes => ({ codeGuids: guids, includeSubcodes })
    if (s?.codeGuid) {
      window.api.sendAnalysisAction('run-word-query', word, s.sourceGuids, surveyScope(), queryCodes([s.codeGuid]))
    } else if (coded) {
      window.api.sendAnalysisAction('run-word-query', word, filteredSourceGuids, surveyScope(), queryCodes([...codeSets.keys()]))
    } else if (s && s.id !== '__all' && s.id !== '__other') {
      window.api.sendAnalysisAction('run-word-query', word, s.sourceGuids, surveyScope(s))
    } else {
      window.api.sendAnalysisAction('run-word-query', word, filteredSourceGuids, surveyScope())
    }
  }, [coded, codeSets, includeSubcodes, filteredSourceGuids, surveyScope])

  // Bar chart — fixed width, bars shrink to fit
  const barW = 600
  const barH = 380
  const barMaxH = 200
  const marginB = 160

  // Word cloud layout (tight spiral, cohesive palette)
  const cloudW = 600
  const cloudH = 380

  const cloudPositions = useMemo(() => {
    if (vizMode !== 'cloud' || displayWords.length === 0) return []
    const positions: { word: string; count: number; x: number; y: number; size: number; color: string }[] = []
    const cx = cloudW / 2
    const cy = cloudH / 2
    const minSize = 11
    const maxSize = 48
    // Per-side padding around each word's hit box. 1 px keeps words
    // visually distinct without leaving a gap large enough to read
    // as wasted space; the previous 3 px left noticeable bands of
    // whitespace between every adjacent pair.
    const padding = 1
    const placed: { x: number; y: number; w: number; h: number }[] = []

    // Frequency-driven gradient anchored to the theme's accent. Most
    // frequent words read in full accent colour; least frequent fade
    // toward a neutral grey via lightness/saturation interpolation.
    const palette = displayWords.map((_, i) => {
      const t = displayWords.length > 1 ? 1 - i / (displayWords.length - 1) : 1
      const sat = Math.round(accentHsl.s * t)
      const light = Math.round(accentHsl.l + (1 - t) * (60 - accentHsl.l))
      return hslToRgb(accentHsl.h, sat, light)
    })

    for (let i = 0; i < displayWords.length; i++) {
      const [word, count] = displayWords[i]
      // Use a power curve so top words are much bigger
      const ratio = count / maxFreq
      const size = minSize + Math.pow(ratio, 0.6) * (maxSize - minSize)
      // Tighter bounding-box estimate: 0.55× advance per char (closer
      // to the actual measured width for the proportional UI font)
      // and 0.95× line height (no descender slack) lets neighbouring
      // words sit closer without overlapping in practice.
      const estW = word.length * size * 0.55 + padding * 2
      const estH = size * 0.95 + padding * 2

      let px = cx
      let py = cy
      let found = false

      // Archimedean spiral with a finer step + smaller radius growth.
      // Doubling the step count and halving the radius increment lets
      // the search find the nearest gap a word will fit in, instead
      // of skipping past one because the spiral jumped too far in a
      // single iteration.
      for (let step = 0; step < 1600; step++) {
        const angle = step * 0.18
        const radius = step * 0.22
        px = cx + Math.cos(angle) * radius
        py = cy + Math.sin(angle) * radius * 0.65 // squash vertically for a wider shape

        const rect = { x: px - estW / 2, y: py - estH / 2, w: estW, h: estH }
        if (rect.x < 2 || rect.y < 2 || rect.x + rect.w > cloudW - 2 || rect.y + rect.h > cloudH - 2) continue

        const overlaps = placed.some((p) =>
          rect.x < p.x + p.w && rect.x + rect.w > p.x &&
          rect.y < p.y + p.h && rect.y + rect.h > p.y
        )
        if (!overlaps) {
          placed.push(rect)
          found = true
          break
        }
      }

      if (found) {
        positions.push({ word, count, x: px, y: py, size, color: palette[i] })
      }
    }
    return positions
  }, [displayWords, maxFreq, vizMode, accentHsl])

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
      toolType: 'word-frequencies',
      name,
      config: { docFilter, includeWords, excludeWords, wordCount, groupBy, textSource, codeGuids, includeSubcodes }
    })
    setBaseline({ docFilter, includeWords, excludeWords, wordCount, groupBy, textSource, codeGuids, includeSubcodes })
    if (inTab) inTab.onSaved(analysisGuid, name)
    else setTimeout(() => window.close(), 200)
  }, [analysisGuid, docFilter, includeWords, excludeWords, wordCount, groupBy, textSource, codeGuids, includeSubcodes, inTab, setBaseline])

  useRegisterToolSave(inTab?.tabId, () => {
    if (isExisting) {
      handleSave(analysisName)
      return true
    }
    setShowSaveDialog(true)
    return false
  })

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '14px 20px 6px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)' }}>
          <Icon icon={faFont} className="analysis-header-icon" style={{ fontSize: 16 }} />
          Word Frequencies{isExisting ? ':' : ''}
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
        <DocumentsSection data={data} filter={docFilter} onChange={setDocFilter} filteredSourceGuids={filteredSourceGuids} />

        <CountWordsIn
          value={textSource}
          onChange={setTextSource}
          codedTitle="Count the words in passages coded with the chosen codes, one series per code."
        />

        {coded ? (
          <CodesSection
            codes={data.codes}
            codeSets={codeSets}
            onChangeCodes={setCodeGuids}
            includeSubcodes={includeSubcodes}
            onChangeIncludeSubcodes={setIncludeSubcodes}
            boxCount={allCodedPassages?.boxCount ?? 0}
          />
        ) : (
          /* Group by \u2014 entire section is the drop target. */
          <div
            className="analysis-section"
            style={{ marginBottom: 14, position: 'relative' }}
            onDragOver={(e) => {
              if (isGroupByDrag(e)) {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'copy'
                setTagDropOver(true)
              }
            }}
            onDragLeave={() => setTagDropOver(false)}
            onDrop={handleTagDrop}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: groupBy.length > 0 ? 8 : 0, position: 'relative', zIndex: 1 }}>
              <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--text-secondary)' }}>Grouped by</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Drag tags, categories, or folders here
              </span>
            </div>
            <div style={{ position: 'relative', zIndex: 1 }}>
              <GroupByChips
                groupBy={groupBy}
                data={data}
                candidateSourceGuids={filteredSourceGuids}
                onRemove={handleRemoveGroupBy}
              />
            </div>
            {tagDropOver && (
              <div style={{
                position: 'absolute', inset: 0,
                background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
                border: '2px dashed var(--accent)',
                borderRadius: 'var(--radius-md)',
                pointerEvents: 'none'
              }} />
            )}
          </div>
        )}

        {/* Include/Exclude words */}
        <div style={{ display: 'flex', gap: 14, marginBottom: 14 }}>
          <div className="analysis-section" style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--text-secondary)' }}>Only these words</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>Leave empty to include every word not left out</div>
            <textarea
              value={includeWords}
              onChange={(e) => setIncludeWords(e.target.value)}
              placeholder="word1, word2, ..."
              style={{ width: '100%', height: 60, resize: 'vertical' }}
            />
          </div>
          <div className="analysis-section" style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--text-secondary)' }}>Leave out these words</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>Common English stop words are left out by default</div>
            <textarea
              value={excludeWords}
              onChange={(e) => setExcludeWords(e.target.value)}
              style={{ width: '100%', height: 60, resize: 'vertical' }}
            />
          </div>
        </div>

        {/* Results */}
        <div style={{ display: 'flex', gap: 14 }}>
          {/* Table — fixed width so viz panel stays constant between bar/cloud */}
          <div className="analysis-section" style={{ width: 260, flexShrink: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--text-secondary)' }}>
                Results <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>{wordFreqs.length} words</span>
              </span>
              <button className="secondary" style={{ fontSize: 10, padding: '3px 8px' }} onClick={handleExportCsv}>Export CSV</button>
            </div>
            <div style={{ maxHeight: 350, overflowY: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ padding: '3px 6px', borderBottom: '1px solid var(--border-color)', textAlign: 'left' }}>Word</th>
                    <th style={{ padding: '3px 6px', borderBottom: '1px solid var(--border-color)', textAlign: 'right' }}>Count</th>
                  </tr>
                </thead>
                <tbody>
                  {wordFreqs.slice(0, 200).map(([word, count]) => (
                    <tr key={word} onClick={() => handleWordClick(word)} style={{ cursor: 'pointer' }} title={coded ? `Search for "${word}" in the coded passages` : `Search for "${word}"`}>
                      <td style={{ padding: '2px 6px', borderBottom: '1px solid var(--border-color)' }}>{word}</td>
                      <td style={{ padding: '2px 6px', borderBottom: '1px solid var(--border-color)', textAlign: 'right' }}>{count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Visualization */}
          <div className="analysis-section" style={{ flex: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 6 }}>
              <SegmentedControl
                label="View"
                value={vizMode}
                onChange={setVizMode}
                options={[
                  { value: 'bar', label: 'Bar Chart' },
                  { value: 'cloud', label: 'Word Cloud' }
                ]}
              />
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <label style={{ fontSize: 10, color: 'var(--text-muted)' }}>Show:
                  <input type="number" min={5} max={200} value={wordCount} onChange={(e) => setWordCount(Number(e.target.value))}
                    style={{ width: 50, marginLeft: 4 }}
                  />
                </label>
                <button className="secondary" style={{ fontSize: 10, padding: '3px 8px' }} onClick={handleExportChart}>Export SVG</button>
              </div>
            </div>

            {/* Legend (only when grouped). When a category/folder band
                is present, prepend the band name (italic, secondary text)
                so it's clear which sub-series belong to which group. */}
            {series.length > 1 && vizMode === 'bar' && (
              <div style={{ display: 'flex', gap: 12, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {(() => {
                  const items: React.ReactNode[] = []
                  let cursor = 0
                  for (const g of seriesGroups) {
                    if (g.label) {
                      items.push(
                        <span key={`band:${g.id}`} style={{ fontSize: 10, fontWeight: 700, fontStyle: 'italic', color: 'var(--text-secondary)', marginLeft: items.length === 0 ? 0 : 8 }}>
                          {g.label}:
                        </span>
                      )
                    }
                    for (let i = 0; i < g.span; i++) {
                      const s = series[cursor]
                      items.push(
                        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }}>
                          <div style={{ width: 10, height: 10, background: seriesColor(cursor), borderRadius: 2 }} />
                          <span style={{ fontStyle: s.isSubtotal ? 'italic' : undefined, fontWeight: s.isSubtotal ? 700 : undefined }}>{s.label}</span>
                        </div>
                      )
                      cursor++
                    }
                  }
                  // Fallback for the no-groups path (each series is its own
                  // 1-span entry without a label).
                  while (cursor < series.length) {
                    const s = series[cursor]
                    items.push(
                      <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }}>
                        <div style={{ width: 10, height: 10, background: seriesColor(cursor), borderRadius: 2 }} />
                        {s.label}
                      </div>
                    )
                    cursor++
                  }
                  return items
                })()}
              </div>
            )}

            {displayWords.length === 0 ? (
              <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
                {coded && codeSets.size === 0 ? 'Drag codes into Coded with to count the words in their passages' : 'No words to display'}
              </div>
            ) : vizMode === 'bar' ? (
              (() => {
                const nSeries = series.length
                const yAxisW = 38
                const plotPad = 4
                const maxPlotW = barW - yAxisW * 2

                // Bar sizing: single series uses full-width bars, multiple series uses grouped sub-bars
                let groupW: number, subBarW: number, groupGap: number
                if (nSeries <= 1) {
                  const gap = Math.max(1, Math.min(4, maxPlotW / displayWords.length * 0.15))
                  subBarW = Math.max(2, (maxPlotW - gap * displayWords.length) / displayWords.length)
                  groupW = subBarW
                  groupGap = gap
                } else {
                  subBarW = Math.max(2, Math.min(14, (maxPlotW / displayWords.length - 4) / nSeries))
                  groupW = subBarW * nSeries
                  groupGap = Math.max(2, Math.min(8, subBarW * 0.4))
                }
                const step = groupW + groupGap
                const plotContentW = displayWords.length * step

                // Label sizing — driven directly by the number of
                // words on screen so reducing the count visibly grows
                // the labels (and vice-versa). The previous formula
                // tied font size to subBarW which itself caps at
                // 14 px, so the label size plateaued at ~10 px no
                // matter how few words were shown.
                const labelFontSize = Math.round(
                  Math.min(17, Math.max(7, 24 - displayWords.length * 0.45))
                )
                const charW = labelFontSize * 0.6

                // Plot-left placement: full word labels (no truncation)
                // need the chart left-padding to be at least the
                // leftward reach of the first label. The label is
                // rotated -45° around its tick anchor, so its leftward
                // extent equals (chars × charW) / √2. Without this the
                // first word would clip off the SVG's left edge.
                const firstWord = displayWords[0]?.[0] || ''
                const firstWordReachPx = firstWord.length * charW / Math.SQRT2
                const requiredLeftPad = firstWordReachPx - plotPad - groupW / 2 + 4
                const naturalPlotLeft = Math.max(yAxisW, (barW - plotContentW) / 2)
                const plotLeft = Math.max(naturalPlotLeft, requiredLeftPad)

                // Expand the SVG viewBox width if growing plotLeft
                // would push the right end of the bars past the
                // original 600 px. Grows the rendered chart width
                // proportionally; bar widths themselves are unchanged.
                const plotRight = plotLeft + plotContentW + plotPad
                const effectiveBarW = Math.max(barW, plotRight + 10)

                // Y-axis ticks at nice equal intervals
                const tickCount = 5
                const rawInterval = maxFreq / tickCount
                // Round up to a "nice" interval so labels are evenly spaced
                const mag = Math.pow(10, Math.floor(Math.log10(Math.max(rawInterval, 1))))
                const niceInterval = Math.ceil(rawInterval / mag) * mag
                const yTicks: { value: number; y: number }[] = []
                const yMax = niceInterval * tickCount
                for (let t = 0; t <= tickCount; t++) {
                  const value = niceInterval * t
                  const y = barH - marginB - (value / yMax) * barMaxH
                  yTicks.push({ value, y })
                }

                const xAxisY = barH - marginB
                // The X-axis labels are rotated -45° around their tick
                // anchor, so the closest point of the rotated text to
                // the axis line sits ~ascent×√2/2 px above the
                // anchor. To keep a constant visual gap (~8 px) at
                // every font size, push the anchor down by that
                // amount plus the gap. With a fixed offset, larger
                // fonts moved their top corner right up against the
                // axis line.
                const xAxisLabelOffsetY = Math.round(7 + labelFontSize * 0.6)

                return (
                  <svg ref={chartRef} viewBox={`0 0 ${effectiveBarW} ${barH}`} width="100%" style={{ display: 'block' }}>
                    {/* Y axis line */}
                    <line x1={plotLeft} y1={xAxisY - barMaxH - 5} x2={plotLeft} y2={xAxisY} stroke={themeColors.borderColor} />
                    {/* X axis line */}
                    <line x1={plotLeft} y1={xAxisY} x2={plotRight} y2={xAxisY} stroke={themeColors.borderColor} />

                    {/* Y axis ticks & labels */}
                    {yTicks.map(({ value, y }, ti) => (
                      <g key={ti}>
                        <line x1={plotLeft - 4} y1={y} x2={plotLeft} y2={y} stroke={themeColors.borderColor} />
                        <line x1={plotLeft} y1={y} x2={plotRight} y2={y} stroke={themeColors.borderColor} opacity={0.15} />
                        <text x={plotLeft - 7} y={y + Math.round(labelFontSize * 0.35)} textAnchor="end" fontSize={labelFontSize} fontFamily={SVG_FONT_FAMILY} fill={themeColors.textPrimary}>
                          {value}
                        </text>
                      </g>
                    ))}

                    {/* Grouped bars, x-axis ticks & labels */}
                    {displayWords.map(([word], wi) => {
                      const groupX = plotLeft + plotPad + wi * step
                      const tickX = groupX + groupW / 2
                      return (
                        <g key={word}>
                          {series.map((s, si) => {
                            const count = seriesFreqs[si].get(word) || 0
                            const bH = count > 0 ? (count / yMax) * barMaxH : 0
                            const bX = groupX + (nSeries > 1 ? si * subBarW : 0)
                            const bY = xAxisY - bH
                            return (
                              <rect
                                key={s.id}
                                x={bX}
                                y={bY}
                                width={subBarW}
                                height={bH}
                                fill={seriesColor(si)}
                                opacity={0.85}
                                rx={Math.min(2, subBarW / 4)}
                                style={{ cursor: count > 0 ? 'pointer' : undefined }}
                                onClick={() => { if (count > 0) handleWordClick(word, s) }}
                              >
                                <title>{`${word}: ${count}${nSeries > 1 ? ` (${s.label})` : ''}`}</title>
                              </rect>
                            )
                          })}
                          {/* X-axis tick */}
                          <line x1={tickX} y1={xAxisY} x2={tickX} y2={xAxisY + 4} stroke={themeColors.borderColor} />
                          {/* X-axis label */}
                          <text
                            x={tickX}
                            y={xAxisY + xAxisLabelOffsetY}
                            textAnchor="end"
                            fontSize={labelFontSize}
                            fontFamily={SVG_FONT_FAMILY}
                            fill={themeColors.textPrimary}
                            transform={`rotate(-45, ${tickX}, ${xAxisY + xAxisLabelOffsetY})`}
                            style={{ cursor: 'pointer' }}
                            onClick={() => handleWordClick(word)}
                          >
                            {word}
                          </text>
                        </g>
                      )
                    })}
                  </svg>
                )
              })()
            ) : (
              <svg ref={chartRef} viewBox={`0 0 ${cloudW} ${cloudH}`} width="100%" style={{ display: 'block' }}>
                {cloudPositions.map(({ word, count, x, y, size, color }) => (
                  <text
                    key={word}
                    x={x}
                    y={y}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize={size}
                    fontFamily={SVG_FONT_FAMILY}
                    fontWeight={size > 30 ? 700 : size > 20 ? 600 : 500}
                    fill={color}
                    opacity={0.9}
                    style={{ cursor: 'pointer' }}
                    onClick={() => handleWordClick(word)}
                  >
                    <title>{`${word}: ${count} — click to search`}</title>
                    {word}
                  </text>
                ))}
              </svg>
            )}
          </div>
        </div>
      </div>

    </div>
  )
}
