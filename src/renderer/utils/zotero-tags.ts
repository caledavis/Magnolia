/**
 * Putting a Zotero item's information on a document as tags. Each
 * category is looked up by name (ignoring case and spacing) and made if
 * the project hasn't one; each value is looked up among the category's
 * tags and made if missing; then the document gets the tag.
 */
import { useTagStore } from '../stores/tag-store'
import type { InfoEntry } from './zotero'

const same = (a: string, b: string): boolean =>
  a.normalize('NFC').trim().toLocaleLowerCase() === b.normalize('NFC').trim().toLocaleLowerCase()

/** The category with this name, made with `type` if there's none. */
function categoryFor(name: string, type: InfoEntry['type']): { guid: string; name: string } {
  const store = useTagStore.getState()
  const found = store.categories.find((c) => same(c.name, name))
  if (found) return found
  return { guid: store.createCategory(name, type), name }
}

/** The category's tag for `value`, made if there's none. */
function tagFor(category: { guid: string; name: string }, value: string): string {
  const store = useTagStore.getState()
  const inCategory = store.tags.filter((t) => t.categoryGuid === category.guid)
  const found =
    inCategory.find((t) => (t.value ?? t.name) === value) ??
    inCategory.find((t) => same(t.value ?? t.name, value))
  if (found) return found.guid
  // A list category offers only its options, so the value becomes one.
  const full = store.categories.find((c) => c.guid === category.guid)
  if (full?.type === 'list' && !(full.listOptions ?? []).some((o) => same(o, value))) {
    store.updateCategoryListOptions(full.guid, [...(full.listOptions ?? []), value])
  }
  return store.createTag(`${category.name}:${value}`, category.guid, value)
}

/** Tag a document with everything in `entries`. */
export function tagDocument(sourceGuid: string, entries: InfoEntry[]): void {
  for (const entry of entries) {
    const category = categoryFor(entry.label, entry.type)
    for (const value of entry.values) useTagStore.getState().assignTagToDocument(tagFor(category, value), sourceGuid)
  }
}
