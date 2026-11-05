/**
 * iconLayout — shared grouping / layout logic for the memo + quote icon
 * column in the document viewers. Used by both CodedTextView (plain
 * text / markdown / transcript) and RichMarginColumn (PDF) so the icon
 * column behaves identically across viewers.
 *
 * The function is pure: callers measure their own DOM positions, feed in
 * memo / quote items with their Y bounds, and get back a list of icon
 * groups whose members share a Y band (within LINE_GROUP_TOLERANCE).
 */

import type { Memo } from '../../models/types'

/** Pixel width of a single icon column (memo or quote). */
export const ICON_COL_W = 18
/** Items whose Y centers fall within this many pixels of each other are
 *  grouped onto one line (shown as a single icon with a count badge). */
export const LINE_GROUP_TOLERANCE = 8

export interface IconItem {
  type: 'memo' | 'quote'
  top: number
  guid: string
  /** True for memos that span a range (paperclip icon) vs. point memos. */
  isRanged?: boolean
  startCp: number
  endCp: number
  title?: string
  /** Present for items anchored to an image/PDF page region. Preserved
   *  through layoutIcons so MemoQuoteIcons can fire a region hover to
   *  highlight the box when the user mouses over the icon. */
  pdfRegion?: import('../../models/types').PdfRegionSelection
}

export interface IconGroup {
  type: 'memo' | 'quote'
  top: number
  /** Optional absolute left offset (px) at which this icon should render.
   *  Set by the viewer after bracket layout so icons sit immediately right
   *  of any overlapping code-name label. When undefined, MemoQuoteIcons
   *  falls back to its legacy right-pinned column layout. */
  leftX?: number
  items: {
    guid: string
    isRanged?: boolean
    startCp: number
    endCp: number
    title?: string
    pdfRegion?: import('../../models/types').PdfRegionSelection
  }[]
}

/**
 * Group icon items by similar Y position so we show one icon + badge per
 * line. Items within LINE_GROUP_TOLERANCE pixels merge into one group.
 */
export function layoutIcons(items: IconItem[]): IconGroup[] {
  if (items.length === 0) return []
  const sorted = [...items].sort((a, b) => a.top - b.top)
  const groups: IconGroup[] = []
  for (const item of sorted) {
    const existing = groups.find(
      (g) => g.type === item.type && Math.abs(g.top - item.top) < LINE_GROUP_TOLERANCE
    )
    if (existing) {
      existing.items.push({
        guid: item.guid,
        isRanged: item.isRanged,
        startCp: item.startCp,
        endCp: item.endCp,
        title: item.title,
        pdfRegion: item.pdfRegion
      })
    } else {
      groups.push({
        type: item.type,
        top: item.top,
        items: [
          { guid: item.guid, isRanged: item.isRanged, startCp: item.startCp, endCp: item.endCp, title: item.title, pdfRegion: item.pdfRegion }
        ]
      })
    }
  }
  return groups
}

/**
 * Build IconItem[] from the viewer's memos and quotes, using a provided
 * "measure top Y" function. Memos with no positional info are skipped.
 * Memos and quotes with a pdfRegion take precedence over codepoint
 * positions when available.
 */
export function buildIconItems(
  contentMemos: Memo[] | undefined,
  quotes: { guid: string; startCp: number; endCp: number; pdfRegion?: import('../../models/types').PdfRegionSelection }[] | undefined,
  measure: (ctx: {
    pdfRegion?: import('../../models/types').PdfRegionSelection
    startPosition?: number
    endPosition?: number
  }) => { top: number; bottom: number } | null
): IconItem[] {
  const result: IconItem[] = []

  if (contentMemos) {
    for (const memo of contentMemos) {
      const bounds = measure({
        pdfRegion: memo.pdfRegion,
        startPosition: memo.startPosition,
        endPosition: memo.endPosition
      })
      if (!bounds) continue
      // A 0×0 pdfRegion is a point memo pinned to a spot on a page —
      // treat it as un-ranged so the icon column shows the thumbtack
      // (not the paperclip).
      const isPointPdfRegion = !!memo.pdfRegion &&
        memo.pdfRegion.width === 0 && memo.pdfRegion.height === 0
      const isRanged =
        (!!memo.pdfRegion && !isPointPdfRegion) ||
        (memo.endPosition !== undefined &&
          memo.startPosition !== undefined &&
          memo.startPosition !== memo.endPosition)
      result.push({
        type: 'memo',
        top: bounds.top,
        guid: memo.guid,
        isRanged,
        startCp: memo.startPosition ?? 0,
        endCp: memo.endPosition ?? memo.startPosition ?? 0,
        title: memo.title,
        pdfRegion: memo.pdfRegion
      })
    }
  }

  if (quotes) {
    for (const q of quotes) {
      const bounds = measure({
        pdfRegion: q.pdfRegion,
        startPosition: q.startCp,
        endPosition: q.endCp
      })
      if (!bounds) continue
      result.push({
        type: 'quote',
        top: bounds.top,
        guid: q.guid,
        startCp: q.startCp,
        endCp: q.endCp,
        pdfRegion: q.pdfRegion
      })
    }
  }

  return result
}

/** Gap kept between a code-name label and a memo or quote icon after it. */
export const LABEL_TO_ICON_GAP = 4

/** Room to keep free at the end of a code-name label on the row starting
 *  at `labelTop` (rows are LABEL_H tall), for the memo and quote icons
 *  that sit after it. Labels may stretch to the pane's edge, so without
 *  this an icon on the same row as a long label is pushed past the edge
 *  and can't be seen. */
export function iconRoomAt(groups: Pick<IconGroup, 'top'>[], labelTop: number, rowHeight: number): number {
  const n = groups.filter((g) => g.top < labelTop + rowHeight && g.top + rowHeight > labelTop).length
  return n === 0 ? 0 : n * ICON_COL_W + LABEL_TO_ICON_GAP
}
