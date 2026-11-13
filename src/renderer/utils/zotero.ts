/**
 * Importing from Zotero: what the Zotero app's local API sends (Zotero 7
 * and later), and how an item's information becomes document tags.
 *
 * Every piece of an item's information is a tag in a category named after
 * the Zotero field (in Zotero's own words, so "Publication", "DOI"), with
 * authors and other creators in a category per role and Zotero's own tags
 * and collections in categories of their own. The abstract and the
 * item's notes become memos. The item's Zotero link (zotero://select/…)
 * isn't a tag: it's kept out of sight on the document (zoteroLink), which
 * is how a later import knows the item is already in the project.
 */
import type { TagCategoryType } from '../models/types'

export interface ZoteroLibrary {
  /** "users/0" for My Library, "groups/<id>" for a group. */
  path: string
  name: string
  /** Group id, for the item's zotero:// link. */
  groupId?: number
}

export interface ZoteroCollection {
  key: string
  name: string
  parentKey: string | null
}

export interface ZoteroItem {
  key: string
  library?: { type: 'user' | 'group'; id: number; name?: string }
  links?: { attachment?: { href: string; attachmentType?: string } }
  meta?: { creatorSummary?: string; parsedDate?: string; numChildren?: number }
  data: Record<string, any> & { key: string; itemType: string }
}

/** One category of information about an item, and its values. */
export interface InfoEntry {
  /** The Zotero field, creator role or one of the extra kinds. */
  field: string
  /** The category name. */
  label: string
  type: TagCategoryType
  values: string[]
}

/** Names for categories, from Zotero (fields, item types) or Magnolia. */
export interface ZoteroLabels {
  field: (field: string) => string
  itemType: (itemType: string) => string
  creator: (creatorType: string) => string
  /** The category for the item type itself ("Item type"). */
  itemTypeField: string
  /** Zotero's own tags. */
  tags: string
  collection: string
}

// ── Talking to Zotero ──────────────────────────────────────────────────

export type ZoteroGet = (path: string) => Promise<{ status: number; total: number | null; body: string }>

export type ZoteroStatus = 'ready' | 'notRunning' | 'disabled' | 'tooOld'

/** Whether Zotero is open and lets other apps read its library. */
export async function zoteroStatus(get: ZoteroGet): Promise<ZoteroStatus> {
  try {
    const r = await get('/api/')
    if (r.status === 200) return 'ready'
    if (r.status === 403 || /not enabled/i.test(r.body)) return 'disabled'
    return 'tooOld'
  } catch (e) {
    if (String((e as any)?.message ?? e).includes('zotero-not-running')) return 'notRunning'
    throw e
  }
}

/** Every result of a list request, 100 at a time. */
export async function getAll<T>(get: ZoteroGet, path: string): Promise<T[]> {
  const out: T[] = []
  const sep = path.includes('?') ? '&' : '?'
  for (;;) {
    const r = await get(`${path}${sep}limit=100&start=${out.length}`)
    if (r.status !== 200) throw new Error(r.body.trim() || `Zotero answered ${r.status}`)
    const page = JSON.parse(r.body) as T[]
    out.push(...page)
    if (page.length === 0 || out.length >= (r.total ?? out.length)) return out
  }
}

/** My Library and the groups the user belongs to. */
export async function listLibraries(get: ZoteroGet, myLibrary: string): Promise<ZoteroLibrary[]> {
  const groups = await getAll<{ id: number; data?: { name?: string } }>(get, '/api/users/0/groups').catch(() => [])
  return [
    { path: 'users/0', name: myLibrary },
    ...groups.map((g) => ({ path: `groups/${g.id}`, name: g.data?.name ?? String(g.id), groupId: g.id }))
  ]
}

export async function listCollections(get: ZoteroGet, library: string): Promise<ZoteroCollection[]> {
  const raw = await getAll<{ key: string; data: { name: string; parentCollection: string | false } }>(
    get, `/api/${library}/collections`
  )
  return raw.map((c) => ({ key: c.key, name: c.data.name, parentKey: c.data.parentCollection || null }))
}

/** The top-level items of a library, or of one collection. */
export async function listItems(get: ZoteroGet, library: string, collection: string | null): Promise<ZoteroItem[]> {
  const path = collection ? `/api/${library}/collections/${collection}/items/top` : `/api/${library}/items/top`
  const items = await getAll<ZoteroItem>(get, path)
  return items.filter((it) => it.data.itemType !== 'note' && it.data.itemType !== 'annotation')
}

/** An item's child notes, as HTML. */
export async function listNotes(get: ZoteroGet, library: string, key: string): Promise<string[]> {
  const children = await getAll<ZoteroItem>(get, `/api/${library}/items/${key}/children`)
  return children.filter((c) => c.data.itemType === 'note' && c.data.note).map((c) => c.data.note as string)
}

/** Zotero's names for its fields and item types, in Zotero's language. */
export async function zoteroNames(get: ZoteroGet): Promise<{ fields: Map<string, string>; itemTypes: Map<string, string> }> {
  const read = async (path: string, key: string): Promise<Map<string, string>> => {
    try {
      const r = await get(path)
      if (r.status !== 200) return new Map()
      return new Map((JSON.parse(r.body) as any[]).map((x) => [x[key], x.localized]))
    } catch {
      return new Map()
    }
  }
  const [fields, itemTypes] = await Promise.all([read('/api/itemFields', 'field'), read('/api/itemTypes', 'itemType')])
  return { fields, itemTypes }
}

// ── An item's file ─────────────────────────────────────────────────────

/** File types Magnolia imports, by the MIME type Zotero gives. */
const EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'application/rtf': 'rtf',
  'text/rtf': 'rtf',
  'application/vnd.oasis.opendocument.text': 'odt',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/tiff': 'tiff',
  'image/heic': 'heic',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi'
}

export interface ItemFile {
  /** The attachment's item key. */
  key: string
  contentType: string
  /** Set when Magnolia can import this kind of file. */
  extension?: string
}

/** The file an item brings: Zotero's best attachment for a regular
 *  item (usually its PDF), or the file itself for a standalone one.
 *  Undefined when the item has no file (only a link, or nothing). */
export function itemFile(item: ZoteroItem): ItemFile | undefined {
  const d = item.data
  if (d.itemType === 'attachment') {
    if (d.linkMode === 'linked_url') return undefined
    const contentType = String(d.contentType ?? '')
    const fromName = typeof d.filename === 'string' ? d.filename.split('.').pop()?.toLowerCase() : undefined
    const extension = EXTENSIONS[contentType] ?? (fromName && Object.values(EXTENSIONS).includes(fromName) ? fromName : undefined)
    return { key: d.key, contentType, extension }
  }
  const att = item.links?.attachment
  if (!att?.href) return undefined
  const key = att.href.split('/').pop() ?? ''
  const contentType = att.attachmentType ?? ''
  return { key, contentType, extension: EXTENSIONS[contentType] }
}

/** The document's name: the item's title, else its file's name. */
export function itemTitle(item: ZoteroItem): string {
  const d = item.data
  const title = String(d.title ?? d.caseName ?? d.nameOfAct ?? d.subject ?? '').trim()
  return title || String(d.filename ?? item.key)
}

/** The item's year, for the list ("2019"), from Zotero's reading of its date. */
export function itemYear(item: ZoteroItem): string {
  return item.meta?.parsedDate?.slice(0, 4) ?? ''
}

// ── An item's information as tags ──────────────────────────────────────

/** Fields that aren't information about the work: Zotero's bookkeeping,
 *  the attachment's own details, and what becomes memos instead. */
const NOT_INFO = new Set([
  'key', 'version', 'itemType', 'parentItem', 'relations', 'dateAdded', 'dateModified',
  'collections', 'tags', 'creators', 'abstractNote', 'note', 'linkMode', 'contentType',
  'charset', 'filename', 'md5', 'mtime', 'path', 'inPublications', 'deleted'
])

/** Fields that hold a date. */
const DATE_FIELDS = new Set(['date', 'accessDate', 'dateDecided', 'dateEnacted', 'issueDate', 'filingDate'])

/** A date the way Magnolia's date tags write it: dd/mm/yyyy, mm/yyyy or
 *  yyyy. Zotero's own reading of a free-text date ("May 3, 2019") is
 *  `parsed` (yyyy-mm-dd, yyyy-mm or yyyy). Undefined when it isn't a date. */
export function magnoliaDate(value: string, parsed?: string): string | undefined {
  const m = (parsed ?? value).trim().match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?(?:[T ]|$)/)
  if (!m) return undefined
  const [, y, mo, d] = m
  const pad = (s: string): string => s.padStart(2, '0')
  if (mo && Number(mo) > 0 && d && Number(d) > 0) return `${pad(d)}/${pad(mo)}/${y}`
  if (mo && Number(mo) > 0) return `${pad(mo)}/${y}`
  return y
}

/** A creator as one tag value: "Lastname, Firstname", or a single name. */
export function creatorName(c: { firstName?: string; lastName?: string; name?: string }): string {
  if (c.name) return c.name.trim()
  const last = (c.lastName ?? '').trim()
  const first = (c.firstName ?? '').trim()
  return last && first ? `${last}, ${first}` : last || first
}

/** The item's link in Zotero, which opens it there. */
export function zoteroLink(item: ZoteroItem, library: ZoteroLibrary): string {
  return library.groupId != null
    ? `zotero://select/groups/${library.groupId}/items/${item.key}`
    : `zotero://select/library/items/${item.key}`
}

/** Text on one line, for a tag. */
const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, '; ').replace(/\s+/g, ' ').trim()

/** Everything Zotero knows about an item, as categories and values, in
 *  Zotero's order: item type, creators by role, then each field,
 *  then Zotero's tags and the collections it's in. */
export function itemInfo(
  item: ZoteroItem,
  labels: ZoteroLabels,
  collectionNames: Map<string, string>
): InfoEntry[] {
  const d = item.data
  const out: InfoEntry[] = []
  const add = (field: string, label: string, type: TagCategoryType, values: string[]): void => {
    const clean = [...new Set(values.map(oneLine).filter(Boolean))]
    if (clean.length) out.push({ field, label, type, values: clean })
  }
  add('itemType', labels.itemTypeField, 'text', [labels.itemType(d.itemType)])
  const fieldsInOrder = Object.keys(d).filter((f) => !NOT_INFO.has(f))
  // The creators first, then the rest in Zotero's order. The title isn't
  // a tag: it's the document's name.
  const roles = new Map<string, string[]>()
  for (const c of (d.creators ?? []) as any[]) {
    const name = creatorName(c)
    if (!name) continue
    const role = c.creatorType || 'author'
    roles.set(role, [...(roles.get(role) ?? []), name])
  }
  for (const [role, names] of roles) add(`creator:${role}`, labels.creator(role), 'text', names)
  for (const field of fieldsInOrder) {
    if (field === 'title') continue
    const raw = d[field]
    if (typeof raw !== 'string' && typeof raw !== 'number') continue
    const value = String(raw).trim()
    if (!value) continue
    if (DATE_FIELDS.has(field)) {
      const date = magnoliaDate(value, field === 'date' ? item.meta?.parsedDate : undefined)
      if (date) { add(field, labels.field(field), 'date', [date]); continue }
    }
    add(field, labels.field(field), 'text', [value])
  }
  add('tags', labels.tags, 'text', ((d.tags ?? []) as { tag: string }[]).map((t) => t.tag))
  add('collection', labels.collection, 'text',
    ((d.collections ?? []) as string[]).map((k) => collectionNames.get(k) ?? '').filter(Boolean))
  return out
}

// ── Notes ──────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) ? String.fromCodePoint(n) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** A Zotero note (HTML) as Markdown, for a memo. */
export function noteToMarkdown(html: string): string {
  let s = html.replace(/\r\n?/g, '\n')
  // Lists: number ordered items, bullet the rest.
  s = s.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner: string) => {
    let n = 0
    return '\n' + inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, li: string) => `${++n}. ${li.trim()}\n`) + '\n'
  })
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, li: string) => `- ${li.trim()}\n`)
  s = s.replace(/<\/?ul[^>]*>/gi, '\n')
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n: string, t: string) => `\n${'#'.repeat(Number(n))} ${t.trim()}\n\n`)
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, t: string) => (t.trim() ? `**${t}**` : t))
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, t: string) => (t.trim() ? `*${t}*` : t))
  s = s.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, t: string) => `[${t}](${href})`)
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, t: string) =>
    '\n' + t.replace(/<[^>]+>/g, '').trim().split('\n').map((l) => `> ${l}`).join('\n') + '\n\n')
  s = s.replace(/<br\s*\/?>/gi, '  \n')
  s = s.replace(/<\/(p|div|pre)>/gi, '\n\n')
  s = s.replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  return s.split('\n').map((l) => l.replace(/[ \t]+$/g, (m) => (m === '  ' ? m : ''))).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim()
}

/** A memo title for a note: its first line, as Zotero titles notes. */
export function noteTitle(markdown: string, fallback: string): string {
  const first = markdown.split('\n').map((l) => l.replace(/^#+\s*|^[-*>]\s*|\*\*|\*/g, '').trim()).find(Boolean)
  if (!first) return fallback
  return first.length > 80 ? first.slice(0, 79) + '…' : first
}
