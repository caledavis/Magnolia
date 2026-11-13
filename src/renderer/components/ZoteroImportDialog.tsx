/**
 * Import from Zotero: connects to the Zotero app on this computer, shows
 * a library's collections and items, and imports the chosen items' files
 * as documents tagged with their information (utils/zotero-import.ts).
 * Items without a file Magnolia can read, and items already imported,
 * are listed but can't be chosen.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  itemFile, itemTitle, itemYear, listCollections, listItems, listLibraries, zoteroLink, zoteroNames, zoteroStatus,
  type ZoteroCollection, type ZoteroItem, type ZoteroLabels, type ZoteroLibrary, type ZoteroStatus
} from '../utils/zotero'
import { importedLinks, type ZoteroImport } from '../utils/zotero-import'

const get = (path: string) => window.api.zoteroGet(path)

interface Props {
  onClose: () => void
  onImport: (job: ZoteroImport) => void
}

/** "seriesEditor" → "Series editor", for a role Magnolia has no name for. */
const humanise = (id: string): string => {
  const words = id.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Collections as an indented list, children under their parent. */
function collectionTree(collections: ZoteroCollection[]): { c: ZoteroCollection; depth: number }[] {
  const byParent = new Map<string | null, ZoteroCollection[]>()
  for (const c of collections) byParent.set(c.parentKey, [...(byParent.get(c.parentKey) ?? []), c])
  const out: { c: ZoteroCollection; depth: number }[] = []
  const walk = (parent: string | null, depth: number): void => {
    const kids = (byParent.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name))
    for (const c of kids) { out.push({ c, depth }); walk(c.key, depth + 1) }
  }
  walk(null, 0)
  return out
}

export function ZoteroImportDialog({ onClose, onImport }: Props) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<ZoteroStatus | 'connecting' | 'error'>('connecting')
  const [error, setError] = useState('')
  const [libraries, setLibraries] = useState<ZoteroLibrary[]>([])
  const [library, setLibrary] = useState<ZoteroLibrary | null>(null)
  const [names, setNames] = useState<{ fields: Map<string, string>; itemTypes: Map<string, string> }>({ fields: new Map(), itemTypes: new Map() })
  const [collections, setCollections] = useState<ZoteroCollection[]>([])
  const [collection, setCollection] = useState<string | null>(null)
  const [items, setItems] = useState<ZoteroItem[] | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')

  const labels: ZoteroLabels = useMemo(() => ({
    field: (f) => names.fields.get(f) ?? humanise(f),
    itemType: (it) => names.itemTypes.get(it) ?? humanise(it),
    creator: (c) => t(`zotero.creator.${c}`, { defaultValue: humanise(c) }),
    itemTypeField: t('zotero.category.itemType'),
    tags: t('zotero.category.tags'),
    collection: t('zotero.category.collection')
  }), [names, t])

  const fail = (e: unknown): void => { setError(String((e as any)?.message ?? e)); setStatus('error') }

  const connect = useCallback(async () => {
    setStatus('connecting')
    try {
      const s = await zoteroStatus(get)
      if (s !== 'ready') { setStatus(s); return }
      const [libs, n] = await Promise.all([listLibraries(get, t('zotero.myLibrary')), zoteroNames(get)])
      setNames(n)
      setLibraries(libs)
      setLibrary(libs[0])
      setStatus('ready')
    } catch (e) { fail(e) }
  }, [t])

  useEffect(() => { void connect() }, [connect])

  // A library's collections.
  useEffect(() => {
    if (!library) return
    setCollections([])
    setCollection(null)
    listCollections(get, library.path).then(setCollections, fail)
  }, [library])

  // The items in the chosen collection (or the whole library).
  useEffect(() => {
    if (!library) return
    let current = true
    setItems(null)
    setChosen(new Set())
    listItems(get, library.path, collection).then((list) => { if (current) setItems(list) }, fail)
    return () => { current = false }
  }, [library, collection])

  const already = useMemo(() => importedLinks(), [])

  /** Why an item can't be chosen, if it can't. */
  const reason = useCallback((item: ZoteroItem): string | null => {
    if (library && already.has(zoteroLink(item, library))) return t('zotero.alreadyImported')
    const file = itemFile(item)
    if (!file) return t('zotero.noFile')
    if (!file.extension) return t('zotero.unsupportedFile')
    return null
  }, [already, library, t])

  const shown = useMemo(() => {
    const q = filter.trim().toLocaleLowerCase()
    const list = items ?? []
    if (!q) return list
    return list.filter((it) =>
      `${itemTitle(it)} ${it.meta?.creatorSummary ?? ''} ${itemYear(it)}`.toLocaleLowerCase().includes(q))
  }, [items, filter])
  const choosable = shown.filter((it) => !reason(it))
  const allChosen = choosable.length > 0 && choosable.every((it) => chosen.has(it.key))

  const toggle = (key: string): void =>
    setChosen((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next })
  const toggleAll = (): void =>
    setChosen((prev) => {
      const next = new Set(prev)
      for (const it of choosable) { if (allChosen) next.delete(it.key); else next.add(it.key) }
      return next
    })

  const doImport = (): void => {
    if (!library || !items) return
    const picked = items.filter((it) => chosen.has(it.key) && !reason(it))
    if (!picked.length) return
    onImport({
      items: picked,
      library,
      labels,
      collectionNames: new Map(collections.map((c) => [c.key, c.name])),
      noteFallbackTitle: t('zotero.noteTitle')
    })
  }

  const message = (text: string, retry: boolean) => (
    <>
      <p className="zotero-message">{text}</p>
      <div className="modal-actions">
        <button className="secondary" onClick={onClose}>{t('common.cancel')}</button>
        {retry && <button onClick={() => void connect()} autoFocus>{t('zotero.tryAgain')}</button>}
      </div>
    </>
  )

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div
        className="modal zotero-import"
        role="dialog"
        aria-modal="true"
        aria-label={t('zotero.title')}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
      >
        <h2>{t('zotero.title')}</h2>
        {status === 'connecting' && message(t('zotero.connecting'), false)}
        {status === 'notRunning' && message(t('zotero.notRunning'), true)}
        {status === 'disabled' && message(t('zotero.disabled'), true)}
        {status === 'tooOld' && message(t('zotero.tooOld'), true)}
        {status === 'error' && message(t('zotero.failed', { error }), true)}
        {status === 'ready' && library && (
          <>
            <div className="zotero-bar">
              {libraries.length > 1 && (
                <select
                  aria-label={t('zotero.library')}
                  value={library.path}
                  onChange={(e) => setLibrary(libraries.find((l) => l.path === e.target.value) ?? library)}
                >
                  {libraries.map((l) => <option key={l.path} value={l.path}>{l.name}</option>)}
                </select>
              )}
              <input
                type="search"
                placeholder={t('zotero.filterPlaceholder')}
                aria-label={t('zotero.filterPlaceholder')}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                autoFocus
              />
            </div>
            <div className="zotero-panes">
              <ul className="zotero-collections" role="listbox" aria-label={t('zotero.collections')}>
                <li
                  role="option"
                  aria-selected={collection === null}
                  className={collection === null ? 'selected' : ''}
                  onClick={() => setCollection(null)}
                >
                  {library.name}
                </li>
                {collectionTree(collections).map(({ c, depth }) => (
                  <li
                    key={c.key}
                    role="option"
                    aria-selected={collection === c.key}
                    className={collection === c.key ? 'selected' : ''}
                    style={{ paddingInlineStart: 8 + (depth + 1) * 14 }}
                    onClick={() => setCollection(c.key)}
                    title={c.name}
                  >
                    {c.name}
                  </li>
                ))}
              </ul>
              <div className="zotero-items">
                {items === null ? (
                  <p className="zotero-empty">{t('common.loading')}</p>
                ) : shown.length === 0 ? (
                  <p className="zotero-empty">{t('zotero.empty')}</p>
                ) : (
                  <>
                    <label className="zotero-item zotero-all">
                      <input type="checkbox" checked={allChosen} disabled={!choosable.length} onChange={toggleAll} />
                      <span>{t('zotero.selectAll')}</span>
                    </label>
                    {shown.map((it) => {
                      const why = reason(it)
                      const details = [it.meta?.creatorSummary, itemYear(it), labels.itemType(it.data.itemType)].filter(Boolean).join(' · ')
                      return (
                        <label key={it.key} className={`zotero-item${why ? ' disabled' : ''}`} title={why ?? undefined}>
                          <input type="checkbox" checked={!why && chosen.has(it.key)} disabled={!!why} onChange={() => toggle(it.key)} />
                          <span className="zotero-item-text">
                            <span className="zotero-item-title">{itemTitle(it)}</span>
                            <span className="zotero-item-details">{why ? `${details} — ${why}` : details}</span>
                          </span>
                        </label>
                      )
                    })}
                  </>
                )}
              </div>
            </div>
            <div className="modal-actions">
              <button className="secondary" onClick={onClose}>{t('common.cancel')}</button>
              <button onClick={doImport} disabled={chosen.size === 0}>
                {t('zotero.import', { count: chosen.size })}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
