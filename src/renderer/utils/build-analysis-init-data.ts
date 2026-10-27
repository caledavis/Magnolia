/**
 * Builds the AnalysisInitData payload for an analysis tool, pulled from
 * the live in-process Zustand stores. Single source of truth for what
 * an analysis tool needs to render — used by both the popped-out window
 * launcher (App.openAnalysis / openSavedAnalysis) and the inline tab
 * wrappers (which get the same payload without going through IPC).
 */
import type { AnalysisInitData, AnalysisToolType, Code, SurveyFormatData } from '../models/types'
import { buildCellText } from './survey/cell-text'
import { buildSurveyEntityLabels } from './survey/survey-labels'
import { useDocumentStore } from '../stores/document-store'
import { useCodeStore } from '../stores/code-store'
import { useTagStore } from '../stores/tag-store'
import { useQueryStore } from '../stores/query-store'
import { useMemoStore } from '../stores/memo-store'
import { useQuoteStore } from '../stores/quote-store'
import { useProjectStore } from '../stores/project-store'

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

export function buildAnalysisInitData(
  toolType: AnalysisToolType,
  opts?: { savedConfig?: any }
): AnalysisInitData {
  const docStore = useDocumentStore.getState()
  const cdStore = useCodeStore.getState()
  const tgStore = useTagStore.getState()
  const theme = document.documentElement.getAttribute('data-theme') || ''

  const sourceSelections: Record<string, any[]> = {}
  for (const src of docStore.sources) sourceSelections[src.guid] = src.selections

  // Codable cells per survey = the open-ended answer cells (the only
  // cells a user can apply codes to). Drives the survey denominator for
  // coverage metrics and the text word-frequency counts — the raw CSV
  // (sourceContents) is NOT a survey's analysable content.
  const surveyCodableCells: AnalysisInitData['surveyCodableCells'] = {}
  for (const src of docStore.sources) {
    if ((src as any).sourceType !== 'survey') continue
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
    surveyCodableCells[src.guid] = cells
  }
  const tagMembers: Record<string, string[]> = {}
  const respondentTagMembers: Record<string, import('../models/types').SurveyEntityRef[]> = {}
  const questionTagMembers: Record<string, import('../models/types').SurveyEntityRef[]> = {}
  for (const tag of tgStore.tags) {
    tagMembers[tag.guid] = tag.memberSourceGuids
    if (tag.memberSurveyRespondents?.length) respondentTagMembers[tag.guid] = tag.memberSurveyRespondents
    if (tag.memberSurveyQuestions?.length) questionTagMembers[tag.guid] = tag.memberSurveyQuestions
  }

  const initData: AnalysisInitData = {
    toolType,
    theme,
    sources: docStore.sources.map((s) => ({
      guid: s.guid,
      name: s.name,
      sourceType: (s as any).sourceType,
      duration: (s as any).formatData?.duration
    })),
    folders: docStore.folders.map((f) => ({ guid: f.guid, name: f.name, parentGuid: f.parentGuid ?? null, kind: f.kind })),
    sourceFolder: docStore.sourceFolder,
    codes: flattenCodesWithParent(cdStore.codes),
    tags: tgStore.tags.map((t) => ({ guid: t.guid, name: t.name, categoryGuid: t.categoryGuid, value: t.value })),
    categories: tgStore.categories.map((c) => ({ guid: c.guid, name: c.name, type: c.type, listOptions: c.listOptions })),
    sourceContents: docStore.sourceContents,
    sourceSelections,
    tagMembers,
    respondentTagMembers,
    questionTagMembers,
    surveyCodableCells,
    surveyEntityLabels: buildSurveyEntityLabels(docStore.sources),
    savedConfig: opts?.savedConfig
  }

  // Tools that need extra ambient data:
  if (toolType === 'results-in-documents') {
    const qStore = useQueryStore.getState()
    initData.savedQueries = qStore.savedQueries.map((q) => ({ guid: q.guid, name: q.name, query: q.query }))
  }
  if (toolType === 'relationship-map') {
    const mStore = useMemoStore.getState()
    const quoteStore = useQuoteStore.getState()
    const ps = useProjectStore.getState()
    const qStore = useQueryStore.getState()
    const pdfFilePathsForMap: Record<string, string> = {}
    for (const s of docStore.sources) {
      const fp = (s as any).formatData?.pdfFilePath ?? (s as any).formatData?.imageFilePath
      if (fp) pdfFilePathsForMap[s.guid] = fp
    }
    // Full SurveyData per survey source — drives the Surveys section
    // of the Relationship Map sidebar (respondents/questions/cells
    // each become draggable nodes).
    const surveysByGuid: Record<string, import('../models/types').SurveyData> = {}
    for (const s of docStore.sources) {
      if ((s as any).sourceType !== 'survey') continue
      const survey = (s.formatData as SurveyFormatData | undefined)?.survey
      if (survey) surveysByGuid[s.guid] = survey
    }
    initData.savedQueries = qStore.savedQueries.map((q) => ({ guid: q.guid, name: q.name, query: q.query }))
    initData.memos = mStore.memos.map((m) => ({
      guid: m.guid, title: m.title, type: m.type, content: m.content,
      sourceGuid: m.sourceGuid, sourceGuids: m.sourceGuids
    }))
    initData.savedAnalyses = (ps.savedAnalyses ?? []).map((a) => ({
      guid: a.guid, name: a.name, toolType: a.toolType
    }))
    initData.quotes = quoteStore.quotes.map((q) => ({
      guid: q.guid, text: q.text, sourceName: q.sourceName, sourceGuid: q.sourceGuid,
      startPosition: q.startPosition, endPosition: q.endPosition, pdfRegion: q.pdfRegion
    }))
    initData.pdfFilePaths = pdfFilePathsForMap
    initData.surveysByGuid = surveysByGuid
  }
  return initData
}
