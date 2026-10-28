/**
 * Lucide icon set adapter.
 *
 * Each Magnolia-facing alias (the historical fa* names) maps to a
 * Lucide React component. To try a different library:
 *   1. npm install <library>
 *   2. Create a sibling adapter file (e.g. ./phosphor.ts) that exports
 *      the same fa* names mapped to that library's components plus a
 *      compatible `IconComponent` type.
 *   3. Change the import in ../Icon.tsx to point at the new adapter.
 *
 * Keeping the fa* names as the public contract means consumer files
 * never need to know which library is active.
 */
import {
  Folder,
  FolderPlus,
  File,
  FileText,
  Tags,
  Tag,
  Paperclip,
  Pin,
  StickyNote,
  Bookmark,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  TriangleAlert,
  Circle,
  Grid3x3,
  Table,
  ChartBar,
  ChartNoAxesColumn,
  ChartColumn,
  Lightbulb,
  ListOrdered,
  Type,
  Network,
  Share2,
  Search,
  ArrowLeftRight,
  Palette,
  ClipboardList,
  ExternalLink,
  Minimize2,
  Link,
  PanelLeft,
  SquareSplitVertical,
  SquarePlus,
  SquareArrowRightEnter,
  Plus,
  Menu,
  Quote,
  X,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Voicemail,
  Crosshair,
  TextCursor,
  Video,
  Volume2,
  Volume1,
  VolumeX,
  Pilcrow,
  Info,
  Bold,
  Italic,
  Underline,
  List,
  TextAlignStart,
  TextAlignCenter,
  TextAlignEnd,
  Heading1,
  Heading2,
  Baseline,
  FileCodeCorner,
  Frame,
  FileSearchCorner,
  SquaresIntersect,
  Book,
  NotebookPen,
  NotebookTabs,
  PenLine,
  Settings,
  MessageSquare,
  Check,
  User,
  CircleQuestionMark,
  Scale,
  AppWindow,
  ClockArrowRight,
  ClockArrowLeft,
  GitMerge,
  Heart,
  createLucideIcon
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export type IconComponent = LucideIcon

/* Fillable variants of four stock Lucide glyphs. The coloured document
 * icons (useIconTint) set a soft fill on the <svg>, which every child
 * inherits. These glyphs fill badly as drawn — Headphones is one open
 * path (fills the whole dome), ClipboardPen's board is two open paths,
 * and the detail strokes in Image / MessageCircleQuestionMark would
 * double up the tint. So the detail strokes opt out with fill="none",
 * and Headphones / ClipboardPen gain stroke-less backing shapes that
 * carry the fill. Unfilled, each looks exactly like the stock glyph. */
const Headphones = createLucideIcon('headphones', [
  ['path', { d: 'M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', stroke: 'none', key: 'fill-l' }],
  ['path', { d: 'M21 14h-3a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2z', stroke: 'none', key: 'fill-r' }],
  ['path', { d: 'M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3', fill: 'none', key: '1xhozi' }]
])
const ImageIcon = createLucideIcon('image', [
  ['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2', ry: '2', key: '1m3agn' }],
  ['circle', { cx: '9', cy: '9', r: '2', fill: 'none', key: 'af1f0g' }],
  ['path', { d: 'm21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21', fill: 'none', key: '1xmnt7' }]
])
const ClipboardPen = createLucideIcon('clipboard-pen', [
  ['path', { d: 'M6 4h2v2h8V4h2a2 2 0 0 1 2 2v5.6l-6.67 6.07-1.27 4.33H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', stroke: 'none', key: 'fill' }],
  ['path', { d: 'M16 4h2a2 2 0 0 1 2 2v2', fill: 'none', key: 'j91f56' }],
  ['path', { d: 'M21.34 15.664a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z', key: '16fuwn' }],
  ['path', { d: 'M8 22H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2', fill: 'none', key: '120tdm' }],
  ['rect', { x: '8', y: '2', width: '8', height: '4', rx: '1', key: 'ublpy' }]
])
const MessageCircleQuestionMark = createLucideIcon('message-circle-question-mark', [
  ['path', { d: 'M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719', key: '1sd12s' }],
  ['path', { d: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3', fill: 'none', key: '1u773s' }],
  ['path', { d: 'M12 17h.01', key: 'p32p05' }]
])

export const faFolder = Folder
export const faFolderPlus = FolderPlus
export const faFile = File
export const faFileAlt = FileText
export const faTags = Tags
export const faTag = Tag
export const faPaperclip = Paperclip
export const faThumbtack = Pin
export const faStickyNote = StickyNote
export const faNoteSticky = StickyNote
export const faBookmark = Bookmark
export const faChevronDown = ChevronDown
export const faChevronRight = ChevronRight
export const faChevronsLeft = ChevronsLeft
export const faChevronsRight = ChevronsRight
export const faExclamationTriangle = TriangleAlert
export const faCircle = Circle
export const faTableCells = Grid3x3
export const faTable = Table
export const faChartBar = ChartBar
export const faChartSimple = ChartNoAxesColumn
export const faChartColumn = ChartColumn
export const faLightbulb = Lightbulb
export const faBarsStaggered = ListOrdered
export const faFont = Type
export const faDiagramProject = Network
export const faCircleNodes = Share2
export const faMagnifyingGlass = Search
export const faArrowsLeftRight = ArrowLeftRight
export const faSwatchbook = Palette
export const faClipboardList = ClipboardList
export const faUpRightFromSquare = ExternalLink
export const faDownLeftAndUpRightToCenter = Minimize2
export const faLink = Link
export const faTableColumns = PanelLeft
export const faSquareSplitVertical = SquareSplitVertical
export const faSquarePlus = SquarePlus
export const faSquareArrowRightEnter = SquareArrowRightEnter
export const faPlus = Plus
export const faBars = Menu
export const faQuoteLeft = Quote
export const faXmark = X
export const faPlay = Play
export const faPause = Pause
export const faBackward = SkipBack
export const faForward = SkipForward
export const faVoicemail = Voicemail
export const faCrosshairs = Crosshair
export const faICursor = TextCursor
export const faHeadphones = Headphones
export const faVideo = Video
export const faImage = ImageIcon
export const faVolumeHigh = Volume2
export const faVolumeLow = Volume1
export const faVolumeXmark = VolumeX
export const faParagraph = Pilcrow
export const faCircleInfo = Info
export const faBold = Bold
export const faItalic = Italic
export const faUnderline = Underline
export const faListUl = List
export const faListOl = ListOrdered
export const faAlignLeft = TextAlignStart
export const faAlignCenter = TextAlignCenter
export const faAlignRight = TextAlignEnd
export const faHeading1 = Heading1
export const faHeading2 = Heading2
export const faFontColor = Baseline
export const faFileCodeCorner = FileCodeCorner
export const faFrame = Frame
export const faFileSearchCorner = FileSearchCorner
export const faSquaresIntersect = SquaresIntersect
export const faBook = Book
export const faNotebookPen = NotebookPen
export const faNotebookTabs = NotebookTabs
export const faPenLine = PenLine
export const faGear = Settings
export const faMessageSquare = MessageSquare
export const faClipboardPen = ClipboardPen
export const faCheck = Check
export const faUser = User
export const faQuestion = MessageCircleQuestionMark
export const faCircleQuestion = CircleQuestionMark
export const faScale = Scale
/** Lucide `app-window` — the Studio toolbar button that reopens
 *  closed workspace panels. No Font Awesome forebear, so the alias
 *  reads as the Lucide name. */
export const faAppWindow = AppWindow
/** Check Out / Check In toolbar toggle — a clock with an outgoing arrow
 *  (checked out) vs. an incoming arrow (checked back in). */
export const faClockArrowRight = ClockArrowRight
export const faClockArrowLeft = ClockArrowLeft
export const faGitMerge = GitMerge
/** Donate / sponsor — Help popover's "Donate" row. */
export const faHeart = Heart
