/**
 * sortTagsForCategory — orders the tags inside a category according to
 * the category's type:
 *   - text   → alphabetical (A→Z) by tag.value || tag.name
 *   - list   → alphabetical (A→Z) by tag.value || tag.name
 *   - date   → newest to oldest by Date.parse(tag.value)
 *   - numeric → high to low by parseFloat(tag.value)
 *
 * Items whose value can't be parsed as the category's type fall back to
 * alphabetical order behind the parsed entries — keeps the display
 * deterministic when a tag's value drifts away from the category's
 * declared type (legacy projects, manual JSON edits, etc.).
 *
 * Returns a new array; the input is not mutated.
 */
import type { QDASet, TagCategory } from '../models/types'
import { compareText } from '../i18n'

function alpha(a: QDASet, b: QDASet): number {
  return compareText(a.value || a.name || '', b.value || b.name || '')
}

export function sortTagsForCategory(tags: QDASet[], category: TagCategory | undefined): QDASet[] {
  const out = tags.slice()
  if (!category) {
    out.sort(alpha)
    return out
  }
  if (category.type === 'date') {
    out.sort((a, b) => {
      const da = Date.parse(a.value || '')
      const db = Date.parse(b.value || '')
      const aOk = !isNaN(da)
      const bOk = !isNaN(db)
      if (aOk && bOk) return db - da // newest first
      if (aOk) return -1
      if (bOk) return 1
      return alpha(a, b)
    })
    return out
  }
  if (category.type === 'numeric') {
    out.sort((a, b) => {
      const na = parseFloat(a.value || '')
      const nb = parseFloat(b.value || '')
      const aOk = !isNaN(na)
      const bOk = !isNaN(nb)
      if (aOk && bOk) return nb - na // high to low
      if (aOk) return -1
      if (bOk) return 1
      return alpha(a, b)
    })
    return out
  }
  // text + list: alphabetical
  out.sort(alpha)
  return out
}

/** Alphabetical sort for a list-category's listOptions (the strings the
 *  user maintains as the closed set of allowed values). */
export function sortListOptions(opts: string[] | undefined): string[] {
  return (opts || []).slice().sort(compareText)
}
