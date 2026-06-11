/**
 * SurveyViewer — renders a survey source in one of three modes:
 *
 *   summary     Placeholder with a "to do" badge (per the spec we
 *               don't build the stats yet, just reserve the slot).
 *   respondent  One respondent's answers to every question, formatted
 *               as headings + per-cell text panes.
 *   question    All respondents' answers to one question.
 *
 * ── Architecture ──────────────────────────────────────────────────
 *
 * Each answer cell is rendered by its own <CodedTextView> — the same
 * component the plain-text document viewer uses. That means
 * everything CodedTextView provides — atom-by-atom highlighting,
 * blended overlapping codes, the right-margin bracket column with
 * code-name labels, content-memo underlines, quote underlines,
 * hover-locking, the right-click context menu — works in surveys for
 * free, because each cell IS a plain-text viewer.
 *
 * Survey-specific glue around CodedTextView:
 *
 *   - A `data-survey-cell` attribute on each cell wrapper lets the
 *     top-level mouseup handler resolve a native text selection (one
 *     drag, possibly across cells) into per-cell (start, end)
 *     ranges. CodedTextView's own onTextSelected is fed a no-op so
 *     we own the single source of pending state.
 *
 *   - All applied-code paths (drop, hotkey, +Code from the menu,
 *     Apply Code from the menu) iterate over `pending.cells` and
 *     create one selection + coding per cell, tagged with the
 *     `surveyCell` extension on PlainTextSelection.
 *
 *   - Content memos and quotes created from the survey context menu
 *     get the same `surveyCell` extension, so a re-render filters
 *     them to the cell they belong to and CodedTextView paints their
 *     underlines without any extra work.
 *
 *   - The right-click context menu is sourced from CodedTextView's
 *     `onCodingRightClick` callback for parity with the plain-text
 *     viewer; survey-specific items (multi-cell apply, surveyCell-
 *     scoped quotes / memos) wrap the same menu structure.
 *
 *   - Section headings between cells are stand-alone React elements
 *     (NavHeading) so they stay clickable for nav and aren't
 *     selectable text.
 *
 * The bracket overlay, label overlay, hover state, memo edit window,
 * everything else — none of it lives in this file. CodedTextView
 * owns those concerns.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Code,
  Memo,
  MemoEditInitData,
  PlainTextSelection,
  Quote,
  SurveyData,
  SurveyFormatData,
  SurveyQuestion,
  SurveyQuestionType,
  SurveyRespondent,
  TextSource
} from '../../models/types'
import { useSurveyViewStore, type SurveyViewMode } from '../../stores/survey-view-store'
import { useDocumentStore } from '../../stores/document-store'
import { useCodeStore } from '../../stores/code-store'
import { useMemoStore } from '../../stores/memo-store'
import { useQuoteStore } from '../../stores/quote-store'
import { usePendingSelectionStore } from '../../stores/pending-selection-store'
import { useNewCodeTriggerStore } from '../../stores/new-code-trigger-store'
import { CodedTextView, type CodingRightClickContext } from '../DocumentViewer/CodedTextView'
import { Icon, faCheck } from '../Icon'
import { MemoFab } from '../Memos/MemoFab'
import { cleanCellText, buildCellText } from '../../utils/survey/cell-text'
import { exportPdfWithHeader, buildPdfDocument, escHtml } from '../../utils/pdf-export'

interface Props {
  source: TextSource
}

// ── Helpers ────────────────────────────────────────────────────────

/** Strip embedded HTML / collapse whitespace for safe display.
 *  Delegates to the shared cleaner so the query engine's snippet
 *  recovery uses identical rules — survey selection offsets are
 *  codepoint offsets into THIS cleaned text. */
const clean = cleanCellText

/** Walk a DOM subtree to compute the character offset of (node, offset)
 *  relative to the subtree's `textContent`. Used to convert a native
 *  Selection range endpoint into a cell-relative offset. */
function offsetWithin(root: HTMLElement, node: Node, offset: number): number | null {
  if (!root.contains(node)) return null
  let total = 0
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let cur: Node | null = walker.nextNode()
  while (cur) {
    if (cur === node) return total + offset
    total += (cur.nodeValue || '').length
    cur = walker.nextNode()
  }
  if (node.nodeType === Node.ELEMENT_NODE && root.contains(node)) {
    let sum = 0
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let n: Node | null = tw.nextNode()
    while (n) {
      if ((node as HTMLElement).contains(n)) break
      sum += (n.nodeValue || '').length
      n = tw.nextNode()
    }
    return sum
  }
  return null
}

/** Cleaned cell text for an open-ended answer cell. Mirrors what the
 *  CodedTextView renders, so survey selection offsets index into the
 *  result. Delegates to the shared helper used by the query engine. */
const buildOpenEndedText = buildCellText

/** Walk up from `el` (inclusive of its parents) until we find the
 *  scroll container — used by the scrollTarget effect to offset the
 *  scroll position by the sticky header's height. Stops at `boundary`
 *  if that's hit first; returns null when no scrollable ancestor is
 *  found before the boundary. */
function findScrollContainer(el: HTMLElement, boundary: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = el.parentElement
  while (cur && cur !== boundary) {
    const overflowY = getComputedStyle(cur).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return cur
    cur = cur.parentElement
  }
  return null
}

// ── Aggregate stats per question ──────────────────────────────────

interface OptionTally {
  /** Canonical option text — same as the respondent's stored answer
   *  for that option (e.g. "Never 1"). Used to match against `chosen`
   *  selections in Respondent view, so don't reformat it. */
  option: string
  /** Optional pretty form for display only. Populated for rating-scale
   *  single-choice questions, where we flip "Never 1" → "1 Never" so
   *  the numeric value reads first. Falls back to `option` when
   *  unset. */
  displayOption?: string
  count: number
  pct: number
}

/** Count distinct cleaned answers for a single-choice question.
 *  Sorted by count descending — except for rating-scale questions
 *  (where most distinct options resolve to a number, either via
 *  `extractRatingValue` — "Never 1", "2", "Always 5" — or via
 *  `extractOrdinalValue` — "First", "Second", "Third"), which sort by
 *  that numeric value ascending so the scale reads low → high.
 *
 *  Catch-all options that don't resolve ("Other", "Prefer not to
 *  say", "N/A") are tolerated: as long as a strict majority of
 *  options resolves, scale ordering applies and the unresolved
 *  outliers fall to the end in count-descending order. */
function computeSingleChoiceDistribution(
  survey: SurveyData,
  question: SurveyQuestion
): OptionTally[] {
  const counts = new Map<string, number>()
  let total = 0
  for (const r of survey.respondents) {
    const ans = r.answers[question.id]
    if (typeof ans !== 'string') continue
    const cleaned = clean(ans)
    if (!cleaned) continue
    counts.set(cleaned, (counts.get(cleaned) ?? 0) + 1)
    total++
  }
  const arr: OptionTally[] = []
  const ratingValues = new Map<string, number>()
  for (const [option, count] of counts.entries()) {
    arr.push({ option, count, pct: total > 0 ? count / total : 0 })
    // Try the embedded-number form first ("Never 1", "3"); fall back
    // to ordinal-word form ("First", "Second"). Options that resolve
    // join the scale; unresolved options ("Other", "N/A") are
    // tolerated as outliers if the majority resolves.
    const v = extractRatingValue(option) ?? extractOrdinalValue(option)
    if (v != null) ratingValues.set(option, v)
  }
  // Scale sort kicks in only when at least 2 options resolve AND a
  // strict majority of options resolve. The 2-minimum keeps an
  // accidental single ordinal match from triggering scale ordering on
  // an otherwise categorical question.
  const resolved = ratingValues.size
  const isScale = resolved >= 2 && resolved * 2 > arr.length
  if (isScale) {
    arr.sort((a, b) => {
      const av = ratingValues.get(a.option)
      const bv = ratingValues.get(b.option)
      // Resolved options first, in numeric order.
      if (av != null && bv != null) return av - bv || a.option.localeCompare(b.option)
      if (av != null) return -1
      if (bv != null) return 1
      // Unresolved outliers among themselves: count descending.
      return b.count - a.count || a.option.localeCompare(b.option)
    })
    // Number-first display: "Never 1" → "1 Never", "Always 5" →
    // "5 Always". Only fires for the embedded-number form — for
    // ordinal-word options ("First", "Second") we keep the original
    // spelling, so we check that stripping the trailing number
    // actually changed the text before flipping.
    for (const t of arr) {
      const cleanedOpt = clean(t.option)
      const label = extractRatingLabel(t.option)
      if (!label || label === cleanedOpt) continue
      const v = ratingValues.get(t.option)
      if (v != null) t.displayOption = `${v} ${label}`
    }
  } else {
    arr.sort((a, b) => b.count - a.count || a.option.localeCompare(b.option))
  }
  return arr
}

/** For multi-select, the option list is authoritative (from
 *  question.columns) — we iterate it instead of distinct cell
 *  values so unselected options still appear. Denominator is the
 *  total respondent count (each respondent could have picked the
 *  option or not). Result is sorted by percentage descending so the
 *  most-picked option reads first; option label is the stable
 *  tiebreaker when two options tie. */
function computeMultiSelectDistribution(
  survey: SurveyData,
  question: SurveyQuestion
): OptionTally[] {
  const total = survey.respondents.length
  const out: OptionTally[] = []
  for (const col of question.columns) {
    const label = col.optionLabel || '(unlabeled)'
    let count = 0
    for (const r of survey.respondents) {
      const ans = r.answers[question.id]
      if (Array.isArray(ans) && ans.some((v) => clean(v) === clean(label))) count++
    }
    out.push({ option: label, count, pct: total > 0 ? count / total : 0 })
  }
  out.sort((a, b) => b.pct - a.pct || a.option.localeCompare(b.option))
  return out
}

interface NumericStats {
  values: number[]
  min: number
  q1: number
  median: number
  q3: number
  max: number
  mean: number
  /** Most-frequent value. When there's a tie, the smallest of the
   *  tied values is reported. */
  mode: number
}

/** Extract the numeric value from a survey rating-scale answer.
 *
 * SurveyMonkey embeds the label inline with the number for the
 * endpoints of a scale ("Never<br>1", "Always<br>5"), so the cleaned
 * cell text comes through as "Never 1" / "Always 5". `parseFloat`
 * of the whole string returns NaN for those, which previously
 * dropped them from the box plot — and since those are the
 * endpoints, the X axis ended up running from e.g. 2 to 4 instead
 * of 1 to 5.
 *
 * Strategy: pull every numeric token out of the cleaned string and
 * take the last one. For the SurveyMonkey format the label sits at
 * the start and the number at the end, so "the last number" is
 * always the right value. Plain numbers ("2", "3.5") still work
 * because the whole string is the only token. */
function extractRatingValue(raw: string): number | null {
  const cleaned = clean(raw)
  if (!cleaned) return null
  const matches = cleaned.match(/[-+]?\d+(?:\.\d+)?/g)
  if (!matches || matches.length === 0) return null
  const last = parseFloat(matches[matches.length - 1])
  return isNaN(last) ? null : last
}

/** English ordinal words → number, for surveys whose options are
 *  "First" / "Second" / "Third" etc. instead of digits. Covers the
 *  realistic range for a survey scale; anything past 20 falls back
 *  to count-descending sort. Match is case-insensitive and looks at
 *  word tokens, so "First choice", "the second one" etc. still
 *  resolve. */
const ORDINAL_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14,
  fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18,
  nineteenth: 19, twentieth: 20
}

function extractOrdinalValue(raw: string): number | null {
  const cleaned = clean(raw).toLowerCase()
  if (!cleaned) return null
  for (const word of cleaned.split(/\W+/)) {
    if (word && Object.prototype.hasOwnProperty.call(ORDINAL_WORDS, word)) {
      return ORDINAL_WORDS[word]
    }
  }
  return null
}

/** Extract the textual label part of a rating-scale answer. For
 *  "Never 1" returns "Never"; for "Always 5" returns "Always"; for
 *  "2" (no label) returns ""; useful for showing the named endpoints
 *  under the box plot's X axis ticks. */
function extractRatingLabel(raw: string): string {
  const cleaned = clean(raw)
  if (!cleaned) return ''
  // Strip a trailing number (with optional sign / decimal) so what
  // remains is the label text. Trim to handle the gap that clean()
  // left where the original `<br>` was.
  return cleaned.replace(/\s*[-+]?\d+(?:\.\d+)?\s*$/, '').trim()
}

/** Walk every respondent's answer for `question` and harvest the
 *  value → label pairing. The first non-empty label wins per value;
 *  values without a label aren't added. */
function computeValueLabels(survey: SurveyData, question: SurveyQuestion): Map<number, string> {
  const out = new Map<number, string>()
  for (const r of survey.respondents) {
    const ans = r.answers[question.id]
    if (typeof ans !== 'string') continue
    const v = extractRatingValue(ans)
    if (v == null) continue
    if (out.has(v)) continue
    const label = extractRatingLabel(ans)
    if (label) out.set(v, label)
  }
  return out
}

function computeNumericStats(survey: SurveyData, question: SurveyQuestion): NumericStats | null {
  const vals: number[] = []
  for (const r of survey.respondents) {
    const ans = r.answers[question.id]
    if (typeof ans !== 'string') continue
    const num = extractRatingValue(ans)
    if (num != null) vals.push(num)
  }
  if (vals.length === 0) return null
  vals.sort((a, b) => a - b)
  const quantile = (p: number) => {
    const i = (vals.length - 1) * p
    const lo = Math.floor(i)
    const hi = Math.ceil(i)
    return lo === hi ? vals[lo] : vals[lo] + (vals[hi] - vals[lo]) * (i - lo)
  }
  const mean = vals.reduce((sum, v) => sum + v, 0) / vals.length
  // Mode: most-frequent value; ties resolved by picking the smallest
  // of the tied values (which matches the sort order, since we walk
  // ascending and only replace on strictly greater counts).
  const counts = new Map<number, number>()
  for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1)
  let mode = vals[0]
  let bestCount = 0
  for (const v of vals) {
    const c = counts.get(v)!
    if (c > bestCount) { bestCount = c; mode = v }
  }
  return {
    values: vals,
    min: vals[0],
    q1: quantile(0.25),
    median: quantile(0.5),
    q3: quantile(0.75),
    max: vals[vals.length - 1],
    mean,
    mode
  }
}

function formatPct(p: number): string {
  return `${Math.round(p * 100)}%`
}

/** Display helper: integers stay bare, floats round to 2 dp with
 *  trailing zeros trimmed. Used for the box plot's summary line so
 *  rating-scale numbers ("3", "4") aren't shown as "3.00". */
function formatStat(n: number): string {
  if (Number.isInteger(n)) return String(n)
  return Number(n.toFixed(2)).toString()
}

/** PlainTextSelections re-projected onto one cell — kept as the
 *  PlainTextSelection shape so they can be passed straight into
 *  CodedTextView's `selections` prop. start/end on the originals are
 *  already cell-relative when surveyCell is set, so we just filter. */
function selectionsForCell(
  allSelections: PlainTextSelection[],
  respondentId: string,
  questionId: string
): PlainTextSelection[] {
  return allSelections.filter(
    (s) =>
      s.surveyCell &&
      s.surveyCell.respondentId === respondentId &&
      s.surveyCell.questionId === questionId
  )
}

/** Content memos filtered to a cell. */
function memosForCell(
  memos: Memo[],
  sourceGuid: string,
  respondentId: string,
  questionId: string
): Memo[] {
  return memos.filter(
    (m) =>
      m.type === 'content' &&
      m.sourceGuid === sourceGuid &&
      m.surveyCell &&
      m.surveyCell.respondentId === respondentId &&
      m.surveyCell.questionId === questionId
  )
}

/** Quotes filtered to a cell. CodedTextView expects them as
 *  { guid, startCp, endCp }. */
function quoteRangesForCell(
  quotes: Quote[],
  sourceGuid: string,
  respondentId: string,
  questionId: string
): { guid: string; startCp: number; endCp: number }[] {
  return quotes
    .filter(
      (q) =>
        q.sourceGuid === sourceGuid &&
        q.surveyCell &&
        q.surveyCell.respondentId === respondentId &&
        q.surveyCell.questionId === questionId
    )
    .map((q) => ({ guid: q.guid, startCp: q.startPosition, endCp: q.endPosition }))
}

// ── Question-type badge ────────────────────────────────────────────
//
// Click-to-edit dropdown that reveals the detected question type
// next to a heading and lets the user override it. The display
// updates immediately because the SurveyViewer dispatches per
// question.type, so re-typing a question to "numeric" flips the
// cell from a single-choice option list to a box plot on the next
// render.

const TYPE_LABEL: Record<SurveyQuestionType, string> = {
  'open-ended': 'Open-ended',
  'single-choice': 'Single choice',
  numeric: 'Numeric',
  'multi-select': 'Multi-select'
}

/** Allowed conversions depend on column shape: single-column
 *  questions can swap among the single-column types; multi-column
 *  questions stay as multi-select. */
function allowedTypesFor(question: SurveyQuestion): SurveyQuestionType[] {
  if (question.columns.length > 1) return ['multi-select']
  return ['open-ended', 'single-choice', 'numeric']
}

function QuestionTypeBadge({
  question,
  onChange
}: {
  question: SurveyQuestion
  onChange: (next: SurveyQuestionType) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement | null>(null)

  // Close on outside-click / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const allowed = allowedTypesFor(question)
  const isClickable = allowed.length > 1

  return (
    <span
      ref={ref}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        padding: '1px 6px',
        borderRadius: 3,
        fontSize: 10,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        color: 'var(--text-muted)',
        background: 'var(--bg-tertiary)',
        cursor: isClickable ? 'pointer' : 'default',
        userSelect: 'none',
        // Stay on one line. Without this the flex parent will let
        // the badge wrap ("MULTI-SELECT" → "MULTI-" / "SELECT")
        // when the heading row runs out of horizontal room.
        whiteSpace: 'nowrap',
        flexShrink: 0
      }}
      title={isClickable ? 'Click to change the detected question type' : undefined}
      onClick={(e) => {
        if (!isClickable) return
        e.stopPropagation()
        setOpen((v) => !v)
      }}
    >
      {TYPE_LABEL[question.type]}
      {isClickable && (
        <span style={{ fontSize: 8, lineHeight: 1, marginLeft: 1 }}>▾</span>
      )}
      {open && (
        <div
          className="context-menu"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            zIndex: 1000,
            minWidth: 140,
            // Reset inherited styling from the badge so the menu reads
            // exactly like every other context menu in the app:
            // mixed case, normal weight, no letter-spacing.
            textTransform: 'none',
            letterSpacing: 'normal',
            fontWeight: 'normal'
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {allowed.map((t) => (
            <div
              key={t}
              className="context-menu-item"
              onClick={(e) => {
                e.stopPropagation()
                if (t !== question.type) onChange(t)
                setOpen(false)
              }}
            >
              {TYPE_LABEL[t]}
            </div>
          ))}
        </div>
      )}
    </span>
  )
}

// ── Headings ───────────────────────────────────────────────────────

function NavHeading({
  number,
  label,
  onClick
}: {
  number?: number
  label: string
  onClick: () => void
}) {
  const onEnter = (e: React.MouseEvent<HTMLElement>) => {
    e.currentTarget.style.color = 'var(--accent)'
  }
  const onLeave = (e: React.MouseEvent<HTMLElement>) => {
    e.currentTarget.style.color = 'var(--text-secondary)'
  }
  // Numbered headings use a 2-column flex layout so wrapped lines
  // line up under the text instead of under the number — i.e. a
  // hanging indent. Variable number widths (1 vs 28 vs 128) are
  // handled naturally because the number column shrinks to fit.
  if (number != null) {
    return (
      <h2
        onClick={onClick}
        style={{ ...sectionHeadingStyle, display: 'flex', alignItems: 'baseline', gap: 8 }}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
      >
        <span style={{ flexShrink: 0 }}>{number}.</span>
        <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
      </h2>
    )
  }
  return (
    <h2
      onClick={onClick}
      style={sectionHeadingStyle}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {label}
    </h2>
  )
}

// ── Display-only cells for closed / numeric questions ─────────────
//
// These cells are NOT codable — only open-ended (free-text) cells
// get a CodedTextView. The text inside these display cells uses
// `user-select: none` so a drag inside one won't even create a
// browser selection (so the survey-cell drag-to-code gesture stays
// scoped to free-text answers).

/** Single-choice / multi-select option list. The respondent's own
 *  selections are bold; every option also shows the proportion of
 *  respondents that picked it. Used in both Respondent and Question
 *  views; in Question view the `chosen` set is empty so nothing is
 *  bold (it reads as a pure distribution).
 *
 *  `compact` shrinks the option-label font from 14 → 12 so the list
 *  matches the smaller text of the summary table. Default 14 keeps
 *  the standalone Question/Respondent views readable. */
function OptionListCell({
  options,
  chosen,
  compact = false,
  showSwatches = false
}: {
  options: OptionTally[]
  chosen: Set<string>
  compact?: boolean
  /** When set, the reserved left column shows a colour swatch per
   *  option (matching DonutChart's `segmentColor(index)`) instead of
   *  staying blank, so the list doubles as the donut's legend. */
  showSwatches?: boolean
}) {
  if (options.length === 0) {
    return <div style={emptyAnswerStyle}>(no responses)</div>
  }
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0 12px 0', userSelect: 'none' }}>
      {options.map((d, i) => {
        const isChosen = chosen.has(clean(d.option))
        return (
          <li
            key={d.option}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '2px 0',
              fontSize: compact ? 12 : 14,
              lineHeight: 1.5,
              fontWeight: isChosen ? 700 : 400,
              color: isChosen ? 'var(--text-primary)' : 'var(--text-secondary)'
            }}
          >
            {/* Reserved-width left column so every row's label starts at
                the same x. Holds the donut-legend colour swatch when
                showSwatches; otherwise stays blank. The chosen tick now
                sits next to the option label rather than replacing the
                swatch here, so the legend stays intact. */}
            <span
              style={{
                width: 14,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0
              }}
            >
              {showSwatches && (
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: 2,
                    background: segmentColor(i),
                    display: 'inline-block'
                  }}
                />
              )}
            </span>
            <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ minWidth: 0 }}>{d.displayOption ?? d.option}</span>
              {isChosen && (
                <Icon icon={faCheck} style={{ fontSize: 12, color: 'var(--accent)', flexShrink: 0 }} />
              )}
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', minWidth: 40, textAlign: 'right' }}>
              {formatPct(d.pct)}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/** Categorical palette for donut segments (and the matching list
 *  swatches). Apple system colours, picked to stay distinguishable
 *  on both light and dark themes; cycles if a question has more
 *  options than colours. Kept fixed rather than derived from
 *  --accent so segments don't all collapse to one hue. */
const SEGMENT_PALETTE = [
  '#007AFF', '#34c759', '#ff9500', '#af52de', '#ff2d55',
  '#5ac8fa', '#ffcc00', '#5856d6', '#30b0c7', '#a2845e'
]

function segmentColor(index: number): string {
  return SEGMENT_PALETTE[index % SEGMENT_PALETTE.length]
}

/** Donut chart of a single-choice answer distribution. Segments are
 *  drawn with the stroke-dasharray ring trick (one <circle> per
 *  option) rather than arc paths, so the geometry stays trivial.
 *  Colours come from `segmentColor(index)`, matching the swatches an
 *  OptionListCell renders when `showSwatches` is set — the two read
 *  as one chart + legend. Returns null when there are no responses
 *  (the sibling OptionListCell already shows "(no responses)"). */
function DonutChart({
  options,
  size = 72,
  thickness = 14
}: {
  options: OptionTally[]
  size?: number
  thickness?: number
}) {
  const total = options.reduce((sum, d) => sum + d.count, 0)
  if (total === 0) return null
  const cx = size / 2
  const cy = size / 2
  const radius = (size - thickness) / 2
  const circ = 2 * Math.PI * radius
  let offset = 0
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ flexShrink: 0, marginTop: 6 }}
      role="img"
      aria-label="Answer distribution"
    >
      {/* Track behind the segments so sub-pixel rounding between
          slices never reads as a gap in the ring. */}
      <circle cx={cx} cy={cy} r={radius} fill="none" stroke="var(--bg-tertiary)" strokeWidth={thickness} />
      {/* Rotate so the first segment starts at 12 o'clock. */}
      <g transform={`rotate(-90 ${cx} ${cy})`}>
        {options.map((d, i) => {
          const dash = (d.count / total) * circ
          const seg = (
            <circle
              key={d.option}
              cx={cx}
              cy={cy}
              r={radius}
              fill="none"
              stroke={segmentColor(i)}
              strokeWidth={thickness}
              strokeDasharray={`${dash} ${circ - dash}`}
              strokeDashoffset={-offset}
            >
              <title>{`${d.displayOption ?? d.option}: ${formatPct(d.pct)} (${d.count})`}</title>
            </circle>
          )
          offset += dash
          return seg
        })}
      </g>
    </svg>
  )
}

/** Compute axis tick positions covering [min, max]. For tight
 *  rating-scale ranges every integer gets a tick; for wider ranges
 *  the step grows so the axis stays at ~5–15 ticks regardless. */
function computeAxisTicks(min: number, max: number): number[] {
  const lo = Math.floor(min)
  const hi = Math.ceil(max)
  const span = hi - lo
  if (span <= 0) return [lo]
  // Pick a step that keeps tick count manageable.
  const candidates = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000]
  let step = 1
  for (const c of candidates) {
    if (span / c <= 15) { step = c; break }
    step = c
  }
  const ticks: number[] = []
  // Snap start to a multiple of step for clean labels.
  const start = Math.floor(lo / step) * step
  for (let v = start; v <= hi; v += step) {
    if (v >= lo) ticks.push(v)
  }
  if (ticks.length === 0) ticks.push(lo)
  if (ticks[ticks.length - 1] < hi) ticks.push(hi)
  return ticks
}

/** Box plot for a numeric question. `highlightValue` (Respondent
 *  view) marks where the active respondent's value sits on the
 *  distribution; Question view omits it for a pure aggregate.
 *  `valueLabels` (e.g. {1: "Never", 5: "Always"}) renders the
 *  named endpoints under the matching tick numbers — the survey
 *  data carries those labels inline with the rating ("Never 1") and
 *  showing them disambiguates the otherwise-bare 1-5 scale. */
function NumericBoxPlot({
  stats,
  highlightValue,
  valueLabels
}: {
  stats: NumericStats | null
  highlightValue?: number
  valueLabels?: Map<number, string>
}) {
  if (!stats) {
    return <div style={emptyAnswerStyle}>(no numeric responses)</div>
  }
  // Layout: box plot up top, X axis below with tick marks +
  // number labels + (optional) named-label row underneath.
  // Padding on each side is sized so a centred axis label (e.g.
  // "Never", "Always") at the first / last tick has room to render
  // without crossing the SVG's left / right edge.
  const W = 360
  const PAD_LEFT = 36
  const PAD_RIGHT = 36
  const BOX_TOP = 8
  const BOX_BOTTOM = 36
  const AXIS_Y = 48
  const TICK_LEN = 4
  const NUM_LABEL_Y = AXIS_Y + TICK_LEN + 10
  const TEXT_LABEL_Y = NUM_LABEL_Y + 12
  const hasAnyText = valueLabels != null && valueLabels.size > 0
  const H = (hasAnyText ? TEXT_LABEL_Y : NUM_LABEL_Y) + 4

  // Axis range = full integer span covering [min, max]. We extend
  // beyond stats.min / stats.max so the axis labels line up neatly
  // at integer boundaries.
  const ticks = computeAxisTicks(stats.min, stats.max)
  const axisMin = ticks[0]
  const axisMax = ticks[ticks.length - 1]
  const range = axisMax - axisMin || 1
  const x = (v: number) => PAD_LEFT + ((v - axisMin) / range) * (W - PAD_LEFT - PAD_RIGHT)

  const midY = (BOX_TOP + BOX_BOTTOM) / 2
  const whiskerHalf = 5

  return (
    <div style={{ userSelect: 'none', margin: '4px 0 12px 0' }}>
      <svg width={W} height={H} style={{ display: 'block', overflow: 'visible' }}>
        {/* Whiskers (horizontal) */}
        <line x1={x(stats.min)} x2={x(stats.q1)} y1={midY} y2={midY} stroke="var(--text-muted)" strokeWidth={1} />
        <line x1={x(stats.q3)} x2={x(stats.max)} y1={midY} y2={midY} stroke="var(--text-muted)" strokeWidth={1} />
        {/* Whisker caps (vertical) */}
        <line x1={x(stats.min)} x2={x(stats.min)} y1={midY - whiskerHalf} y2={midY + whiskerHalf} stroke="var(--text-muted)" strokeWidth={1} />
        <line x1={x(stats.max)} x2={x(stats.max)} y1={midY - whiskerHalf} y2={midY + whiskerHalf} stroke="var(--text-muted)" strokeWidth={1} />
        {/* Box: q1 → q3 */}
        <rect
          x={x(stats.q1)}
          y={BOX_TOP}
          width={x(stats.q3) - x(stats.q1)}
          height={BOX_BOTTOM - BOX_TOP}
          fill="var(--accent-soft, var(--bg-tertiary))"
          stroke="var(--accent)"
          strokeWidth={1}
        />
        {/* Median */}
        <line x1={x(stats.median)} x2={x(stats.median)} y1={BOX_TOP} y2={BOX_BOTTOM} stroke="var(--accent)" strokeWidth={2} />
        {/* Respondent's value marker */}
        {highlightValue != null && (
          <circle
            cx={x(highlightValue)}
            cy={midY}
            r={5}
            fill="var(--text-primary)"
            stroke="var(--bg-panel)"
            strokeWidth={2}
          />
        )}
        {/* X axis */}
        <line x1={x(axisMin)} x2={x(axisMax)} y1={AXIS_Y} y2={AXIS_Y} stroke="var(--text-muted)" strokeWidth={1} />
        {ticks.map((t) => {
          const namedLabel = valueLabels?.get(t)
          return (
            <g key={t}>
              <line
                x1={x(t)}
                x2={x(t)}
                y1={AXIS_Y}
                y2={AXIS_Y + TICK_LEN}
                stroke="var(--text-muted)"
                strokeWidth={1}
              />
              <text
                x={x(t)}
                y={NUM_LABEL_Y}
                fontSize={10}
                fill="var(--text-muted)"
                textAnchor="middle"
              >
                {t}
              </text>
              {namedLabel && (
                <text
                  x={x(t)}
                  y={TEXT_LABEL_Y}
                  fontSize={9}
                  fill="var(--text-muted)"
                  textAnchor="middle"
                  fontStyle="italic"
                >
                  {namedLabel}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 14 }}>
        <span>n = {stats.values.length}</span>
        <span>mean {formatStat(stats.mean)}</span>
        <span>median {formatStat(stats.median)}</span>
        <span>mode {formatStat(stats.mode)}</span>
        <span>IQR {formatStat(stats.q1)}–{formatStat(stats.q3)}</span>
        {highlightValue != null && (
          <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
            this respondent: {formatStat(highlightValue)}
          </span>
        )}
      </div>
    </div>
  )
}

// ── Cell wrapper ───────────────────────────────────────────────────

interface CellProps {
  source: TextSource
  respondentId: string
  questionId: string
  text: string
  codes: Code[]
  memos: Memo[]
  quotes: Quote[]
  onTextSelected: (cellId: { respondentId: string; questionId: string }, startCp: number, endCp: number, text: string) => void
  onCodingRightClick: (
    cellId: { respondentId: string; questionId: string },
    e: React.MouseEvent,
    ctx: CodingRightClickContext
  ) => void
  onMemoClick: (memoGuid: string) => void
}

function SurveyCell({
  source,
  respondentId,
  questionId,
  text,
  codes,
  memos,
  quotes,
  onTextSelected,
  onCodingRightClick,
  onMemoClick
}: CellProps) {
  const selections = useMemo(
    () => selectionsForCell(source.selections, respondentId, questionId),
    [source.selections, respondentId, questionId]
  )
  const cellMemos = useMemo(
    () => memosForCell(memos, source.guid, respondentId, questionId),
    [memos, source.guid, respondentId, questionId]
  )
  const cellQuotes = useMemo(
    () => quoteRangesForCell(quotes, source.guid, respondentId, questionId),
    [quotes, source.guid, respondentId, questionId]
  )

  // Stable per-cell adapters so CodedTextView's selection-syncing
  // effect (which has `onTextSelected` in its deps and calls
  // `window.getSelection().removeAllRanges()` on every re-run) doesn't
  // fire on every parent render and clear the native selection.
  const handleTextSelectedHere = useCallback(
    (startCp: number, endCp: number, selectedText: string) =>
      onTextSelected({ respondentId, questionId }, startCp, endCp, selectedText),
    [onTextSelected, respondentId, questionId]
  )
  const handleRightClickHere = useCallback(
    (e: React.MouseEvent, ctx: CodingRightClickContext) =>
      onCodingRightClick({ respondentId, questionId }, e, ctx),
    [onCodingRightClick, respondentId, questionId]
  )

  if (!text) {
    return <div style={emptyAnswerStyle}>(no answer)</div>
  }

  return (
    <div
      data-survey-cell={`${respondentId}:${questionId}`}
      style={{ marginBottom: 14 }}
    >
      <CodedTextView
        text={text}
        selections={selections}
        codes={codes}
        contentMemos={cellMemos}
        quotes={cellQuotes}
        hideLineNumbers
        onTextSelected={handleTextSelectedHere}
        onCodingRightClick={handleRightClickHere}
        onMemoClick={onMemoClick}
      />
    </div>
  )
}

// ── View shells (respondent / question / summary) ──────────────────

interface ViewProps {
  source: TextSource
  codes: Code[]
  memos: Memo[]
  quotes: Quote[]
  onTextSelected: (cellId: { respondentId: string; questionId: string }, startCp: number, endCp: number, text: string) => void
  onCodingRightClick: (
    cellId: { respondentId: string; questionId: string },
    e: React.MouseEvent,
    ctx: CodingRightClickContext
  ) => void
  onMemoClick: (memoGuid: string) => void
  onChangeQuestionType: (questionId: string, type: SurveyQuestionType) => void
}

function RespondentView({
  survey,
  respondent,
  onJumpToQuestion,
  ...rest
}: ViewProps & {
  survey: SurveyData
  respondent: SurveyRespondent
  onJumpToQuestion: (questionId: string) => void
}) {
  const respondentNumber = Math.max(0, survey.respondents.findIndex((r) => r.id === respondent.id)) + 1
  return (
    <article>
      <header style={headerStyle}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={h1Style}>{respondent.displayName}</h1>
            {respondent.rawRespondentId && (
              <div style={subtleMetaStyle}>RespondentID: {respondent.rawRespondentId}</div>
            )}
          </div>
          <MemoFab
            variant="inline"
            kind="survey-respondent"
            sourceGuid={rest.source.guid}
            respondentId={respondent.id}
            defaultTitle={`R${respondentNumber}`}
          />
        </div>
      </header>
      {survey.questions.map((q, i) => {
        const qNumber = i + 1
        const rNumber = survey.respondents.findIndex((r) => r.id === respondent.id) + 1
        return (
        // `data-survey-section` carries the respondent + question
        // pair on every question section regardless of question type,
        // letting the scroll-target consumer land on numeric / multi-
        // select / single-choice cells too (only open-ended questions
        // render an inner SurveyCell, which is the only element that
        // gets `data-survey-cell` — and that one's reserved for the
        // text-selection iterator). Distinct attribute so the two
        // concerns don't collide.
        <section
          key={q.id}
          data-survey-section={`${respondent.id}:${q.id}`}
          style={{ marginBottom: 18 }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 4 }}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
              <NavHeading number={qNumber} label={clean(q.text)} onClick={() => onJumpToQuestion(q.id)} />
              <QuestionTypeBadge
                question={q}
                onChange={(t) => rest.onChangeQuestionType(q.id, t)}
              />
            </div>
            <MemoFab
              variant="inline"
              kind="survey-cell"
              sourceGuid={rest.source.guid}
              respondentId={respondent.id}
              questionId={q.id}
              defaultTitle={`R${rNumber}Q${qNumber}`}
            />
          </div>
          <div style={indentedAnswerStyle}>
            <RespondentAnswerCell
              survey={survey}
              question={q}
              respondent={respondent}
              source={rest.source}
              codes={rest.codes}
              memos={rest.memos}
              quotes={rest.quotes}
              onTextSelected={rest.onTextSelected}
              onCodingRightClick={rest.onCodingRightClick}
              onMemoClick={rest.onMemoClick}
              onChangeQuestionType={rest.onChangeQuestionType}
            />
          </div>
        </section>
        )
      })}
    </article>
  )
}

/** Per-question dispatch in Respondent view. Open-ended cells route
 *  to SurveyCell (codable); closed / multi-select / numeric route to
 *  display-only components and aren't codable. */
function RespondentAnswerCell({
  survey,
  question,
  respondent,
  source,
  codes,
  memos,
  quotes,
  onTextSelected,
  onCodingRightClick,
  onMemoClick
}: {
  survey: SurveyData
  question: SurveyQuestion
  respondent: SurveyRespondent
} & ViewProps) {
  const ans = respondent.answers[question.id]
  if (question.type === 'open-ended') {
    return (
      <SurveyCell
        source={source}
        respondentId={respondent.id}
        questionId={question.id}
        text={buildOpenEndedText(ans)}
        codes={codes}
        memos={memos}
        quotes={quotes}
        onTextSelected={onTextSelected}
        onCodingRightClick={onCodingRightClick}
        onMemoClick={onMemoClick}
      />
    )
  }
  if (question.type === 'single-choice') {
    const dist = computeSingleChoiceDistribution(survey, question)
    const chosen = new Set<string>()
    if (typeof ans === 'string') {
      const c = clean(ans)
      if (c) chosen.add(c)
    }
    // Donut of the overall distribution, with the list (this respondent's
    // pick bolded) as its legend — mirrors Survey Overview.
    return (
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
        <DonutChart options={dist} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <OptionListCell options={dist} chosen={chosen} showSwatches />
        </div>
      </div>
    )
  }
  if (question.type === 'multi-select') {
    const dist = computeMultiSelectDistribution(survey, question)
    const chosen = new Set<string>()
    if (Array.isArray(ans)) for (const v of ans) chosen.add(clean(v))
    return <OptionListCell options={dist} chosen={chosen} />
  }
  if (question.type === 'numeric') {
    const stats = computeNumericStats(survey, question)
    const labels = computeValueLabels(survey, question)
    const v = typeof ans === 'string' ? extractRatingValue(ans) : null
    return (
      <NumericBoxPlot
        stats={stats}
        highlightValue={v ?? undefined}
        valueLabels={labels}
      />
    )
  }
  return null
}

function QuestionView({
  survey,
  question,
  onJumpToRespondent,
  ...rest
}: ViewProps & {
  survey: SurveyData
  question: SurveyQuestion
  onJumpToRespondent: (respondentId: string) => void
}) {
  // Question's 1-based position in the survey, for "Q3. …" prefixes
  // in the header. -1 (then +1 → 0) signals "not found"; we render
  // it as Q0 in that edge case rather than throwing.
  const questionNumber = Math.max(0, survey.questions.findIndex((q) => q.id === question.id)) + 1

  // For closed / numeric questions, Question view shows a single
  // aggregate display — no per-respondent listing. Open-ended
  // questions are still per-respondent because each free-text answer
  // is its own codable artefact.
  if (question.type === 'single-choice') {
    const dist = computeSingleChoiceDistribution(survey, question)
    return (
      <article>
        <QuestionHeader
          question={question}
          questionNumber={questionNumber}
          respondents={survey.respondents.length}
          sourceGuid={rest.source.guid}
          onChangeType={(t) => rest.onChangeQuestionType(question.id, t)}
        />
        <div style={indentedAnswerStyle}>
          {/* Donut on the left, the option list (with matching colour
              swatches) doubling as its legend — mirrors Survey Overview. */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
            <DonutChart options={dist} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <OptionListCell options={dist} chosen={new Set()} showSwatches />
            </div>
          </div>
        </div>
      </article>
    )
  }
  if (question.type === 'multi-select') {
    const dist = computeMultiSelectDistribution(survey, question)
    return (
      <article>
        <QuestionHeader
          question={question}
          questionNumber={questionNumber}
          respondents={survey.respondents.length}
          sourceGuid={rest.source.guid}
          onChangeType={(t) => rest.onChangeQuestionType(question.id, t)}
        />
        <div style={indentedAnswerStyle}>
          <OptionListCell options={dist} chosen={new Set()} />
        </div>
      </article>
    )
  }
  if (question.type === 'numeric') {
    const stats = computeNumericStats(survey, question)
    const labels = computeValueLabels(survey, question)
    return (
      <article>
        <QuestionHeader
          question={question}
          questionNumber={questionNumber}
          respondents={survey.respondents.length}
          sourceGuid={rest.source.guid}
          onChangeType={(t) => rest.onChangeQuestionType(question.id, t)}
        />
        <div style={indentedAnswerStyle}>
          <NumericBoxPlot stats={stats} valueLabels={labels} />
        </div>
      </article>
    )
  }

  // Open-ended: list every respondent with their free-text answer.
  return (
    <article>
      <QuestionHeader
          question={question}
          questionNumber={questionNumber}
          respondents={survey.respondents.length}
          sourceGuid={rest.source.guid}
          onChangeType={(t) => rest.onChangeQuestionType(question.id, t)}
        />
      {survey.respondents.map((r, i) => {
        const text = buildOpenEndedText(r.answers[question.id])
        const rNumber = i + 1
        return (
          <section key={r.id} style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <NavHeading label={r.displayName} onClick={() => onJumpToRespondent(r.id)} />
              </div>
              <MemoFab
                variant="inline"
                kind="survey-cell"
                sourceGuid={rest.source.guid}
                respondentId={r.id}
                questionId={question.id}
                defaultTitle={`R${rNumber}Q${questionNumber}`}
              />
            </div>
            <div style={indentedAnswerStyle}>
              <SurveyCell
                source={rest.source}
                respondentId={r.id}
                questionId={question.id}
                text={text}
                codes={rest.codes}
                memos={rest.memos}
                quotes={rest.quotes}
                onTextSelected={rest.onTextSelected}
                onCodingRightClick={rest.onCodingRightClick}
                onMemoClick={rest.onMemoClick}
              />
            </div>
          </section>
        )
      })}
    </article>
  )
}

function QuestionHeader({
  question,
  questionNumber,
  respondents,
  sourceGuid,
  onChangeType
}: {
  question: SurveyQuestion
  questionNumber: number
  respondents: number
  sourceGuid: string
  onChangeType: (t: SurveyQuestionType) => void
}) {
  return (
    <header style={headerStyle}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <h1 style={{ ...h1Style, display: 'flex', alignItems: 'baseline', gap: 8, flex: 1, minWidth: 0 }}>
          <span style={{ flexShrink: 0 }}>{questionNumber}.</span>
          <span style={{ flex: 1, minWidth: 0 }}>{clean(question.text)}</span>
        </h1>
        <MemoFab
          variant="inline"
          kind="survey-question"
          sourceGuid={sourceGuid}
          questionGuid={question.id}
          defaultTitle={`Q${questionNumber}`}
        />
      </div>
      <div style={{ ...subtleMetaStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
        <QuestionTypeBadge question={question} onChange={onChangeType} />
        <span>{respondents} respondents</span>
      </div>
    </header>
  )
}

// ── Summary statistics helpers ─────────────────────────────────────

function respondentAnsweredQuestion(r: SurveyRespondent, q: SurveyQuestion): boolean {
  const a = r.answers[q.id]
  if (Array.isArray(a)) return a.length > 0
  return typeof a === 'string' && a.trim().length > 0
}

function questionAnsweredCount(q: SurveyQuestion, respondents: SurveyRespondent[]): number {
  let n = 0
  for (const r of respondents) if (respondentAnsweredQuestion(r, q)) n++
  return n
}

// ── PDF export ─────────────────────────────────────────────────────
//
// The export deliberately mirrors what SummaryView paints on screen,
// with one extra: open-ended questions show each non-empty answer
// attributed to its respondent in the Distribution cell (on screen
// those are accessed via the "Show answers →" drill-in, not inlined).
// The outer document chrome (DOCTYPE, body typography, h1, subtitle)
// lives in buildPdfDocument so every export across the app shares the
// same page layout — only the survey-specific table layout + option
// list / answer list / box plot styling lives here as extraCss.

/** Bullet list of options + percentages, for single-choice and
 *  multi-select questions. `displayOption` (set by
 *  computeSingleChoiceDistribution for rating-scale options) wins
 *  over the canonical option text when present. When `withSwatches`
 *  is set, each row leads with a colour chip matching the donut's
 *  `segmentColor(index)` — mirroring the on-screen single-choice
 *  layout where the list is the donut's legend. */
function pdfOptionListHtml(options: OptionTally[], withSwatches = false): string {
  if (options.length === 0) return '<div class="empty">(no responses)</div>'
  return (
    '<ul class="options">' +
    options
      .map((d, i) => {
        const label = d.displayOption ?? d.option
        const swatch = withSwatches
          ? `<span class="opt-swatch" style="background:${segmentColor(i)}"></span>`
          : ''
        return `<li>${swatch}<span class="opt-label">${escHtml(label)}</span><span class="opt-pct">${formatPct(d.pct)}</span></li>`
      })
      .join('') +
    '</ul>'
  )
}

/** Inline SVG donut mirroring the on-screen DonutChart, for a
 *  single-choice distribution. Uses the same stroke-dasharray ring
 *  trick and the same fixed `segmentColor` palette (already hex, so
 *  it survives the CSS-variable-less print window). Returns '' when
 *  there are no responses — the sibling option list then carries the
 *  "(no responses)" message on its own. */
function pdfDonutHtml(options: OptionTally[], size = 64, thickness = 13): string {
  const total = options.reduce((sum, d) => sum + d.count, 0)
  if (total === 0) return ''
  const cx = size / 2
  const cy = size / 2
  const radius = (size - thickness) / 2
  const circ = 2 * Math.PI * radius
  let offset = 0
  const segments = options
    .map((d, i) => {
      const dash = (d.count / total) * circ
      // rotate -90 (about the centre) starts the first slice at 12
      // o'clock, matching the on-screen chart.
      const seg =
        `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${segmentColor(i)}" ` +
        `stroke-width="${thickness}" stroke-dasharray="${dash} ${circ - dash}" ` +
        `stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})"/>`
      offset += dash
      return seg
    })
    .join('')
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">` +
    `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="#eee" stroke-width="${thickness}"/>` +
    segments +
    `</svg>`
  )
}

/** Attributed list of non-empty free-text answers for an open-ended
 *  question. Respondents who left this question blank are skipped so
 *  the PDF doesn't fill with empty rows. */
function pdfOpenEndedAnswersHtml(survey: SurveyData, q: SurveyQuestion): string {
  const rows: string[] = []
  for (const r of survey.respondents) {
    const ans = r.answers[q.id]
    if (typeof ans !== 'string') continue
    const text = clean(ans)
    if (!text) continue
    rows.push(
      `<li><span class="who">${escHtml(r.displayName)}:</span> <span class="what">${escHtml(text)}</span></li>`
    )
  }
  if (rows.length === 0) return '<div class="empty">(no responses)</div>'
  return '<ul class="answers">' + rows.join('') + '</ul>'
}

/** Inline SVG box plot mirroring NumericBoxPlot's geometry, but with
 *  fixed grayscale colors (CSS variables aren't available in the
 *  hidden print window the main process uses to render). Same axis +
 *  named-endpoint label rendering as the on-screen version. */
function pdfNumericBoxPlotHtml(stats: NumericStats | null, valueLabels?: Map<number, string>): string {
  if (!stats) return '<div class="empty">(no numeric responses)</div>'
  const W = 280
  const PAD_LEFT = 28
  const PAD_RIGHT = 28
  const BOX_TOP = 8
  const BOX_BOTTOM = 32
  const AXIS_Y = 42
  const TICK_LEN = 4
  const NUM_LABEL_Y = AXIS_Y + TICK_LEN + 10
  const TEXT_LABEL_Y = NUM_LABEL_Y + 12
  const hasAnyText = valueLabels != null && valueLabels.size > 0
  const H = (hasAnyText ? TEXT_LABEL_Y : NUM_LABEL_Y) + 4

  const ticks = computeAxisTicks(stats.min, stats.max)
  const axisMin = ticks[0]
  const axisMax = ticks[ticks.length - 1]
  const range = axisMax - axisMin || 1
  const x = (v: number) => PAD_LEFT + ((v - axisMin) / range) * (W - PAD_LEFT - PAD_RIGHT)
  const midY = (BOX_TOP + BOX_BOTTOM) / 2
  const whiskerHalf = 5

  const tickMarks = ticks
    .map((t) => {
      const cx = x(t)
      const labelTxt = valueLabels?.get(t)
      return (
        `<line x1="${cx}" x2="${cx}" y1="${AXIS_Y}" y2="${AXIS_Y + TICK_LEN}" stroke="#888" stroke-width="1"/>` +
        `<text x="${cx}" y="${NUM_LABEL_Y}" font-size="10" fill="#666" text-anchor="middle">${t}</text>` +
        (labelTxt
          ? `<text x="${cx}" y="${TEXT_LABEL_Y}" font-size="9" fill="#888" text-anchor="middle" font-style="italic">${escHtml(labelTxt)}</text>`
          : '')
      )
    })
    .join('')

  return (
    `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">` +
    `<line x1="${x(stats.min)}" x2="${x(stats.q1)}" y1="${midY}" y2="${midY}" stroke="#888" stroke-width="1"/>` +
    `<line x1="${x(stats.q3)}" x2="${x(stats.max)}" y1="${midY}" y2="${midY}" stroke="#888" stroke-width="1"/>` +
    `<line x1="${x(stats.min)}" x2="${x(stats.min)}" y1="${midY - whiskerHalf}" y2="${midY + whiskerHalf}" stroke="#888" stroke-width="1"/>` +
    `<line x1="${x(stats.max)}" x2="${x(stats.max)}" y1="${midY - whiskerHalf}" y2="${midY + whiskerHalf}" stroke="#888" stroke-width="1"/>` +
    `<rect x="${x(stats.q1)}" y="${BOX_TOP}" width="${x(stats.q3) - x(stats.q1)}" height="${BOX_BOTTOM - BOX_TOP}" fill="#eee" stroke="#555" stroke-width="1"/>` +
    `<line x1="${x(stats.median)}" x2="${x(stats.median)}" y1="${BOX_TOP}" y2="${BOX_BOTTOM}" stroke="#555" stroke-width="2"/>` +
    `<line x1="${x(axisMin)}" x2="${x(axisMax)}" y1="${AXIS_Y}" y2="${AXIS_Y}" stroke="#888" stroke-width="1"/>` +
    tickMarks +
    `</svg>` +
    `<div class="stats-line">n ${stats.values.length} &nbsp;·&nbsp; mean ${formatStat(stats.mean)} &nbsp;·&nbsp; median ${formatStat(stats.median)} &nbsp;·&nbsp; mode ${formatStat(stats.mode)} &nbsp;·&nbsp; IQR ${formatStat(stats.q1)}–${formatStat(stats.q3)}</div>`
  )
}

function buildSurveySummaryHtml(survey: SurveyData, displayName: string): string {
  const totalRespondents = survey.respondents.length
  const totalQuestions = survey.questions.length
  const now = new Date().toLocaleString()

  // Inline distribution cell for a closed-question type (donut /
  // option list / box plot). Shared by the Contents overview and the
  // detailed Questions section so both render distributions
  // identically. Open-ended questions are handled separately.
  const closedDistHtml = (q: SurveyQuestion): string => {
    if (q.type === 'numeric') {
      return pdfNumericBoxPlotHtml(computeNumericStats(survey, q), computeValueLabels(survey, q))
    }
    if (q.type === 'single-choice') {
      // Donut on the left, the option list (with matching colour
      // swatches) as its legend on the right — mirrors SummaryView.
      const optDist = computeSingleChoiceDistribution(survey, q)
      return (
        `<div class="dist-single">${pdfDonutHtml(optDist)}` +
        `<div class="dist-legend">${pdfOptionListHtml(optDist, true)}</div></div>`
      )
    }
    if (q.type === 'multi-select') {
      return pdfOptionListHtml(computeMultiSelectDistribution(survey, q))
    }
    return ''
  }

  // Renders one question's table row(s). Both the Contents overview
  // and the detailed Questions section share the #/Question/Answered
  // cells and the closed-question distributions; they differ only for
  // open-ended questions:
  //   - 'contents' shows a "Show answers" hyperlink jumping to the
  //     detailed section (anchor #oe-ans-<i>), mirroring the on-screen
  //     Survey Overview where the answers aren't inlined.
  //   - 'detail' inlines the answers in a full-width row spanning
  //     Question→Distribution (the hyperlink's destination), anchored
  //     on the question's header row.
  const renderQuestionRow = (q: SurveyQuestion, i: number, mode: 'contents' | 'detail'): string => {
    const answered = questionAnsweredCount(q, survey.respondents)
    const pct = totalRespondents === 0 ? 0 : Math.round((answered / totalRespondents) * 100)
    const headCells =
      `<td class="num">${i + 1}</td>` +
      `<td>${escHtml(clean(q.text))}</td>` +
      `<td class="num">${answered} / ${totalRespondents} (${pct}%)</td>`

    if (q.type === 'open-ended') {
      if (mode === 'contents') {
        return `<tr>${headCells}<td><a class="show-answers" href="#oe-ans-${i}">Show answers →</a></td></tr>`
      }
      return (
        `<tr class="oe-head" id="oe-ans-${i}">${headCells}<td></td></tr>` +
        `<tr class="oe-answers"><td></td><td colspan="3">${pdfOpenEndedAnswersHtml(survey, q)}</td></tr>`
      )
    }
    return `<tr>${headCells}<td>${closedDistHtml(q)}</td></tr>`
  }

  const contentsRows = survey.questions.map((q, i) => renderQuestionRow(q, i, 'contents')).join('')
  const questionsRows = survey.questions.map((q, i) => renderQuestionRow(q, i, 'detail')).join('')

  const respondentsRows = survey.respondents
    .map((r, i) => {
      let answered = 0
      for (const q of survey.questions) if (respondentAnsweredQuestion(r, q)) answered++
      const pct = totalQuestions === 0 ? 0 : Math.round((answered / totalQuestions) * 100)
      return (
        `<tr>` +
        `<td class="num">${i + 1}</td>` +
        `<td>${escHtml(r.displayName)}</td>` +
        `<td>` +
        `<div class="resp-pct">` +
        `<div class="resp-bar"><div class="resp-bar-fill" style="width:${pct}%"></div></div>` +
        `<span class="resp-num">${answered} / ${totalQuestions} (${pct}%)</span>` +
        `</div>` +
        `</td>` +
        `</tr>`
      )
    })
    .join('')

  const subtitle =
    `${totalRespondents} respondent${totalRespondents === 1 ? '' : 's'} · ` +
    `${totalQuestions} question${totalQuestions === 1 ? '' : 's'} — ` +
    `exported ${escHtml(now)}`

  const body = `<div class="section-heading">Contents</div>
<table>
  <colgroup>
    <col class="c-num"><col><col class="c-answered"><col class="c-distribution">
  </colgroup>
  <thead><tr><th>#</th><th>Question</th><th>Answered</th><th>Distribution</th></tr></thead>
  <tbody>${contentsRows}</tbody>
</table>

<div class="section-heading section-break">Questions</div>
<table>
  <colgroup>
    <col class="c-num"><col><col class="c-answered"><col class="c-distribution">
  </colgroup>
  <thead><tr><th>#</th><th>Question</th><th>Answered</th><th>Distribution</th></tr></thead>
  <tbody>${questionsRows}</tbody>
</table>

<div class="section-heading">Respondents</div>
<table>
  <colgroup>
    <col class="c-num"><col><col class="c-completed">
  </colgroup>
  <thead><tr><th>#</th><th>Respondent</th><th>Completed</th></tr></thead>
  <tbody>${respondentsRows}</tbody>
</table>`

  // Survey-only CSS: fixed column widths for the Contents and
  // Respondents tables, plus the option-list / answer-list / numeric
  // box plot / open-ended-response styling. Everything else (body
  // typography, h1, table base, .section-heading, .empty, etc.) is
  // provided by buildPdfDocument's base CSS.
  const extraCss = `
  table { table-layout: fixed; }
  /* Percentage widths so the columns scale with the page. The old fixed
     pixel widths (88 + 300 + a 28px tick = 416px) overran narrow pages
     like A5 (~420px printable), starving the unsized Question column to a
     few pixels so every word wrapped onto its own line. c-num stays a
     small fixed tick; the Question / Respondent columns take the slack. */
  col.c-num { width: 28px; }
  col.c-answered { width: 22%; }
  col.c-distribution { width: 38%; }
  col.c-completed { width: 200px; }
  td.num { white-space: nowrap; }
  ul.options { list-style: none; padding: 0; margin: 0; }
  ul.options li { display: flex; align-items: center; gap: 6px; padding: 1px 0; font-size: 11px; color: #333; }
  ul.options li .opt-label { flex: 1; }
  ul.options li .opt-pct { color: #888; font-variant-numeric: tabular-nums; min-width: 32px; text-align: right; font-size: 10px; }
  ul.options li .opt-swatch { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; display: inline-block; }
  .dist-single { display: flex; align-items: flex-start; gap: 12px; }
  .dist-single .dist-legend { flex: 1; min-width: 0; }
  /* Contents "Show answers" link → jumps to the question's answers in
     the detailed Questions section. Print blue, no underline to match
     the on-screen link. */
  a.show-answers { color: #1155cc; text-decoration: none; }
  /* The detailed Questions section starts on a fresh page so Contents
     reads as front matter. */
  .section-break { page-break-before: always; }
  /* Open-ended (detailed section): header row joins seamlessly to its
     full-width answers row (no divider between them), and the answers
     row may break across pages so long lists aren't forced onto a
     fresh page by the table's default break-inside:avoid. */
  tr.oe-head td { border-bottom: none; }
  tr.oe-answers { break-inside: auto; page-break-inside: auto; }
  ul.answers { list-style: none; padding: 0; margin: 0; }
  ul.answers li { padding: 3px 0; font-size: 10.5px; line-height: 1.45; color: #222; }
  ul.answers li .who { font-weight: 600; color: #444; margin-right: 2px; }
  .resp-pct { display: flex; align-items: center; gap: 8px; }
  .resp-bar { width: 120px; height: 6px; background: #eee; border-radius: 3px; overflow: hidden; flex-shrink: 0; }
  .resp-bar-fill { height: 100%; background: #888; }
  .resp-num { font-size: 10px; color: #888; white-space: nowrap; }
  .stats-line { font-size: 10px; color: #888; margin-top: 4px; }
  /* Cap the distribution graphics at their intrinsic width but let them
     shrink to fit a narrower column on small pages (viewBox keeps the
     aspect ratio when they scale). */
  svg { display: block; max-width: 100%; height: auto; }
`

  return buildPdfDocument({ title: displayName, subtitle, body, extraCss })
}

function SummaryView({
  survey,
  displayName,
  onJumpToQuestion,
  onJumpToRespondent
}: {
  survey: SurveyData
  // The live source name from the document store. Used for the header
  // (and PDF filename) so renaming the survey updates them, rather than
  // the stale name embedded in survey.formatData.
  displayName: string
  onJumpToQuestion: (qid: string) => void
  onJumpToRespondent: (rid: string) => void
}) {
  const totalRespondents = survey.respondents.length
  const totalQuestions = survey.questions.length

  const handleExportPdf = useCallback(async () => {
    const html = buildSurveySummaryHtml(survey, displayName)
    // Strip filesystem-hostile chars from the survey name so the
    // save dialog's default filename is always safe to accept as-is.
    const safeName = (displayName || 'Survey Summary').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'Survey Summary'
    await exportPdfWithHeader(html, safeName, 'Export Survey Summary as PDF')
  }, [survey, displayName])

  return (
    <div style={{ padding: 24 }}>
      <style>{`
        .survey-summary-row { transition: background 0.08s; }
        .survey-summary-row:hover { background: var(--bg-tertiary); }
      `}</style>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={h1Style}>{displayName}</h1>
          <div style={subtleMetaStyle}>
            {totalRespondents} respondent{totalRespondents === 1 ? '' : 's'} ·{' '}
            {totalQuestions} question{totalQuestions === 1 ? '' : 's'}
          </div>
        </div>
        <button
          className="secondary"
          style={{ fontSize: 11, padding: '3px 10px', flexShrink: 0 }}
          onClick={handleExportPdf}
          title="Export this summary as a PDF, including each respondent's answers to open questions"
        >
          Export PDF
        </button>
      </div>

      <section style={{ marginTop: 28 }}>
        <h2 style={summaryHeadingStyle}>Questions</h2>
        <table style={summaryTableStyle}>
          <thead>
            <tr>
              <th style={summaryThStyle}>#</th>
              <th style={{ ...summaryThStyle, width: '100%' }}>Question</th>
              <th style={summaryThStyle}>Answered</th>
              <th style={summaryThStyle}>Distribution</th>
            </tr>
          </thead>
          <tbody>
            {survey.questions.map((q, i) => {
              const answered = questionAnsweredCount(q, survey.respondents)
              const pct = totalRespondents === 0 ? 0 : Math.round((answered / totalRespondents) * 100)
              // Reuse the question-mode box plot + stats helpers so
              // the summary view matches what the user sees when
              // drilling into the question, and so the X axis +
              // named endpoint labels render identically.
              const numericStats = q.type === 'numeric' ? computeNumericStats(survey, q) : null
              const valueLabels = q.type === 'numeric' ? computeValueLabels(survey, q) : undefined
              // Inline option distributions for closed-question types,
              // so the summary page reads like a mini report without a
              // drill-in click. Same renderer as Question view (empty
              // `chosen` → no bolded selection).
              const optionDist =
                q.type === 'single-choice'
                  ? computeSingleChoiceDistribution(survey, q)
                  : q.type === 'multi-select'
                    ? computeMultiSelectDistribution(survey, q)
                    : null
              return (
                <tr
                  key={q.id}
                  className="survey-summary-row"
                  onClick={() => onJumpToQuestion(q.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <td style={{ ...summaryTdStyle, verticalAlign: 'top' }}>{i + 1}</td>
                  <td style={{ ...summaryTdStyle, verticalAlign: 'top' }}>{clean(q.text)}</td>
                  <td style={{ ...summaryTdStyle, verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                    {answered} / {totalRespondents} ({pct}%)
                  </td>
                  <td style={{ ...summaryTdStyle, verticalAlign: 'top' }}>
                    {q.type === 'numeric' ? (
                      <NumericBoxPlot stats={numericStats} valueLabels={valueLabels} />
                    ) : q.type === 'single-choice' && optionDist ? (
                      // Single-select: donut on the left, the option
                      // list (with matching colour swatches) doubling
                      // as its legend on the right.
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                        <DonutChart options={optionDist} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <OptionListCell options={optionDist} chosen={new Set()} compact showSwatches />
                        </div>
                      </div>
                    ) : optionDist ? (
                      <OptionListCell options={optionDist} chosen={new Set()} compact />
                    ) : (
                      <a
                        onClick={(e) => {
                          e.stopPropagation()
                          onJumpToQuestion(q.id)
                        }}
                        style={{ cursor: 'pointer', color: 'var(--accent)' }}
                      >
                        Show answers →
                      </a>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={summaryHeadingStyle}>Respondents</h2>
        <table style={summaryTableStyle}>
          <thead>
            <tr>
              <th style={summaryThStyle}>#</th>
              <th style={{ ...summaryThStyle, width: '100%' }}>Respondent</th>
              <th style={summaryThStyle}>Completed</th>
            </tr>
          </thead>
          <tbody>
            {survey.respondents.map((r, i) => {
              let answered = 0
              for (const q of survey.questions) if (respondentAnsweredQuestion(r, q)) answered++
              const pct = totalQuestions === 0 ? 0 : Math.round((answered / totalQuestions) * 100)
              return (
                <tr
                  key={r.id}
                  className="survey-summary-row"
                  onClick={() => onJumpToRespondent(r.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <td style={summaryTdStyle}>{i + 1}</td>
                  <td style={summaryTdStyle}>{r.displayName}</td>
                  <td style={summaryTdStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div
                        style={{
                          width: 120,
                          height: 6,
                          background: 'var(--bg-tertiary)',
                          borderRadius: 3,
                          overflow: 'hidden',
                          flexShrink: 0
                        }}
                      >
                        <div style={{ width: pct + '%', height: '100%', background: 'var(--accent)' }} />
                      </div>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {answered} / {totalQuestions} ({pct}%)
                      </span>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>
    </div>
  )
}

const summaryHeadingStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--text-secondary)',
  margin: '0 0 8px 0',
  userSelect: 'none'
}
const summaryTableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 12
}
const summaryThStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '6px 10px',
  borderBottom: '1px solid var(--border-color)',
  fontWeight: 600,
  fontSize: 11,
  color: 'var(--text-muted)',
  whiteSpace: 'nowrap',
  userSelect: 'none'
}
const summaryTdStyle: React.CSSProperties = {
  padding: '6px 10px',
  borderBottom: '1px solid var(--border-color)',
  verticalAlign: 'middle',
  color: 'var(--text-primary)'
}

// ── Main viewer ────────────────────────────────────────────────────

export function SurveyViewer({ source }: Props) {
  const survey: SurveyData | undefined = (source.formatData as SurveyFormatData | undefined)?.survey
  const view = useSurveyViewStore((s) => s.viewBySurveyGuid[source.guid]) ?? { mode: 'summary' as SurveyViewMode }
  const setView = useSurveyViewStore((s) => s.setView)
  const scrollTarget = useSurveyViewStore((s) => s.scrollTarget)
  const clearScrollTarget = useSurveyViewStore((s) => s.setScrollTarget)

  const codes = useCodeStore((s) => s.codes)
  const memos = useMemoStore((s) => s.memos)
  const quotes = useQuoteStore((s) => s.quotes)

  // Build a flat code list once per code-store change so hotkey
  // resolution + the menu's color-pip / hotkey row doesn't re-walk
  // the tree per render.
  const flatCodes = useMemo(() => {
    const out: { code: Code; depth: number }[] = []
    const walk = (cs: Code[], depth: number) => {
      for (const c of cs) {
        out.push({ code: c, depth })
        walk(c.children, depth + 1)
      }
    }
    walk(codes, 0)
    return out
  }, [codes])
  const hotkeyCodes = useMemo(
    () => flatCodes.filter((c) => c.code.hotkey !== undefined).sort((a, b) => (a.code.hotkey ?? 0) - (b.code.hotkey ?? 0)),
    [flatCodes]
  )
  const findCode = useCallback((guid: string) => flatCodes.find((f) => f.code.guid === guid)?.code, [flatCodes])

  const addSelection = useDocumentStore((s) => s.addSelection)
  const addCodingToSelection = useDocumentStore((s) => s.addCodingToSelection)
  const removeCoding = useDocumentStore((s) => s.removeCoding)
  const removeSelection = useDocumentStore((s) => s.removeSelection)
  const updateSurveyQuestionType = useDocumentStore((s) => s.updateSurveyQuestionType)
  const setGlobalPending = usePendingSelectionStore((s) => s.setSelection)

  const handleChangeQuestionType = useCallback(
    (questionId: string, t: SurveyQuestionType) => {
      updateSurveyQuestionType(source.guid, questionId, t)
    },
    [source.guid, updateSurveyQuestionType]
  )

  // ── Pending selection ──────────────────────────────────────────
  type Cell = { respondentId: string; questionId: string }
  type LocalCellPending = Cell & {
    start: number
    end: number
    selectedText: string
  }
  const [pending, setPending] = useState<{ cells: LocalCellPending[] } | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  // The cell a click-drag began in. Selection is confined to this cell while
  // the drag is live (see the selectionchange effect below), so a drag can
  // never visibly spill into neighbouring cells.
  const dragStartCellRef = useRef<HTMLElement | null>(null)

  // Consume an incoming scroll target. Memo-pane single-clicks
  // (and any other future caller) write a `(surveyGuid,
  // questionId)` target into the survey-view store; when that
  // target matches this source we find the matching cell wrapper
  // and scroll it into view, then clear the target so it doesn't
  // re-fire on later renders.
  useEffect(() => {
    if (!scrollTarget || scrollTarget.surveyGuid !== source.guid) return
    // The cell wrapper might not be in the DOM yet — view mode could
    // have just switched from summary → respondent in the same tick,
    // or the SurveyViewer might have just mounted alongside the
    // viewDocument() call. Retry across a handful of frames so the
    // scroll still lands when the target arrives a beat later.
    let rafId = 0
    let attempts = 0
    const MAX_ATTEMPTS = 30
    const tick = () => {
      attempts++
      const root = containerRef.current
      // Prefer the cell-scoped wrapper when both ids are present;
      // fall back to the per-question <section> wrapper (which the
      // RespondentView attaches even for closed / numeric questions
      // that don't render a SurveyCell), then to any cell with the
      // matching questionId for Question view (where the heading is
      // the question itself).
      let target: HTMLElement | null = null
      if (root) {
        if (scrollTarget.respondentId && scrollTarget.questionId) {
          target = root.querySelector<HTMLElement>(
            `[data-survey-cell="${scrollTarget.respondentId}:${scrollTarget.questionId}"]`
          )
          if (!target) {
            target = root.querySelector<HTMLElement>(
              `[data-survey-section="${scrollTarget.respondentId}:${scrollTarget.questionId}"]`
            )
          }
        }
        if (!target && scrollTarget.questionId) {
          target = root.querySelector<HTMLElement>(
            `[data-survey-cell$=":${scrollTarget.questionId}"]`
          )
        }
      }
      if (target) {
        // `scrollIntoView({block: 'start'})` aligns the cell with the
        // top of the scroll container, which tucks it underneath the
        // sticky header. Measure the actual scroll container + header
        // and scroll manually so the cell lands just below the header.
        const scrollContainer = findScrollContainer(target, root!)
        if (scrollContainer) {
          const header = scrollContainer.querySelector<HTMLElement>('header')
          const headerHeight = header ? header.offsetHeight : 0
          const containerRect = scrollContainer.getBoundingClientRect()
          const targetRect = target.getBoundingClientRect()
          const offsetWithin = targetRect.top - containerRect.top + scrollContainer.scrollTop
          const top = Math.max(0, offsetWithin - headerHeight - 8)
          scrollContainer.scrollTo({ top, behavior: 'smooth' })
        } else {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
        clearScrollTarget(null)
        return
      }
      if (attempts < MAX_ATTEMPTS) {
        rafId = requestAnimationFrame(tick)
      } else {
        // Give up after ~half a second so a stale target doesn't sit
        // in the store forever.
        clearScrollTarget(null)
      }
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [scrollTarget, source.guid, view, clearScrollTarget])

  // Mirror local pending → global. Cleared on tab switch via the
  // cleanup so a stale 'survey-cell' kind doesn't outlive the
  // viewer.
  useEffect(() => {
    if (pending && pending.cells.length > 0) {
      setGlobalPending({
        kind: 'survey-cell',
        sourceGuid: source.guid,
        cells: pending.cells
      })
    }
    return () => {
      const cur = usePendingSelectionStore.getState().selection
      if (cur && cur.kind === 'survey-cell' && cur.sourceGuid === source.guid) {
        setGlobalPending(null)
      }
    }
  }, [pending, source.guid, setGlobalPending])

  // CodedTextView reports a single-cell selection — adopt as pending.
  const handleCellTextSelected = useCallback(
    (cellId: Cell, startCp: number, endCp: number, selectedText: string) => {
      if (endCp <= startCp) {
        setPending(null)
        return
      }
      setPending({
        cells: [{ ...cellId, start: startCp, end: endCp, selectedText }]
      })
    },
    []
  )

  // Remember which cell a drag began in and hard-lock the selection to it.
  // While the container carries `.survey-drag-lock` and the origin cell carries
  // `.survey-drag-source`, every OTHER cell's content is forced to
  // user-select:none (see global.css) — overriding CodedTextView's inline
  // user-select:text — so the browser physically refuses to extend the native
  // selection into a neighbouring cell. (The selectionchange handler below is a
  // JS backstop for anything that slips past the CSS lock.)
  const handleContainerMouseDown = useCallback((e: React.MouseEvent) => {
    // Drop any stale lock from a previous interaction first.
    dragStartCellRef.current?.classList.remove('survey-drag-source')
    if (e.button !== 0) {
      dragStartCellRef.current = null
      containerRef.current?.classList.remove('survey-drag-lock')
      return
    }
    const cell = (e.target as HTMLElement).closest?.('[data-survey-cell]') as HTMLElement | null
    dragStartCellRef.current = cell
    if (cell) {
      cell.classList.add('survey-drag-source')
      containerRef.current?.classList.add('survey-drag-lock')
    } else {
      containerRef.current?.classList.remove('survey-drag-lock')
    }
  }, [])

  // JS backstop to the CSS hard-lock: if any selection still escapes the start
  // cell, pull the moving end (focus) back to the cell's near edge, keeping the
  // anchor put. Re-entrant-safe: once clamped the focus is back inside, so the
  // next change is a no-op. Also clears the lock (ref + classes) on any release.
  useEffect(() => {
    const clampToStartCell = (): void => {
      const startEl = dragStartCellRef.current
      if (!startEl) return
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0 || !sel.focusNode) return
      if (startEl.contains(sel.focusNode)) return
      const pos = startEl.compareDocumentPosition(sel.focusNode)
      try {
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) {
          sel.extend(startEl, startEl.childNodes.length) // focus drifted past → clamp to cell end
        } else if (pos & Node.DOCUMENT_POSITION_PRECEDING) {
          sel.extend(startEl, 0) // focus drifted before → clamp to cell start
        }
      } catch {
        /* transient invalid range mid-drag — ignore */
      }
    }
    // Release: drop the lock everywhere (ref + both classes), including for
    // releases outside the container, so a later selection isn't constrained.
    const clearDragCell = (): void => {
      dragStartCellRef.current?.classList.remove('survey-drag-source')
      containerRef.current?.classList.remove('survey-drag-lock')
      dragStartCellRef.current = null
    }
    document.addEventListener('selectionchange', clampToStartCell)
    document.addEventListener('mouseup', clearDragCell)
    return () => {
      document.removeEventListener('selectionchange', clampToStartCell)
      document.removeEventListener('mouseup', clearDragCell)
    }
  }, [])

  // Top-level mouseup: catches drags that started in one cell and
  // ended in another (CodedTextView's per-cell onTextSelected only
  // fires when the selection terminates inside the SAME cell). Coding
  // is limited to one cell at a time, so when a drag spans cells we keep
  // only the cell where the selection began and clamp the on-screen
  // selection to it.
  const handleContainerMouseUp = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return
    const range = sel.getRangeAt(0)
    const container = containerRef.current
    if (!container) return
    const cellEls = Array.from(container.querySelectorAll<HTMLElement>('[data-survey-cell]'))

    // A selection contained entirely within one cell is normally reported by
    // that cell's CodedTextView (more accurate, codepoint-based) on its own
    // mouseup — defer to it. But after the live clamp confines a cross-cell
    // drag, the pointer can be released over a DIFFERENT cell than the one
    // holding the selection, so the start cell's CodedTextView never fires.
    // Only defer when the release happened inside the selection's own cell;
    // otherwise fall through and resolve the pending here.
    const selCell = cellEls.find(
      (el) => el.contains(range.startContainer) && el.contains(range.endContainer)
    )
    if (selCell && selCell.contains(e.target as Node)) {
      return
    }

    const matched: LocalCellPending[] = []
    for (const el of cellEls) {
      // Exact text-overlap test. `intersectsNode` (and the
      // contains-based fallback below) also report a hit when the
      // selection merely *touches* a cell's leading edge — which is
      // what happens when a drag runs through the invisible line break
      // at the end of one response: the caret lands at the very start
      // of the NEXT response. Counting that as overlap pulled the
      // neighbouring cell into `matched` and coded it too. Comparing
      // boundary points instead is exact and treats a zero-length
      // boundary touch as no overlap.
      const cellRange = document.createRange()
      cellRange.selectNodeContents(el)
      // Selection ends at or before this cell's content begins.
      if (range.compareBoundaryPoints(Range.START_TO_END, cellRange) <= 0) continue
      // Selection starts at or after this cell's content ends.
      if (range.compareBoundaryPoints(Range.END_TO_START, cellRange) >= 0) continue

      const [respondentId, questionId] = (el.getAttribute('data-survey-cell') || '').split(':')
      if (!respondentId || !questionId) continue
      const cellText = el.textContent || ''
      let start: number
      let end: number
      if (el.contains(range.startContainer)) {
        const s = offsetWithin(el, range.startContainer, range.startOffset)
        start = s == null ? 0 : s
      } else {
        start = 0
      }
      if (el.contains(range.endContainer)) {
        const ep = offsetWithin(el, range.endContainer, range.endOffset)
        end = ep == null ? cellText.length : ep
      } else {
        end = cellText.length
      }
      if (start >= end) continue
      matched.push({
        respondentId,
        questionId,
        start,
        end,
        selectedText: cellText.slice(start, end)
      })
    }
    // Coding is limited to a single cell. `matched` is in DOM order, so
    // matched[0] is the cell where the selection begins; when a drag spans
    // several cells we keep only that one. (A length-1 result is the
    // single-response case — e.g. a response selected past its trailing line
    // break, which CodedTextView can't resolve — and is kept as-is.)
    if (matched.length >= 1) {
      setPending({ cells: [matched[0]] })
      // Collapse the visible selection to the start cell so the on-screen
      // highlight matches what will actually be coded (one cell).
      if (matched.length > 1) {
        const startEl = cellEls.find((el) => el.contains(range.startContainer))
        if (startEl) {
          const clamped = document.createRange()
          clamped.selectNodeContents(startEl)
          clamped.setStart(range.startContainer, range.startOffset)
          sel.removeAllRanges()
          sel.addRange(clamped)
        }
      }
    }
  }, [])

  // ── Code application ───────────────────────────────────────────
  const applyCodeToPending = useCallback(
    (codeGuid: string) => {
      if (!pending) return
      const ds = useDocumentStore.getState()
      for (const cell of pending.cells) {
        const src = ds.sources.find((s) => s.guid === source.guid)
        const existingSel = src?.selections.find(
          (sel) =>
            sel.surveyCell &&
            sel.surveyCell.respondentId === cell.respondentId &&
            sel.surveyCell.questionId === cell.questionId &&
            sel.startPosition === cell.start &&
            sel.endPosition === cell.end
        )
        let selGuid = existingSel?.guid
        if (!selGuid) {
          const truncated =
            cell.selectedText.length > 60 ? cell.selectedText.slice(0, 57) + '...' : cell.selectedText
          selGuid = addSelection(
            source.guid,
            cell.start,
            cell.end,
            truncated,
            undefined,
            { respondentId: cell.respondentId, questionId: cell.questionId }
          )
        }
        const sel = (ds.sources.find((s) => s.guid === source.guid))?.selections.find(
          (s) => s.guid === selGuid
        )
        const alreadyCoded = sel?.codings.some((c) => c.codeGuid === codeGuid)
        if (!alreadyCoded) addCodingToSelection(source.guid, selGuid, codeGuid)
      }
    },
    [pending, source.guid, addSelection, addCodingToSelection]
  )

  // Drop code anywhere in the viewer → apply to every pending cell.
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      const multi = e.dataTransfer.getData('application/x-magnolia-codes')
      const single = e.dataTransfer.getData('application/x-magnolia-code')
      if (!multi && !single) return
      e.preventDefault()
      e.stopPropagation()
      if (!pending) return
      const guids: string[] = []
      if (multi) {
        try { guids.push(...(JSON.parse(multi) as { guid: string }[]).map((c) => c.guid)) } catch { /* */ }
      } else if (single) {
        try { guids.push((JSON.parse(single) as { guid: string }).guid) } catch { /* */ }
      }
      for (const g of guids) applyCodeToPending(g)
    },
    [pending, applyCodeToPending]
  )

  // Cmd / Ctrl + 0..9 → apply hotkeyed code.
  const isActive = useDocumentStore((s) => s.viewedDocumentGuid === source.guid)
  useEffect(() => {
    if (!isActive) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return
      const digit = parseInt(e.key, 10)
      if (isNaN(digit) || digit < 0 || digit > 9) return
      const match = hotkeyCodes.find((h) => h.code.hotkey === digit)
      if (!match || !pending) return
      e.preventDefault()
      applyCodeToPending(match.code.guid)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isActive, hotkeyCodes, pending, applyCodeToPending])

  // ArrowUp / ArrowDown → flick between sub-items of the same kind.
  // Only fires when this survey is the active source AND the user
  // isn't typing in a text input / textarea / contenteditable. Lets
  // the user step through respondents (or questions) one at a time
  // from the keyboard, matching the visual selection in the tree.
  useEffect(() => {
    if (!isActive || !survey) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      // Skip when a text input has focus.
      const ae = document.activeElement as HTMLElement | null
      if (ae) {
        const tag = ae.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || ae.isContentEditable) return
      }
      // No effect on summary view — nothing to step through.
      if (view.mode === 'summary') return
      const list = view.mode === 'respondent' ? survey.respondents : survey.questions
      if (list.length === 0) return
      const idx = list.findIndex((it) => it.id === view.childId)
      const dir = e.key === 'ArrowDown' ? 1 : -1
      let nextIdx: number
      if (idx < 0) {
        nextIdx = dir > 0 ? 0 : list.length - 1
      } else {
        nextIdx = Math.max(0, Math.min(list.length - 1, idx + dir))
        if (nextIdx === idx) return
      }
      e.preventDefault()
      setView(source.guid, view.mode, list[nextIdx].id)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isActive, survey, view, source.guid, setView])

  // ── Right-click context menu ──────────────────────────────────
  //
  // Sourced from CodedTextView's `onCodingRightClick` so the menu
  // matches plain text. Each cell forwards the click + its
  // (respondentId, questionId) so we can apply the menu actions to
  // the cell where the right-click happened.
  type MenuState = {
    x: number
    y: number
    cellId: Cell
    existingCodings: { selectionGuid: string; codingGuid: string; codeGuid: string; startCp: number; endCp: number }[]
    /** Pending span from the cell's CodedTextView (single-cell). */
    cellPending?: { startCp: number; endCp: number; selectedText: string }
    overlappingMemos: { guid: string; title: string; startCp: number; endCp: number }[]
  }
  const [menu, setMenu] = useState<MenuState | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])

  const handleCellRightClick = useCallback(
    (cellId: Cell, e: React.MouseEvent, ctx: CodingRightClickContext) => {
      const x = e.clientX
      const y = e.clientY
      // Pull overlapping memos for THIS cell from the memo store
      // (filtered to the cell + click range).
      const cellMemos = memos.filter(
        (m) =>
          m.type === 'content' &&
          m.sourceGuid === source.guid &&
          m.surveyCell &&
          m.surveyCell.respondentId === cellId.respondentId &&
          m.surveyCell.questionId === cellId.questionId
      )
      const clickCp = ctx.codepointOffset
      const overlapping = clickCp != null
        ? cellMemos
            .filter((m) => m.startPosition != null && m.endPosition != null && m.startPosition <= clickCp && m.endPosition >= clickCp)
            .map((m) => ({ guid: m.guid, title: m.title || 'Memo', startCp: m.startPosition!, endCp: m.endPosition! }))
        : []

      setMenu({
        x,
        y,
        cellId,
        existingCodings: ctx.existingCodings,
        cellPending: ctx.pendingSelection,
        overlappingMemos: overlapping
      })
    },
    [memos, source.guid]
  )

  // Close menu on outside click / Escape.
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest('.survey-context-menu')) return
      closeMenu()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu, closeMenu])

  // ── Menu actions ──────────────────────────────────────────────

  /** Cells to act on when a menu item runs. Prefers the multi-cell
   *  `pending` if it exists; otherwise falls back to the single-cell
   *  span CodedTextView reported when the user right-clicked. */
  const targetCells = useCallback((): LocalCellPending[] => {
    if (pending && pending.cells.length > 0) return pending.cells
    if (menu?.cellPending) {
      return [{
        respondentId: menu.cellId.respondentId,
        questionId: menu.cellId.questionId,
        start: menu.cellPending.startCp,
        end: menu.cellPending.endCp,
        selectedText: menu.cellPending.selectedText
      }]
    }
    return []
  }, [pending, menu])

  const handleApplyHotkeyCode = useCallback(
    (codeGuid: string) => {
      const cells = targetCells()
      if (cells.length === 0) return
      // Promote into `pending` so applyCodeToPending sees them, then
      // reuse its existing loop.
      const ds = useDocumentStore.getState()
      for (const cell of cells) {
        const src = ds.sources.find((s) => s.guid === source.guid)
        const existingSel = src?.selections.find(
          (sel) =>
            sel.surveyCell &&
            sel.surveyCell.respondentId === cell.respondentId &&
            sel.surveyCell.questionId === cell.questionId &&
            sel.startPosition === cell.start &&
            sel.endPosition === cell.end
        )
        let selGuid = existingSel?.guid
        if (!selGuid) {
          const truncated =
            cell.selectedText.length > 60 ? cell.selectedText.slice(0, 57) + '...' : cell.selectedText
          selGuid = addSelection(
            source.guid,
            cell.start,
            cell.end,
            truncated,
            undefined,
            { respondentId: cell.respondentId, questionId: cell.questionId }
          )
        }
        const sel = (ds.sources.find((s) => s.guid === source.guid))?.selections.find(
          (s) => s.guid === selGuid
        )
        if (!sel?.codings.some((c) => c.codeGuid === codeGuid)) {
          addCodingToSelection(source.guid, selGuid, codeGuid)
        }
      }
      closeMenu()
    },
    [targetCells, source.guid, addSelection, addCodingToSelection, closeMenu]
  )

  const handleRemoveCoding = useCallback(
    (selectionGuid: string, codingGuid: string) => {
      removeCoding(source.guid, selectionGuid, codingGuid)
      const sel = source.selections.find((s) => s.guid === selectionGuid)
      if (sel && sel.codings.length <= 1) {
        removeSelection(source.guid, selectionGuid)
      }
      closeMenu()
    },
    [source, removeCoding, removeSelection, closeMenu]
  )

  const handleAddQuote = useCallback(() => {
    const cells = targetCells()
    if (cells.length === 0) return
    for (const cell of cells) {
      useQuoteStore.getState().addQuote(
        source.guid,
        source.name,
        cell.start,
        cell.end,
        cell.selectedText,
        undefined,
        { respondentId: cell.respondentId, questionId: cell.questionId }
      )
    }
    closeMenu()
  }, [targetCells, source.guid, source.name, closeMenu])

  const handleAddContentMemo = useCallback(() => {
    const cells = targetCells()
    if (cells.length === 0) return
    const cell = cells[0]
    const guid = useMemoStore.getState().addMemo('content', '', {
      sourceGuid: source.guid,
      startPosition: cell.start,
      endPosition: cell.end,
      surveyCell: { respondentId: cell.respondentId, questionId: cell.questionId }
    })
    const memo = useMemoStore.getState().findMemo(guid)
    if (memo) {
      const initData: MemoEditInitData = {
        memo,
        theme: document.documentElement.getAttribute('data-theme') || ''
      }
      window.api.openMemoEditWindow(initData)
    }
    closeMenu()
  }, [targetCells, source.guid, closeMenu])

  const handleDeleteMemo = useCallback(
    (memoGuid: string) => {
      useMemoStore.getState().removeMemo(memoGuid)
      closeMenu()
    },
    [closeMenu]
  )

  // ── View resolution ──────────────────────────────────────────

  const respondent = useMemo(
    () => (view.mode === 'respondent' && view.childId
      ? survey?.respondents.find((r) => r.id === view.childId)
      : undefined),
    [survey, view]
  )
  const question = useMemo(
    () => (view.mode === 'question' && view.childId
      ? survey?.questions.find((q) => q.id === view.childId)
      : undefined),
    [survey, view]
  )

  const handleMemoClick = useCallback((memoGuid: string) => {
    const memo = useMemoStore.getState().findMemo(memoGuid)
    if (!memo) return
    const initData: MemoEditInitData = {
      memo,
      theme: document.documentElement.getAttribute('data-theme') || ''
    }
    window.api.openMemoEditWindow(initData)
  }, [])

  if (!survey) {
    return (
      <div style={{ padding: 24, color: 'var(--text-muted)' }}>
        This survey couldn't be loaded — its parsed data is missing.
      </div>
    )
  }

  const showApply = pending != null || !!menu?.cellPending
  const showRemove = (menu?.existingCodings.length ?? 0) > 0
  const showQuoteMemo = pending != null || !!menu?.cellPending
  const showDeleteMemo = (menu?.overlappingMemos.length ?? 0) > 0

  return (
    <div
      ref={containerRef}
      style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      onMouseDown={handleContainerMouseDown}
      onMouseUp={handleContainerMouseUp}
      onDragOver={(e) => {
        if (
          e.dataTransfer.types.includes('application/x-magnolia-code') ||
          e.dataTransfer.types.includes('application/x-magnolia-codes')
        ) {
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = pending ? 'copy' : 'none'
        }
      }}
      onDrop={handleDrop}
    >
      <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg-panel)', padding: '0 20px 24px 20px' }}>
        {view.mode === 'summary' && (
          <SummaryView
            survey={survey}
            displayName={source.name}
            onJumpToQuestion={(qid) => setView(source.guid, 'question', qid)}
            onJumpToRespondent={(rid) => setView(source.guid, 'respondent', rid)}
          />
        )}
        {view.mode === 'respondent' && respondent && (
          <RespondentView
            survey={survey}
            respondent={respondent}
            source={source}
            codes={codes}
            memos={memos}
            quotes={quotes}
            onTextSelected={handleCellTextSelected}
            onCodingRightClick={handleCellRightClick}
            onMemoClick={handleMemoClick}
            onChangeQuestionType={handleChangeQuestionType}
            onJumpToQuestion={(qid) => setView(source.guid, 'question', qid)}
          />
        )}
        {view.mode === 'question' && question && (
          <QuestionView
            survey={survey}
            question={question}
            source={source}
            codes={codes}
            memos={memos}
            quotes={quotes}
            onTextSelected={handleCellTextSelected}
            onCodingRightClick={handleCellRightClick}
            onMemoClick={handleMemoClick}
            onChangeQuestionType={handleChangeQuestionType}
            onJumpToRespondent={(rid) => setView(source.guid, 'respondent', rid)}
          />
        )}
        {view.mode === 'respondent' && !respondent && (
          <div style={{ color: 'var(--text-muted)' }}>Select a respondent on the left.</div>
        )}
        {view.mode === 'question' && !question && (
          <div style={{ color: 'var(--text-muted)' }}>Select a question on the left.</div>
        )}
      </div>

      {menu && (
        <div
          className="survey-context-menu context-menu"
          style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 1000 }}
          // Prevent the menu's own mousedown from collapsing the
          // underlying selection (which would clear `pending` before
          // the menu item's click handler runs).
          onMouseDown={(e) => e.preventDefault()}
          onMouseUp={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="context-menu-item"
            onClick={() => { useNewCodeTriggerStore.getState().request(); closeMenu() }}
          >
            New Code
          </div>
          <div className="context-menu-separator" />

          {showApply && (
            <>
              <div style={menuSectionLabelStyle}>Apply Code</div>
              {hotkeyCodes.map(({ code }) => (
                <div
                  key={code.guid}
                  className="context-menu-item"
                  onClick={() => handleApplyHotkeyCode(code.guid)}
                >
                  <span className="color-pip" style={{ background: code.color || '#888' }} />
                  <span style={{ flex: 1 }}>{code.name}</span>
                  <span style={{ fontSize: 10, color: 'var(--menu-fg-muted)', marginLeft: 12 }}>
                    {'⌘'}{code.hotkey}
                  </span>
                </div>
              ))}
              {hotkeyCodes.length === 0 && (
                <div className="context-menu-item" style={{ color: 'var(--text-muted)', pointerEvents: 'none' }}>
                  No hotkeys assigned — right-click a code to assign one
                </div>
              )}
            </>
          )}

          {showApply && showRemove && <div className="context-menu-separator" />}

          {showRemove && (
            <>
              <div style={menuSectionLabelStyle}>Remove Code</div>
              {menu!.existingCodings.map((ec) => {
                const code = findCode(ec.codeGuid)
                return (
                  <div
                    key={ec.codingGuid}
                    className="context-menu-item"
                    style={{ color: 'var(--menu-fg-danger)' }}
                    onClick={() => handleRemoveCoding(ec.selectionGuid, ec.codingGuid)}
                  >
                    <span className="color-pip" style={{ background: code?.color || '#888' }} />
                    {code?.name ?? 'Unknown'}
                  </div>
                )
              })}
            </>
          )}

          {showQuoteMemo && (
            <>
              <div className="context-menu-separator" />
              <div className="context-menu-item" onClick={handleAddQuote}>
                Add as Quote
              </div>
            </>
          )}

          {showQuoteMemo && (
            <>
              <div className="context-menu-separator" />
              <div className="context-menu-item" onClick={handleAddContentMemo}>
                Add Content Memo
              </div>
            </>
          )}

          {showDeleteMemo && (
            <>
              <div className="context-menu-separator" />
              <div style={menuSectionLabelStyle}>Delete Memo</div>
              {menu!.overlappingMemos.map((m) => (
                <div
                  key={m.guid}
                  className="context-menu-item"
                  style={{ color: 'var(--menu-fg-danger)' }}
                  onClick={() => handleDeleteMemo(m.guid)}
                >
                  {m.title}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Styles ─────────────────────────────────────────────────────────

const h1Style: React.CSSProperties = {
  margin: 0,
  fontSize: 18,
  color: 'var(--text-secondary)',
  userSelect: 'none'
}

const headerStyle: React.CSSProperties = {
  // Stay visible at the top of the scroll container while the user
  // scrolls through the question / respondent list below.
  position: 'sticky',
  top: 0,
  zIndex: 5,
  // Solid panel-coloured backdrop so content scrolling underneath
  // doesn't bleed through. We also extend horizontally with negative
  // left/right margins (re-padded inside) so the background covers
  // the full width of the scroll container — otherwise the side
  // gutters would show a sliver of scrolling content.
  // Padding matches the DocumentViewer's header (14px 20px 12px 20px)
  // so the heading bar reads as the same component across viewers.
  background: 'var(--bg-panel)',
  marginLeft: -20,
  marginRight: -20,
  paddingLeft: 20,
  paddingRight: 20,
  paddingTop: 14,
  paddingBottom: 12,
  marginBottom: 24,
  borderBottom: '1px solid var(--border-color)',
  userSelect: 'none'
}

const subtleMetaStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-muted)',
  marginTop: 2,
  userSelect: 'none'
}

const sectionHeadingStyle: React.CSSProperties = {
  margin: '0 0 4px 0',
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--text-secondary)',
  userSelect: 'none',
  cursor: 'pointer',
  transition: 'color 0.12s'
}

const indentedAnswerStyle: React.CSSProperties = {
  paddingLeft: 16
}

const emptyAnswerStyle: React.CSSProperties = {
  margin: '4px 0 12px 16px',
  fontSize: 13,
  color: 'var(--text-muted)',
  fontStyle: 'italic',
  userSelect: 'none'
}

const menuSectionLabelStyle: React.CSSProperties = {
  padding: '4px 14px',
  fontSize: 11,
  color: 'var(--text-muted)',
  fontWeight: 600,
  userSelect: 'none'
}
