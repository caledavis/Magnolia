/**
 * Live equivalents of the snapshot fields on AnalysisInitData that are
 * vulnerable to staleness. Originally each analysis tool consumed a
 * frozen snapshot built by buildAnalysisInitData() at the moment the
 * tool was opened — fine for popped-out windows (now retired), but
 * inside an inline tab it meant codes / tags / categories / folders
 * created or renamed *after* the tool opened were missing or wrong.
 *
 * Pop-outs are gone, so every analysis tool runs in the main renderer
 * where the zustand stores already live. This hook subscribes the tool
 * to those stores and reshapes them into the same flat structures the
 * snapshot used, so all downstream code (group-by builder, code maps,
 * tag chips, Document Selector) keeps working unchanged.
 *
 * Document-derived fields (sources, sourceContents, sourceSelections,
 * and the per-survey surveyCodableCells / surveyEntityLabels) are now
 * live too: a document added — or a selection coded — after the tool
 * opened immediately flows into the Document Selector and the results.
 * Each is memoised on the store reference so the reshape only re-runs
 * when documents actually change.
 *
 * Open tool tabs stay mounted while another tab is showing (DocumentViewer
 * hides them, so they keep their state). A hidden tool holds the data it
 * last showed instead of following the stores: otherwise, say, Word
 * Frequencies would re-read every document on each keystroke in a note.
 * It catches up the moment it's shown again.
 */
import { createContext, useContext, useMemo, useRef } from 'react'
import type {
  AnalysisInitData,
  Code,
  PlainTextSelection,
  SurveyFormatData
} from '../../models/types'
import { useCodeStore } from '../../stores/code-store'
import { useTagStore } from '../../stores/tag-store'
import { useDocumentStore } from '../../stores/document-store'
import { buildCellText } from '../../utils/survey/cell-text'
import { buildSurveyEntityLabels } from '../../utils/survey/survey-labels'

function flattenCodesWithParent(
  codes: Code[],
  parentGuid?: string
): { guid: string; name: string; color?: string; isCodable: boolean; parentGuid?: string }[] {
  const result: { guid: string; name: string; color?: string; isCodable: boolean; parentGuid?: string }[] = []
  for (const c of codes) {
    result.push({ guid: c.guid, name: c.name, color: c.color, isCodable: c.isCodable, parentGuid })
    result.push(...flattenCodesWithParent(c.children, c.guid))
  }
  return result
}

export type LiveAnalysisData = Pick<
  AnalysisInitData,
  'codes' | 'tags' | 'categories' | 'folders' | 'tagMembers' | 'sourceFolder'
  | 'respondentTagMembers' | 'questionTagMembers'
  | 'sources' | 'sourceContents' | 'sourceSelections'
  | 'surveyCodableCells' | 'surveyEntityLabels'
>

interface StoreInputs {
  codesTree: ReturnType<typeof useCodeStore.getState>['codes']
  tags: ReturnType<typeof useTagStore.getState>['tags']
  categories: ReturnType<typeof useTagStore.getState>['categories']
  docSources: ReturnType<typeof useDocumentStore.getState>['sources']
  docFolders: ReturnType<typeof useDocumentStore.getState>['folders']
  sourceFolder: ReturnType<typeof useDocumentStore.getState>['sourceFolder']
  sourceContents: ReturnType<typeof useDocumentStore.getState>['sourceContents']
}

/** Whether the tool tab around a component is the one showing. Tools not
 *  in a tab (the default) are always showing. */
export const ToolTabShowingContext = createContext(true)

export function useLiveAnalysisData(): LiveAnalysisData {
  const showing = useContext(ToolTabShowingContext)
  // The store values this tool last used. While hidden, each selector
  // returns its held value, so a store change doesn't even re-render the
  // tool; once showing again, the selectors return the live values.
  const held = useRef<StoreInputs | null>(null)
  const hold = <T>(live: T, pick: (h: StoreInputs) => T): T =>
    showing || !held.current ? live : pick(held.current)
  const codesTree = useCodeStore((s) => hold(s.codes, (h) => h.codesTree))
  const tags = useTagStore((s) => hold(s.tags, (h) => h.tags))
  const categories = useTagStore((s) => hold(s.categories, (h) => h.categories))
  const docSources = useDocumentStore((s) => hold(s.sources, (h) => h.docSources))
  const docFolders = useDocumentStore((s) => hold(s.folders, (h) => h.docFolders))
  const sourceFolder = useDocumentStore((s) => hold(s.sourceFolder, (h) => h.sourceFolder))
  const sourceContents = useDocumentStore((s) => hold(s.sourceContents, (h) => h.sourceContents))
  held.current = { codesTree, tags, categories, docSources, docFolders, sourceFolder, sourceContents }

  const codes = useMemo(() => flattenCodesWithParent(codesTree), [codesTree])
  const folders = useMemo(
    () => docFolders.map((f) => ({ guid: f.guid, name: f.name, parentGuid: f.parentGuid ?? null, kind: f.kind })),
    [docFolders]
  )
  const tagMembers = useMemo(() => {
    const m: Record<string, string[]> = {}
    for (const t of tags) m[t.guid] = t.memberSourceGuids
    return m
  }, [tags])
  const respondentTagMembers = useMemo(() => {
    const m: Record<string, import('../../models/types').SurveyEntityRef[]> = {}
    for (const t of tags) if (t.memberSurveyRespondents?.length) m[t.guid] = t.memberSurveyRespondents
    return m
  }, [tags])
  const questionTagMembers = useMemo(() => {
    const m: Record<string, import('../../models/types').SurveyEntityRef[]> = {}
    for (const t of tags) if (t.memberSurveyQuestions?.length) m[t.guid] = t.memberSurveyQuestions
    return m
  }, [tags])
  const slimTags = useMemo(
    () => tags.map((t) => ({ guid: t.guid, name: t.name, categoryGuid: t.categoryGuid, value: t.value })),
    [tags]
  )
  const slimCategories = useMemo(
    () => categories.map((c) => ({ guid: c.guid, name: c.name, type: c.type, listOptions: c.listOptions })),
    [categories]
  )

  // Document-derived fields. Reshaped to exactly mirror
  // buildAnalysisInitData() so every consumer keeps working unchanged.
  const sources = useMemo(
    () => docSources.map((s) => ({
      guid: s.guid,
      name: s.name,
      sourceType: s.sourceType,
      duration: (s.formatData as { duration?: number } | undefined)?.duration,
      lineTimes: (s.formatData as { lineTimes?: Record<string, number> } | undefined)?.lineTimes
    })),
    [docSources]
  )
  const sourceSelections = useMemo(() => {
    const m: Record<string, PlainTextSelection[]> = {}
    for (const src of docSources) m[src.guid] = src.selections
    return m
  }, [docSources])
  const surveyCodableCells = useMemo(() => {
    const m: NonNullable<AnalysisInitData['surveyCodableCells']> = {}
    for (const src of docSources) {
      if (src.sourceType !== 'survey') continue
      const survey = (src.formatData as SurveyFormatData | undefined)?.survey
      if (!survey) continue
      const cells: { respondentId: string; questionId: string; text: string }[] = []
      const openEnded = survey.questions.filter((q) => q.type === 'open-ended')
      for (const r of survey.respondents) {
        for (const q of openEnded) {
          const text = buildCellText(r.answers[q.id])
          if (text) cells.push({ respondentId: r.id, questionId: q.id, text })
        }
      }
      m[src.guid] = cells
    }
    return m
  }, [docSources])
  const surveyEntityLabels = useMemo(() => buildSurveyEntityLabels(docSources), [docSources])

  // Memoised so the object keeps its identity until a store actually
  // changes: tools spread it into a memoised `data`, and a fresh object on
  // every render rebuilt their columns, grids and totals on any re-render.
  return useMemo(
    () => ({
      codes,
      tags: slimTags,
      categories: slimCategories,
      folders,
      tagMembers,
      respondentTagMembers,
      questionTagMembers,
      sourceFolder,
      sources,
      sourceContents,
      sourceSelections,
      surveyCodableCells,
      surveyEntityLabels
    }),
    [
      codes, slimTags, slimCategories, folders, tagMembers, respondentTagMembers, questionTagMembers,
      sourceFolder, sources, sourceContents, sourceSelections, surveyCodableCells, surveyEntityLabels
    ]
  )
}
