import { faFolder, faTag, faMagnifyingGlass, faBookmark, faQuoteLeft, faLightbulb, type IconComponent } from '../components/Icon'

/** The icon for each pane the user can show or hide, shared by the
 *  ribbon's View tab and the Icons toolbar's panes pop-up so the two
 *  always match. Drawn in the icon palette (PALETTE_ICON_CLASS). */
export const PANE_ICONS = {
  documents: faFolder,
  codes: faTag,
  queries: faMagnifyingGlass,
  memos: faBookmark,
  quotes: faQuoteLeft,
  analyses: faLightbulb
} satisfies Record<string, IconComponent>

export type PaneIconId = keyof typeof PANE_ICONS
