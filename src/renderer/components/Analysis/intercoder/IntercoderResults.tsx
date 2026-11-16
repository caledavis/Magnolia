/**
 * The Inter-coder Agreement results: the measure and view switches, the
 * table, and a clicked result's coded passages side by side. Shown in
 * the tool, or popped out into a window of its own (IntercoderResultsWindow),
 * which is sent everything it shows as IntercoderResultsData.
 */
import { useState, useMemo, useEffect, useLayoutEffect, useRef, Fragment } from 'react'
import {
  Icon,
  faXmark,
  faFile,
  faHeadphones,
  faVideo,
  faImage,
  faChevronDown,
  faChevronRight,
  faCircleInfo,
  faUpRightFromSquare,
  SURVEY_ICON,
  type IconComponent
} from '../../Icon'
import { useIconTint, iconTintKindForSourceType, PALETTE_ICON_CLASS, type IconTintKind } from '../../../utils/icon-tint'
import { SegmentedControl } from '../SegmentedControl'
import { formatTimestamp } from '../../../utils/timestamp-parser'
import { renderPdfRegionThumbnail } from '../../../utils/pdf-thumbnail'
import { renderImageRegionThumbnail } from '../../../utils/image-thumbnail'
import { mediaPathField } from '../../../utils/binary-handles'
import { useTranslation, Trans } from 'react-i18next'
import { formatNumber, formatPercent } from '../../../i18n'
import {
  codeSegments,
  passagesFor,
  surveyCells,
  type CoderProject,
  type MatchedDoc,
  type MatchedCode,
  type Measure,
  type Passage,
  type Segment
} from './intercoder-model'
import {
  metricColumns,
  metricValue,
  formatMetric,
  metricLabel,
  metricTitle,
  headerGroups,
  alphaChange,
  formatChange,
  changeLevel,
  asShown,
  columnGroup,
  tintScale,
  type ResultsView,
  tableRows,
  brennanPredigerLine,
  type IntercoderSnapshot,
  type MetricCol
} from './intercoder-tables'

const CONTEXT = 60

/** A clicked result: a code (and document, or all of them) for a pair. */
export interface Drill { codeKey: string; docKey: string | null; pair: number }

/** What a clicked result's passages are read from: the coders' projects
 *  (for the pop-out, only the documents being compared) and the code. */
export interface DrillData { coders: CoderProject[]; docs: MatchedDoc[]; code?: MatchedCode }

/** Everything the results show — what the pop-out window is sent. */
export interface IntercoderResultsData {
  snapshot: IntercoderSnapshot | null
  view: ResultsView
  measure: Measure
  threshold: number
  /** A coder's file couldn't be opened: these are the saved results. */
  showingSaved: boolean
  /** By coder needs three or more coders. */
  byCoderOffered: boolean
  /** Shown instead of the table when there are no results. */
  emptyMessage: string
  /** Document names by key, for documents the snapshot doesn't name. */
  docNames: Record<string, string>
  /** Codes whose documents are shown. */
  expanded: string[]
  drill: Drill | null
  drillData: DrillData | null
}

interface Props extends IntercoderResultsData {
  /** The scrolling area the results are in. */
  scroller: HTMLElement | null
  poppedOut: boolean
  onPopOut: () => void
  onView: (v: ResultsView) => void
  onMeasure: (m: Measure) => void
  onThreshold: (t: number) => void
  onToggleExpanded: (codeKey: string) => void
  onDrill: (d: Drill | null) => void
}

export function IntercoderResults(p: Props) {
  const { t } = useTranslation()
  const tint = useIconTint()
  const { snapshot, view, measure, threshold, showingSaved, byCoderOffered, drill, scroller } = p
  const expandedSet = useMemo(() => new Set(p.expanded), [p.expanded])

  // A clicked result's coded segments must always be in view, so the user
  // sees them change: while they're open the table is kept short (see the
  // table's box), and the tool scrolls down to the results (the measure
  // controls at its top), so the table and the start of the coding fill
  // the window.
  const resultsTopRef = useRef<HTMLDivElement>(null)
  const [scrollerHeight, setScrollerHeight] = useState(0)
  useLayoutEffect(() => {
    const el = scroller
    if (!el) return
    const measure = () => setScrollerHeight(el.clientHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [scroller])
  const tableBoxRef = useRef<HTMLDivElement>(null)
  const drillRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!drill) return
    const frame = requestAnimationFrame(() => {
      const sc = scroller
      const box = tableBoxRef.current
      const dd = drillRef.current
      if (!sc || !box || !dd) return
      // Keep the clicked result in view inside the (now shorter) table,
      // clear of its pinned header rows and code column.
      const cell = box.querySelector<HTMLElement>('td[data-selected]')
      if (cell) {
        const b = box.getBoundingClientRect()
        const c = cell.getBoundingClientRect()
        const headH = box.querySelector('thead')?.getBoundingClientRect().height ?? 0
        // Past the code column and the pinned all-coders column.
        const codeW = [...box.querySelectorAll<HTMLElement>('thead tr:first-child th[data-pinned]')].reduce((w, th) => w + th.getBoundingClientRect().width, 0)
        const bottom = b.top + box.clientHeight
        if (c.top < b.top + headH) box.scrollTop -= b.top + headH - c.top
        else if (c.bottom > bottom) box.scrollTop += c.bottom - bottom
        const rtl = getComputedStyle(box).direction === 'rtl'
        const start = rtl ? b.right - codeW : b.left + codeW
        if (!rtl && c.left < start) box.scrollLeft -= start - c.left
        if (rtl && c.right > start) box.scrollLeft += c.right - start
      }
      const view = sc.getBoundingClientRect()
      const top = (resultsTopRef.current ?? box).getBoundingClientRect().top
      sc.scrollTo({ top: sc.scrollTop + top - view.top - 6, behavior: 'smooth' })
    })
    return () => cancelAnimationFrame(frame)
  }, [drill, scroller])

  const cols: MetricCol[] = snapshot ? metricColumns(snapshot.measure, snapshot.coders.length, byCoderOffered ? view : 'pairs') : []
  const rows = snapshot ? tableRows(snapshot, expandedSet) : []
  // Where each column's group (all coders, a pair, a coder) starts and ends.
  const groupStarts = cols.map((c, i) => i === 0 || columnGroup(cols[i - 1]) !== columnGroup(c))
  const groupEnds = cols.map((c, i) => i === cols.length - 1 || columnGroup(cols[i + 1]) !== columnGroup(c))
  // The header's first row, measured so the second sticks just below it.
  const headRowRef = useRef<HTMLTableRowElement>(null)
  const [headRowHeight, setHeadRowHeight] = useState(0)
  useLayoutEffect(() => {
    const el = headRowRef.current
    if (!el) return
    const measure = () => setHeadRowHeight(el.getBoundingClientRect().height)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [snapshot !== null])
  // The all-coders column stays beside the code column when the table
  // scrolls sideways: each pair or coder is read against it (a coder's
  // "Alpha without" against everyone's alpha). Measure the code column
  // so the pinned column sits just past it.
  const pinFirst = cols.length > 0 && columnGroup(cols[0]) === 'all'
  const codeHeadRef = useRef<HTMLTableCellElement>(null)
  const [codeColWidth, setCodeColWidth] = useState(0)
  useLayoutEffect(() => {
    const el = codeHeadRef.current
    if (!el) return
    const measure = () => setCodeColWidth(el.getBoundingClientRect().width)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [snapshot !== null])
  const pinned = (top?: number): React.CSSProperties => ({
    position: 'sticky', insetInlineStart: codeColWidth, borderInlineEnd: '1px solid var(--border-color)',
    ...(top === undefined ? { zIndex: 1 } : { top, zIndex: 3 })
  })
  const bpLine = snapshot ? brennanPredigerLine(snapshot) : null
  const docNameOf = (key: string) => snapshot?.docs.find((d) => d.key === key)?.name ?? p.docNames[key] ?? ''

  return (
    <>
    {/* ── Results ── While a result's coded segments are open, the
        results take at least the tool's whole height, so the tool can
        always scroll down to them however short the segments are. */}
    <div style={{ minHeight: drill && !showingSaved ? Math.max(0, scrollerHeight - 20) : undefined }}>
    <div ref={resultsTopRef} style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '14px 0 8px', flexWrap: 'wrap' }}>
      {byCoderOffered && (
        <SegmentedControl
          label={t('analysis.view')}
          value={view}
          onChange={p.onView}
          options={[
            { value: 'pairs', label: t('intercoder.viewPairs'), title: t('intercoder.viewPairsTitle') },
            { value: 'coders', label: t('intercoder.viewCoders'), title: t('intercoder.viewCodersTitle') }
          ]}
        />
      )}
      <SegmentedControl
        label={t('intercoder.measure')}
        value={measure}
        onChange={p.onMeasure}
        options={[
          { value: 'characters', label: t('intercoder.measureCharacters'), title: t('intercoder.measureCharactersTitle') },
          { value: 'segments', label: t('intercoder.measureSegments'), title: t('intercoder.measureSegmentsTitle') }
        ]}
      />
      {measure === 'segments' && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-secondary)' }} title={t('intercoder.thresholdTitle')}>
          {t('intercoder.threshold')}
          <input
            type="range"
            className="themed-range"
            min={10}
            max={100}
            step={5}
            value={Math.round(threshold * 100)}
            onChange={(e) => p.onThreshold(Number(e.target.value) / 100)}
            style={{ width: 140, ['--filled' as string]: `${((Math.round(threshold * 100) - 10) / 90) * 100}%` }}
          />
          <span style={{ minWidth: 36 }}>{formatPercent(threshold * 100, 0)}</span>
        </label>
      )}
      <HowCalculated />
      <div style={{ flex: 1 }} />
      {/* Pop the results out into a window of their own (to put them
          on a bigger screen, say). The window has Pop back in in its
          header, as the other pop-outs do. */}
      {!p.poppedOut && (
        <button
          className="panel-header-popout"
          style={{ fontSize: 12 }}
          onClick={p.onPopOut}
          title={t('intercoder.popOutTitle')}
          aria-label={t('intercoder.popOutTitle')}
        >
          <Icon icon={faUpRightFromSquare} />
        </button>
      )}
    </div>

    {showingSaved && (
      <div style={noteStyle}>{t('intercoder.showingSaved')}</div>
    )}
    {snapshot && snapshot.results.skippedDocs.length > 0 && (
      <div style={noteStyle}>
        {t('intercoder.skippedNote', { names: snapshot.results.skippedDocs.map((s) => docNameOf(s.key)).join(', ') })}
      </div>
    )}
    {snapshot && snapshot.results.approxDocs.length > 0 && (
      <div style={noteStyle}>
        {t('intercoder.approxNote', { names: snapshot.results.approxDocs.map(docNameOf).join(', ') })}
      </div>
    )}

    {!snapshot ? (
      <div style={{ ...emptyPane, padding: '30px 20px', background: 'var(--bg-panel)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
        {p.emptyMessage}
      </div>
    ) : (
      // The table scrolls inside its own box — as wide as the tool and
      // no taller than the window, or under half of it while a result's
      // coded segments are open below — with its two header rows pinned
      // to the box's top and the code column to its side. The tool
      // itself only ever scrolls up and down.
      <div ref={tableBoxRef} style={{ overflow: 'auto', maxHeight: drill && !showingSaved ? drillTableHeight(scrollerHeight) : 'max(240px, calc(100vh - 200px))', background: 'var(--bg-panel)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
        <table style={{ borderCollapse: 'separate', borderSpacing: 0, fontSize: 12, minWidth: '100%' }}>
          <thead>
            <tr ref={headRowRef}>
              <th ref={codeHeadRef} data-pinned="" rowSpan={2} style={{ ...headStyle, ...stickyHead(0), insetInlineStart: 0, zIndex: 3, borderInlineEnd: '1px solid var(--border-color)', textAlign: 'start', minWidth: 220, cursor: 'help' }} title={t('intercoder.codeTitle')}>{t('intercoder.code')}</th>
              {headerGroups(snapshot, cols).map((g, k) => (
                <th key={k} colSpan={g.span} title={g.title} data-pinned={pinFirst && k === 0 ? '' : undefined} style={{ ...headStyle, ...stickyHead(0), ...(pinFirst && k === 0 ? pinned(0) : {}), textAlign: 'center', cursor: 'help' }}>{g.label}</th>
              ))}
            </tr>
            <tr>
              {cols.map((c, i) => (
                <th key={i} style={{ ...headStyle, ...stickyHead(headRowHeight), ...(pinFirst && i === 0 ? pinned(headRowHeight) : {}), fontWeight: 500, textAlign: 'center', cursor: 'help' }} title={metricTitle(c.metric, snapshot.measure)}>{metricLabel(c.metric)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isCode = r.kind === 'code'
              const code = r.codeKey ? snapshot.codes.find((c) => c.key === r.codeKey) : undefined
              return (
                <tr key={`${r.kind}|${r.codeKey ?? ''}|${r.docKey ?? ''}`} style={{ background: r.kind === 'overall' ? 'var(--bg-secondary)' : undefined }}>
                  <td style={{
                    ...cellStyle, textAlign: 'start', paddingInlineStart: r.kind === 'doc' ? 34 : 8, fontWeight: r.kind === 'overall' ? 600 : undefined,
                    // The code names stay in view when the table scrolls sideways.
                    position: 'sticky', insetInlineStart: 0, zIndex: 1, borderInlineEnd: '1px solid var(--border-color)',
                    background: r.kind === 'overall' ? 'var(--bg-secondary)' : 'var(--bg-panel)'
                  }} title={r.title ?? r.label}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                      {isCode && (
                        <span onClick={() => p.onToggleExpanded(r.codeKey!)} style={{ cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', width: 10 }} title={t('intercoder.showDocuments')}>
                          <Icon icon={expandedSet.has(r.codeKey!) ? faChevronDown : faChevronRight} style={{ fontSize: 10 }} />
                        </span>
                      )}
                      {isCode && <span style={{ width: 8, height: 8, borderRadius: '50%', background: code?.color || '#888', flexShrink: 0 }} />}
                      {r.kind === 'doc' && (() => {
                        const ic = docIcon(snapshot.docs.find((d) => d.key === r.docKey)?.sourceType)
                        return <Icon className={PALETTE_ICON_CLASS} icon={ic.icon} style={{ fontSize: 11, color: 'var(--text-muted)', ...(ic.tint ? tint(ic.tint) : {}) }} />
                      })()}
                      <span style={ellipsis}>{r.label}</span>
                    </div>
                  </td>
                  {cols.map((c, i) => {
                    const v = metricValue(r.cell, c, snapshot.measure)
                    const clickable = !showingSaved && r.kind !== 'overall' && c.pair !== null && r.codeKey
                    const isSel = !!drill && c.pair === drill.pair && r.codeKey === drill.codeKey && (r.docKey ?? null) === drill.docKey
                    return (
                      <td
                        key={i}
                        onClick={clickable ? () => p.onDrill({ codeKey: r.codeKey!, docKey: r.docKey ?? null, pair: c.pair! }) : undefined}
                        data-selected={isSel && groupStarts[i] ? '' : undefined}
                        title={clickable ? t('intercoder.showPassages') : undefined}
                        style={{
                          ...cellStyle,
                          textAlign: 'center',
                          cursor: clickable ? 'pointer' : undefined,
                          color: v === null ? 'var(--text-muted)' : undefined,
                          fontWeight: isCode || r.kind === 'overall' ? 600 : undefined,
                          // A line before each group's columns (all coders, a pair, a coder).
                          // (The first column's line is the code column's own edge.)
                          // (Not after the pinned column, which has its own.)
                          borderInlineStart: i > 0 && groupStarts[i] && !(pinFirst && i === 1) ? '1px solid var(--border-color)' : undefined,
                          boxShadow: isSel ? selectionOutline(groupStarts[i], groupEnds[i]) : undefined,
                          ...(pinFirst && i === 0 ? pinned() : {}),
                          background: cellBackground(
                            v !== null && tintScale(c.metric, snapshot.measure) ? strengthTint(v, tintScale(c.metric, snapshot.measure)!) : undefined,
                            // The pinned column covers what scrolls beneath it.
                            pinFirst && i === 0 ? (r.kind === 'overall' ? 'var(--bg-secondary)' : 'var(--bg-panel)') : undefined
                          )
                        }}
                      >
                        {formatMetric(v, c.metric)}
                        {(() => {
                          // Alpha without a coder: its change from everyone's alpha.
                          // Red or amber where agreement is clearly higher
                          // without the coder: they're out of step.
                          const d = alphaChange(r.cell, c, snapshot.measure)
                          if (d === null) return null
                          const level = changeLevel(d)
                          return (
                            <span title={t('intercoder.metricAlphaChangeTitle')} style={{
                              marginInlineStart: 5, fontSize: 10,
                              fontWeight: level ? 600 : 400,
                              color: level === 'clear' ? 'color-mix(in srgb, #d0473a 85%, var(--text-primary))'
                                : level === 'some' ? 'color-mix(in srgb, #d39b1a 65%, var(--text-primary))'
                                  : 'var(--text-muted)'
                            }}>({formatChange(d)})</span>
                          )
                        })()}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
        {bpLine && <div style={{ position: 'sticky', insetInlineStart: 0, padding: '6px 10px', fontSize: 11, color: 'var(--text-secondary)', borderTop: '1px solid var(--border-color)' }}>{bpLine}</div>}
      </div>
    )}

    {snapshot && drill && p.drillData && !showingSaved && (
      <div ref={drillRef}>
      <DrillDown
        coders={p.drillData.coders}
        docs={p.drillData.docs}
        code={p.drillData.code}
        pair={snapshot.results.pairs[drill.pair]}
        measure={measure}
        threshold={threshold}
        onClose={() => p.onDrill(null)}
      />
      </div>
    )}
    </div>
    </>
  )
}

export function docIcon(sourceType: string | undefined): { icon: IconComponent; tint?: IconTintKind } {
  if (sourceType === 'survey') return { icon: SURVEY_ICON, tint: 'survey' }
  const tint = iconTintKindForSourceType(sourceType ?? 'text')
  if (sourceType === 'audio') return { icon: faHeadphones, tint }
  if (sourceType === 'video') return { icon: faVideo, tint }
  if (sourceType === 'image') return { icon: faImage, tint }
  return { icon: faFile, tint }
}

/** The outline of a selected pair's cells: one box around them all, so
 *  the edges between the cells aren't drawn. `first` / `last` say whether
 *  the cell starts or ends the pair (in reading order: right to left in
 *  a right-to-left language). */
function selectionOutline(first: boolean, last: boolean): string {
  const rtl = document.documentElement.dir === 'rtl'
  const left = rtl ? last : first
  const right = rtl ? first : last
  const edges = ['inset 0 2px 0 0 var(--accent)', 'inset 0 -2px 0 0 var(--accent)']
  if (left) edges.push('inset 2px 0 0 0 var(--accent)')
  if (right) edges.push('inset -2px 0 0 0 var(--accent)')
  return edges.join(', ')
}

/** A soft green / amber / red wash for an agreement or kappa value, so
 *  weak agreement stands out. Kappa bands follow Landis & Koch loosely:
 *  ≥ 0.8 strong, ≥ 0.6 moderate, below that weak. */
/** A cell's shading, laid over an opaque base where the cell is pinned. */
function cellBackground(tint: string | undefined, base: string | undefined): string | undefined {
  if (!base) return tint
  return tint ? `linear-gradient(${tint}, ${tint}), ${base}` : base
}

function strengthTint(raw: number, scale: 'segments' | 'kappa' | 'alpha'): string | undefined {
  // Judge the value as shown (0.1% / two decimals), so a 0.7996 shown as
  // 0.80 is shaded as 0.80. Segment agreement: 80% good, 70% workable;
  // kappa and alpha: 0.80 strong, 0.60 moderate.
  const v = scale === 'segments' ? asShown(raw, 3) : asShown(raw, 2)
  const strong = 0.8
  const moderate = scale === 'segments' ? 0.7 : 0.6
  const colour = v >= strong ? '#2e9d5b' : v >= moderate ? '#d39b1a' : '#d0473a'
  return `color-mix(in srgb, ${colour} 13%, transparent)`
}

// ── Drill-down ─────────────────────────────────────────────────────────

function DrillDown({ coders, docs, code, pair, measure, threshold, onClose }: {
  coders: CoderProject[]
  docs: MatchedDoc[]
  code: MatchedCode | undefined
  pair: [number, number]
  measure: Measure
  threshold: number
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [showAgreed, setShowAgreed] = useState(false)
  const first = coders[pair[0]]
  const second = coders[pair[1]]

  const groups = useMemo(() => {
    if (!code || !first || !second) return []
    return docs
      .filter((d) => d.members[first.id] && d.members[second.id])
      .map((d) => {
        // All coders' segments, so a recording is compared the same way
        // (transcript or time) as in the table.
        const per = codeSegments(coders, d, code)
        return { doc: d, passages: passagesFor(per[pair[0]], per[pair[1]], measure, threshold) }
      })
      .filter((g) => g.passages.length > 0)
  }, [docs, code, coders, pair, first, second, measure, threshold])

  const shown = groups
    .map((g) => ({ ...g, passages: showAgreed ? g.passages : g.passages.filter((p) => !p.agreed) }))
    .filter((g) => g.passages.length > 0)
  const total = groups.reduce((n, g) => n + g.passages.length, 0)
  const disagreements = groups.reduce((n, g) => n + g.passages.filter((p) => !p.agreed).length, 0)

  if (!code || !first || !second) return null
  return (
    <div style={{ marginTop: 14, background: 'var(--bg-panel)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderBottom: '1px solid var(--border-color)' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: code.color || '#888' }} />
        <strong style={{ fontSize: 12 }}>{code.name}</strong>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {t('intercoder.passageCount', { count: total, disagreements })}
        </span>
        <div style={{ flex: 1 }} />
        <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={showAgreed} onChange={(e) => setShowAgreed(e.target.checked)} />
          {t('intercoder.showAgreed')}
        </label>
        <span onClick={onClose} title={t('common.close')} style={xStyle}><Icon icon={faXmark} style={{ fontSize: 11 }} /></span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)' }}>
        <div style={{ padding: '6px 10px' }}>{first.label}</div>
        <div style={{ padding: '6px 10px', borderInlineStart: '1px solid var(--border-color)' }}>{second.label}</div>
      </div>
      {shown.length === 0 ? (
        <div style={{ ...emptyPane, padding: 20 }}>{total === 0 ? t('intercoder.noPassages') : t('intercoder.noDisagreements')}</div>
      ) : shown.map((g) => (
        <Fragment key={g.doc.key}>
          <div style={{ padding: '6px 10px', fontSize: 11, fontWeight: 600, background: 'color-mix(in srgb, var(--text-secondary) 6%, var(--bg-panel))', borderBottom: '1px solid var(--border-color)' }}>
            {g.doc.name}
          </div>
          {g.passages.map((p, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: '1px solid var(--border-color)' }}>
              {[first, second].map((c, side) => (
                <div key={side} style={{ padding: '8px 10px', borderInlineStart: side ? '1px solid var(--border-color)' : undefined, minWidth: 0 }}>
                  <PassageView coder={c} doc={g.doc} passage={p} segs={side ? p.second : p.first} colour={code.color || '#888'} />
                </div>
              ))}
            </div>
          ))}
        </Fragment>
      ))}
    </div>
  )
}

const pageNumber = (line: string): number => Number(line.slice(1)) || 1

function PassageView({ coder, doc, passage, segs, colour }: {
  coder: CoderProject
  doc: MatchedDoc
  passage: Passage
  segs: Segment[]
  colour: string
}) {
  const { t } = useTranslation()
  const source = coder.sources.find((s) => s.guid === doc.members[coder.id])
  const notCoded = <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', marginBottom: 4 }}>{t('intercoder.notCoded')}</div>

  if (passage.ch === 'text') {
    const text = !source ? '' : passage.line ? surveyCells(source)[passage.line] ?? '' : coder.sourceContents[source.guid] ?? ''
    return (
      <>
        {segs.length === 0 && notCoded}
        <TextSnippet text={text} passage={passage} segs={segs} colour={colour} />
      </>
    )
  }

  if (passage.ch === 'time') {
    // A timeline coding's transcript text: the lines whose start time
    // falls in the passage (as Query Results shows it), with the lines in
    // this coder's ranges highlighted.
    const transcript = source ? coder.sourceContents[source.guid] ?? '' : ''
    const lineTimes = (source?.formatData as { lineTimes?: Record<string, number> } | undefined)?.lineTimes
    if (transcript && lineTimes) {
      const inRange = (secs: number, from: number, to: number) => secs * 1000 >= from - 0.5 && secs * 1000 < to - 0.1
      const lines = transcript.split('\n')
        .map((text, i) => ({ text, at: lineTimes[String(i)] }))
        .filter((l) => typeof l.at === 'number' && inRange(l.at, passage.start, passage.end))
      if (lines.length > 0) {
        return (
          <div dir="auto" style={{ fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--text-secondary)' }}>
            {segs.length === 0 && notCoded}
            {lines.map((l, i) => {
              const on = segs.some((s) => s.ch === 'time' && inRange(l.at!, s.start, s.end))
              return (
                <div key={i}>
                  <span style={on ? { background: `color-mix(in srgb, ${colour} 30%, transparent)`, color: 'var(--text-primary)', borderRadius: 2 } : undefined}>{l.text}</span>
                </div>
              )
            })}
          </div>
        )
      }
    }
    const span = Math.max(1, passage.end - passage.start)
    return (
      <div>
        {segs.length === 0 ? notCoded : segs.map((s, i) => s.ch === 'time' && (
          <div key={i} style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
            {formatTimestamp(s.start / 1000)} – {formatTimestamp(s.end / 1000)}
          </div>
        ))}
        <div style={{ position: 'relative', height: 8, marginTop: 6, background: 'var(--bg-tertiary)', borderRadius: 4 }}>
          {segs.map((s, i) => s.ch === 'time' && (
            <div key={i} style={{
              position: 'absolute', top: 0, bottom: 0, borderRadius: 4, background: colour,
              insetInlineStart: `${((s.start - passage.start) / span) * 100}%`,
              width: `${((s.end - s.start) / span) * 100}%`
            }} />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>
        {doc.sourceType === 'pdf' ? t('intercoder.page', { n: pageNumber(passage.line) }) : null}
      </div>
      {segs.length === 0 && notCoded}
      <RegionPreview coder={coder} sourceType={doc.sourceType} formatData={source?.formatData} passage={passage} segs={segs} colour={colour} />
    </div>
  )
}

/** The passage with some context, this coder's coded parts highlighted. */
function TextSnippet({ text, passage, segs, colour }: { text: string; passage: Passage; segs: Segment[]; colour: string }) {
  const chars = useMemo(() => Array.from(text), [text])
  const from = Math.max(0, passage.start - CONTEXT)
  const to = Math.min(chars.length, passage.end + CONTEXT)
  const pieces: { s: string; on: boolean }[] = []
  for (let i = from; i < to; ) {
    const on = segs.some((s) => s.ch === 'text' && i >= s.start && i < s.end)
    let j = i + 1
    while (j < to && segs.some((s) => s.ch === 'text' && j >= s.start && j < s.end) === on) j++
    pieces.push({ s: chars.slice(i, j).join(''), on })
    i = j
  }
  return (
    <div dir="auto" style={{ fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--text-secondary)' }}>
      {from > 0 && '…'}
      {pieces.map((p, i) => p.on
        ? <mark key={i} style={{ background: `color-mix(in srgb, ${colour} 30%, transparent)`, color: 'var(--text-primary)', borderRadius: 2 }}>{p.s}</mark>
        : <span key={i}>{p.s}</span>)}
      {to < chars.length && '…'}
    </div>
  )
}

/** The passage's bounding box (padded), with this coder's regions drawn
 *  on it. Shows the picture underneath when the file is the open
 *  project's; other projects' files show the outlines alone. */
function RegionPreview({ coder, sourceType, formatData, passage, segs, colour }: {
  coder: CoderProject
  sourceType?: string
  formatData: unknown
  passage: Passage
  segs: Segment[]
  colour: string
}) {
  const box = passage.box!
  const pad = Math.max(box.w, box.h) * 0.08
  const view = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), w: box.w + pad * 2, h: box.h + pad * 2 }
  const [img, setImg] = useState<string | null>(null)
  useEffect(() => {
    setImg(null)
    if (coder.filePath) return
    const field = mediaPathField(sourceType)
    const handle = field ? (formatData as Record<string, unknown> | undefined)?.[field] : undefined
    if (typeof handle !== 'string') return
    let cancelled = false
    const opts = { filePath: handle, x: view.x, y: view.y, width: view.w, height: view.h }
    const p = sourceType === 'pdf'
      ? renderPdfRegionThumbnail({ ...opts, page: pageNumber(passage.line) })
      : renderImageRegionThumbnail(opts)
    p.then((url) => { if (!cancelled) setImg(url) }).catch(() => {})
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coder.filePath, sourceType, formatData, passage.line, view.x, view.y, view.w, view.h])
  const maxW = 320
  const scale = Math.min(maxW / view.w, 200 / view.h)
  return (
    <div style={{ position: 'relative', width: view.w * scale, height: view.h * scale, background: 'var(--bg-tertiary)', borderRadius: 4, overflow: 'hidden' }}>
      {img && <img src={img} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />}
      <svg viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} preserveAspectRatio="none">
        {segs.map((s, i) => s.ch === 'region' && (
          <rect key={i} x={s.x} y={s.y} width={s.w} height={s.h} fill={colour} fillOpacity={0.25} stroke={colour} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
    </div>
  )
}

/** The (i) button beside the measure switch: how every figure in the
 *  results is worked out, both measures, with the formulas. */
function HowCalculated() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  // Placed against the window, not the tool (whose scrolling area would
  // clip it), and kept inside it.
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null)
  useEffect(() => {
    if (!open || !buttonRef.current) return
    const update = () => {
      const r = buttonRef.current!.getBoundingClientRect()
      const width = Math.min(440, window.innerWidth - 32)
      const rtl = getComputedStyle(buttonRef.current!).direction === 'rtl'
      const left = rtl ? Math.max(16, r.right - width) : Math.min(r.left, window.innerWidth - width - 16)
      const top = r.bottom + 6
      setPlace({ left, top, width, maxHeight: Math.max(160, window.innerHeight - top - 16) })
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [open])
  const heading: React.CSSProperties = { fontWeight: 600, fontSize: 12, marginBottom: 4 }
  const subheading: React.CSSProperties = { fontWeight: 600, fontSize: 11, margin: '8px 0 4px' }
  const rule: React.CSSProperties = { borderTop: '1px solid var(--border-color)', margin: '10px 0 8px' }
  const para = (k: string) => (
    <p key={k} style={{ margin: '0 0 6px', color: 'var(--text-secondary)' }}><Trans i18nKey={`intercoder.${k}`} components={{ b: <strong /> }} /></p>
  )
  const item = (k: string) => (
    <li style={{ marginBottom: 6 }}><Trans i18nKey={k} components={{ b: <strong /> }} /></li>
  )
  const section = (headingKey: string, keys: string[]) => (
    <>
      <div style={{ fontWeight: 600, fontSize: 11, margin: '8px 0 4px' }}>{t(headingKey)}</div>
      <ul style={{ margin: 0, paddingInlineStart: 16, color: 'var(--text-secondary)' }}>{keys.map((k) => <Fragment key={k}>{item(k)}</Fragment>)}</ul>
    </>
  )
  return (
    <div style={{ position: 'relative', display: 'flex' }}>
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        title={t('intercoder.howCalculated')}
        aria-label={t('intercoder.howCalculated')}
        style={{
          background: 'none', border: 'none', padding: 2,
          color: open ? 'var(--accent)' : 'var(--text-muted)',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}
      >
        <Icon icon={faCircleInfo} style={{ fontSize: 14 }} />
      </button>
      {open && place && (
        <>
          {/* Click-outside dismiss */}
          <div style={{ position: 'fixed', inset: 0, zIndex: 99 }} onClick={() => setOpen(false)} />
          <div
            style={{
              position: 'fixed', left: place.left, top: place.top,
              width: place.width, maxHeight: Math.min(520, place.maxHeight), overflow: 'auto', padding: '12px 14px',
              background: 'var(--bg-panel)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)',
              boxShadow: '0 4px 16px rgba(0,0,0,0.12)', fontSize: 11, lineHeight: 1.5, color: 'var(--text-primary)', zIndex: 100
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Three parts: which measure to use, what the results mean in
                plain words, and how they're calculated. */}
            <div style={heading}>{t('intercoder.choiceHeading')}</div>
            {para('choiceCharacters')}
            {para('choiceSegments')}
            {para('choiceBoth')}
            <MeasureDiagram />
            <div style={rule} />
            <div style={heading}>{t('intercoder.meaningHeading')}</div>
            <div style={subheading}>{t('intercoder.infoCharsHeading')}</div>
            {['meaningAgreement', 'meaningKappa', 'meaningExample', 'meaningScale', 'meaningAlpha'].map(para)}
            <div style={subheading}>{t('intercoder.infoSegmentsHeading')}</div>
            {['meaningSegments', 'meaningOverlap', 'meaningSegmentScale', 'meaningAvgAgreement'].map(para)}
            <div style={subheading}>{t('intercoder.viewCoders')}</div>
            {para('meaningByCoder')}
            {para('meaningAlphaWithoutColours')}
            <div style={rule} />
            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 2 }}>{t('intercoder.infoHeading')}</div>
            {section('intercoder.infoCharsHeading', ['intercoder.infoUnits', 'intercoder.infoPercent', 'intercoder.infoKappa', 'intercoder.infoAlpha', 'intercoder.infoTotals', 'intercoder.infoAllCodes'])}
            {section('intercoder.infoSegmentsHeading', ['intercoder.infoSegments', 'intercoder.infoAvgAgreement', 'intercoder.infoBp'])}
            {section('intercoder.viewCoders', ['intercoder.infoByCoder'])}
            {section('intercoder.infoNotesHeading', ['intercoder.infoNotes'])}
          </div>
        </>
      )}
    </div>
  )
}

/** The two measures side by side on the same pair of codings: coder 1
 *  codes characters 1–9, coder 2 characters 4–12, of 16. Characters
 *  compares each character; Segments compares the passages whole, by the
 *  share of what either coded that both coded (6 of 12 = 50%). */
function MeasureDiagram() {
  const { t } = useTranslation()
  const N = 16, CELL = 9, GAP = 2, X0 = 12
  const first = [1, 9], second = [4, 12]
  const inA = (i: number) => i >= first[0] && i <= first[1]
  const inB = (i: number) => i >= second[0] && i <= second[1]
  const x = (i: number) => X0 + i * (CELL + GAP)
  const coded = 'color-mix(in srgb, var(--accent) 55%, transparent)'
  const empty = 'color-mix(in srgb, var(--border-color) 70%, transparent)'
  const both = 'color-mix(in srgb, #2e9d5b 75%, transparent)'
  const one = 'color-mix(in srgb, #d0473a 75%, transparent)'
  // Neither coded it: agreement as well, in a paler green.
  const neither = 'color-mix(in srgb, #2e9d5b 30%, transparent)'
  const width = X0 + N * (CELL + GAP)
  const label = (y: number, text: string) => (
    <text x={0} y={y + CELL - 1} fontSize={9} fill="var(--text-muted)">{text}</text>
  )
  const cells = (y: number, fill: (i: number) => string) => Array.from({ length: N }, (_, i) => (
    <rect key={i} x={x(i)} y={y} width={CELL} height={CELL} rx={1.5} fill={fill(i)} />
  ))
  const span = (y: number, [a, b]: number[], fill: string, dashed = false) => (
    <rect x={x(a)} y={y} width={x(b) + CELL - x(a)} height={CELL} rx={2}
      fill={dashed ? 'none' : fill} stroke={dashed ? 'var(--text-muted)' : 'none'} strokeDasharray={dashed ? '3 2' : undefined} />
  )
  const shared = second[0] <= first[1] ? first[1] - second[0] + 1 : 0
  const union = Math.max(first[1], second[1]) - Math.min(first[0], second[0]) + 1
  const pct = formatPercent((shared / union) * 100, 0)
  const panel = (title: string, svg: React.ReactNode, caption: string) => (
    <div style={{ flex: '1 1 180px', minWidth: 0 }}>
      <div style={{ fontWeight: 600, fontSize: 11, marginBottom: 4 }}>{title}</div>
      <svg width={width} height={42} viewBox={`0 0 ${width} 42`} aria-hidden="true" style={{ display: 'block', maxWidth: '100%' }}>{svg}</svg>
      <div style={{ marginTop: 4, color: 'var(--text-secondary)', fontSize: 10.5, lineHeight: 1.4 }}>{caption}</div>
    </div>
  )
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', margin: '6px 0 4px', padding: '8px 10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)' }}>
      {panel(t('intercoder.measureCharacters'), <>
        {label(0, formatNumber(1))}{cells(0, (i) => (inA(i) ? coded : empty))}
        {label(12, formatNumber(2))}{cells(12, (i) => (inB(i) ? coded : empty))}
        {cells(30, (i) => (inA(i) && inB(i) ? both : inA(i) || inB(i) ? one : neither))}
      </>, t('intercoder.diagramCharacters'))}
      {panel(t('intercoder.measureSegments'), <>
        {label(0, formatNumber(1))}{span(0, first, coded)}
        {label(12, formatNumber(2))}{span(12, second, coded)}
        {span(30, [Math.min(first[0], second[0]), Math.max(first[1], second[1])], '', true)}
        {span(30, [second[0], first[1]], both)}
      </>, t('intercoder.diagramSegments', { shared: formatNumber(shared), union: formatNumber(union), pct }))}
    </div>
  )
}

export const btnStyle: React.CSSProperties = { fontSize: 11, padding: '4px 14px' }
export const smallBtn: React.CSSProperties = { fontSize: 10, padding: '2px 8px', display: 'inline-flex', alignItems: 'center', gap: 4 }
export const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', fontSize: 12, minWidth: 0 }
export const ellipsis: React.CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
export const xStyle: React.CSSProperties = { cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', flexShrink: 0, padding: 2 }
export const emptyPane: React.CSSProperties = { padding: '16px 10px', fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }
export const noteStyle: React.CSSProperties = { fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }
export const coderBadge: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, minWidth: 16, height: 16, lineHeight: '16px', textAlign: 'center',
  borderRadius: 8, background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', flexShrink: 0
}
export const countBadge: React.CSSProperties = {
  fontSize: 9, fontWeight: 600, padding: '0 5px', lineHeight: '14px', borderRadius: 7,
  background: 'var(--bg-tertiary)', color: 'var(--text-muted)', flexShrink: 0
}
/** A header cell pinned `top` px below the top of the table's box. */
export const stickyHead = (top: number): React.CSSProperties => ({ position: 'sticky', top, zIndex: 2 })

export const headStyle: React.CSSProperties = {
  background: 'var(--bg-secondary)',
  borderBottom: '1px solid var(--border-color)', padding: '6px 8px', fontSize: 11, fontWeight: 600,
  color: 'var(--text-secondary)', whiteSpace: 'nowrap'
}
export const cellStyle: React.CSSProperties = {
  borderBottom: '1px solid var(--border-color)', padding: '5px 8px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums'
}

/** The results table's height while a result's passages are open: short
 *  enough that the passages' first lines show below it in the tool's own
 *  scroll area (not the window, which also holds the panels below). */
function drillTableHeight(scrollerHeight: number): number {
  if (!scrollerHeight) return 180
  return Math.round(Math.max(120, Math.min(scrollerHeight * 0.45, scrollerHeight - 320)))
}

