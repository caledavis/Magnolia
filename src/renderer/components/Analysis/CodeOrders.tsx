import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import type { AnalysisInitData, SurveyCellScopeArgs, SurveyEntityRef } from '../../models/types'
import { Icon, faBarsStaggered, faChevronDown, faChevronRight } from '../Icon'
import { toolColors } from '../../utils/tool-colors'
import {
  DocumentSelector,
  emptyDocumentFilter,
  type DocumentFilterState
} from '../DocumentSelector/DocumentSelector'
import { truncate, toCsv, resolveFilteredSources, applySurveyCellScope } from './analysis-helpers'
import { generateGuid } from '../../utils/guid'
import {
  type GroupByEntry,
  parseGroupByDrop,
  isGroupByDrag,
  mergeGroupBy,
  groupByKey,
  migrateLegacyGroupBy,
  GroupByChips
} from './group-by'
import {
  buildSurveyAwareColumns,
  hasSurveyInScope,
  QuestionScopeBox,
  type QuestionScopeRef
} from './survey-grouping'
import { useLiveAnalysisData } from './use-live-analysis-data'
import { EditableTitleSuffix } from '../EditableTitleSuffix'
import { renameSavedAnalysis } from '../../utils/rename-saved-analysis'
import { useToolDirtyState } from '../../hooks/use-tool-dirty-state'
import { useRegisterToolSave } from '../../hooks/use-register-tool-save'
import { useThemeSvgColors, SVG_FONT_FAMILY } from '../../utils/use-theme-svg-colors'

interface Props {
  data: AnalysisInitData
  savedConfig?: {
    codeGuids: string[]
    docFilter: DocumentFilterState
    groupByTags?: string[]
    groupBy?: GroupByEntry[]
    questionScope?: QuestionScopeRef[]
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

function parseDraggedCodes(e: React.DragEvent): string[] {
  const multiJson = e.dataTransfer.getData('application/x-magnolia-codes')
  const singleJson = e.dataTransfer.getData('application/x-magnolia-code')
  try {
    let codes: { guid: string }[]
    if (multiJson) codes = JSON.parse(multiJson)
    else if (singleJson) codes = [JSON.parse(singleJson)]
    else return []
    return codes.map((c) => c.guid)
  } catch { return [] }
}

function isCodeDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes('application/x-magnolia-code') ||
    e.dataTransfer.types.includes('application/x-magnolia-codes')
}

/** Build a color stripe for a single document showing code positions along a normalized line. */
interface CodeSegment {
  /** Normalized start 0..1 */
  start: number
  /** Normalized end 0..1 */
  end: number
  color: string
  codeGuid: string
  codeName: string
}

/** Lay a survey's codable (open-ended) cells end-to-end. Returns the
 *  total codepoint length and each cell's start offset, so cell-relative
 *  selection offsets can be turned into a source-relative 0..1 position
 *  normalized over the codable text (not the raw CSV). */
function surveyCellLayout(
  data: AnalysisInitData,
  sourceGuid: string
): { total: number; offsetByCell: Map<string, number> } {
  const cells = data.surveyCodableCells?.[sourceGuid] || []
  let total = 0
  const offsetByCell = new Map<string, number>()
  for (const c of cells) {
    offsetByCell.set(c.respondentId + ' ' + c.questionId, total)
    total += Array.from(c.text).length
  }
  return { total, offsetByCell }
}

function buildSegments(
  data: AnalysisInitData,
  sourceGuid: string,
  codeGuids: string[],
  codeMap: Map<string, { name: string; color?: string }>
): CodeSegment[] {
  const sels = data.sourceSelections[sourceGuid] || []
  const segments: CodeSegment[] = []
  const src = data.sources.find((s) => s.guid === sourceGuid)

  if (src?.sourceType === 'survey') {
    // Position codings within the concatenated codable cells, not the
    // raw CSV — survey offsets are cell-relative.
    const { total, offsetByCell } = surveyCellLayout(data, sourceGuid)
    if (total === 0) return []
    for (const sel of sels) {
      if (!sel.surveyCell) continue
      const base = offsetByCell.get(sel.surveyCell.respondentId + ' ' + sel.surveyCell.questionId)
      if (base === undefined) continue
      for (const coding of sel.codings) {
        if (!codeGuids.includes(coding.codeGuid)) continue
        const info = codeMap.get(coding.codeGuid)
        segments.push({
          start: (base + sel.startPosition) / total,
          end: (base + sel.endPosition) / total,
          color: info?.color || '#888',
          codeGuid: coding.codeGuid,
          codeName: info?.name || ''
        })
      }
    }
    segments.sort((a, b) => a.start - b.start || a.end - b.end)
    return segments
  }

  const content = data.sourceContents[sourceGuid]
  if (!content) return []
  const totalCp = Array.from(content).length
  if (totalCp === 0) return []

  for (const sel of sels) {
    for (const coding of sel.codings) {
      if (!codeGuids.includes(coding.codeGuid)) continue
      const info = codeMap.get(coding.codeGuid)
      segments.push({
        start: sel.startPosition / totalCp,
        end: sel.endPosition / totalCp,
        color: info?.color || '#888',
        codeGuid: coding.codeGuid,
        codeName: info?.name || ''
      })
    }
  }

  // Sort by start position for a clean visual
  segments.sort((a, b) => a.start - b.start || a.end - b.end)
  return segments
}

export function CodeOrders({ data: propData, savedConfig, inTab }: Props) {
  const [docFilter, setDocFilter] = useState<DocumentFilterState>(savedConfig?.docFilter ?? emptyDocumentFilter())
  const [codeGuids, setCodeGuids] = useState<string[]>(savedConfig?.codeGuids ?? [])
  const [groupBy, setGroupBy] = useState<GroupByEntry[]>(
    () => savedConfig?.groupBy ?? migrateLegacyGroupBy(savedConfig?.groupByTags)
  )
  const [questionScope, setQuestionScope] = useState<QuestionScopeRef[]>(savedConfig?.questionScope ?? [])
  const respondentsDismissed = useRef(false)
  const live = useLiveAnalysisData()
  const data = useMemo(() => {
    const base = applySurveyCellScope({ ...propData, ...live }, docFilter)
    return questionScope.length > 0 ? applySurveyCellScope(base, { questionScope }) : base
  }, [propData, live, docFilter, questionScope])
  const [docSectionOpen, setDocSectionOpen] = useState(false)
  const [dropOver, setDropOver] = useState(false)
  const [tagDropOver, setTagDropOver] = useState(false)
  const [analysisGuid] = useState(savedConfig?.guid ?? generateGuid())
  const [analysisName, setAnalysisName] = useState(savedConfig?.name ?? '')
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const isExisting = !!savedConfig?.guid
  const svgRef = useRef<SVGSVGElement>(null)
  const themeColors = useThemeSvgColors()

  // Dirty tracking (see useToolDirtyState).
  const currentConfig = useMemo(
    () => ({ codeGuids, docFilter, groupBy, questionScope }),
    [codeGuids, docFilter, groupBy, questionScope]
  )
  const initialBaseline = useMemo(() => ({
    codeGuids: savedConfig?.codeGuids ?? [],
    docFilter: savedConfig?.docFilter ?? emptyDocumentFilter(),
    groupBy: savedConfig?.groupBy ?? migrateLegacyGroupBy(savedConfig?.groupByTags),
    questionScope: savedConfig?.questionScope ?? []
  }), [])
  const { dirty, baseline, setBaseline } = useToolDirtyState(currentConfig, initialBaseline, inTab)

  const handleDiscard = useCallback(() => {
    setCodeGuids(baseline.codeGuids)
    setDocFilter(baseline.docFilter)
    setGroupBy(baseline.groupBy)
    setQuestionScope(baseline.questionScope ?? [])
  }, [baseline])

  const filteredSourceGuids = useMemo(
    () => resolveFilteredSources(data, docFilter.sourceGuids, docFilter.tagGuids, docFilter.tagExcludeGuids, docFilter.typeInclude, docFilter.typeExclude),
    [data, docFilter]
  )

  // Survey-cell scope carried into a generated query so it re-runs
  // against the same subset: the tool-level Questions scope plus, for a
  // respondent / tagged row, that row's narrowing.
  const surveyScope = useCallback((row?: { respondentRef?: SurveyEntityRef; tagScopeGuids?: string[] }): SurveyCellScopeArgs | undefined => {
    const s: SurveyCellScopeArgs = {}
    if (questionScope.length > 0) s.questionScope = questionScope.map((q) => ({ sourceGuid: q.sourceGuid, id: q.id }))
    if (row?.respondentRef) s.respondentScope = [row.respondentRef]
    if (row?.tagScopeGuids?.length) s.tagGuids = row.tagScopeGuids
    return s.questionScope || s.respondentScope || s.tagGuids ? s : undefined
  }, [questionScope])

  // Auto-add "Respondents" grouping when a survey first enters scope on a
  // fresh, never-saved analysis; removing the chip prevents re-adding.
  useEffect(() => {
    if (respondentsDismissed.current || savedConfig) return
    if (groupBy.some((e) => e.kind === 'respondents')) return
    if (hasSurveyInScope(filteredSourceGuids, data)) {
      setGroupBy((p) => mergeGroupBy(p, [{ kind: 'respondents' }]))
    }
  }, [filteredSourceGuids, data, groupBy, savedConfig])

  const codeMap = useMemo(() => {
    const m = new Map<string, { name: string; color?: string }>()
    for (const c of data.codes) m.set(c.guid, { name: c.name, color: c.color })
    return m
  }, [data.codes])

  const sourceMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of data.sources) m.set(s.guid, s.name)
    return m
  }, [data.sources])

  // Row build via the shared, survey-aware builder (renamed columns →
  // rows, since group-by adds rows here). No subtotal slot — a
  // stripe-of-stripes adds no information; the category/folder/survey
  // name spans its child rows on the left of the SVG instead.
  const { columns: rows, headerGroups, hasGroupedHeader } = useMemo(
    () => buildSurveyAwareColumns(groupBy, data, filteredSourceGuids, sourceMap, { includeSubtotals: false }),
    [filteredSourceGuids, groupBy, data, sourceMap]
  )

  // Per-row metadata for the spanning category/folder label cell on the
  // left of each row group. Mirrors the rowLayout pattern used by
  // ResultsInDocuments after the grid was flipped.
  const rowLayout = useMemo(() => {
    const layout: { groupLabel: string | null; isGroupStart: boolean; groupSpan: number }[] = []
    for (const g of headerGroups) {
      for (let i = 0; i < g.span; i++) {
        layout.push({ groupLabel: g.label, isGroupStart: i === 0, groupSpan: g.span })
      }
    }
    while (layout.length < rows.length) {
      layout.push({ groupLabel: null, isGroupStart: true, groupSpan: 1 })
    }
    return layout
  }, [rows, headerGroups])

  // Build segments for each row, concatenating documents end-to-end when grouped
  const rowSegments = useMemo(() => {
    return rows.map((row) => {
      // A tag-grouped row counts only that tag's survey cells; a
      // respondent row counts only that respondent's cells.
      const rd = row.respondentRef
        ? applySurveyCellScope(data, { respondentScope: [row.respondentRef] })
        : row.tagScopeGuids
          ? applySurveyCellScope(data, { tagGuids: row.tagScopeGuids })
          : data
      if (row.sourceGuids.length === 1) {
        return buildSegments(rd, row.sourceGuids[0], codeGuids, codeMap)
      }
      // Multiple sources: concatenate end-to-end, normalizing positions
      // across the combined length. Surveys contribute their codable
      // (open-ended) length, not the raw CSV, and their cell-relative
      // selection offsets are placed within each cell's slot.
      let totalCp = 0
      const layouts: ({ total: number; offsetByCell: Map<string, number> } | null)[] = []
      const sourceLengths: number[] = []
      for (const sg of row.sourceGuids) {
        const isSurvey = rd.sources.find((s) => s.guid === sg)?.sourceType === 'survey'
        if (isSurvey) {
          const layout = surveyCellLayout(rd, sg)
          layouts.push(layout)
          sourceLengths.push(layout.total)
          totalCp += layout.total
        } else {
          const content = data.sourceContents[sg]
          const len = content ? Array.from(content).length : 0
          layouts.push(null)
          sourceLengths.push(len)
          totalCp += len
        }
      }
      if (totalCp === 0) return []
      const segments: CodeSegment[] = []
      let offset = 0
      for (let i = 0; i < row.sourceGuids.length; i++) {
        const sg = row.sourceGuids[i]
        const len = sourceLengths[i]
        if (len === 0) continue
        const layout = layouts[i]
        const sels = rd.sourceSelections[sg] || []
        for (const sel of sels) {
          // For surveys, shift cell-relative offsets by the cell's slot.
          let base = offset
          if (layout) {
            if (!sel.surveyCell) continue
            const cellOff = layout.offsetByCell.get(sel.surveyCell.respondentId + ' ' + sel.surveyCell.questionId)
            if (cellOff === undefined) continue
            base = offset + cellOff
          }
          for (const coding of sel.codings) {
            if (!codeGuids.includes(coding.codeGuid)) continue
            const info = codeMap.get(coding.codeGuid)
            segments.push({
              start: (base + sel.startPosition) / totalCp,
              end: (base + sel.endPosition) / totalCp,
              color: info?.color || '#888',
              codeGuid: coding.codeGuid,
              codeName: info?.name || ''
            })
          }
        }
        offset += len
      }
      segments.sort((a, b) => a.start - b.start || a.end - b.end)
      return segments
    })
  }, [rows, codeGuids, data, codeMap])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDropOver(false)
    const guids = parseDraggedCodes(e)
    if (guids.length > 0) {
      setCodeGuids((prev) => {
        const existing = new Set(prev)
        return [...prev, ...guids.filter((g) => !existing.has(g))]
      })
    }
  }, [])

  const handleTagDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setTagDropOver(false)
    const fresh = parseGroupByDrop(e)
    if (fresh.length > 0) setGroupBy((p) => mergeGroupBy(p, fresh))
  }, [])

  const handleRemoveGroupBy = useCallback((entry: GroupByEntry) => {
    if (entry.kind === 'respondents') respondentsDismissed.current = true
    const key = groupByKey(entry)
    setGroupBy((p) => p.filter((e) => groupByKey(e) !== key))
  }, [])

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
      toolType: 'code-orders',
      name,
      config: { codeGuids, docFilter, groupBy, questionScope }
    })
    setBaseline({ codeGuids, docFilter, groupBy, questionScope })
    if (inTab) inTab.onSaved(analysisGuid, name)
    else setTimeout(() => window.close(), 200)
  }, [analysisGuid, codeGuids, docFilter, groupBy, questionScope, inTab, setBaseline])

  useRegisterToolSave(inTab?.tabId, () => {
    if (isExisting) {
      handleSave(analysisName)
      return true
    }
    setShowSaveDialog(true)
    return false
  })

  // SVG dimensions. groupLabelW reserves space to the left of the
  // document label for the category/folder name when rows are grouped;
  // it stays at 0 (no extra space) when the table isn't grouped.
  const groupLabelW = hasGroupedHeader ? 80 : 0
  const labelW = 160
  const stripeH = 18
  const rowGap = 4
  const stripeW = 600
  const svgW = groupLabelW + labelW + stripeW + 20
  const svgH = rows.length > 0 ? 10 + rows.length * (stripeH + rowGap) + 6 : 60

  const handleExportSvg = useCallback(() => {
    if (!svgRef.current) return

    // Build a colour key (one swatch + code name per included code)
    // and prepend it to the export. Wrapped horizontal layout, same
    // pattern as the Code Frequencies legend so the two tools'
    // exports feel consistent.
    const SWATCH = 10
    const SWATCH_GAP = 4
    const ITEM_GAP = 12
    const FONT_SIZE = 10
    const LINE_HEIGHT = 18
    const PADDING_X = 10
    const PADDING_Y = 8
    const CHAR_W = 5.5

    const items = codeGuids.map((guid) => {
      const info = codeMap.get(guid)
      const label = (info?.name || '').slice(0, 28)
      return {
        color: info?.color || '#888',
        label,
        width: SWATCH + SWATCH_GAP + label.length * CHAR_W
      }
    }).filter((it) => it.label.length > 0)

    const maxRowWidth = svgW - PADDING_X * 2
    const rows: (typeof items)[] = [[]]
    let rowWidth = 0
    for (const item of items) {
      const sep = rowWidth > 0 ? ITEM_GAP : 0
      if (rowWidth > 0 && rowWidth + sep + item.width > maxRowWidth) {
        rows.push([item])
        rowWidth = item.width
      } else {
        rows[rows.length - 1].push(item)
        rowWidth += sep + item.width
      }
    }
    const legendH = items.length === 0 ? 0 : rows.length * LINE_HEIGHT + PADDING_Y * 2

    const escapeXml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const fontFamilyAttr = SVG_FONT_FAMILY.replace(/"/g, '&quot;')

    const legendParts: string[] = []
    for (let r = 0; r < rows.length; r++) {
      const yBase = PADDING_Y + r * LINE_HEIGHT
      const swatchY = yBase + (LINE_HEIGHT - SWATCH) / 2
      const textY = yBase + LINE_HEIGHT * 0.7
      let x = PADDING_X
      for (const item of rows[r]) {
        legendParts.push(
          `<rect x="${x.toFixed(1)}" y="${swatchY.toFixed(1)}" width="${SWATCH}" height="${SWATCH}" rx="2" fill="${item.color}"/>`
        )
        legendParts.push(
          `<text x="${(x + SWATCH + SWATCH_GAP).toFixed(1)}" y="${textY.toFixed(1)}" font-size="${FONT_SIZE}" font-family="${fontFamilyAttr}" fill="${themeColors.textPrimary}">${escapeXml(item.label)}</text>`
        )
        x += item.width + ITEM_GAP
      }
    }

    const totalH = legendH + svgH
    const chartHtml = svgRef.current.outerHTML
    const combined = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${totalH}" viewBox="0 0 ${svgW} ${totalH}"><rect width="${svgW}" height="${totalH}" fill="#ffffff"/>${legendParts.join('')}<g transform="translate(0, ${legendH})">${chartHtml}</g></svg>`

    window.api.exportSvg(combined, 'code-orders.svg')
  }, [codeGuids, codeMap, themeColors, svgW, svgH])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '14px 20px 6px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)' }}>
          <Icon icon={faBarsStaggered} className="analysis-header-icon" style={{ fontSize: 16 }} />
          Code Orders{isExisting ? ':' : ''}
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
        {/* Document Selector */}
        <div className="analysis-section" style={{ marginBottom: 14 }}>
          <div onClick={() => setDocSectionOpen(!docSectionOpen)} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
            <Icon icon={docSectionOpen ? faChevronDown : faChevronRight} style={{ fontSize: 12, color: 'var(--text-muted)' }} />
            <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--text-secondary)' }}>Select Documents</span>
          </div>
          {docSectionOpen && (
            <div style={{ marginTop: 10, minHeight: 160 }}>
              <DocumentSelector sources={data.sources} tags={data.tags} categories={data.categories} folders={data.folders} sourceFolder={data.sourceFolder} tagMembers={data.tagMembers} respondentTagMembers={data.respondentTagMembers} questionTagMembers={data.questionTagMembers} surveyEntityLabels={data.surveyEntityLabels} filter={docFilter} onChange={setDocFilter} />
            </div>
          )}
        </div>

        {/* Group by \u2014 entire section is the drop target. */}
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
            <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--text-secondary)' }}>Group by</span>
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

        {/* Questions scope \u2014 only meaningful when a survey is analysed. */}
        {hasSurveyInScope(filteredSourceGuids, data) && (
          <QuestionScopeBox value={questionScope} onChange={setQuestionScope} data={data} />
        )}

        {/* Visualisation \u2014 entire section accepts code drops. */}
        <div
          className="analysis-section"
          style={{ marginBottom: 14, position: 'relative' }}
          onDragOver={(e) => {
            if (isCodeDrag(e)) {
              e.preventDefault()
              setDropOver(true)
            }
          }}
          onDragLeave={() => setDropOver(false)}
          onDrop={handleDrop}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, position: 'relative', zIndex: 1 }}>
            <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--text-secondary)' }}>Code Orders</span>
            <button className="secondary" style={{ fontSize: 10, padding: '3px 8px' }} onClick={handleExportSvg} disabled={codeGuids.length === 0 || rows.length === 0}>
              Export SVG
            </button>
          </div>

          {/* Code pills for removal */}
          {codeGuids.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
              {codeGuids.map((guid) => {
                const info = codeMap.get(guid)
                return (
                  <span key={guid} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, background: 'var(--bg-tertiary)', padding: '2px 8px', borderRadius: 'var(--radius-sm)' }}>
                    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: info?.color || '#888' }} />
                    {info?.name || guid}
                    <span onClick={() => setCodeGuids((p) => p.filter((g) => g !== guid))} style={{ fontSize: 9, color: 'var(--text-muted)', cursor: 'pointer' }}>&times;</span>
                  </span>
                )
              })}
            </div>
          )}

          {codeGuids.length === 0 || rows.length === 0 ? (
            <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)', position: 'relative', zIndex: 1 }}>
              {codeGuids.length === 0
                ? 'Drag codes from the Code Browser to build the visualisation'
                : 'Select documents using the Document Selector above'}
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <svg ref={svgRef} width={svgW} height={svgH} style={{ background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)', display: 'block' }}>
                {rows.map((row, ri) => {
                  const segments = rowSegments[ri]
                  const y = 10 + ri * (stripeH + rowGap)
                  const layout = rowLayout[ri]
                  // Show the category/folder name once per band, on the
                  // first row of the band, vertically centred across all
                  // its rows. A faint vertical rule on the right edge
                  // visually ties the band's rows together.
                  const showGroupLabel = hasGroupedHeader && layout?.isGroupStart && layout.groupLabel !== null
                  const bandTotalH = layout ? layout.groupSpan * stripeH + (layout.groupSpan - 1) * rowGap : stripeH

                  return (
                    <g key={row.id}>
                      {showGroupLabel && (
                        <>
                          <text
                            x={4}
                            y={y + bandTotalH / 2 + 3}
                            fontSize={10}
                            fontWeight={700}
                            fontFamily={SVG_FONT_FAMILY}
                            fill={themeColors.textSecondary}
                            style={{ dominantBaseline: 'middle' } as any}
                          >
                            {truncate(layout!.groupLabel!, 12)}
                          </text>
                          <line
                            x1={groupLabelW - 4}
                            y1={y - 2}
                            x2={groupLabelW - 4}
                            y2={y + bandTotalH + 2}
                            stroke={themeColors.borderColor}
                            strokeWidth={1}
                          />
                        </>
                      )}

                      {/* Document label */}
                      <text
                        x={groupLabelW + 4}
                        y={y + stripeH / 2 + 3}
                        fontSize={10}
                        fontFamily={SVG_FONT_FAMILY}
                        fill={themeColors.textPrimary}
                        style={{ dominantBaseline: 'middle' } as any}
                      >
                        {truncate(row.label, 22)}
                      </text>

                      {/* Background stripe */}
                      <rect
                        x={groupLabelW + labelW}
                        y={y}
                        width={stripeW}
                        height={stripeH}
                        rx={2}
                        fill={themeColors.bgTertiary}
                        stroke={themeColors.borderColor}
                        strokeWidth={0.5}
                      />

                      {/* Code segments */}
                      {segments.map((seg, si) => {
                        const x = groupLabelW + labelW + seg.start * stripeW
                        const w = Math.max(1, (seg.end - seg.start) * stripeW)
                        return (
                          <rect
                            key={si}
                            x={x}
                            y={y + 1}
                            width={w}
                            height={stripeH - 2}
                            fill={seg.color}
                            opacity={0.8}
                            rx={1}
                            style={{ cursor: 'pointer' }}
                            onClick={() => {
                              // Always run the query against the row's
                              // actual sourceGuids; works for tags,
                              // category/folder children, and "Other".
                              window.api.sendAnalysisAction('run-code-in-doc-query', seg.codeGuid, row.sourceGuids, filteredSourceGuids, surveyScope(row))
                            }}
                          >
                            <title>{`${seg.codeName} (${(seg.start * 100).toFixed(0)}%–${(seg.end * 100).toFixed(0)}%)`}</title>
                          </rect>
                        )
                      })}
                    </g>
                  )
                })}
              </svg>
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

      </div>

    </div>
  )
}
