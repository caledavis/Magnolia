/**
 * QueryResultsBody — single source of truth for the result-list UI used
 * by both the inline `QueryResultViewer` (in the main window's Queries
 * pane) and the popped-out `QueryResultsWindow`. It owns the empty
 * states, the document-grouped headers, and the per-result `ResultItem`
 * rendering. Callers pass in:
 *
 *   - `groups` (already grouped via `groupByDocument`)
 *   - per-source selections + a `findCode(guid)` lookup
 *   - a navigation callback (`onOpenResult`) that handles double-click
 *   - optional `onOpenSource` for the clickable group header (omit in
 *     popout mode where document tabs aren't reachable)
 *   - optional `pdfFilePathForSource(guid)` for region thumbnails
 *     (popout passes via the IPC initData; inline relies on
 *     PdfRegionThumbnail's store fallback)
 *   - optional `sourceTypeForGuid(guid)` (inline reads from store; popout
 *     falls back to filename detection)
 *
 * `groupByDocument` and `buildHighlightedSpans` are exported here too so
 * both viewers consume them from the same module.
 */
import React, { useMemo } from 'react'
import {
  Icon,
  faChevronDown,
  faChevronRight
} from '../Icon'
import type {
  QueryResult,
  PlainTextSelection,
  PdfRegionSelection,
  TimeRange,
  SourceType,
  SurveyData
} from '../../models/types'
import { stripFormatting } from '../../utils/strip-formatting'
import { sourceTypeFromFilename } from '../../utils/format-registry'
import { PdfRegionThumbnail } from '../DocumentViewer/PdfRegionThumbnail'
import { blendColors, multiColorUnderline } from '../../utils/code-highlight'

/** Group results by sourceGuid, preserving order of first appearance. */
export function groupByDocument(
  results: QueryResult[]
): { sourceGuid: string; sourceName: string; results: QueryResult[] }[] {
  const map = new Map<string, { sourceGuid: string; sourceName: string; results: QueryResult[] }>()
  for (const r of results) {
    let group = map.get(r.sourceGuid)
    if (!group) {
      group = { sourceGuid: r.sourceGuid, sourceName: r.sourceName, results: [] }
      map.set(r.sourceGuid, group)
    }
    group.results.push(r)
  }
  return Array.from(map.values())
}

/** Build highlighted spans for a text region — same visual treatment as
 *  the document body so the user can see every other code attached to
 *  the snippet text. In the matched region we skip the matched code(s)
 *  themselves: the outer match wrapper already paints them (and bolds
 *  the text), so re-painting here would just stack a darker background. */
export function buildHighlightedSpans(
  text: string,
  textStartCp: number,
  selections: PlainTextSelection[],
  findCode: (guid: string) => { name: string; color?: string } | undefined,
  isMatchRegion: boolean,
  matchedCodeGuids?: Set<string>
): React.ReactNode[] {
  if (!text) return []
  const textEndCp = textStartCp + Array.from(text).length
  interface Highlight {
    start: number
    end: number
    color: string
    codeName: string
  }
  const highlights: Highlight[] = []
  for (const sel of selections) {
    if (sel.endPosition <= textStartCp || sel.startPosition >= textEndCp) continue
    const relStart = Math.max(0, sel.startPosition - textStartCp)
    const relEnd = Math.min(textEndCp - textStartCp, sel.endPosition - textStartCp)
    for (const coding of sel.codings) {
      if (isMatchRegion && matchedCodeGuids?.has(coding.codeGuid)) continue
      const code = findCode(coding.codeGuid)
      if (code) highlights.push({ start: relStart, end: relEnd, color: code.color || '#888', codeName: code.name })
    }
  }
  if (highlights.length === 0) return [text]
  const breaks = new Set<number>([0, Array.from(text).length])
  for (const h of highlights) { breaks.add(h.start); breaks.add(h.end) }
  const sorted = Array.from(breaks).sort((a, b) => a - b)
  const chars = Array.from(text)
  const spans: React.ReactNode[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const s = sorted[i], e = sorted[i + 1]
    const segment = chars.slice(s, e).join('')
    const covering = highlights.filter((h) => h.start <= s && h.end >= e)
    if (covering.length > 0) {
      const tooltip = [...new Set(covering.map((h) => h.codeName))].join(', ')
      const uniqueColors = [...new Set(covering.map((h) => h.color))]
      const isMultiCode = uniqueColors.length > 1
      const style: React.CSSProperties = {
        backgroundColor: blendColors(uniqueColors, isMultiCode ? 0.15 : 0.12),
        borderRadius: 'var(--radius-sm)',
        ...multiColorUnderline(uniqueColors)
      }
      spans.push(<span key={i} title={tooltip} style={style}>{segment}</span>)
    } else {
      spans.push(<span key={i}>{segment}</span>)
    }
  }
  return spans
}

export function formatClipTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

interface ResultItemProps {
  result: QueryResult
  isExpanded: boolean
  onToggleExpand: () => void
  onOpenResult: (result: QueryResult, selection?: PlainTextSelection) => void
  selections: PlainTextSelection[]
  findCode: (guid: string) => { name: string; color?: string } | undefined
  /** Optional sourceType — when omitted, inferred from result.sourceName. */
  sourceType?: SourceType
  /** Optional explicit file path for region thumbnails. When absent
   *  PdfRegionThumbnail falls back to a documentStore lookup, which
   *  is correct for the inline viewer (stores populated) but absent
   *  for the popout (no project loaded). */
  pdfFilePath?: string
  /** Parsed survey data for this result's source, when the source is
   *  a survey. Used to render the "Respondent N · Question N" badge
   *  on survey-cell results. */
  survey?: SurveyData
}

export function ResultItem({
  result,
  isExpanded,
  onToggleExpand,
  onOpenResult,
  selections,
  findCode,
  sourceType,
  pdfFilePath,
  survey
}: ResultItemProps) {
  const beforeCpLen = result.contextBefore ? Array.from(result.contextBefore).length : 0
  const matchCpLen = Array.from(result.matchedText).length
  const contextStartCp = result.startPosition - beforeCpLen

  const selection = selections.find((s) => s.guid === result.selectionGuid)
  const pdfRegion: PdfRegionSelection | undefined = selection?.pdfRegion
  const effectiveSourceType: SourceType | undefined = sourceType ?? sourceTypeFromFilename(result.sourceName)

  // "Respondent N · Question N" label for survey-cell results. The
  // numbers are 1-based positions in the survey's respondent /
  // question lists, matching what the survey browser shows.
  let surveyCellLabel: string | null = null
  if (selection?.surveyCell && survey) {
    const rIdx = survey.respondents.findIndex((r) => r.id === selection.surveyCell!.respondentId)
    const qIdx = survey.questions.findIndex((q) => q.id === selection.surveyCell!.questionId)
    if (rIdx >= 0 && qIdx >= 0) {
      surveyCellLabel = `Respondent ${rIdx + 1} · Question ${qIdx + 1}`
    }
  }

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(
          'application/json',
          JSON.stringify({
            kind: 'query-result',
            entityGuid: result.selectionGuid,
            sourceGuid: result.sourceGuid,
            label: result.sourceName,
            snippet: (result.contextBefore ? '...' + result.contextBefore : '') + result.matchedText + (result.contextAfter ? result.contextAfter + '...' : ''),
            startPosition: result.startPosition,
            endPosition: result.endPosition,
            pdfRegion
          })
        )
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onDoubleClick={() => onOpenResult(result, selection)}
      style={{
        padding: '6px 10px 6px 18px',
        cursor: 'pointer',
        fontSize: 'var(--font-size-sm)',
        borderBottom: '1px solid var(--border-color)'
      }}
    >
      {/* Code badges + position */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
        <div style={{ display: 'flex', gap: 4, flex: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          {surveyCellLabel && (
            <span
              style={{
                fontSize: 10,
                color: 'var(--text-muted)',
                background: 'var(--bg-tertiary)',
                borderRadius: 'var(--radius-sm)',
                padding: '1px 6px',
                whiteSpace: 'nowrap'
              }}
            >
              {surveyCellLabel}
            </span>
          )}
          {result.matchedCodes.map((code) => (
            <span
              key={code.guid}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                fontSize: 10,
                background: 'var(--bg-tertiary)',
                borderRadius: 'var(--radius-sm)',
                padding: '1px 6px'
              }}
            >
              <span
                className="color-pip"
                style={{ background: code.color || '#888', width: 8, height: 8 }}
              />
              {code.name}
            </span>
          ))}
        </div>
        <span
          style={{ fontSize: 9, color: 'var(--text-muted)', flexShrink: 0 }}
          title={`Codepoints ${result.startPosition}–${result.endPosition}`}
        >
          {result.startPosition}–{result.endPosition}
        </span>
      </div>

      {pdfRegion ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <PdfRegionThumbnail
            sourceGuid={result.sourceGuid}
            filePath={pdfFilePath}
            page={pdfRegion.page}
            x={pdfRegion.x}
            y={pdfRegion.y}
            width={pdfRegion.width}
            height={pdfRegion.height}
            maxW={260}
            maxH={180}
          />
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Page {pdfRegion.page}</span>
        </div>
      ) : (
        <>
          {result.timeRange && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>
              {formatClipTime(result.timeRange.startTime)} – {formatClipTime(result.timeRange.endTime)}
            </div>
          )}

          <div
            style={{
              color: 'var(--text-primary)',
              lineHeight: 1.6,
              whiteSpace: isExpanded ? 'pre-wrap' : undefined,
              overflow: isExpanded ? undefined : 'hidden',
              display: isExpanded ? undefined : '-webkit-box',
              WebkitLineClamp: isExpanded ? undefined : 3,
              WebkitBoxOrient: isExpanded ? undefined : 'vertical' as any
            }}
          >
            {(() => {
              const matchedColor = result.matchedCodes[0]?.color
              const highlightColor = matchedColor ? matchedColor + '40' : 'var(--selection-bg)'
              const matchedCodeGuids = new Set(result.matchedCodes.map((c) => c.guid))
              const matchStyle: React.CSSProperties = {
                background: highlightColor,
                borderRadius: 'var(--radius-sm)',
                padding: '1px 2px 0',
                fontWeight: 600,
                ...(matchedColor ? { borderBottom: `2px solid ${matchedColor}` } : {})
              }
              if (result.timeRange) {
                return <span style={matchStyle}>{result.matchedText}</span>
              }
              // Position-preserving source types let us render code
              // highlights through buildHighlightedSpans because their
              // stored content matches what's displayed. Markdown is
              // excluded — stripFormatting drops characters.
              const positionsPreserved = !effectiveSourceType
                || effectiveSourceType === 'text'
                || effectiveSourceType === 'pdf'
                || effectiveSourceType === 'audio'
              return (
                <>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {result.contextBefore ? '...' : ''}
                    {positionsPreserved
                      ? buildHighlightedSpans(result.contextBefore || '', contextStartCp, selections, findCode, false)
                      : stripFormatting(result.contextBefore || '', effectiveSourceType)}
                  </span>
                  <span style={matchStyle}>
                    {positionsPreserved
                      ? buildHighlightedSpans(result.matchedText, result.startPosition, selections, findCode, true, matchedCodeGuids)
                      : stripFormatting(result.matchedText, effectiveSourceType)}
                  </span>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {positionsPreserved
                      ? buildHighlightedSpans(result.contextAfter || '', result.startPosition + matchCpLen, selections, findCode, false)
                      : stripFormatting(result.contextAfter || '', effectiveSourceType)}
                    {result.contextAfter ? '...' : ''}
                  </span>
                </>
              )
            })()}
          </div>

          <div
            onClick={(e) => {
              e.stopPropagation()
              onToggleExpand()
            }}
            style={{
              fontSize: 10,
              color: 'var(--text-muted)',
              marginTop: 2,
              cursor: 'pointer',
              userSelect: 'none',
              opacity: 0.7
            }}
          >
            {isExpanded ? 'Show less' : 'Show more'}
          </div>
        </>
      )}
    </div>
  )
}

interface QueryResultsBodyProps {
  results: QueryResult[]
  isActive: boolean
  expandedKeys: Set<string>
  toggleExpand: (key: string) => void
  collapsedGroups: Set<string>
  toggleGroup: (sourceGuid: string) => void
  /** sourceGuid → list of selections on that source. */
  sourceSelectionsByGuid: Map<string, PlainTextSelection[]>
  findCode: (guid: string) => { name: string; color?: string } | undefined
  /** Navigation: called on result double-click. Each viewer wires this
   *  to its own navigation (zustand action inline; IPC in popout). */
  onOpenResult: (result: QueryResult, selection?: PlainTextSelection) => void
  /** Optional click handler for the source name in a group header. When
   *  omitted, the source name is plain text (popout mode — no document
   *  tabs to navigate to). */
  onOpenSource?: (sourceGuid: string) => void
  /** Optional sourceType resolver. Inline reads from store; popout
   *  falls back to filename detection inside ResultItem. */
  sourceTypeForGuid?: (sourceGuid: string) => SourceType | undefined
  pdfFilePathForGuid?: (sourceGuid: string) => string | undefined
  /** Optional resolver from sourceGuid to parsed survey data. Lets
   *  result rows render "Respondent N · Question N" for survey-cell
   *  matches. Inline mode pulls from the document store; popout mode
   *  reads from the init data sent over IPC. */
  surveyForGuid?: (sourceGuid: string) => SurveyData | undefined
  /** Optional missing-document warning (inline only — popout doesn't
   *  surface this currently). */
  missingDocuments?: string[]
}

export function QueryResultsBody({
  results,
  isActive,
  expandedKeys,
  toggleExpand,
  collapsedGroups,
  toggleGroup,
  sourceSelectionsByGuid,
  findCode,
  onOpenResult,
  onOpenSource,
  sourceTypeForGuid,
  pdfFilePathForGuid,
  surveyForGuid,
  missingDocuments
}: QueryResultsBodyProps) {
  const groups = useMemo(() => groupByDocument(results), [results])
  return (
    <>
      {!isActive && (
        <div className="empty-state" style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
          No active query.
          <br />
          Use the Query tool to create a new query.
        </div>
      )}
      {isActive && missingDocuments && missingDocuments.length > 0 && (
        <div
          style={{
            padding: '8px 12px',
            margin: '8px 8px 0',
            borderRadius: 'var(--radius-sm)',
            background: 'color-mix(in srgb, var(--warning, #e0a020) 12%, transparent)',
            border: '1px solid color-mix(in srgb, var(--warning, #e0a020) 30%, transparent)',
            fontSize: 'var(--font-size-sm)',
            color: 'var(--text-secondary)'
          }}
        >
          This query references {missingDocuments.length} document{missingDocuments.length !== 1 ? 's' : ''} no longer in the project.
        </div>
      )}
      {isActive && results.length === 0 && (
        <div className="empty-state" style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
          No matches found.
        </div>
      )}
      {groups.map((group) => {
        const isCollapsed = collapsedGroups.has(group.sourceGuid)
        return (
          <div key={group.sourceGuid}>
            <div
              className="query-results-group-header"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 10px',
                background: 'var(--bg-tertiary)',
                borderBottom: '1px solid var(--border-color)',
                cursor: 'pointer',
                userSelect: 'none',
                position: 'sticky',
                top: 0,
                zIndex: 1
              }}
              onClick={() => toggleGroup(group.sourceGuid)}
            >
              <Icon
                icon={isCollapsed ? faChevronRight : faChevronDown}
                style={{ fontSize: 9, width: 12, textAlign: 'center', opacity: 0.6 }}
              />
              <span
                style={{
                  fontSize: 'var(--font-size-sm)',
                  fontWeight: 600,
                  color: 'var(--text-secondary)',
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  cursor: onOpenSource ? 'pointer' : undefined
                }}
                onClick={onOpenSource
                  ? (e) => { e.stopPropagation(); onOpenSource(group.sourceGuid) }
                  : undefined}
                title={onOpenSource ? 'Open document' : undefined}
              >
                {group.sourceName}
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
                {group.results.length} match{group.results.length !== 1 ? 'es' : ''}
              </span>
            </div>

            {!isCollapsed && group.results.map((result) => {
              const key = `${result.sourceGuid}:${result.selectionGuid}`
              return (
                <ResultItem
                  key={key}
                  result={result}
                  isExpanded={expandedKeys.has(key)}
                  onToggleExpand={() => toggleExpand(key)}
                  onOpenResult={onOpenResult}
                  selections={sourceSelectionsByGuid.get(result.sourceGuid) || []}
                  findCode={findCode}
                  sourceType={sourceTypeForGuid?.(result.sourceGuid)}
                  pdfFilePath={pdfFilePathForGuid?.(result.sourceGuid)}
                  survey={surveyForGuid?.(result.sourceGuid)}
                />
              )
            })}
          </div>
        )
      })}
    </>
  )
}
