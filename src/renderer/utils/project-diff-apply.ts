import { useCodeStore } from '../stores/code-store'
import { useTagStore } from '../stores/tag-store'
import { useMemoStore } from '../stores/memo-store'
import { useQuoteStore } from '../stores/quote-store'
import { useLogbookStore } from '../stores/logbook-store'
import { useQueryStore } from '../stores/query-store'
import { useDocumentStore } from '../stores/document-store'
import { useProjectStore } from '../stores/project-store'
import { anchorKey, type DiffItem, type CodeDiffItem, type CodingsDiffItem, type CodingInstance, type DocumentTextDiffItem, type SavedAnalysisDiffItem, type SourceDiffItem } from './project-diff'
import { mediaPathField } from './binary-handles'
import type { Code, QDASet, TagCategory, Memo, Quote, LogbookEntry, SavedQuery, DocumentFolder, TextSource } from '../models/types'

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
  savedAnalyses: SavedAnalysisDiffItem[]
  /** Approved whole-document add/remove/rename. */
  sources: SourceDiffItem[]
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
    savedQueries: [], folders: [], savedAnalyses: [], sources: [],
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
 *  saved queries, saved analyses). */
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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Reads a source's binary bytes from the ACTIVE project, dispatched to
 *  whichever of the app's existing per-type read IPCs matches its
 *  sourceType (they're all thin wrappers around the same handle
 *  resolver — see readMediaFile in ipc-handlers.ts — so any one of them
 *  would work; dispatching keeps the call sites self-documenting). */
export type ReadMineBinaryFn = (handle: string, sourceType: string | undefined) => Promise<Uint8Array | ArrayBuffer | null>

/** Reads a source's binary bytes straight from a second .qdpx on disk
 *  (comparisonFilePath), without registering anything — see
 *  ipc-handlers.ts's read-compare-binary IPC. */
export type ReadTheirsBinaryFn = (comparisonFilePath: string, handle: string) => Promise<Uint8Array | null>

/** Whether `mine` and `theirs` are actually the SAME document — text/
 *  markdown by sourceContents, survey by formatData.survey, and
 *  pdf/audio/video/image by their real bytes. For the binary types,
 *  sourceContents (pdf's extracted text, an audio/video transcript) is
 *  used only as a cheap short-circuit for "definitely different" —
 *  matching text is NOT treated as proof of identical bytes (two
 *  different files could coincidentally extract to the same text), so a
 *  text match still falls through to an actual byte comparison. Image has
 *  no text content at all and always falls through. */
async function sourcesAreIdentical(
  mine: TextSource,
  theirs: TextSource,
  mineContents: Record<string, string>,
  theirsContents: Record<string, string>,
  comparisonFilePath: string,
  readMineBinary: ReadMineBinaryFn,
  readTheirsBinary: ReadTheirsBinaryFn
): Promise<boolean> {
  if (mine.sourceType === 'survey' && theirs.sourceType === 'survey') {
    return JSON.stringify((mine.formatData as { survey?: unknown } | undefined)?.survey)
      === JSON.stringify((theirs.formatData as { survey?: unknown } | undefined)?.survey)
  }
  const mineText = mineContents[mine.guid] ?? ''
  const theirsText = theirsContents[theirs.guid] ?? ''
  const field = mediaPathField(mine.sourceType)
  if (!field) return mineText === theirsText // text / markdown — sourceContents IS the whole document

  if (mine.sourceType !== 'image' && mineText !== theirsText) return false
  const mineHandle = (mine.formatData as Record<string, unknown> | undefined)?.[field]
  const theirsHandle = (theirs.formatData as Record<string, unknown> | undefined)?.[field]
  if (typeof mineHandle !== 'string' || typeof theirsHandle !== 'string') return false
  const [mineBytesRaw, theirsBytes] = await Promise.all([
    readMineBinary(mineHandle, mine.sourceType),
    readTheirsBinary(comparisonFilePath, theirsHandle)
  ])
  if (!mineBytesRaw || !theirsBytes) return false
  const mineBytes = mineBytesRaw instanceof Uint8Array ? mineBytesRaw : new Uint8Array(mineBytesRaw)
  return bytesEqual(mineBytes, theirsBytes)
}

/** Drops onlyMine/onlyTheirs pairs from `sources` that turn out to be the
 *  SAME document — independently imported into each project (each import
 *  mints its own guid, which is how diffSources's guid-keyed bucketing
 *  sees them as two unrelated adds/removes) but identical once you look
 *  past the guid. Candidates are matched by name + sourceType first (a
 *  cheap, safe filter — two genuinely different documents that happen to
 *  share a filename are never collapsed unless their content also
 *  matches, verified by sourcesAreIdentical), then the first content
 *  match wins and both sides are dropped from the review entirely: the
 *  document already exists, unchanged, on both sides — there is nothing
 *  to review. Runs once, when Compare is opened (see merge-review-
 *  store.ts's openCompare), not at Apply time. */
export async function dedupeIdenticalSources(
  sources: SourceDiffItem[],
  mineContents: Record<string, string>,
  theirsContents: Record<string, string>,
  comparisonFilePath: string,
  readMineBinary: ReadMineBinaryFn,
  readTheirsBinary: ReadTheirsBinaryFn
): Promise<SourceDiffItem[]> {
  const onlyMine = sources.filter((i): i is SourceDiffItem & { mine: TextSource } => i.bucket === 'onlyMine' && !!i.mine)
  const onlyTheirs = sources.filter((i): i is SourceDiffItem & { theirs: TextSource } => i.bucket === 'onlyTheirs' && !!i.theirs)
  if (onlyMine.length === 0 || onlyTheirs.length === 0) return sources

  const duplicateGuids = new Set<string>()
  for (const mineItem of onlyMine) {
    for (const theirsItem of onlyTheirs) {
      if (duplicateGuids.has(theirsItem.guid)) continue
      if (mineItem.mine.name !== theirsItem.theirs.name || mineItem.mine.sourceType !== theirsItem.theirs.sourceType) continue
      if (await sourcesAreIdentical(mineItem.mine, theirsItem.theirs, mineContents, theirsContents, comparisonFilePath, readMineBinary, readTheirsBinary)) {
        duplicateGuids.add(mineItem.guid)
        duplicateGuids.add(theirsItem.guid)
        break
      }
    }
  }
  return duplicateGuids.size === 0 ? sources : sources.filter((i) => !duplicateGuids.has(i.guid))
}

/** Callback signature for pulling a binary source's bytes out of a second
 *  .qdpx and registering them as an overlay in the active project — see
 *  ipc-handlers.ts's import-merge-binary IPC. Injected rather than called
 *  as `window.api.importMergeBinary` directly, so this module (and its
 *  tests) never need a `window` global — only the renderer call site
 *  (MergeReviewWindow.tsx) touches Electron's API surface. */
export type ImportBinaryFn = (comparisonFilePath: string, handle: string) => Promise<string | null>

/** Resolves every binary-backed (`binary: true`) onlyTheirs source in
 *  `items` into a copy whose formatData handle points at a fresh overlay
 *  registered in the ACTIVE project, by pulling its bytes out of
 *  comparisonFilePath via `importBinary`. Every other item (non-binary
 *  add, remove, rename) passes through unchanged. Must be awaited before
 *  applySourceChanges/applyMerge — those stay synchronous (plain store
 *  mutations), so all the async archive I/O happens here, up front.
 *
 *  A source whose bytes can't be recovered (the comparison file moved or
 *  was deleted since Compare was opened, or the binary is missing from
 *  its archive) is DROPPED from the result rather than passed through
 *  with its original, comparison-file-scoped handle — adding it as-is
 *  would silently resolve to the wrong bytes (or nothing) once it's part
 *  of the active project, which only ever reads archive handles against
 *  itself. */
export async function resolveBinarySources(
  items: SourceDiffItem[],
  comparisonFilePath: string,
  importBinary: ImportBinaryFn
): Promise<SourceDiffItem[]> {
  const resolved: SourceDiffItem[] = []
  for (const item of items) {
    if (item.bucket !== 'onlyTheirs' || !item.binary || !item.theirs) {
      resolved.push(item)
      continue
    }
    const field = mediaPathField(item.theirs.sourceType)
    const handle = field ? (item.theirs.formatData as Record<string, unknown> | undefined)?.[field] : undefined
    if (typeof handle !== 'string') {
      resolved.push(item) // no handle to resolve (shouldn't happen for a binary-flagged item) — pass through as-is
      continue
    }
    const newHandle = await importBinary(comparisonFilePath, handle)
    if (!newHandle) continue // bytes unrecoverable — drop rather than add a document with a broken handle
    resolved.push({
      ...item,
      binary: false,
      theirs: { ...item.theirs, formatData: { ...(item.theirs.formatData as Record<string, unknown>), [field as string]: newHandle } }
    })
  }
  return resolved
}

/** Adds/removes/renames whole documents (the "Documents" category — see
 *  SourceDiffItem). A binary-backed onlyTheirs item must already have had
 *  its handle resolved by resolveBinarySources above (binary: false) — if
 *  one somehow reaches here still flagged `binary: true`, it's skipped
 *  rather than added with a handle that would resolve against the wrong
 *  archive. */
function applySourceChanges(items: SourceDiffItem[]): void {
  if (items.length === 0) return
  const ds = useDocumentStore.getState()
  const contents = { ...ds.sourceContents }
  let sources = ds.sources

  for (const item of items) {
    if (item.bucket === 'onlyMine') {
      sources = sources.filter((s) => s.guid !== item.guid)
      delete contents[item.guid]
    } else if (item.bucket === 'onlyTheirs' && item.theirs && !item.binary) {
      sources = [...sources, item.theirs]
      contents[item.theirs.guid] = item.theirsContent ?? ''
    } else if (item.bucket === 'bothDiffer' && item.theirs) {
      const newName = item.theirs.name
      sources = sources.map((s) => (s.guid === item.guid ? { ...s, name: newName } : s))
    }
  }
  ds.setSources(sources, contents)
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
    if (coarseItem?.theirsSource) {
      const theirsSource = coarseItem.theirsSource
      // A survey's real content is formatData.survey, not its selections
      // or its sourceContents text — a coarse item for a survey means
      // "the survey's data differs" (see sourceContentIdentical in
      // project-diff.ts), so taking it must also take that data, or the
      // merge silently leaves the old respondents/answers/questions in
      // place even though the checkbox reads as applied.
      if (s.sourceType === 'survey' && theirsSource.sourceType === 'survey') {
        const theirsRawCsv = (theirsSource.formatData as { rawCsv?: string } | undefined)?.rawCsv
        if (theirsRawCsv !== undefined) newContents[s.guid] = theirsRawCsv
        return { ...s, selections: theirsSource.selections, formatData: theirsSource.formatData }
      }
      return { ...s, selections: theirsSource.selections }
    }
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
  applySourceChanges(plan.sources)

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
