/**
 * The "From these documents" section shared by the analysis tools: a
 * collapsible Document Selector whose heading says what the analysis
 * reads (how many documents, and any survey questions or respondents
 * chosen), so the scope is clear without opening it.
 */
import { useState } from 'react'
import type { AnalysisInitData } from '../../models/types'
import { Icon, faChevronDown, faChevronRight } from '../Icon'
import { DocumentSelector, type DocumentFilterState } from '../DocumentSelector/DocumentSelector'
import { documentsSummary } from './documents-filter'
import { mayBeSurveyEntityDrag, parseSurveyEntityDrop, withSurveyEntity } from '../DocumentSelector/SurveyScope'

export function DocumentsSection({ data, filter, onChange, filteredSourceGuids }: {
  data: AnalysisInitData
  filter: DocumentFilterState
  onChange: (filter: DocumentFilterState) => void
  /** The documents the analysis reads after the filter. */
  filteredSourceGuids: string[]
}) {
  const [open, setOpen] = useState(false)
  // Open, the selector takes the drop itself.
  const handleDrop = (e: React.DragEvent) => {
    if (open) return
    const dropped = parseSurveyEntityDrop(e)
    if (!dropped || !filteredSourceGuids.includes(dropped.ref.sourceGuid)) return
    e.preventDefault()
    const key = dropped.kind === 'questions' ? 'questionScope' : 'respondentScope'
    onChange({ ...filter, [key]: withSurveyEntity(filter[key], dropped.ref) })
  }
  return (
    <div
      className="analysis-section"
      style={{ marginBottom: 14 }}
      onDragOver={(e) => {
        if (!open && mayBeSurveyEntityDrag(e)) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDrop={handleDrop}
    >
      <div onClick={() => setOpen(!open)} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
        <Icon icon={open ? faChevronDown : faChevronRight} style={{ fontSize: 12, color: 'var(--text-muted)' }} />
        <span style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--text-secondary)' }}>From these documents</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
          {documentsSummary(filteredSourceGuids.length, data.sources.length, filter)}
        </span>
      </div>
      {open && (
        <div style={{ marginTop: 10, minHeight: 160 }}>
          <DocumentSelector
            sources={data.sources}
            tags={data.tags}
            categories={data.categories}
            folders={data.folders}
            sourceFolder={data.sourceFolder}
            tagMembers={data.tagMembers}
            respondentTagMembers={data.respondentTagMembers}
            questionTagMembers={data.questionTagMembers}
            surveyEntityLabels={data.surveyEntityLabels}
            filter={filter}
            onChange={onChange}
          />
        </div>
      )}
    </div>
  )
}
