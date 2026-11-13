/**
 * Import from Zotero: an item's information as tags (utils/zotero.ts),
 * and putting them on a document, reusing the project's categories and
 * tags (utils/zotero-tags.ts).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  creatorName, getAll, itemFile, itemInfo, magnoliaDate, noteTitle, noteToMarkdown, zoteroLink, zoteroStatus,
  type ZoteroGet, type ZoteroItem, type ZoteroLabels, type ZoteroLibrary
} from '../../src/renderer/utils/zotero'
import { tagDocument } from '../../src/renderer/utils/zotero-tags'
import { importedLinks, importZoteroItems } from '../../src/renderer/utils/zotero-import'
import { useTagStore } from '../../src/renderer/stores/tag-store'
import { useDocumentStore } from '../../src/renderer/stores/document-store'

const labels: ZoteroLabels = {
  field: (f) => ({ title: 'Title', publicationTitle: 'Publication', date: 'Date', DOI: 'DOI', accessDate: 'Accessed', volume: 'Volume' } as Record<string, string>)[f] ?? f,
  itemType: (t) => (t === 'journalArticle' ? 'Journal Article' : t),
  creator: (c) => (c === 'author' ? 'Author' : c === 'editor' ? 'Editor' : c),
  itemTypeField: 'Item Type',
  tags: 'Zotero Tags',
  collection: 'Collection'
}
const myLibrary: ZoteroLibrary = { path: 'users/0', name: 'My Library' }

const article: ZoteroItem = {
  key: 'ABCD1234',
  links: { attachment: { href: 'http://localhost:23119/api/users/0/items/PDF00001', attachmentType: 'application/pdf' } },
  meta: { creatorSummary: 'Smith and Jones', parsedDate: '2019-05-03' },
  data: {
    key: 'ABCD1234',
    version: 4,
    itemType: 'journalArticle',
    title: 'Teaching with care',
    creators: [
      { creatorType: 'author', firstName: 'Ann', lastName: 'Smith' },
      { creatorType: 'author', firstName: 'Bo', lastName: 'Jones' },
      { creatorType: 'editor', name: 'Research Council' }
    ],
    abstractNote: 'A long abstract.',
    publicationTitle: 'Journal of Care',
    volume: '12',
    date: 'May 3, 2019',
    DOI: '10.1000/xyz',
    accessDate: '2024-01-15T10:20:00Z',
    extra: '',
    tags: [{ tag: 'care' }, { tag: 'teaching', type: 1 }],
    collections: ['COLL0001'],
    relations: {},
    dateAdded: '2024-01-15T10:20:00Z',
    dateModified: '2024-01-16T10:20:00Z'
  }
}

describe("an item's information", () => {
  const info = itemInfo(article, labels, new Map([['COLL0001', 'Pedagogy']]))
  const byLabel = Object.fromEntries(info.map((e) => [e.label, e]))

  it('has a category for every non-empty field, in order', () => {
    expect(info.map((e) => e.label)).toEqual([
      'Item Type', 'Author', 'Editor', 'Publication', 'Volume', 'Date', 'DOI', 'Accessed',
      'Zotero Tags', 'Collection'
    ])
  })

  it('names the item type, creators by role, tags and collections', () => {
    expect(byLabel['Item Type'].values).toEqual(['Journal Article'])
    expect(byLabel.Author.values).toEqual(['Smith, Ann', 'Jones, Bo'])
    expect(byLabel.Editor.values).toEqual(['Research Council'])
    expect(byLabel['Zotero Tags'].values).toEqual(['care', 'teaching'])
    expect(byLabel.Collection.values).toEqual(['Pedagogy'])
  })

  it('writes dates the way date tags do', () => {
    expect(byLabel.Date).toMatchObject({ type: 'date', values: ['03/05/2019'] })
    expect(byLabel.Accessed).toMatchObject({ type: 'date', values: ['15/01/2024'] })
  })

  it("keeps the title, the abstract and Zotero's bookkeeping out of the tags", () => {
    const fields = info.map((e) => e.field)
    for (const f of ['title', 'abstractNote', 'dateAdded', 'dateModified', 'key', 'version', 'extra']) expect(fields).not.toContain(f)
  })

  it('links the item in Zotero, in a group too', () => {
    expect(zoteroLink(article, myLibrary)).toBe('zotero://select/library/items/ABCD1234')
    expect(zoteroLink(article, { path: 'groups/77', name: 'Lab', groupId: 77 })).toBe('zotero://select/groups/77/items/ABCD1234')
  })
})

describe('dates and names', () => {
  it('reads dates', () => {
    expect(magnoliaDate('2019')).toBe('2019')
    expect(magnoliaDate('2019-05')).toBe('05/2019')
    expect(magnoliaDate('2019-00-00')).toBe('2019')
    expect(magnoliaDate('Spring 2019', '2019')).toBe('2019')
    expect(magnoliaDate('sometime')).toBeUndefined()
  })

  it('writes creators as "Last, First"', () => {
    expect(creatorName({ firstName: 'Ann', lastName: 'Smith' })).toBe('Smith, Ann')
    expect(creatorName({ lastName: 'Plato' })).toBe('Plato')
    expect(creatorName({ name: ' UNESCO ' })).toBe('UNESCO')
  })
})

describe("an item's file", () => {
  it("is Zotero's best attachment", () => {
    expect(itemFile(article)).toEqual({ key: 'PDF00001', contentType: 'application/pdf', extension: 'pdf' })
  })

  it('is the file itself for a standalone attachment', () => {
    const pdf: ZoteroItem = { key: 'S1', data: { key: 'S1', itemType: 'attachment', linkMode: 'imported_file', contentType: 'application/pdf', filename: 'a.pdf' } }
    expect(itemFile(pdf)?.extension).toBe('pdf')
    const link: ZoteroItem = { key: 'S2', data: { key: 'S2', itemType: 'attachment', linkMode: 'linked_url' } }
    expect(itemFile(link)).toBeUndefined()
  })

  it("can't be imported when Magnolia doesn't read that kind of file", () => {
    const snapshot = { ...article, links: { attachment: { href: '/x/SNAP', attachmentType: 'text/html' } } }
    expect(itemFile(snapshot)?.extension).toBeUndefined()
    expect(itemFile({ ...article, links: {} })).toBeUndefined()
  })
})

describe('notes', () => {
  it('become Markdown', () => {
    const html = '<div data-schema-version="9"><h1>Key points</h1><p>It is <strong>very</strong> <em>good</em> &amp; <a href="https://x.org">cited</a>.</p><ul><li>one</li><li>two</li></ul></div>'
    const md = noteToMarkdown(html)
    expect(md).toBe('# Key points\n\nIt is **very** *good* & [cited](https://x.org).\n\n- one\n- two')
    expect(noteTitle(md, 'Zotero Note')).toBe('Key points')
    expect(noteTitle('', 'Zotero Note')).toBe('Zotero Note')
  })
})

describe('talking to Zotero', () => {
  it('reads every page of a list', async () => {
    const all = Array.from({ length: 230 }, (_, i) => i)
    const seen: string[] = []
    const get: ZoteroGet = async (path) => {
      seen.push(path)
      const start = Number(new URL(path, 'http://x').searchParams.get('start'))
      return { status: 200, total: all.length, body: JSON.stringify(all.slice(start, start + 100)) }
    }
    expect(await getAll(get, '/api/users/0/items/top')).toEqual(all)
    expect(seen).toEqual([0, 100, 200].map((s) => `/api/users/0/items/top?limit=100&start=${s}`))
  })

  it('tells why Zotero can’t be read', async () => {
    expect(await zoteroStatus(async () => ({ status: 200, total: null, body: 'Nothing to see here.' }))).toBe('ready')
    expect(await zoteroStatus(async () => ({ status: 403, total: null, body: 'Local API is not enabled' }))).toBe('disabled')
    expect(await zoteroStatus(async () => ({ status: 404, total: null, body: '' }))).toBe('tooOld')
    expect(await zoteroStatus(async () => { throw new Error('zotero-not-running') })).toBe('notRunning')
  })
})

describe('tagging the document', () => {
  beforeEach(() => useTagStore.getState().clearAll())

  it("uses the project's categories and tags, and makes what's missing", () => {
    const store = useTagStore.getState()
    const authorCat = store.createCategory('author', 'text') // the project's own, in lower case
    const smith = store.createTag('author:Smith, Ann', authorCat, 'Smith, Ann')
    const typeCat = store.createCategory('Item Type', 'list', ['Book'])

    tagDocument('DOC1', itemInfo(article, labels, new Map()))

    const { categories, tags } = useTagStore.getState()
    expect(categories.filter((c) => c.name.toLowerCase() === 'author')).toHaveLength(1)
    expect(tags.find((t) => t.guid === smith)!.memberSourceGuids).toEqual(['DOC1'])
    const authors = tags.filter((t) => t.categoryGuid === authorCat).map((t) => t.value)
    expect(authors).toEqual(['Smith, Ann', 'Jones, Bo'])
    // A list category gains the value as an option.
    expect(categories.find((c) => c.guid === typeCat)!.listOptions).toEqual(['Book', 'Journal Article'])
    // New categories take the field's kind.
    expect(categories.find((c) => c.name === 'Date')!.type).toBe('date')
    // Every tag made is on the document.
    expect(tags.every((t) => t.memberSourceGuids.includes('DOC1'))).toBe(true)
  })

  it('reuses the tags on a second document', () => {
    tagDocument('DOC1', itemInfo(article, labels, new Map()))
    const count = useTagStore.getState().tags.length
    tagDocument('DOC2', itemInfo({ ...article, key: 'OTHER', data: { ...article.data, key: 'OTHER' } }, labels, new Map()))
    expect(useTagStore.getState().tags.length).toBe(count)
  })

  it('knows which items are already in the project, without a tag', () => {
    const docs = useDocumentStore.getState()
    const guid = docs.addSource('Teaching with care', 'text')
    docs.setZoteroLink(guid, zoteroLink(article, myLibrary))
    expect(importedLinks()).toEqual(new Set(['zotero://select/library/items/ABCD1234']))
    expect(useTagStore.getState().tags).toEqual([])
  })
})

describe('importing', () => {
  beforeEach(() => {
    useTagStore.getState().clearAll()
    useDocumentStore.setState({ sources: [], folders: [], sourceFolder: {} })
    ;(globalThis as any).window ??= globalThis
    ;(window as any).api = {
      ...(window as any).api,
      zoteroFilePath: async (_lib: string, key: string) => `/files/${key}.pdf`,
      readTextFiles: async (paths: string[]) => paths.map((p) => ({ name: p.split('/').pop(), extension: 'pdf', content: 'x' }))
    }
  })
  const job = { items: [article], library: myLibrary, labels, collectionNames: new Map<string, string>(), noteFallbackTitle: 'Note' }
  const get: ZoteroGet = async () => ({ status: 200, total: 0, body: '[]' })

  it('names the document after the title and files it in a "Zotero" folder', async () => {
    await importZoteroItems(get, job)
    const { sources, folders, sourceFolder } = useDocumentStore.getState()
    expect(sources.map((s) => s.name)).toEqual(['Teaching with care'])
    expect(folders.map((f) => f.name)).toEqual(['Zotero'])
    expect(sourceFolder[sources[0].guid]).toBe(folders[0].guid)
  })

  it("uses the project's Zotero folder if it has one", async () => {
    const mine = useDocumentStore.getState().addFolder('zotero')
    await importZoteroItems(get, job)
    await importZoteroItems(get, { ...job, items: [{ ...article, key: 'OTHER', data: { ...article.data, key: 'OTHER' } }] })
    const { sources, folders, sourceFolder } = useDocumentStore.getState()
    expect(folders).toHaveLength(1)
    expect(sources.every((s) => sourceFolder[s.guid] === mine)).toBe(true)
  })
})
