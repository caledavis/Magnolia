import { faFolder, faTag, faMagnifyingGlass, faBookmark, faQuoteLeft, faLightbulb, type IconComponent } from '../components/Icon'

/** The icon for each pane the user can show or hide, in the ribbon's View
 *  tab. Drawn in the icon palette (PALETTE_ICON_CLASS). */
export const PANE_ICONS = {
  documents: faFolder,
  codes: faTag,
  queries: faMagnifyingGlass,
  memos: faBookmark,
  quotes: faQuoteLeft,
  analyses: faLightbulb
} satisfies Record<string, IconComponent>
