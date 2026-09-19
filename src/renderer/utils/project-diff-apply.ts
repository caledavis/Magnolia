import { useCodeStore } from '../stores/code-store'
import { useTagStore } from '../stores/tag-store'
import { useMemoStore } from '../stores/memo-store'
import { useQuoteStore } from '../stores/quote-store'
import { useLogbookStore } from '../stores/logbook-store'
import { useQueryStore } from '../stores/query-store'
import { useDocumentStore } from '../stores/document-store'
import { useProjectStore } from '../stores/project-store'
import { anchorKey, type DiffItem, type CodeDiffItem, type CodingsDiffItem, type CodingInstance, type DocumentTextDiffItem, type SavedAnalysisDiffItem } from './project-diff'
import type { Code, QDASet, TagCategory, Memo, Quote, LogbookEntry, SavedQuery, DocumentFolder, User, TextSource } from '../models/types'

/**
 * Turns a set of user-approved diff items (see project-diff.ts) into real
 * store mutations on the currently-open project. The caller (the review
 * UI) is responsible for filtering each category's diff array down to
 * just the checked items — this module only ever sees "apply these."
 *
 * Most categories go through each store's existing BULK setter
 * (setTags/setMemos/etc.) rather than the single-item "add" convenience
 * actions (createTag/addQuote/addEntry/...), because those all mint a
 * BRAND NEW guid internally — which would silently break every reference
 * to the original guid (a tag's own identity, a code referenced by
 * codings and CodeCondition trees, etc.). Splicing the exact object from
 * the diff into the array via the bulk setter preserves the original
 * guid, exactly like the existing code-store `mergeCodes` helper already
 * does for codes.
 */
export interface ApplyPlan {
  codes: CodeDiffItem[]
  tags: DiffItem<QDASet>[]
  tagCategories: DiffItem<TagCategory>[]
  memos: DiffItem<Memo>[]
  quotes: DiffItem<Quote>[]
  logbookEntries: DiffItem<LogbookEntry>[]
  savedQueries: DiffItem<SavedQuery>[]
  folders: DiffItem<DocumentFolder>[]
  users: DiffItem<User>[]
  savedAnalyses: SavedAnalysisDiffItem[]
  /** Approved wholesale "take theirs' text" for a document. */
  documentText: DocumentTextDiffItem[]
  /** Approved coarse coding items — implies also taking theirs' text for
   *  that document (see the comment on CodingsDiffItem.theirsSource). */
  codingsCoarse: CodingsDiffItem[]
  codingsAdd: { sourceGuid: string; instance: CodingInstance }[]
  codingsRemove: { sourceGuid: string; instance: CodingInstance }[]
}

export function emptyApplyPlan(): ApplyPlan {
  return {
    codes: [], tags: [], tagCategories: [], memos: [], quotes: [], logbookEntries: [],
    savedQueries: [], folders: [], users: [], savedAnalyses: [],
    documentText: [], codingsCoarse: [], codingsAdd: [], codingsRemove: []
  }
}

function isPlanEmpty(plan: ApplyPlan): boolean {
  return Object.values(plan).every((arr) => Array.isArray(arr) && arr.length === 0)
}

/** Bulk-splice guid-keyed items into a flat array, preserving order and
 *  original guids: onlyTheirs/bothDiffer set `item.theirs` at that guid
 *  (inserting or replacing), onlyMine removes it. Used for every flat-
 *  array category (tags, tag categories, memos, quotes, logbook entries,
 *  saved queries, users, saved analyses). */
function spliceByGuid<T extends { guid: string }>(current: T[], items: DiffItem<T>[]): T[] {
  const map = new Map(current.map((x) => [x.guid, x]))
  for (const item of items) {
    if (item.bucket === 'onlyMine') map.delete(item.guid)
    else if (item.theirs) map.set(item.guid, item.theirs)
  }
  return Array.from(map.values())
}

function updateCodeInTree(codes: Code[], guid: string, patch: Partial<Code>): Code[] {
  return codes.map((c) => {
    if (c.guid === guid) return { ...c, ...patch }
    if (c.children.length > 0) return { ...c, children: updateCodeInTree(c.children, guid, patch) }
    return c
  })
}

function applyCodeChanges(items: CodeDiffItem[]): void {
  if (items.length === 0) return
  const toAdd: Code[] = []
  for (const item of items) {
    if (item.bucket === 'onlyTheirs' && item.theirs) {
      // Landing new codes at root (not their original nested position)
      // matches the existing mergeCodes precedent in code-store.ts.
      toAdd.push(item.theirs)
    } else if (item.bucket === 'onlyMine') {
      useCodeStore.getState().removeCode(item.guid)
    } else if (item.bucket === 'bothDiffer' && item.theirs) {
      if (item.changedFields && item.changedFields.length > 0) {
        const patch: Partial<Code> = {}
        for (const field of item.changedFields) {
          ;(patch as Record<string, unknown>)[field] = (item.theirs as unknown as Record<string, unknown>)[field]
        }
        useCodeStore.setState((s) => ({ codes: updateCodeInTree(s.codes, item.guid, patch) }))
      }
      if (item.moved) {
        useCodeStore.getState().moveCode(item.guid, item.moved.toParentGuid)
      }
    }
  }
  if (toAdd.length > 0) useCodeStore.getState().mergeCodes(toAdd)
}

/** Applies approved document-text replacements and coarse coding
 *  replacements in one pass, since a coarse item's selections only make
 *  sense once its document's text is also taken (see the type comment on
 *  CodingsDiffItem). These two categories never target the same source
 *  as each other's itemized-coding counterpart — a source's codings are
 *  either coarse (text differs) or itemized (text identical), never
 *  both — so there's no ordering conflict with applyItemizedCodings. */
function applyDocumentTextAndCoarseCodings(
  documentText: DocumentTextDiffItem[],
  codingsCoarse: CodingsDiffItem[]
): void {
  if (documentText.length === 0 && codingsCoarse.length === 0) return
  const ds = useDocumentStore.getState()
  const textByGuid = new Map(documentText.map((d) => [d.sourceGuid, d]))
  const coarseByGuid = new Map(codingsCoarse.map((c) => [c.sourceGuid, c]))

  const newContents = { ...ds.sourceContents }
  const newSources: TextSource[] = ds.sources.map((s) => {
    const textItem = textByGuid.get(s.guid)
    const coarseItem = coarseByGuid.get(s.guid)
    if (!textItem && !coarseItem) return s
    if (textItem) newContents[s.guid] = textItem.theirsText
    if (coarseItem?.theirsSource) return { ...s, selections: coarseItem.theirsSource.selections }
    return s
  })
  ds.setSources(newSources, newContents)
}

/** Finds an existing selection in "mine" at the same anchor as the given
 *  instance (ignoring which code it's tagged with), so adding a second
 *  coding at an anchor mine already has reuses that selection instead of
 *  creating a duplicate overlapping one. */
function findMatchingSelectionGuid(sourceGuid: string, key: string): string | null {
  const source = useDocumentStore.getState().sources.find((s) => s.guid === sourceGuid)
  if (!source) return null
  const match = source.selections.find((sel) => anchorKey(sel) === key)
  return match?.guid ?? null
}

function applyItemizedCodings(
  codingsAdd: { sourceGuid: string; instance: CodingInstance }[],
  codingsRemove: { sourceGuid: string; instance: CodingInstance }[]
): void {
  const ds = useDocumentStore.getState()
  for (const { sourceGuid, instance } of codingsRemove) {
    ds.removeCoding(sourceGuid, instance.selection.guid, instance.coding.guid)
  }
  for (const { sourceGuid, instance } of codingsAdd) {
    const key = anchorKey(instance.selection)
    let selectionGuid = findMatchingSelectionGuid(sourceGuid, key)
    if (!selectionGuid) {
      const sel = instance.selection
      selectionGuid = useDocumentStore.getState().addSelection(
        sourceGuid,
        sel.startPosition,
        sel.endPosition,
        sel.name ?? '',
        sel.pdfRegion,
        sel.surveyCell
      )
    }
    useDocumentStore.getState().addCodingToSelection(sourceGuid, selectionGuid, instance.coding.codeGuid)
  }
}

export function applyMerge(plan: ApplyPlan): void {
  if (isPlanEmpty(plan)) return

  applyCodeChanges(plan.codes)

  if (plan.tags.length > 0) {
    useTagStore.getState().setTags(spliceByGuid(useTagStore.getState().tags, plan.tags))
  }
  if (plan.tagCategories.length > 0) {
    useTagStore.getState().setCategories(spliceByGuid(useTagStore.getState().categories, plan.tagCategories))
  }
  if (plan.memos.length > 0) {
    useMemoStore.getState().setMemos(spliceByGuid(useMemoStore.getState().memos, plan.memos))
  }
  if (plan.quotes.length > 0) {
    useQuoteStore.getState().setQuotes(spliceByGuid(useQuoteStore.getState().quotes, plan.quotes))
  }
  if (plan.logbookEntries.length > 0) {
    useLogbookStore.getState().setEntries(spliceByGuid(useLogbookStore.getState().entries, plan.logbookEntries))
  }
  if (plan.savedQueries.length > 0) {
    useQueryStore.getState().setSavedQueries(spliceByGuid(useQueryStore.getState().savedQueries, plan.savedQueries))
  }
  if (plan.folders.length > 0) {
    const ds = useDocumentStore.getState()
    ds.setFolders(spliceByGuid(ds.folders, plan.folders), ds.sourceFolder)
  }
  if (plan.users.length > 0) {
    useProjectStore.getState().setUsers(spliceByGuid(useProjectStore.getState().users, plan.users))
  }
  if (plan.savedAnalyses.length > 0) {
    const current = useProjectStore.getState().savedAnalyses ?? []
    useProjectStore.getState().setSavedAnalyses(spliceByGuid(current, plan.savedAnalyses))
  }

  applyDocumentTextAndCoarseCodings(plan.documentText, plan.codingsCoarse)
  applyItemizedCodings(plan.codingsAdd, plan.codingsRemove)

  // Bulk setters (setTags/setMemos/etc.) don't call markDirty themselves
  // (they're also used for project *load*, which must NOT dirty a freshly
  // opened project) — every named single-item action already does, but
  // call it once more here regardless so nothing is missed.
  useProjectStore.getState().markDirty()
}
