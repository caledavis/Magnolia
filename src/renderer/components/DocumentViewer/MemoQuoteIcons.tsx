/**
 * MemoQuoteIcons — shared icon column renderer used by both
 * CodedTextView and RichMarginColumn. Renders absolutely-positioned
 * quote and memo icons based on precomputed IconGroup[] data.
 *
 * Positioning modes:
 *   - If a group carries a `leftX`, the icon is placed at that X
 *     (computed by the parent to sit immediately after any overlapping
 *     code-name label at the same Y).
 *   - Otherwise the icon falls back to the legacy right-pinned column
 *     (quote at right = ICON_COL_W, memo at right = 0).
 */
import type { CSSProperties } from 'react'
import { Icon, MEMO_RANGED_ICON, MEMO_POINT_ICON, QUOTE_ICON } from '../Icon'
import { ICON_COL_W, type IconGroup } from './iconLayout'
import type { Memo, PdfRegionSelection } from '../../models/types'
import { useTranslation } from 'react-i18next'
import { formatNumber } from '../../i18n'

interface Props {
  groups: IconGroup[]
  /** Resolve a memo guid to the full Memo (needed for popup rendering). */
  findMemo: (guid: string) => Memo | undefined
  /** Open the memo edit window for a given memo guid. */
  onMemoClick?: (memoGuid: string) => void
  /** Show a multi-item popup at (x,y) when multiple icons are stacked. */
  onMemoPopup?: (e: React.MouseEvent, memos: Memo[]) => void
  /** Delegate the right-click context menu for a memo icon. */
  onMemoContextMenu?: (e: React.MouseEvent, memos: Memo[]) => void
  /** Hover a range in the document — used for transient highlighting. */
  onHoverRange?: (range: { startCp: number; endCp: number } | null) => void
  /** Hover a pdf/image region — used by the PDF + image viewers to
   *  highlight the region box when the user mouses over a memo or
   *  quote icon whose underlying item has a `pdfRegion`. Parent clears
   *  by calling with null. */
  onHoverRegion?: (region: PdfRegionSelection | null) => void
  /** Lock a range (toggled on icon click when there's only one item). */
  onLockRange?: (range: { startCp: number; endCp: number } | null) => void
  lockedRange?: { startCp: number; endCp: number } | null
  /** Handle quote icon click — opens a popup with the list of quotes. */
  onQuoteClick?: (
    e: React.MouseEvent,
    items: { guid: string; startCp: number; endCp: number }[],
    showDelete?: boolean
  ) => void
}

const colStyle: CSSProperties = {
  width: ICON_COL_W,
  minWidth: ICON_COL_W,
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  userSelect: 'none',
  overflow: 'visible',
  position: 'relative'
}

function Badge({ count, color }: { count: number; color: string }) {
  return (
    <span
      style={{
        position: 'absolute',
        top: -3,
        right: -3,
        fontSize: 7,
        fontWeight: 700,
        background: color,
        color: '#fff',
        borderRadius: '50%',
        width: 10,
        height: 10,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        lineHeight: 1
      }}
    >
      {formatNumber(count)}
    </span>
  )
}

export function MemoQuoteIcons({
  groups,
  findMemo,
  onMemoClick,
  onMemoPopup,
  onMemoContextMenu,
  onHoverRange,
  onHoverRegion,
  onLockRange,
  lockedRange,
  onQuoteClick
}: Props) {
  const { t } = useTranslation()
  const quoteGroups = groups.filter((g) => g.type === 'quote')
  const memoGroups = groups.filter((g) => g.type === 'memo')

  return (
    <>
      {/* Quote icons — positioned via leftX when the parent has packed
          them against the code-name labels; otherwise pinned to a right
          column (legacy layout). */}
      {quoteGroups.map((g, i) => (
        <div
          key={`quote-${i}`}
          style={{
            ...colStyle,
            position: 'absolute',
            ...(g.leftX !== undefined ? { left: g.leftX } : { right: ICON_COL_W }),
            top: g.top + 1,
            pointerEvents: 'auto'
          }}
        >
          <span
            style={{
              fontSize: 10,
              cursor: 'pointer',
              color: 'var(--quote-icon-color)',
              position: 'relative'
            }}
            title={t('viewer.quoteCount', { count: g.items.length })}
            onMouseEnter={() => {
              if (g.items.length === 1) {
                const it = g.items[0]
                if (it.pdfRegion) onHoverRegion?.(it.pdfRegion)
                else onHoverRange?.({ startCp: it.startCp, endCp: it.endCp })
              }
            }}
            onMouseLeave={() => {
              onHoverRegion?.(null)
              if (!lockedRange) onHoverRange?.(null)
            }}
            onClick={(e) => {
              if (g.items.length === 1) onLockRange?.({ startCp: g.items[0].startCp, endCp: g.items[0].endCp })
              onQuoteClick?.(
                e,
                g.items.map((it) => ({ guid: it.guid, startCp: it.startCp, endCp: it.endCp })),
                false
              )
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onQuoteClick?.(
                e,
                g.items.map((it) => ({ guid: it.guid, startCp: it.startCp, endCp: it.endCp })),
                true
              )
            }}
          >
            <Icon icon={QUOTE_ICON} />
            {g.items.length > 1 && <Badge count={g.items.length} color="var(--accent)" />}
          </span>
        </div>
      ))}

      {/* Memo icons — same positioning rule as quotes. The parent is
          responsible for adding ICON_COL_W to a memo's leftX when a
          quote sits at the same Y so they stack side-by-side. */}
      {memoGroups.map((g, i) => {
        const firstItem = g.items[0]
        const titles = g.items.map((it) => it.title || t('viewer.selectionMemo')).join(', ')
        const isRanged = !!firstItem.isRanged
        return (
          <div
            key={`memo-${i}`}
            style={{
              ...colStyle,
              position: 'absolute',
              ...(g.leftX !== undefined ? { left: g.leftX } : { right: 0 }),
              top: g.top + 1,
              pointerEvents: 'auto'
            }}
          >
            <span
              style={{
                fontSize: 11,
                cursor: 'pointer',
                color: 'var(--memo-icon-color)',
                position: 'relative'
              }}
              title={titles}
              onMouseEnter={() => {
                if (g.items.length === 1 && firstItem.isRanged) {
                  if (firstItem.pdfRegion) onHoverRegion?.(firstItem.pdfRegion)
                  else onHoverRange?.({ startCp: firstItem.startCp, endCp: firstItem.endCp })
                }
              }}
              onMouseLeave={() => {
                onHoverRegion?.(null)
                if (!lockedRange) onHoverRange?.(null)
              }}
              onClick={(e) => {
                if (g.items.length === 1) {
                  if (firstItem.isRanged) {
                    const r = { startCp: firstItem.startCp, endCp: firstItem.endCp }
                    if (lockedRange && lockedRange.startCp === r.startCp && lockedRange.endCp === r.endCp) {
                      onLockRange?.(null)
                    } else {
                      onLockRange?.(r)
                    }
                  }
                  onMemoClick?.(firstItem.guid)
                } else {
                  let minCp = Infinity
                  let maxCp = -Infinity
                  for (const it of g.items) {
                    if (it.isRanged && it.startCp !== it.endCp) {
                      minCp = Math.min(minCp, it.startCp)
                      maxCp = Math.max(maxCp, it.endCp)
                    }
                  }
                  if (minCp < Infinity) onLockRange?.({ startCp: minCp, endCp: maxCp })
                  const memos = g.items.map((it) => findMemo(it.guid)).filter((m): m is Memo => !!m)
                  onMemoPopup?.(e, memos)
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                const memos = g.items.map((it) => findMemo(it.guid)).filter((m): m is Memo => !!m)
                onMemoContextMenu?.(e, memos)
              }}
            >
              <Icon icon={isRanged ? MEMO_RANGED_ICON : MEMO_POINT_ICON} />
              {g.items.length > 1 && <Badge count={g.items.length} color="var(--accent)" />}
            </span>
          </div>
        )
      })}
    </>
  )
}
