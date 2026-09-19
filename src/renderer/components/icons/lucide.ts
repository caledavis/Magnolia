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
  Headphones,
  Video,
  Image as ImageIcon,
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
  FileSearchCorner,
  SquaresIntersect,
  Book,
  NotebookPen,
  NotebookTabs,
  PenLine,
  Settings,
  MessageSquare,
  ClipboardPen,
  Check,
  User,
  MessageCircleQuestionMark,
  CircleQuestionMark,
  Scale,
  AppWindow,
  ClockArrowRight,
  ClockArrowLeft,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export type IconComponent = LucideIcon

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
