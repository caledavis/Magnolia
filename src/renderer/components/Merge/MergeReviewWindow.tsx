import { useState } from 'react'
import { useMergeReviewStore, collectCurrentProject, type FlatCategory } from '../../stores/merge-review-store'
import { applyMerge, emptyApplyPlan, type ApplyPlan } from '../../utils/project-diff-apply'
import type { DiffItem, MergeDiff, CodeDiffItem, SavedAnalysisDiffItem, CodingInstance } from '../../utils/project-diff'
import { useProjectStore } from '../../stores/project-store'
import { useDocumentStore } from '../../stores/document-store'
import { useCodeStore } from '../../stores/code-store'
import { getContext, codepointSlice } from '../../utils/unicode'
import { textForSelection } from '../../utils/query-engine'
import { buildHighlightedSpans, formatClipTime } from '../QueryResultViewer/QueryResultsBody'
import { PdfRegionThumbnail } from '../DocumentViewer/PdfRegionThumbnail'
import { stripFormatting } from '../../utils/strip-formatting'
import type { Code } from '../../models/types'

interface MergeReviewWindowProps {
  onClose: () => void
}

interface CategoryMeta {
  id: FlatCategory
  label: string
  count: (diff: MergeDiff) => number
}

const FLAT_CATEGORIES: CategoryMeta[] = [
  { id: 'codes', label: 'Codes', count: (d) => d.codes.length },
  { id: 'tags', label: 'Tags', count: (d) => d.tags.length },
  { id: 'tagCategories', label: 'Tag Categories', count: (d) => d.tagCategories.length },
  { id: 'memos', label: 'Memos', count: (d) => d.memos.length },
  { id: 'quotes', label: 'Quotes', count: (d) => d.quotes.length },
  { id: 'logbookEntries', label: 'Logbook', count: (d) => d.logbookEntries.length },
  { id: 'savedQueries', label: 'Saved Queries', count: (d) => d.savedQueries.length },
  { id: 'folders', label: 'Folders', count: (d) => d.folders.length },
  { id: 'users', label: 'Users', count: (d) => d.users.length },
  { id: 'savedAnalyses', label: 'Saved Analyses', count: (d) => d.savedAnalyses.length }
]

/** Possessive form of the comparison file's last-editor name — "Cale
 *  Davis's" — for every "only in ___" / "take ___ version" label. Falls
 *  back to the pronoun "theirs" (already possessive on its own, no
 *  trailing 's) when the file has no recorded editor (e.g. it was never
 *  saved after Stage 2 shipped). */
function theirsPossessive(comparisonEditedBy: string | null): string {
  const name = comparisonEditedBy?.trim()
  return name ? `${name}’s` : 'theirs'
}

function bucketLabel(bucket: DiffItem<unknown>['bucket'], comparisonEditedBy: string | null): string {
  const theirs = theirsPossessive(comparisonEditedBy)
  if (bucket === 'onlyMine') return 'Only in mine — check to remove'
  if (bucket === 'onlyTheirs') return `Only in ${theirs} — check to add`
  return `Differs — check to take ${theirs} version`
}

/** Small color-pip, matching the one shown next to codes everywhere else
 *  in the app (e.g. code badges in Query Results), so a code stays
 *  visually recognizable by its pip in the merge review too. */
function ColorPip({ color }: { color?: string }): JSX.Element {
  return <span className="color-pip" style={{ background: color || '#888', width: 8, height: 8, flexShrink: 0 }} />
}

/** Human-readable one-line label per category's item shape. Falls back to
 *  the guid if nothing more specific applies. Codes get their color pip
 *  inline since users associate the pip with "this is a code". */
function describeItem(category: FlatCategory, item: DiffItem<any>): React.ReactNode {
  const obj = item.theirs ?? item.mine
  switch (category) {
    case 'codes': {
      const code = item as CodeDiffItem
      const base = obj?.name ?? code.guid
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <ColorPip color={obj?.color} />
          {code.moved ? `${base} (moved)` : base}
        </span>
      )
    }
    case 'tags':
      return obj?.name ?? item.guid
    case 'tagCategories':
      return obj?.name ?? item.guid
    case 'memos':
      return obj?.title || `${obj?.type ?? 'memo'} memo`
    case 'quotes':
      return obj?.text ? `"${String(obj.text).slice(0, 60)}"` : item.guid
    case 'logbookEntries':
      return obj?.title ?? item.guid
    case 'savedQueries':
      return obj?.name ?? item.guid
    case 'folders':
      return obj?.name ?? item.guid
    case 'users':
      return obj?.name ?? item.guid
    case 'savedAnalyses': {
      const sa = item as SavedAnalysisDiffItem
      if (sa.relationshipMapSummary) {
        const s = sa.relationshipMapSummary
        return `${obj?.name ?? sa.guid} (+${s.addedElements}/−${s.removedElements} elements, +${s.addedConnections}/−${s.removedConnections} connections)`
      }
      return obj?.name ?? item.guid
    }
    default:
      return item.guid
  }
}

function CheckboxRow({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: React.ReactNode }): JSX.Element {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', cursor: 'pointer', fontSize: 12.5 }}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      {label}
    </label>
  )
}

function BucketSection({
  title,
  items,
  isChecked,
  onToggle,
  describe
}: {
  title: string
  items: DiffItem<any>[]
  isChecked: (item: DiffItem<any>) => boolean
  onToggle: (item: DiffItem<any>) => void
  describe: (item: DiffItem<any>) => React.ReactNode
}): JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div style={{ marginBottom: 16 }}>
      <h4 style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', margin: '0 0 6px', textTransform: 'uppercase', letterSpacing: 0.02 }}>
        {title} ({items.length})
      </h4>
      {items.map((item) => (
        <CheckboxRow key={item.guid} checked={isChecked(item)} onChange={() => onToggle(item)} label={describe(item)} />
      ))}
    </div>
  )
}

function FlatCategoryPane({ category, diff }: { category: FlatCategory; diff: MergeDiff }): JSX.Element {
  const approved = useMergeReviewStore((s) => s.approved[category])
  const toggle = useMergeReviewStore((s) => s.toggle)
  const comparisonEditedBy = useMergeReviewStore((s) => s.comparisonEditedBy)
  const theirs = theirsPossessive(comparisonEditedBy)
  const items = (diff as any)[category] as DiffItem<any>[]
  const onlyMine = items.filter((i) => i.bucket === 'onlyMine')
  const onlyTheirs = items.filter((i) => i.bucket === 'onlyTheirs')
  const bothDiffer = items.filter((i) => i.bucket === 'bothDiffer')
  const isChecked = (item: DiffItem<any>) => approved.has(item.guid)
  const onToggle = (item: DiffItem<any>) => toggle(category, item.guid)
  const describe = (item: DiffItem<any>): React.ReactNode => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {describeItem(category, item)}
      <span style={{ color: 'var(--text-muted)' }}>— {bucketLabel(item.bucket, comparisonEditedBy)}</span>
    </span>
  )
  return (
    <div>
      <BucketSection title={`Only in ${theirs}`} items={onlyTheirs} isChecked={isChecked} onToggle={onToggle} describe={describe} />
      <BucketSection title="Differs" items={bothDiffer} isChecked={isChecked} onToggle={onToggle} describe={describe} />
      <BucketSection title="Only in mine" items={onlyMine} isChecked={isChecked} onToggle={onToggle} describe={describe} />
    </div>
  )
}

function DocumentTextPane({ diff }: { diff: MergeDiff }): JSX.Element {
  const approved = useMergeReviewStore((s) => s.approved.documentText)
  const toggle = useMergeReviewStore((s) => s.toggle)
  const comparisonEditedBy = useMergeReviewStore((s) => s.comparisonEditedBy)
  const theirs = theirsPossessive(comparisonEditedBy)
  if (diff.documentText.length === 0) return <p style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>No documents differ.</p>
  return (
    <div>
      {diff.documentText.map((d) => (
        <CheckboxRow
          key={d.sourceGuid}
          checked={approved.has(d.sourceGuid)}
          onChange={() => toggle('documentText', d.sourceGuid)}
          label={`${d.sourceName} — text differs, check to take ${theirs} version`}
        />
      ))}
    </div>
  )
}

function findCodeInTree(codes: Code[], guid: string): Code | undefined {
  for (const c of codes) {
    if (c.guid === guid) return c
    const found = findCodeInTree(c.children, guid)
    if (found) return found
  }
  return undefined
}

/** Looks up a code by guid in mine's live codeStore first, falling back to
 *  theirs' project — an onlyTheirs coding can reference a code that only
 *  exists on theirs' side (an added code the user hasn't approved yet has
 *  no entry in the live codeStore). */
function useFindCode(): (guid: string) => { name: string; color?: string } | undefined {
  const mineCodes = useCodeStore((s) => s.codes)
  const comparisonProject = useMergeReviewStore((s) => s.comparisonProject)
  return (guid: string) => findCodeInTree(mineCodes, guid) ?? (comparisonProject ? findCodeInTree(comparisonProject.codes, guid) : undefined)
}

/** Renders a preview for a coding, dispatching exactly the way
 *  QueryResultsBody's ResultItem does for every anchor kind, so a coded
 *  segment looks identical wherever it's previewed in the app:
 *   - plain text (incl. audio transcript): highlighted snippet with
 *     context, via getContext/codepointSlice + buildHighlightedSpans.
 *   - PDF / image (PdfRegionSelection is shared by both — page is always
 *     1 for images): PdfRegionThumbnail, which already dispatches
 *     PDF-page-crop vs. image-crop internally.
 *   - video (timeRange): the clip's time range plus its transcript text,
 *     matched-style only — Query Results shows no before/after context
 *     for video either.
 *   - survey cell: textForSelection (query-engine.ts) resolves the
 *     cleaned cell text the offsets actually index into (NOT the raw
 *     CSV), with a "Respondent N · Question N" label, matching Query
 *     Results' survey-cell handling exactly (including its choice to
 *     strip rather than highlight the surrounding context for survey,
 *     same as markdown, since “positions preserved” excludes both). */
function CodingPreview({
  sourceGuid,
  instance,
  findCode
}: {
  sourceGuid: string
  instance: CodingInstance
  findCode: (guid: string) => { name: string; color?: string } | undefined
}): JSX.Element {
  const sourceContents = useDocumentStore((s) => s.sourceContents)
  const source = useDocumentStore((s) => s.sources.find((src) => src.guid === sourceGuid))
  const selections = source?.selections ?? []
  const sel = instance.selection
  const code = findCode(instance.coding.codeGuid)
  const matchStyle: React.CSSProperties = {
    background: code?.color ? code.color + '40' : 'var(--selection-bg)',
    borderRadius: 'var(--radius-sm)',
    padding: '1px 2px 0',
    fontWeight: 600,
    ...(code?.color ? { borderBottom: `2px solid ${code.color}` } : {})
  }

  if (sel.pdfRegion) {
    const isImage = source?.sourceType === 'image'
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 2 }}>
        <PdfRegionThumbnail
          sourceGuid={sourceGuid}
          page={sel.pdfRegion.page}
          x={sel.pdfRegion.x}
          y={sel.pdfRegion.y}
          width={sel.pdfRegion.width}
          height={sel.pdfRegion.height}
          maxW={220}
          maxH={140}
        />
        {!isImage && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Page {sel.pdfRegion.page}</span>}
      </div>
    )
  }

  if (!source) return <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Document not found</span>
  const documentContent = sourceContents[sourceGuid] ?? ''
  const text = textForSelection(source, sel, documentContent)
  const matchedText = codepointSlice(text, sel.startPosition, sel.endPosition)

  if (sel.timeRange) {
    return (
      <div style={{ fontSize: 11.5, lineHeight: 1.5, marginTop: 2 }}>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>
          {formatClipTime(sel.timeRange.startTime)} – {formatClipTime(sel.timeRange.endTime)}
        </div>
        <span style={matchStyle}>{matchedText}</span>
      </div>
    )
  }

  let surveyCellLabel: string | null = null
  if (sel.surveyCell) {
    const survey = (source.formatData as { survey?: import('../../models/types').SurveyData })?.survey
    if (survey) {
      const rIdx = survey.respondents.findIndex((r) => r.id === sel.surveyCell!.respondentId)
      const qIdx = survey.questions.findIndex((q) => q.id === sel.surveyCell!.questionId)
      if (rIdx >= 0 && qIdx >= 0) surveyCellLabel = `Respondent ${rIdx + 1} · Question ${qIdx + 1}`
    }
  }

  const { before, after } = getContext(text, sel.startPosition, sel.endPosition)
  const contextStartCp = sel.startPosition - Array.from(before).length
  const matchedCodeGuids = new Set([instance.coding.codeGuid])
  // Same as Query Results: only these source types have offsets that
  // line up with the RAW content, so only they get highlighted context.
  // Survey (cleaned cell text) and markdown both fall back to plain text.
  const positionsPreserved = !source.sourceType || source.sourceType === 'text' || source.sourceType === 'pdf' || source.sourceType === 'audio'

  return (
    <div style={{ fontSize: 11.5, lineHeight: 1.5, marginTop: 2 }}>
      {surveyCellLabel && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>{surveyCellLabel}</div>
      )}
      <span style={{ color: 'var(--text-secondary)' }}>
        {before ? '…' : ''}
        {positionsPreserved ? buildHighlightedSpans(before, contextStartCp, selections, findCode, false) : stripFormatting(before, source.sourceType)}
      </span>
      <span style={matchStyle}>
        {positionsPreserved
          ? buildHighlightedSpans(matchedText, sel.startPosition, selections, findCode, true, matchedCodeGuids)
          : stripFormatting(matchedText, source.sourceType)}
      </span>
      <span style={{ color: 'var(--text-secondary)' }}>
        {positionsPreserved ? buildHighlightedSpans(after, sel.startPosition + Array.from(matchedText).length, selections, findCode, false) : stripFormatting(after, source.sourceType)}
        {after ? '…' : ''}
      </span>
    </div>
  )
}

function CodingLabel({ code, suffix }: { code: { name: string; color?: string } | undefined; suffix: string }): JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <ColorPip color={code?.color} />
      {code?.name ?? 'Unknown code'} <span style={{ color: 'var(--text-muted)' }}>— {suffix}</span>
    </span>
  )
}

function CodingsPane({ diff }: { diff: MergeDiff }): JSX.Element {
  const approved = useMergeReviewStore((s) => s.codingsApproved)
  const toggleCoding = useMergeReviewStore((s) => s.toggleCoding)
  const comparisonEditedBy = useMergeReviewStore((s) => s.comparisonEditedBy)
  const theirs = theirsPossessive(comparisonEditedBy)
  const findCode = useFindCode()
  if (diff.codings.length === 0) return <p style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>No coding differences.</p>
  return (
    <div>
      {diff.codings.map((c) => {
        if (c.coarse) {
          const key = `coarse::${c.sourceGuid}`
          return (
            <CheckboxRow
              key={key}
              checked={approved.has(key)}
              onChange={() => toggleCoding(key)}
              label={`${c.sourceName} — text differs, codings can't be itemized. Check to take ${theirs} text AND codings for this document.`}
            />
          )
        }
        return (
          <div key={c.sourceGuid} style={{ marginBottom: 16 }}>
            <h4 style={{ fontSize: 11.5, fontWeight: 600, margin: '0 0 4px' }}>{c.sourceName}</h4>
            {(c.onlyTheirs ?? []).map((inst, i) => {
              const key = `add::${c.sourceGuid}::${i}`
              const code = findCode(inst.coding.codeGuid)
              return (
                <div key={key} style={{ padding: '4px 0', borderBottom: '1px solid var(--border-color)' }}>
                  <CheckboxRow
                    checked={approved.has(key)}
                    onChange={() => toggleCoding(key)}
                    label={<CodingLabel code={code} suffix={`only in ${theirs}, check to add`} />}
                  />
                  <div style={{ marginLeft: 22 }}>
                    <CodingPreview sourceGuid={c.sourceGuid} instance={inst} findCode={findCode} />
                  </div>
                </div>
              )
            })}
            {(c.onlyMine ?? []).map((inst, i) => {
              const key = `remove::${c.sourceGuid}::${i}`
              const code = findCode(inst.coding.codeGuid)
              return (
                <div key={key} style={{ padding: '4px 0', borderBottom: '1px solid var(--border-color)' }}>
                  <CheckboxRow
                    checked={approved.has(key)}
                    onChange={() => toggleCoding(key)}
                    label={<CodingLabel code={code} suffix="only in mine, check to remove" />}
                  />
                  <div style={{ marginLeft: 22 }}>
                    <CodingPreview sourceGuid={c.sourceGuid} instance={inst} findCode={findCode} />
                  </div>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

/** Builds an ApplyPlan from the diff + everything checked, parsing the
 *  combined codings key scheme (see merge-review-store.ts) back apart. */
function buildApplyPlan(diff: MergeDiff, approved: Record<FlatCategory, Set<string>>, codingsApproved: Set<string>): ApplyPlan {
  const plan = emptyApplyPlan()
  for (const meta of FLAT_CATEGORIES) {
    const items = (diff as any)[meta.id] as DiffItem<any>[]
    ;(plan as any)[meta.id] = items.filter((i) => approved[meta.id].has(i.guid))
  }
  plan.documentText = diff.documentText.filter((d) => approved.documentText.has(d.sourceGuid))

  for (const key of codingsApproved) {
    const [kind, sourceGuid, indexStr] = key.split('::')
    const item = diff.codings.find((c) => c.sourceGuid === sourceGuid)
    if (!item) continue
    if (kind === 'coarse') {
      plan.codingsCoarse.push(item)
      // Approving "take theirs' codings" implies also taking their text —
      // codings only make sense anchored to the text they came from.
      if (!plan.documentText.some((d) => d.sourceGuid === sourceGuid)) {
        const textItem = diff.documentText.find((d) => d.sourceGuid === sourceGuid)
        if (textItem) plan.documentText.push(textItem)
      }
    } else if (kind === 'add') {
      const inst = item.onlyTheirs?.[Number(indexStr)]
      if (inst) plan.codingsAdd.push({ sourceGuid, instance: inst })
    } else if (kind === 'remove') {
      const inst = item.onlyMine?.[Number(indexStr)]
      if (inst) plan.codingsRemove.push({ sourceGuid, instance: inst })
    }
  }
  return plan
}

function totalApprovedCount(approved: Record<FlatCategory, Set<string>>, codingsApproved: Set<string>): number {
  return Object.values(approved).reduce((sum, s) => sum + s.size, 0) + codingsApproved.size
}

/** Every selectable guid/key for one category, in the exact same shape
 *  its approved-set uses — for "Select All". Mirrors categoryCount's
 *  counting logic so the two always agree on what "all" means. */
function allKeysForCategory(id: FlatCategory | 'codings', diff: MergeDiff): string[] {
  if (id === 'codings') {
    const keys: string[] = []
    for (const c of diff.codings) {
      if (c.coarse) {
        keys.push(`coarse::${c.sourceGuid}`)
      } else {
        ;(c.onlyTheirs ?? []).forEach((_, i) => keys.push(`add::${c.sourceGuid}::${i}`))
        ;(c.onlyMine ?? []).forEach((_, i) => keys.push(`remove::${c.sourceGuid}::${i}`))
      }
    }
    return keys
  }
  if (id === 'documentText') return diff.documentText.map((d) => d.sourceGuid)
  return ((diff as any)[id] as DiffItem<any>[]).map((i) => i.guid)
}

export function MergeReviewWindow({ onClose }: MergeReviewWindowProps): JSX.Element {
  const { diff, loading, error, comparisonFilePath, comparisonEditedBy, approved, codingsApproved } = useMergeReviewStore()
  const reset = useMergeReviewStore((s) => s.reset)
  const [selected, setSelected] = useState<'codings' | 'documentText' | FlatCategory>('codes')
  const [applied, setApplied] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const handleClose = (): void => {
    reset()
    onClose()
  }

  const handleApply = (): void => {
    if (!diff) return
    const plan = buildApplyPlan(diff, approved, codingsApproved)
    applyMerge(plan)
    setApplied(totalApprovedCount(approved, codingsApproved))
  }

  // Scoped to whichever category is currently active in the sidebar —
  // selecting all in "Codes" never touches "Memos", etc. Deselect reuses
  // the same actions with an empty list rather than needing its own.
  const handleSelectAll = (): void => {
    if (!diff) return
    const store = useMergeReviewStore.getState()
    const keys = allKeysForCategory(selected, diff)
    if (selected === 'codings') store.selectAllCodings(keys)
    else store.selectAll(selected as FlatCategory, keys)
  }

  const handleDeselectAll = (): void => {
    const store = useMergeReviewStore.getState()
    if (selected === 'codings') store.selectAllCodings([])
    else store.selectAll(selected as FlatCategory, [])
  }

  // Mirrors App.tsx's handleSaveProject (main-process save + dirty-flag
  // clearing + recent-projects tracking), reimplemented against store
  // getters rather than hooks/refs since this tab lives outside App.tsx's
  // own component tree. Closes the tab automatically once the save
  // genuinely succeeds; a blocked/failed save leaves the tab open with
  // the error shown, so approved changes are never silently lost.
  const handleSaveAndClose = async (): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    try {
      const ps = useProjectStore.getState()
      const ds = useDocumentStore.getState()
      const result = await window.api.saveProject({
        project: collectCurrentProject(),
        sourceContents: ds.sourceContents,
        filePath: ps.filePath ?? undefined
      })
      if (result && typeof result === 'object' && 'guardBlocked' in result) {
        setSaveError((result as { message: string }).message)
        setSaving(false)
        return
      }
      if (typeof result === 'string') {
        ps.setFilePath(result)
        ps.markClean()
        ds.promoteImportedBinariesToArchive()
        window.api.trackRecentProject(ps.name, result)
        handleClose()
        return
      }
      // result is null: the user cancelled the save-location dialog
      // (unsaved project with no filePath yet) — leave the tab open.
      setSaving(false)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 10, width: 340 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>Comparing projects…</span>
          <div style={{ height: 6, background: 'var(--bg-tertiary, var(--border-color))', borderRadius: 3, overflow: 'hidden', position: 'relative' }}>
            <div
              style={{
                position: 'absolute', top: 0, left: 0, height: '100%', width: '35%',
                background: 'var(--accent, #3b82f6)', borderRadius: 3,
                animation: 'magnolia-indeterminate 1.2s ease-in-out infinite'
              }}
            />
          </div>
          <style>{`
            @keyframes magnolia-indeterminate {
              0%   { left: -35%; }
              100% { left: 100%; }
            }
          `}</style>
        </div>
      </div>
    )
  }
  if (error) {
    return (
      <div style={{ padding: 24, fontSize: 13, color: 'var(--danger)' }}>Couldn’t read that file: {error}</div>
    )
  }
  if (!diff) {
    return <div style={{ padding: 24, fontSize: 13, color: 'var(--text-secondary)' }}>No comparison loaded.</div>
  }

  if (applied !== null) {
    return (
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Merge applied</h2>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          {applied} change{applied === 1 ? '' : 's'} applied to this project. Save to write them to disk.
        </p>
        {saveError && (
          <p style={{ fontSize: 12.5, color: 'var(--danger)' }}>Couldn’t save: {saveError}</p>
        )}
        <div className="modal-actions" style={{ marginTop: 'auto' }}>
          <button onClick={handleSaveAndClose} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    )
  }

  const categoryCount = (id: FlatCategory | 'codings' | 'documentText'): number => {
    if (id === 'codings') return diff.codings.reduce((n, c) => n + (c.coarse ? 1 : (c.onlyMine?.length ?? 0) + (c.onlyTheirs?.length ?? 0)), 0)
    if (id === 'documentText') return diff.documentText.length
    return FLAT_CATEGORIES.find((c) => c.id === id)!.count(diff)
  }

  // "Reviewed" = checked/approved so far — the only review state this
  // screen tracks (there's no separate "seen but left unchecked" marker).
  const approvedCount = (id: FlatCategory | 'codings' | 'documentText'): number => {
    if (id === 'codings') return codingsApproved.size
    return approved[id as FlatCategory].size
  }

  const allCategories: { id: FlatCategory | 'codings' | 'documentText'; label: string }[] = [
    ...FLAT_CATEGORIES.filter((c) => c.id !== 'savedAnalyses').map((c) => ({ id: c.id, label: c.label })),
    { id: 'documentText', label: 'Document Text' },
    { id: 'codings', label: 'Codings' },
    { id: 'savedAnalyses', label: 'Saved Analyses' }
  ]

  const totalApproved = totalApprovedCount(approved, codingsApproved)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid var(--border-color)' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Merge Project</h2>
          <p style={{ margin: '2px 0 0', fontSize: 11.5, color: 'var(--text-muted)' }}>
            Comparing against {comparisonFilePath}
            {comparisonEditedBy ? ` — last edited by ${comparisonEditedBy}` : ''}
          </p>
        </div>
        <button className="secondary" onClick={handleClose}>Close</button>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ width: 180, flexShrink: 0, borderRight: '1px solid var(--border-color)', overflowY: 'auto', padding: '10px 0' }}>
          {allCategories.map((cat) => {
            const count = categoryCount(cat.id)
            const reviewed = approvedCount(cat.id)
            return (
              <div
                key={cat.id}
                onClick={() => setSelected(cat.id)}
                style={{
                  display: 'flex', justifyContent: 'space-between', padding: '6px 16px', cursor: 'pointer', fontSize: 12.5,
                  background: selected === cat.id ? 'var(--selection-bg)' : 'transparent',
                  color: count === 0 ? 'var(--text-muted)' : 'var(--text-primary)'
                }}
              >
                <span>{cat.label}</span>
                {count > 0 && (
                  <span style={{ color: reviewed === count ? 'var(--success)' : 'var(--text-secondary)' }}>
                    {reviewed}/{count}
                  </span>
                )}
              </div>
            )
          })}
        </div>

        <div style={{ flex: 1, padding: '14px 20px', overflowY: 'auto' }}>
          {categoryCount(selected) > 0 && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 8 }}>
              <button className="secondary" onClick={handleDeselectAll}>Deselect All</button>
              <button className="secondary" onClick={handleSelectAll}>Select All</button>
            </div>
          )}
          {selected === 'codings' && <CodingsPane diff={diff} />}
          {selected === 'documentText' && <DocumentTextPane diff={diff} />}
          {selected !== 'codings' && selected !== 'documentText' && <FlatCategoryPane category={selected as FlatCategory} diff={diff} />}
        </div>
      </div>

      <div className="modal-actions" style={{ padding: '12px 20px', borderTop: '1px solid var(--border-color)', margin: 0 }}>
        <button className="secondary" onClick={handleClose}>Cancel</button>
        <button onClick={handleApply} disabled={totalApproved === 0}>
          Apply {totalApproved > 0 ? `${totalApproved} ` : ''}Approved Change{totalApproved === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  )
}
