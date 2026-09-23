import { diffLines, type Change } from 'diff'
import type {
  Project,
  Code,
  QDASet,
  TagCategory,
  Memo,
  Quote,
  LogbookEntry,
  SavedQuery,
  DocumentFolder,
  TextSource,
  PlainTextSelection,
  Coding,
  SavedAnalysis
} from '../models/types'
import type { RelationshipMapConfig } from '../components/Analysis/RelationshipMap/types'

/**
 * Pure diff engine for Stage 2 merge: compares "mine" (the currently-open
 * project) against "theirs" (a second .qdpx picked for comparison) and
 * produces a structured, reviewable list of differences per category. No
 * store/React imports — see project-diff-apply.ts for turning an approved
 * item back into store mutations.
 *
 * Every entity category buckets into exactly three kinds, with no
 * inferred intent (the plan's explicit decision: the tool never guesses
 * whether "only in mine" means "I added it" or "they deleted it" — the
 * human reviewing decides):
 *  - onlyMine: guid exists only in the open project
 *  - onlyTheirs: guid exists only in the comparison file
 *  - bothDiffer: guid exists in both, but some field actually differs
 * A shared guid with byte-identical content produces no diff item at all
 * — nothing to review.
 */
export type DiffBucket = 'onlyMine' | 'onlyTheirs' | 'bothDiffer'

export interface DiffItem<T> {
  guid: string
  bucket: DiffBucket
  mine?: T
  theirs?: T
  /** Field names that actually differ, for a bothDiffer item. */
  changedFields?: string[]
}

export interface CodeDiffItem extends DiffItem<Code> {
  /** Same guid, different parent — Code has no parentGuid field itself
   *  (hierarchy is positional), so this is tracked separately from
   *  changedFields. */
  moved?: { fromParentGuid: string | null; toParentGuid: string | null }
}

export interface TagDiffItem extends DiffItem<QDASet> {
  addedMemberSourceGuids?: string[]
  removedMemberSourceGuids?: string[]
  addedMemberCodeGuids?: string[]
  removedMemberCodeGuids?: string[]
}

export interface DocumentTextDiffItem {
  sourceGuid: string
  sourceName: string
  mineText: string
  theirsText: string
  changes: Change[]
}

export interface CodingsDiffItem {
  sourceGuid: string
  sourceName: string
  /** When the underlying document text differs between the two files,
   *  codings can't be reliably position-matched — collapses to one
   *  coarse choice for the whole document rather than itemized rows
   *  (the document's own text difference is still itemized separately,
   *  in documentText). Approving a coarse item means "take theirs'
   *  codings wholesale for this document" — see theirsSource below. */
  coarse: boolean
  /** Populated only when coarse is true — theirs' full source object,
   *  so the apply engine can wholesale-replace this document's
   *  selections with theirs' (their positions only make sense once the
   *  text is also taken — see project-diff-apply.ts). */
  theirsSource?: TextSource
  /** Populated only when coarse is false — itemized added/removed
   *  coding instances, matched by anchor + code, not by guid (selection/
   *  coding guids won't survive independent edits to the same source). */
  onlyMine?: CodingInstance[]
  onlyTheirs?: CodingInstance[]
}

export interface CodingInstance {
  selection: PlainTextSelection
  coding: Coding
}

export interface RelationshipMapSummary {
  addedElements: number
  removedElements: number
  addedConnections: number
  removedConnections: number
}

export interface SavedAnalysisDiffItem extends DiffItem<SavedAnalysis> {
  /** Friendlier one-line summary for relationship-map configs only —
   *  every other toolType's config is treated as an opaque blob. */
  relationshipMapSummary?: RelationshipMapSummary
}

/** Whole-document presence/rename diff — a "Documents" category alongside
 *  the existing per-document text/codings diffs below. A brand-new
 *  document (onlyMine/onlyTheirs) never shows up in documentText/codings
 *  at all (those require the guid to already exist on both sides), so
 *  without this a document added on either side was invisible to Merge
 *  entirely — the original gap this category closes. */
export interface SourceDiffItem extends DiffItem<TextSource> {
  /** onlyTheirs only: theirs' sourceContents entry to bring in alongside
   *  the source itself — plain text, a PDF's extracted text, an audio/
   *  video transcript, or a survey's raw-CSV backup (empty for image,
   *  which has none). Independent of `binary` below: every source type
   *  has a sourceContents entry, whether or not it also needs its bytes
   *  resolved. */
  theirsContent?: string
  /** True for onlyTheirs items whose sourceType is pdf/audio/video/image
   *  — their real bytes live in the comparison .qdpx's archive, addressed
   *  by a `magnolia-bin://` handle scoped to whichever project is
   *  currently open. Before such an item can be added to the active
   *  project, applying the merge must first re-resolve its handle against
   *  the comparison file and register the bytes as an overlay in the
   *  active one — see resolveBinarySources in project-diff-apply.ts. This
   *  flag only affects what Apply does internally; the review UI treats
   *  it like any other addable document. */
  binary?: boolean
}

export interface MergeDiff {
  codes: CodeDiffItem[]
  tags: TagDiffItem[]
  tagCategories: DiffItem<TagCategory>[]
  memos: DiffItem<Memo>[]
  quotes: DiffItem<Quote>[]
  logbookEntries: DiffItem<LogbookEntry>[]
  savedQueries: DiffItem<SavedQuery>[]
  folders: DiffItem<DocumentFolder>[]
  sources: SourceDiffItem[]
  documentText: DocumentTextDiffItem[]
  codings: CodingsDiffItem[]
  savedAnalyses: SavedAnalysisDiffItem[]
}

export interface ProjectSide {
  project: Project
  sourceContents: Record<string, string>
  /** Display name to attribute "theirs" items to — from the comparison
   *  file's magnolia-editor.json (readEditorInfo), or undefined for the
   *  currently-open project (attribution is only shown for "theirs"). */
  editedBy?: string
}

// ─── Generic helpers ────────────────────────────────────────────────────

function bucketByKey<T>(
  mine: T[],
  theirs: T[],
  keyOf: (t: T) => string
): { onlyMine: T[]; onlyTheirs: T[]; bothPairs: [T, T][] } {
  const mineByKey = new Map(mine.map((x) => [keyOf(x), x]))
  const theirsByKey = new Map(theirs.map((x) => [keyOf(x), x]))
  const onlyMine = mine.filter((x) => !theirsByKey.has(keyOf(x)))
  const onlyTheirs = theirs.filter((x) => !mineByKey.has(keyOf(x)))
  const bothPairs: [T, T][] = []
  for (const m of mine) {
    const t = theirsByKey.get(keyOf(m))
    if (t) bothPairs.push([m, t])
  }
  return { onlyMine, onlyTheirs, bothPairs }
}

function fieldsDiffer(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) !== JSON.stringify(b)
}

/** Generic guid-keyed 3-bucket diff with a flat field-level comparison for
 *  the bothDiffer case. `fields` lists which properties count toward
 *  "differs" — used for every category except codes (parent tracking),
 *  tags (membership sub-diff), codings, and document text (their own
 *  specialized logic below). */
function diffByGuid<T extends { guid: string }>(
  mine: T[],
  theirs: T[],
  fields: (keyof T)[]
): DiffItem<T>[] {
  const { onlyMine, onlyTheirs, bothPairs } = bucketByKey(mine, theirs, (x) => x.guid)
  const items: DiffItem<T>[] = []
  for (const m of onlyMine) items.push({ guid: m.guid, bucket: 'onlyMine', mine: m })
  for (const t of onlyTheirs) items.push({ guid: t.guid, bucket: 'onlyTheirs', theirs: t })
  for (const [m, t] of bothPairs) {
    const changedFields = fields.filter((f) => fieldsDiffer(m[f], t[f])).map(String)
    if (changedFields.length > 0) {
      items.push({ guid: m.guid, bucket: 'bothDiffer', mine: m, theirs: t, changedFields })
    }
  }
  return items
}

function diffStringArray(a: string[] = [], b: string[] = []): { added: string[]; removed: string[] } {
  const aSet = new Set(a)
  const bSet = new Set(b)
  return {
    added: b.filter((x) => !aSet.has(x)),
    removed: a.filter((x) => !bSet.has(x))
  }
}

// ─── Codes (hierarchical — no parentGuid field, so parent is tracked
//     positionally and diffed as a "move" separate from field changes) ──

interface FlatCode {
  code: Code
  parentGuid: string | null
}

function flattenCodes(codes: Code[], parentGuid: string | null = null): Map<string, FlatCode> {
  const map = new Map<string, FlatCode>()
  for (const c of codes) {
    map.set(c.guid, { code: c, parentGuid })
    for (const [guid, flat] of flattenCodes(c.children, c.guid)) map.set(guid, flat)
  }
  return map
}

const CODE_FIELDS: (keyof Code)[] = ['name', 'color', 'description', 'hotkey', 'isCodable']

function diffCodes(mine: Code[], theirs: Code[]): CodeDiffItem[] {
  const mineFlat = flattenCodes(mine)
  const theirsFlat = flattenCodes(theirs)
  const allGuids = new Set([...mineFlat.keys(), ...theirsFlat.keys()])
  const items: CodeDiffItem[] = []
  for (const guid of allGuids) {
    const m = mineFlat.get(guid)
    const t = theirsFlat.get(guid)
    if (m && !t) {
      items.push({ guid, bucket: 'onlyMine', mine: m.code })
    } else if (!m && t) {
      items.push({ guid, bucket: 'onlyTheirs', theirs: t.code })
    } else if (m && t) {
      const changedFields = CODE_FIELDS.filter((f) => fieldsDiffer(m.code[f], t.code[f])).map(String)
      const moved = m.parentGuid !== t.parentGuid
        ? { fromParentGuid: m.parentGuid, toParentGuid: t.parentGuid }
        : undefined
      if (changedFields.length > 0 || moved) {
        items.push({ guid, bucket: 'bothDiffer', mine: m.code, theirs: t.code, changedFields, moved })
      }
    }
  }
  return items
}

// ─── Tags/sets — field diff plus a membership sub-diff, since "3 more
//     documents tagged" reads much better than a blanket "tag changed" ──

const TAG_FIELDS: (keyof QDASet)[] = ['name', 'description', 'categoryGuid', 'value']

function diffTags(mine: QDASet[], theirs: QDASet[]): TagDiffItem[] {
  const { onlyMine, onlyTheirs, bothPairs } = bucketByKey(mine, theirs, (x) => x.guid)
  const items: TagDiffItem[] = []
  for (const m of onlyMine) items.push({ guid: m.guid, bucket: 'onlyMine', mine: m })
  for (const t of onlyTheirs) items.push({ guid: t.guid, bucket: 'onlyTheirs', theirs: t })
  for (const [m, t] of bothPairs) {
    const changedFields = TAG_FIELDS.filter((f) => fieldsDiffer(m[f], t[f])).map(String)
    const sources = diffStringArray(m.memberSourceGuids, t.memberSourceGuids)
    const codesMem = diffStringArray(m.memberCodeGuids, t.memberCodeGuids)
    const hasMembershipChange =
      sources.added.length > 0 || sources.removed.length > 0 ||
      codesMem.added.length > 0 || codesMem.removed.length > 0
    if (changedFields.length > 0 || hasMembershipChange) {
      items.push({
        guid: m.guid,
        bucket: 'bothDiffer',
        mine: m,
        theirs: t,
        changedFields,
        addedMemberSourceGuids: sources.added.length ? sources.added : undefined,
        removedMemberSourceGuids: sources.removed.length ? sources.removed : undefined,
        addedMemberCodeGuids: codesMem.added.length ? codesMem.added : undefined,
        removedMemberCodeGuids: codesMem.removed.length ? codesMem.removed : undefined
      })
    }
  }
  return items
}

// ─── Sources (whole documents) — presence/rename only. Content itself
//     (text, codings, a survey's respondents/answers) is handled by the
//     document-text/codings diff below for guids present on both sides ──

function isBinaryBackedSourceType(sourceType: string | undefined): boolean {
  return sourceType === 'pdf' || sourceType === 'audio' || sourceType === 'video' || sourceType === 'image'
}

function diffSources(
  mine: TextSource[],
  theirs: TextSource[],
  theirsContents: Record<string, string>
): SourceDiffItem[] {
  const { onlyMine, onlyTheirs, bothPairs } = bucketByKey(mine, theirs, (x) => x.guid)
  const items: SourceDiffItem[] = []
  for (const m of onlyMine) items.push({ guid: m.guid, bucket: 'onlyMine', mine: m })
  for (const t of onlyTheirs) {
    items.push({
      guid: t.guid,
      bucket: 'onlyTheirs',
      theirs: t,
      binary: isBinaryBackedSourceType(t.sourceType),
      theirsContent: theirsContents[t.guid] ?? ''
    })
  }
  for (const [m, t] of bothPairs) {
    if (!fieldsDiffer(m.name, t.name)) continue
    items.push({ guid: m.guid, bucket: 'bothDiffer', mine: m, theirs: t, changedFields: ['name'] })
  }
  return items
}

// ─── Document text + codings — a document's text diff is always
//     itemized; its codings are only itemized when the text matches
//     exactly, since character offsets aren't comparable otherwise ──────

/** Whether a source's substantive content is the same on both sides. A
 *  survey's real content is the parsed formatData.survey (respondents,
 *  questions, columns) — sourceContents only holds a raw-CSV provenance
 *  backup (also duplicated at formatData.rawCsv) that a user can change
 *  indirectly (e.g. reclassifying a column's type in the survey editor)
 *  WITHOUT the CSV bytes changing at all. Comparing sourceContents alone
 *  for surveys therefore both misses real edits and can flag false ones
 *  from incidental CSV re-serialization — compare the parsed structure
 *  instead. Every other source type still compares its text as before. */
function sourceContentIdentical(
  mineSource: TextSource, mineText: string,
  theirsSource: TextSource, theirsText: string
): boolean {
  if (mineSource.sourceType === 'survey' && theirsSource.sourceType === 'survey') {
    return !fieldsDiffer(
      (mineSource.formatData as { survey?: unknown } | undefined)?.survey,
      (theirsSource.formatData as { survey?: unknown } | undefined)?.survey
    )
  }
  return mineText === theirsText
}

/** Stable key for a selection's anchor, independent of its own guid
 *  (which won't survive independent edits to the same source) — text
 *  offset range, or the PDF/video/survey-specific anchor when present.
 *  Exported so the apply engine can find/reuse a matching selection in
 *  "mine" instead of creating a duplicate overlapping one. */
export function anchorKey(sel: PlainTextSelection): string {
  if (sel.surveyCell) {
    return `survey:${sel.surveyCell.respondentId}:${sel.surveyCell.questionId}:${sel.startPosition}:${sel.endPosition}`
  }
  if (sel.pdfRegion) {
    const r = sel.pdfRegion
    return `pdf:${r.page}:${r.x}:${r.y}:${r.width}:${r.height}`
  }
  if (sel.timeRange) {
    return `time:${sel.timeRange.startTime}:${sel.timeRange.endTime}`
  }
  return `text:${sel.startPosition}:${sel.endPosition}`
}

interface KeyedCodingInstance extends CodingInstance {
  key: string
}

function flattenCodingInstances(source: TextSource): KeyedCodingInstance[] {
  const out: KeyedCodingInstance[] = []
  for (const selection of source.selections) {
    for (const coding of selection.codings) {
      out.push({ key: `${anchorKey(selection)}::${coding.codeGuid}`, selection, coding })
    }
  }
  return out
}

function diffDocumentTextAndCodings(
  mineSources: TextSource[],
  mineContents: Record<string, string>,
  theirsSources: TextSource[],
  theirsContents: Record<string, string>
): { documentText: DocumentTextDiffItem[]; codings: CodingsDiffItem[] } {
  const documentText: DocumentTextDiffItem[] = []
  const codings: CodingsDiffItem[] = []

  const theirsByGuid = new Map(theirsSources.map((s) => [s.guid, s]))
  for (const mineSource of mineSources) {
    const theirsSource = theirsByGuid.get(mineSource.guid)
    if (!theirsSource) continue // presence/absence of the document itself isn't diffed here — sources are structural, out of scope for this pass

    const mineText = mineContents[mineSource.guid] ?? ''
    const theirsText = theirsContents[theirsSource.guid] ?? ''
    const textIdentical = sourceContentIdentical(mineSource, mineText, theirsSource, theirsText)

    // A survey's raw-CSV text is a provenance backup, not reviewable
    // content — its real diff is the coarse coding item below, which
    // carries theirsSource (and so its whole formatData.survey) instead.
    if (!textIdentical && mineSource.sourceType !== 'survey') {
      documentText.push({
        sourceGuid: mineSource.guid,
        sourceName: mineSource.name,
        mineText,
        theirsText,
        changes: diffLines(mineText, theirsText)
      })
    }

    if (textIdentical) {
      const mineInstances = flattenCodingInstances(mineSource)
      const theirsInstances = flattenCodingInstances(theirsSource)
      const { onlyMine, onlyTheirs } = bucketByKey(mineInstances, theirsInstances, (x) => x.key)
      if (onlyMine.length > 0 || onlyTheirs.length > 0) {
        codings.push({
          sourceGuid: mineSource.guid,
          sourceName: mineSource.name,
          coarse: false,
          onlyMine,
          onlyTheirs
        })
      }
    } else {
      codings.push({ sourceGuid: mineSource.guid, sourceName: mineSource.name, coarse: true, theirsSource })
    }
  }
  return { documentText, codings }
}

// ─── Saved analyses — opaque blob diff, with a friendlier summary for
//     relationship maps (the one tool-type with well-known structure) ──

function diffRelationshipMap(mine: RelationshipMapConfig, theirs: RelationshipMapConfig): RelationshipMapSummary {
  const els = bucketByKey(mine.elements ?? [], theirs.elements ?? [], (e) => e.id)
  const conns = bucketByKey(mine.connections ?? [], theirs.connections ?? [], (c) => c.id)
  return {
    addedElements: els.onlyTheirs.length,
    removedElements: els.onlyMine.length,
    addedConnections: conns.onlyTheirs.length,
    removedConnections: conns.onlyMine.length
  }
}

function diffSavedAnalyses(mine: SavedAnalysis[], theirs: SavedAnalysis[]): SavedAnalysisDiffItem[] {
  const { onlyMine, onlyTheirs, bothPairs } = bucketByKey(mine, theirs, (x) => x.guid)
  const items: SavedAnalysisDiffItem[] = []
  for (const m of onlyMine) items.push({ guid: m.guid, bucket: 'onlyMine', mine: m })
  for (const t of onlyTheirs) items.push({ guid: t.guid, bucket: 'onlyTheirs', theirs: t })
  for (const [m, t] of bothPairs) {
    const changedFields = (['name', 'config'] as (keyof SavedAnalysis)[]).filter((f) => fieldsDiffer(m[f], t[f])).map(String)
    if (changedFields.length === 0) continue
    const item: SavedAnalysisDiffItem = { guid: m.guid, bucket: 'bothDiffer', mine: m, theirs: t, changedFields }
    if (m.toolType === 'relationship-map' && t.toolType === 'relationship-map' && changedFields.includes('config')) {
      item.relationshipMapSummary = diffRelationshipMap(m.config, t.config)
    }
    items.push(item)
  }
  return items
}

// ─── Top-level entry point ──────────────────────────────────────────────

export function diffProjects(mine: ProjectSide, theirs: ProjectSide): MergeDiff {
  const { documentText, codings } = diffDocumentTextAndCodings(
    mine.project.sources,
    mine.sourceContents,
    theirs.project.sources,
    theirs.sourceContents
  )
  return {
    codes: diffCodes(mine.project.codes, theirs.project.codes),
    tags: diffTags(mine.project.sets, theirs.project.sets),
    tagCategories: diffByGuid(mine.project.tagCategories ?? [], theirs.project.tagCategories ?? [], ['name', 'type', 'listOptions']),
    memos: diffByGuid(mine.project.memos ?? [], theirs.project.memos ?? [], [
      'type', 'title', 'content', 'sourceGuids', 'sourceGuid', 'startPosition', 'endPosition',
      'pdfRegion', 'analysisGuid', 'queryGuid', 'questionGuid', 'respondentId', 'surveyCell'
    ]),
    quotes: diffByGuid(mine.project.quotes ?? [], theirs.project.quotes ?? [], [
      'sourceGuid', 'sourceName', 'startPosition', 'endPosition', 'text', 'pdfRegion', 'surveyCell'
    ]),
    logbookEntries: diffByGuid(mine.project.logbookEntries ?? [], theirs.project.logbookEntries ?? [], ['title', 'content']),
    savedQueries: diffByGuid(mine.project.savedQueries ?? [], theirs.project.savedQueries ?? [], ['name', 'query']),
    folders: diffByGuid(mine.project.folders ?? [], theirs.project.folders ?? [], ['name', 'parentGuid']),
    sources: diffSources(mine.project.sources, theirs.project.sources, theirs.sourceContents),
    documentText,
    codings,
    savedAnalyses: diffSavedAnalyses(mine.project.savedAnalyses ?? [], theirs.project.savedAnalyses ?? [])
  }
}
