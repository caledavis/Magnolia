import {
  ELEMENT_COLORS,
  type MapElement as MapElementType,
  type MapElementKind
} from './types'
import { TOOL_REGISTRY } from '../../../utils/tool-registry'
import { stripFormatting } from '../../../utils/strip-formatting'
import { sourceTypeFromFilename } from '../../../utils/format-registry'
import { PdfRegionThumbnail } from '../../DocumentViewer/PdfRegionThumbnail'
import { PdfFilePathsContext } from './PdfFilePathsContext'
import { useContext } from 'react'
import {
  Icon,
  faFile,
  faFolder,
  faTag,
  faTags,
  faMagnifyingGlass,
  faHeadphones,
  faVideo,
  faImage,
  MEMO_RANGED_ICON,
  QUOTE_ICON,
  faCircleNodes,
  SURVEY_RESPONDENT_ICON,
  SURVEY_QUESTION_ICON,
  SURVEY_ICON
} from '../../Icon'
import { useRef, useEffect } from 'react'
import type { IconComponent } from '../../Icon'
import { useTranslation } from 'react-i18next'
import { t } from '../../../i18n'

/** An element's kind badge (map.kind.<kind>), e.g. DOC, CODE. */
export const kindBadge = (kind: MapElementKind): string => t(`map.kind.${kind}`)

const KIND_ICONS: Record<MapElementKind, IconComponent | null> = {
  document: faFile,
  code: null,
  query: faMagnifyingGlass,
  'query-result': faMagnifyingGlass,
  memo: MEMO_RANGED_ICON,
  analysis: null,
  tag: faTag,
  'tag-category': faTags,
  quote: QUOTE_ICON,
  folder: faFolder,
  'survey-respondent': SURVEY_RESPONDENT_ICON,
  'survey-question': SURVEY_QUESTION_ICON,
  // Cells render as edge-accent cards (not chips), so KIND_ICONS is
  // only read for the tiny header kind-glyph next to the kind label.
  // Use the SURVEY_ICON there so the card visibly ties back to its
  // parent survey source.
  'survey-cell': SURVEY_ICON
}

function getElementColor(element: MapElementType): string {
  if (element.kind === 'analysis' && element.analysisToolType) {
    return TOOL_REGISTRY[element.analysisToolType]?.color || ELEMENT_COLORS.analysis
  }
  // Memos and quotes match the theme-aware icon colours defined in
  // global.css, so the map edge matches the icon colour users see in
  // the Quote / Memo panes and document viewers.
  if (element.kind === 'memo') return 'var(--memo-icon-color)'
  if (element.kind === 'quote') return 'var(--quote-icon-color)'
  return ELEMENT_COLORS[element.kind]
}

function getElementIcon(element: MapElementType): IconComponent | null {
  if (element.kind === 'analysis' && element.analysisToolType) {
    // Pull straight from the canonical tool registry so every analysis
    // kind (including results-in-documents) uses its own icon instead
    // of falling through to the relationship-map icon.
    return TOOL_REGISTRY[element.analysisToolType]?.icon || faCircleNodes
  }
  // Document kind branches on sourceType so the map node mirrors the
  // Document Browser's per-type glyph: clipboard-pen for surveys,
  // headphones for audio, camera-on-stand for video, image for image.
  // Anything unrecognised (or sourceType absent) falls through to the
  // generic faFile.
  if (element.kind === 'document') {
    switch (element.sourceType) {
      case 'survey': return SURVEY_ICON
      case 'audio':  return faHeadphones
      case 'video':  return faVideo
      case 'image':  return faImage
    }
  }
  return KIND_ICONS[element.kind]
}

interface Props {
  element: MapElementType
  selected: boolean
  /** Header mousedown → move; Body mousedown → draw link */
  onHeaderMouseDown: (e: React.MouseEvent, id: string) => void
  onBodyMouseDown: (e: React.MouseEvent, id: string) => void
  onDoubleClick: (element: MapElementType) => void
  /** Report actual rendered height so connection ports are positioned correctly */
  onRenderedHeight: (id: string, height: number) => void
  /** Focus-fade: when another element is hovered/selected and this one
   *  isn't in the focused subset, drop the opacity so the canvas clears. */
  dimmed?: boolean
  onHoverChange?: (id: string, hovered: boolean) => void
}

/** Simple single-label entities that render as chips (pill shape, one row).
 *  Content-bearing kinds (memo, quote, query-result, survey-cell) render
 *  as edge-accent cards with a title + snippet. */
const CHIP_KINDS: Set<MapElementKind> = new Set([
  'document',
  'code',
  'query',
  'tag',
  'tag-category',
  'analysis',
  'folder',
  'survey-respondent',
  'survey-question'
])

export function MapElement({ element, selected, onHeaderMouseDown, onBodyMouseDown, onDoubleClick, onRenderedHeight, dimmed, onHoverChange }: Props) {
  const { t } = useTranslation()
  const divRef = useRef<HTMLDivElement>(null)
  const pdfFilePaths = useContext(PdfFilePathsContext)
  const color = getElementColor(element)
  const icon = getElementIcon(element)
  const isChip = CHIP_KINDS.has(element.kind)
  const isMemo = element.kind === 'memo'
  const isQuote = element.kind === 'quote'
  const isResult = element.kind === 'query-result'
  const isSurveyCell = element.kind === 'survey-cell'

  // Report actual rendered height to parent so connection ports are accurate
  useEffect(() => {
    if (!divRef.current) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // Measure the border-box height directly — that's what `minHeight`
        // controls (global `* { box-sizing: border-box }`) and what the
        // connection ports are positioned against. Fall back to
        // contentRect + 2px borders on engines without borderBoxSize.
        const measured =
          entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height + 2
        const h = Math.round(measured)
        // Dead-band: only sync when the height genuinely changed (>1px).
        // Fractional display scaling (common on Windows at 125/150%) snaps
        // the box to the device-pixel grid, so `measured` lands a sub-pixel
        // off the integer `minHeight` every frame. Without this tolerance
        // the ResizeObserver → setHeight → minHeight → ResizeObserver cycle
        // ratchets the node ~1px taller each frame indefinitely.
        if (Math.abs(h - element.height) > 1) onRenderedHeight(element.id, h)
      }
    })
    observer.observe(divRef.current)
    return () => observer.disconnect()
  }, [element.id, element.height, onRenderedHeight])

  // Shared wrapper props so click/double-click/shadow behave the same way
  // for both chip and card variants.
  const wrapperProps = {
    ref: divRef,
    onDoubleClick: (e: React.MouseEvent) => {
      e.stopPropagation()
      onDoubleClick(element)
    },
    onMouseEnter: () => onHoverChange?.(element.id, true),
    onMouseLeave: () => onHoverChange?.(element.id, false)
  } as const

  const dimOpacity = dimmed && !selected ? 0.22 : 1

  if (isChip) {
    // ─── Chip ───────────────────────────────────────────────
    // Left grip (kind color dot + icon) moves the node; the rest of the
    // chip draws a connection wire — same dual-zone semantics as before.
    const codeDotBg =
      element.kind === 'code' && element.codeColor ? element.codeColor : color
    return (
      <div
        {...wrapperProps}
        style={{
          position: 'absolute',
          left: element.x,
          top: element.y,
          width: element.width,
          minHeight: element.height,
          background: 'var(--bg-primary, #fff)',
          border: `1px solid ${selected ? '#3b82f6' : 'var(--border-color, #e0e0e0)'}`,
          borderRadius: 999,
          userSelect: 'none',
          display: 'flex',
          alignItems: 'center',
          overflow: 'hidden',
          opacity: dimOpacity,
          boxShadow: selected
            ? '0 0 0 2px rgba(59,130,246,0.3), 0 1px 3px rgba(0,0,0,0.08)'
            : '0 1px 2px rgba(0,0,0,0.05)',
          transition: 'box-shadow 0.1s, opacity 0.12s'
        }}
      >
        {/* Grip — icon (if any) or kind-color dot. Drag to move.
            When an icon exists we skip the pip so query/document/tag chips
            aren't doubled up; codes and tag-categories rely on the dot
            since their icon is either missing or already coloured. */}
        <div
          onMouseDown={(e) => {
            e.stopPropagation()
            onHeaderMouseDown(e, element.id)
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 4px 4px 10px',
            alignSelf: 'stretch',
            cursor: 'grab'
          }}
        >
          {icon ? (
            <Icon
              icon={icon}
              style={{ fontSize: 11, color }}
            />
          ) : (
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: '50%',
                background: codeDotBg,
                flexShrink: 0
              }}
            />
          )}
        </div>
        {/* Label — drag to draw link. */}
        <div
          onMouseDown={(e) => {
            e.stopPropagation()
            onBodyMouseDown(e, element.id)
          }}
          style={{
            flex: 1,
            padding: '4px 12px 4px 4px',
            fontSize: 12,
            fontWeight: 400,
            color: 'var(--text-primary, #1d1d1f)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            cursor: 'crosshair'
          }}
          title={element.label}
        >
          {element.label}
        </div>
      </div>
    )
  }

  // ─── Edge-accent card (memo, quote, query-result) ─────────────
  // Left 3px colored bar; top row (title/source) is the move handle, the
  // snippet area draws a connection wire.
  const title = isMemo
    ? element.label || t('map.untitledMemo')
    : element.label /* source name for quote/result */

  return (
    <div
      {...wrapperProps}
      style={{
        position: 'absolute',
        left: element.x,
        top: element.y,
        width: element.width,
        minHeight: element.height,
        background: 'var(--bg-primary, #fff)',
        // Avoid the `border` shorthand: in inline styles it can clobber
        // borderLeft on subsequent re-renders (select/deselect cycles),
        // which made the edge colour appear to vanish.
        borderTop: `1px solid ${selected ? '#3b82f6' : 'var(--border-color, #e0e0e0)'}`,
        borderRight: `1px solid ${selected ? '#3b82f6' : 'var(--border-color, #e0e0e0)'}`,
        borderBottom: `1px solid ${selected ? '#3b82f6' : 'var(--border-color, #e0e0e0)'}`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 6,
        userSelect: 'none',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        opacity: dimOpacity,
        boxShadow: selected
          ? '0 0 0 2px rgba(59,130,246,0.3), 0 1px 3px rgba(0,0,0,0.08)'
          : '0 1px 2px rgba(0,0,0,0.05)',
        transition: 'box-shadow 0.1s, opacity 0.12s'
      }}
    >
      {/* Title row — drag to move */}
      <div
        onMouseDown={(e) => {
          e.stopPropagation()
          onHeaderMouseDown(e, element.id)
        }}
        style={{
          padding: '4px 8px 2px',
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 6,
          cursor: 'grab'
        }}
      >
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--text-primary, #1d1d1f)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
            lineHeight: '14px'
          }}
          title={title}
        >
          {title}
        </span>
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '0.4px',
            color: 'var(--text-muted, #8e8e93)',
            flexShrink: 0,
            lineHeight: '14px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4
          }}
        >
          {icon && <Icon icon={icon} style={{ fontSize: 10, color }} />}
          {kindBadge(element.kind)}
        </span>
      </div>
      {/* Snippet / thumbnail — drag to draw link */}
      <div
        onMouseDown={(e) => {
          e.stopPropagation()
          onBodyMouseDown(e, element.id)
        }}
        style={{
          flex: 1,
          padding: '0 8px 6px',
          fontSize: 11,
          fontWeight: 400,
          lineHeight: '14px',
          color: 'var(--text-primary, #1d1d1f)',
          overflow: 'hidden',
          wordBreak: 'break-word',
          cursor: 'crosshair'
        }}
      >
        {element.pdfRegion && element.sourceGuid ? (
          <PdfRegionThumbnail
            sourceGuid={element.sourceGuid}
            filePath={pdfFilePaths[element.sourceGuid]}
            page={element.pdfRegion.page}
            x={element.pdfRegion.x}
            y={element.pdfRegion.y}
            width={element.pdfRegion.width}
            height={element.pdfRegion.height}
            maxW={element.width - 16}
            maxH={Math.max(60, element.height - 30)}
          />
        ) : isMemo ? (
          <div
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 5,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden'
            }}
          >
            {element.snippet ? stripFormatting(element.snippet, 'markdown') : ''}
          </div>
        ) : isSurveyCell ? (
          <>
            {/* Question text — italic, muted, sits above the answer
                body. Denormalised onto the element at drop time
                (element.questionLabel) so the renderer doesn't need
                to look survey data back up. */}
            {element.questionLabel && (
              <div
                style={{
                  fontStyle: 'italic',
                  color: 'var(--text-muted, #8e8e93)',
                  marginBottom: 4,
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden'
                }}
                title={element.questionLabel}
              >
                {element.questionLabel}
              </div>
            )}
            <div
              style={{
                display: '-webkit-box',
                WebkitLineClamp: 3,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden'
              }}
            >
              {element.snippet || ''}
            </div>
          </>
        ) : (
          <div
            style={{
              display: '-webkit-box',
              WebkitLineClamp: isQuote || isResult ? 3 : 4,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden'
            }}
          >
            {element.snippet
              ? stripFormatting(element.snippet, sourceTypeFromFilename(element.label || ''))
              : ''}
          </div>
        )}
      </div>
    </div>
  )
}
