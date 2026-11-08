import { useEffect, useRef, useState } from 'react'
import { useMemoStore } from '../../stores/memo-store'
import { Icon, MEMO_ICON } from '../Icon'
import { generateGuid } from '../../utils/guid'
import type { Memo, MemoEditInitData } from '../../models/types'
import { useTranslation } from 'react-i18next'

/** Layout variant shared by every FAB kind. */
interface BaseProps {
  /** 'absolute' (default) floats the button at the top-right of the
   *  parent, with a ResizeObserver compensating for any scrollbar
   *  gutter on a sibling scroll area. 'inline' drops the absolute
   *  positioning so callers can place the same button inside an
   *  existing flex toolbar. */
  variant?: 'absolute' | 'inline'
  /** Default title pre-filled on the memo when the user creates a
   *  new draft via this FAB. Lets callers customise the auto-name
   *  (e.g. "Q3" for question memos, "R5Q3" for cell memos) without
   *  forcing them to handle the create flow themselves. */
  defaultTitle?: string
}

interface SavedAnalysisProps extends BaseProps {
  kind: 'saved-analysis'
  /** When undefined the analysis hasn't been saved yet — the FAB
   *  renders ghost and clicking it nudges the user to save first. */
  targetGuid?: string
}

interface SavedQueryProps extends BaseProps {
  kind: 'saved-query'
  targetGuid?: string
}

/** One memo per document. Document memos can list multiple sources
 *  in `sourceGuids`; the FAB lights up whenever the current source
 *  appears in any document memo's `sourceGuids`. */
interface DocumentProps extends BaseProps {
  kind: 'document'
  sourceGuid: string
}

/** One memo per (survey, question). */
interface SurveyQuestionProps extends BaseProps {
  kind: 'survey-question'
  sourceGuid: string
  questionGuid: string
}

/** One memo per (survey, respondent). */
interface SurveyRespondentProps extends BaseProps {
  kind: 'survey-respondent'
  sourceGuid: string
  respondentId: string
}

/** One whole-cell memo per (survey, respondent, question). Stored
 *  as `type: 'survey-cell'` so it doesn't collide with the span
 *  memos that may also exist in the same cell ('content' memos with
 *  a surveyCell extension). */
interface SurveyCellProps extends BaseProps {
  kind: 'survey-cell'
  sourceGuid: string
  respondentId: string
  questionId: string
}

type Props =
  | SavedAnalysisProps
  | SavedQueryProps
  | DocumentProps
  | SurveyQuestionProps
  | SurveyRespondentProps
  | SurveyCellProps

/**
 * Floating circular memo button shown in the top-right corner of an
 * open analysis / query-builder tab. Filled glyph when a memo is
 * attached, faint outlined "ghost" glyph when none — clicking either
 * opens the memo edit window (creating a new draft for the ghost
 * case). Hidden from the Memos pane: this is the only entry point
 * the user has for these memos in the main window aside from the
 * context-menu / row icon in the Saved Queries / Saved Analyses
 * sidebars.
 */
export function MemoFab(props: Props) {
  const { t } = useTranslation()
  const { kind, variant = 'absolute', defaultTitle } = props
  const memos = useMemoStore((s) => s.memos)

  // Pick the existing memo this FAB represents — dispatched per kind.
  let memo: Memo | undefined
  let isUnsaved = false
  if (kind === 'saved-analysis') {
    const t = props.targetGuid
    isUnsaved = !t
    memo = !t ? undefined : memos.find((m) => m.type === 'saved-analysis' && m.analysisGuid === t)
  } else if (kind === 'saved-query') {
    const t = props.targetGuid
    isUnsaved = !t
    memo = !t ? undefined : memos.find((m) => m.type === 'saved-query' && m.queryGuid === t)
  } else if (kind === 'document') {
    memo = memos.find((m) =>
      m.type === 'document' && !!m.sourceGuids?.includes(props.sourceGuid)
    )
  } else if (kind === 'survey-question') {
    memo = memos.find((m) =>
      m.type === 'survey-question' &&
      m.sourceGuid === props.sourceGuid &&
      m.questionGuid === props.questionGuid
    )
  } else if (kind === 'survey-respondent') {
    memo = memos.find((m) =>
      m.type === 'survey-respondent' &&
      m.sourceGuid === props.sourceGuid &&
      m.respondentId === props.respondentId
    )
  } else if (kind === 'survey-cell') {
    // Match whole-cell memos for this cell. Span memos from the
    // right-click context menu must NOT light up the FAB — they
    // attach to part of the cell and live in the right-margin icon
    // strip instead. We tell the two apart on type AND on whether
    // a startPosition was recorded:
    //   - type 'survey-cell'                    → whole-cell (current model)
    //   - type 'content' + surveyCell + no
    //     startPosition                          → whole-cell (legacy:
    //                                              FAB created these
    //                                              before survey-cell
    //                                              became its own type)
    //   - type 'content' + surveyCell + a
    //     startPosition                          → span (right-click)
    memo = memos.find((m) => {
      if (m.sourceGuid !== props.sourceGuid) return false
      if (m.surveyCell?.respondentId !== props.respondentId) return false
      if (m.surveyCell?.questionId !== props.questionId) return false
      if (m.type === 'survey-cell') return true
      if (m.type === 'content' && m.startPosition === undefined) return true
      return false
    })
  }
  const hasMemo = !!memo

  // The sections inside an analysis tool live inside a scrollable
  // container that reserves an 8 px gutter when its scrollbar is
  // visible. The FAB lives in the *outer* (non-scrollable) wrapper,
  // so without compensation the circle's right edge drifts 8 px
  // right of the sections' visible right edge whenever the scrollbar
  // is showing. Measure the scrollable sibling's gutter
  // (offsetWidth - clientWidth) and feed it into the right offset.
  // ResizeObserver keeps it correct as the panel is resized and the
  // scrollbar appears / disappears.
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [scrollbarGutter, setScrollbarGutter] = useState(0)
  // Hover affordance for the "off" FAB: the resting state is a quiet
  // --border-color outline, which can read as non-interactive. On hover
  // we darken the circle + glyph to --text-muted so it's clearly
  // clickable. (The "on" state already stands out, so hover leaves it.)
  const [hovered, setHovered] = useState(false)
  const offColor = hovered ? 'var(--text-muted)' : 'var(--border-color)'
  useEffect(() => {
    if (variant !== 'absolute') return
    const button = buttonRef.current
    if (!button) return
    const parent = button.parentElement
    if (!parent) return
    const findScrollable = (): HTMLElement | null => {
      const candidates = parent.querySelectorAll<HTMLElement>('*')
      for (const el of Array.from(candidates)) {
        if (el === button || el.contains(button)) continue
        const cs = getComputedStyle(el)
        if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > 0) {
          return el
        }
      }
      return null
    }
    let scrollable = findScrollable()
    const measure = () => {
      if (!scrollable) scrollable = findScrollable()
      if (!scrollable) return
      const gutter = scrollable.offsetWidth - scrollable.clientWidth
      setScrollbarGutter((prev) => prev !== gutter ? gutter : prev)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(parent)
    if (scrollable) ro.observe(scrollable)
    // Some tools mutate their tree on first interaction (e.g. Query
    // Builder) — re-check shortly after mount in case the scrollable
    // descendant wasn't there yet.
    const timeout = window.setTimeout(measure, 50)
    return () => {
      ro.disconnect()
      window.clearTimeout(timeout)
    }
  }, [variant])

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isUnsaved) {
      window.alert(t(kind === 'saved-query' ? 'memoFab.saveFirst.query' : 'memoFab.saveFirst.analysis'))
      return
    }
    if (memo) {
      const initData: MemoEditInitData = {
        memo,
        theme: document.documentElement.getAttribute('data-theme') || ''
      }
      window.api.openMemoEditWindow(initData)
      return
    }
    // Build the new-draft Memo per kind.
    const base = {
      guid: generateGuid(),
      title: defaultTitle ?? '',
      content: '',
      createdDateTime: new Date().toISOString()
    } as const
    let draft: Memo
    if (kind === 'saved-analysis') {
      draft = { ...base, type: 'saved-analysis', analysisGuid: props.targetGuid! }
    } else if (kind === 'saved-query') {
      draft = { ...base, type: 'saved-query', queryGuid: props.targetGuid! }
    } else if (kind === 'document') {
      draft = {
        ...base,
        type: 'document',
        sourceGuids: [props.sourceGuid]
      }
    } else if (kind === 'survey-question') {
      draft = {
        ...base,
        type: 'survey-question',
        sourceGuid: props.sourceGuid,
        questionGuid: props.questionGuid
      }
    } else if (kind === 'survey-respondent') {
      draft = {
        ...base,
        type: 'survey-respondent',
        sourceGuid: props.sourceGuid,
        respondentId: props.respondentId
      }
    } else {
      // survey-cell — whole-cell memo, stored as type 'survey-cell'
      // (not 'content') so it doesn't collide with span memos that
      // happen to live in the same cell.
      draft = {
        ...base,
        type: 'survey-cell',
        sourceGuid: props.sourceGuid,
        surveyCell: {
          respondentId: props.respondentId,
          questionId: props.questionId
        }
      }
    }
    const initData: MemoEditInitData = {
      memo: draft,
      theme: document.documentElement.getAttribute('data-theme') || '',
      isNew: true
    }
    window.api.openMemoEditWindow(initData)
  }

  return (
    <button
      ref={buttonRef}
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={
        isUnsaved
          ? t(kind === 'saved-query' ? 'memoFab.saveToAttach.query' : 'memoFab.saveToAttach.analysis')
          : hasMemo
            ? t('common.openMemo')
            : t('memos.add')
      }
      aria-label={hasMemo ? t('common.openMemo') : t('memos.add')}
      style={{
        ...(variant === 'absolute' ? {
          position: 'absolute' as const,
          // top: 11 instead of the row's padding-top of 14: the title
          // row's buttons (font-size 11, padding 4) and h2 (font-size
          // 18) are ~22 px tall and centred with align-items, so their
          // vertical centre sits at y≈25. The FAB is 28 px tall, so
          // top: 11 puts its centre at the same y. With top: 14 it
          // sat ~3 px below the buttons' centre.
          top: 11,
          // 20 px matches the analysis content's right padding so
          // the FAB's outer edge lands flush with the sections
          // beneath it. The +scrollbarGutter compensates for the
          // scrollbar gutter the inner scroll area reserves when it
          // overflows; without it the FAB would sit 8 px right of
          // the section edges as soon as the scrollbar appears.
          insetInlineEnd: 20 + scrollbarGutter,
          zIndex: 5
        } : {
          // Inline variant — caller controls placement via the
          // surrounding flex container.
          position: 'relative' as const,
          flexShrink: 0
        }),
        width: 28,
        height: 28,
        borderRadius: '50%',
        // Use grid + place-items: center to centre the SVG: this
        // ignores the button's text-baseline + font-size box, which
        // were nudging the glyph a hair above geometric centre with
        // flexbox.
        display: 'grid',
        placeItems: 'center',
        lineHeight: 0,
        fontSize: 0,
        // Always solid so scrolling content underneath doesn't bleed
        // through the FAB. --bg-panel matches the analysis-section /
        // doc-viewer surface the FAB usually sits on, so it still
        // reads as flush with its container rather than a chip.
        background: 'var(--bg-panel)',
        border: `1.5px solid ${hasMemo ? 'var(--memo-active-color)' : offColor}`,
        // In the "off" state the bookmark glyph matches its surrounding
        // circle so the FAB reads as a single quiet outline — resting at
        // --border-color, darkening to --text-muted on hover (offColor).
        color: hasMemo ? 'var(--memo-active-color)' : offColor,
        cursor: 'pointer',
        padding: 0,
        transition: 'color 0.12s, border-color 0.12s'
      }}
    >
      <Icon
        icon={MEMO_ICON}
        style={{
          fontSize: 13,
          display: 'block',
          // Lucide glyphs are stroke-only by default (fill="none" on
          // the SVG). When a memo is attached, fill the bookmark
          // interior with the same colour as its outline so the FAB
          // reads as a solid, "on" indicator instead of an outline.
          fill: hasMemo ? 'currentColor' : 'none'
        }}
      />
    </button>
  )
}
