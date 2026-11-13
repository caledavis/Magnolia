/**
 * Importing chosen Zotero items: each item's file is read like any other
 * import (with the import progress dialog, and Word files typeset as
 * PDFs), becomes a document named after the item's title in the project's
 * "Zotero" folder (made if there's none), and is tagged with the
 * item's information. The abstract and the item's notes become memos on
 * the document.
 */
import { useDocumentStore } from '../stores/document-store'
import { useMemoStore } from '../stores/memo-store'
import { sourceTypeFromExtension } from './format-registry'
import {
  itemFile, itemInfo, itemTitle, listNotes, noteTitle, noteToMarkdown, zoteroLink,
  type ZoteroGet, type ZoteroItem, type ZoteroLabels, type ZoteroLibrary
} from './zotero'
import { tagDocument } from './zotero-tags'

export interface ZoteroImport {
  items: ZoteroItem[]
  library: ZoteroLibrary
  labels: ZoteroLabels
  collectionNames: Map<string, string>
  /** The memo title for a note with no text to name it by. */
  noteFallbackTitle: string
}

/** The folder imports go in: the project's top-level "Zotero" folder,
 *  made if there's none. */
export const ZOTERO_FOLDER = 'Zotero'
function zoteroFolder(): string {
  const docs = useDocumentStore.getState()
  const found = docs.folders.find(
    (f) => !f.parentGuid && f.kind !== 'notebook' && f.name.trim().toLocaleLowerCase() === ZOTERO_FOLDER.toLocaleLowerCase()
  )
  return found?.guid ?? docs.addFolder(ZOTERO_FOLDER)
}

/** Import the items; true if any document came in. */
export async function importZoteroItems(get: ZoteroGet, job: ZoteroImport): Promise<boolean> {
  const { items, library, labels, collectionNames } = job
  // Where each item's file is. One Zotero has no copy of goes in under a
  // made-up path, so the progress dialog lists it as one that couldn't
  // be opened.
  const paths: string[] = []
  for (const item of items) {
    const file = itemFile(item)
    const path = file ? await window.api.zoteroFilePath(library.path, file.key) : null
    paths.push(path ?? `/zotero-missing/${itemTitle(item).replace(/[\\/:]/g, ' ')}.${file?.extension ?? 'pdf'}`)
  }
  const read = (await window.api.readTextFiles(paths)) ?? []
  let added = false
  let folder: string | undefined
  for (const [i, item] of items.entries()) {
    const file = read[i] as any
    if (!file || file.error) continue
    const ext = file.extension || String(file.name ?? '').split('.').pop()?.toLowerCase() || ''
    const sourceType = sourceTypeFromExtension(ext)
    const guid = useDocumentStore.getState().addSource(
      itemTitle(item), file.content, sourceType !== 'text' ? sourceType : undefined, file.formatting
    )
    added = true
    folder ??= zoteroFolder()
    useDocumentStore.getState().moveSourceToFolder(guid, folder)
    useDocumentStore.getState().setZoteroLink(guid, zoteroLink(item, library))
    tagDocument(guid, itemInfo(item, labels, collectionNames))
    const { addMemo } = useMemoStore.getState()
    const abstract = String(item.data.abstractNote ?? '').trim()
    if (abstract) addMemo('document', labels.field('abstractNote'), { content: abstract, sourceGuids: [guid] })
    const notes = item.data.itemType === 'attachment' ? [] : await listNotes(get, library.path, item.key).catch(() => [])
    for (const html of notes) {
      const content = noteToMarkdown(html)
      if (content) addMemo('document', noteTitle(content, job.noteFallbackTitle), { content, sourceGuids: [guid] })
    }
  }
  return added
}

/** The Zotero links of the items already in the project. */
export function importedLinks(): Set<string> {
  return new Set(useDocumentStore.getState().sources.flatMap((s) => (s.zoteroLink ? [s.zoteroLink] : [])))
}
