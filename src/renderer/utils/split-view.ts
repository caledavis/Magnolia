/**
 * Split view: a PDF or text document can be shown in two halves, one above
 * the other, each scrolled (and, for PDFs, zoomed) on its own and each
 * fully codeable, like Word's Split — so the reader can code page 1 while
 * reading an endnote on page 23.
 *
 * The half the reader last clicked in is the active one. Only it takes
 * Cmd/Ctrl+0-9 code hotkeys, holds the selection the New Code dialog
 * applies to, and follows quote, memo and query-result clicks.
 *
 * Whether a document is split, and where the divider sits, is remembered
 * per document with its reading position (view-position-store.ts).
 */
import { getViewSetting, setViewSetting } from '../stores/view-position-store'

export type SplitPane = 'primary' | 'secondary'

/** The divider position a new split starts at (the top half's share). */
export const DEFAULT_SPLIT_RATIO = 0.5
/** Neither half may shrink below this share of the viewer's height... */
export const MIN_SPLIT_RATIO = 0.15
/** ...except that dragging the divider this close to the top or bottom
 *  edge closes that half, removing the split. */
export const COLLAPSE_SPLIT_RATIO = 0.05

/** The key a half's scroll position is remembered under. */
export function paneScrollKey(sourceGuid: string, pane: SplitPane): string {
  return pane === 'primary' ? sourceGuid : `${sourceGuid}|split`
}

const ratioKey = (sourceGuid: string): string => `${sourceGuid}|split-ratio`

export function clampSplitRatio(ratio: number): number {
  return Math.min(1 - MIN_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio))
}

/** The saved divider position if the document was left split, else null. */
export function getSplitRatio(sourceGuid: string): number | null {
  const ratio = Number(getViewSetting(ratioKey(sourceGuid)))
  return ratio > 0 && ratio < 1 ? clampSplitRatio(ratio) : null
}

/** Remember the divider position, or that the document isn't split (null). */
export function setSplitRatio(sourceGuid: string, ratio: number | null): void {
  setViewSetting(ratioKey(sourceGuid), ratio === null ? '' : clampSplitRatio(ratio).toFixed(3))
}
