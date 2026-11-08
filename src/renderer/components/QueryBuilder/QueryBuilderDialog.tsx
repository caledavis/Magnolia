import { useState, useCallback, useMemo } from 'react'
import { useDocumentStore } from '../../stores/document-store'
import { useCodeStore } from '../../stores/code-store'
import { useTagStore } from '../../stores/tag-store'
import { useQueryStore } from '../../stores/query-store'
import { buildSurveyEntityLabels } from '../../utils/survey/survey-labels'
import { QueryNodeEditor } from './QueryNodeEditor'
import { Icon, faChevronDown, faChevronRight } from '../Icon'
import {
  DocumentSelector,
  emptyDocumentFilter,
  type DocumentFilterState
} from '../DocumentSelector/DocumentSelector'
import type { Code, CodeCondition, Query } from '../../models/types'

interface Props {
  onClose: () => void
}

// Section boxes in the Query Builder use the shared .analysis-section
// class (defined in global.css) so they stay visually consistent with
// the collapsible sections in every Analysis tool.

export function QueryBuilderDialog({ onClose }: Props) {
  const sources = useDocumentStore((s) => s.sources)
  const folders = useDocumentStore((s) => s.folders)
  const tags = useTagStore((s) => s.tags)
  const categories = useTagStore((s) => s.categories)
  const setComplexQuery = useQueryStore((s) => s.setComplexQuery)
  const codesTree = useCodeStore((s) => s.codes)
  const codesList = useMemo(() => {
    function flatten(codes: Code[], parentGuid?: string): { guid: string; name: string; color?: string; isCodable: boolean; parentGuid?: string }[] {
      const result: { guid: string; name: string; color?: string; isCodable: boolean; parentGuid?: string }[] = []
      for (const c of codes) {
        result.push({ guid: c.guid, name: c.name, color: c.color, isCodable: c.isCodable, parentGuid })
        result.push(...flatten(c.children, c.guid))
      }
      return result
    }
    return flatten(codesTree)
  }, [codesTree])

  const [docFilter, setDocFilter] = useState<DocumentFilterState>(emptyDocumentFilter())
  const [docSectionOpen, setDocSectionOpen] = useState(false)
  const [codeCondition, setCodeCondition] = useState<CodeCondition | null>(null)

  const handleConditionChange = useCallback(
    (condition: CodeCondition | null) => {
      setCodeCondition(condition)
    },
    []
  )

  const handleRun = () => {
    if (!codeCondition) return

    const query: Query = {
      documentFilter: {
        sourceGuids: docFilter.sourceGuids.length > 0 ? docFilter.sourceGuids : undefined,
        tagGuids: docFilter.tagGuids.length > 0 ? docFilter.tagGuids : undefined,
        folderGuids: docFilter.folderGuids.length > 0 ? docFilter.folderGuids : undefined
      },
      codeCondition
    }

    setComplexQuery(query)
    onClose()
  }

  const hasDocFilters =
    docFilter.sourceGuids.length > 0 ||
    docFilter.folderGuids.length > 0 ||
    docFilter.tagGuids.length > 0 ||
    docFilter.typeInclude.length > 0

  const selectorSources = sources.map((s) => ({ guid: s.guid, name: s.name, sourceType: s.sourceType }))
  const selectorTags = tags.map((t) => ({
    guid: t.guid,
    name: t.name,
    categoryGuid: t.categoryGuid,
    value: t.value
  }))
  const selectorCategories = categories.map((c) => ({ guid: c.guid, name: c.name, type: c.type, listOptions: c.listOptions }))
  const selectorFolders = folders.map((f) => ({
    guid: f.guid,
    name: f.name,
    parentGuid: f.parentGuid ?? null
  }))
  const selectorTagMembers = useMemo(() => {
    const m: Record<string, string[]> = {}
    for (const t of tags) m[t.guid] = t.memberSourceGuids
    return m
  }, [tags])
  const selectorRespondentTagMembers = useMemo(() => {
    const m: Record<string, import('../../models/types').SurveyEntityRef[]> = {}
    for (const t of tags) if (t.memberSurveyRespondents?.length) m[t.guid] = t.memberSurveyRespondents
    return m
  }, [tags])
  const selectorQuestionTagMembers = useMemo(() => {
    const m: Record<string, import('../../models/types').SurveyEntityRef[]> = {}
    for (const t of tags) if (t.memberSurveyQuestions?.length) m[t.guid] = t.memberSurveyQuestions
    return m
  }, [tags])
  const selectorSurveyLabels = useMemo(() => buildSurveyEntityLabels(sources), [sources])

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      style={{ pointerEvents: 'none' }}
    >
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '88vw',
          maxWidth: 960,
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          pointerEvents: 'auto'
        }}
      >
        <h2>Build Query</h2>

        {/* Scrollable body */}
        <div style={{ flex: 1, overflowY: 'auto', paddingInlineEnd: 4 }}>
          {/* ── Part 1: Search these documents (collapsible) ── */}
          <div className="analysis-section" style={{ marginBottom: 14 }}>
            <div
              onClick={() => setDocSectionOpen(!docSectionOpen)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                cursor: 'pointer',
                userSelect: 'none'
              }}
            >
              <Icon icon={docSectionOpen ? faChevronDown : faChevronRight} style={{ fontSize: 10, color: 'var(--text-muted)' }} />
              <span
                style={{
                  fontSize: 'var(--font-size-lg)',
                  fontWeight: 600,
                  color: 'var(--text-secondary)'
                }}
              >
                Select Documents
              </span>
              <span
                style={{
                  fontSize: 11,
                  color: hasDocFilters
                    ? 'var(--status-success)'
                    : 'var(--text-muted)',
                  marginInlineStart: 'auto'
                }}
              >
                {hasDocFilters ? 'Filtered' : 'All documents'}
              </span>
            </div>

            {docSectionOpen && (
              <div style={{ marginTop: 10, minHeight: 200 }}>
                <DocumentSelector
                  sources={selectorSources}
                  tags={selectorTags}
                  categories={selectorCategories}
                  folders={selectorFolders}
                  tagMembers={selectorTagMembers}
                  respondentTagMembers={selectorRespondentTagMembers}
                  questionTagMembers={selectorQuestionTagMembers}
                  surveyEntityLabels={selectorSurveyLabels}
                  filter={docFilter}
                  onChange={setDocFilter}
                />
              </div>
            )}
          </div>

          {/* ── Part 2: For this content (node editor) ── */}
          <div className="analysis-section" style={{ marginBottom: 14 }}>
            <div
              style={{
                fontSize: 'var(--font-size-lg)',
                fontWeight: 600,
                color: 'var(--text-secondary)',
                marginBottom: 10
              }}
            >
              For this content...
            </div>

            <QueryNodeEditor
              onChange={handleConditionChange}
              codes={codesList}
            />
          </div>
        </div>

        {/* ── Actions ── */}
        <div className="modal-actions" style={{ paddingTop: 10 }}>
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button onClick={handleRun} disabled={!codeCondition}>
            Run Query
          </button>
        </div>
      </div>
    </div>
  )
}
