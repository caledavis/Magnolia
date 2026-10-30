/**
 * SurveyImportDialog — preview a parsed survey CSV before committing
 * it to the project as a `survey` source.
 *
 * Shows:
 *   - Editable survey name (prefilled from the filename)
 *   - The metadata columns (RespondentID, dates, etc.) — the user can
 *     mark any as `skip`
 *   - Each detected question with a type dropdown so a wrong
 *     auto-detection can be overridden before import
 *   - Respondent count + a small data sample under each question
 *
 * Type-override constraints (kept tight to keep v1 simple):
 *   - Multi-select questions can stay multi-select or be skipped — we
 *     don't try to splinter a multi-column group into independent
 *     single-cell questions.
 *   - Single-column questions can flip among open-ended /
 *     single-choice / numeric / metadata / skip.
 *   - Metadata columns can be flipped to skip; everything else stays.
 *
 * The dialog returns an updated SurveyData (with the user's type
 * overrides applied) plus the new survey name. Skipped columns /
 * questions are filtered out of the saved survey.
 */
import { useMemo, useState } from 'react'
import type {
  SurveyColumn,
  SurveyColumnType,
  SurveyData,
  SurveyQuestion,
  SurveyQuestionType,
  SurveyRespondent
} from '../models/types'
import { parseSurveyCsvAs, type SurveyFormat } from '../utils/survey/survey-parser'

interface Props {
  /** Initial parsed survey from the importer (parsed under the
   *  detected format). */
  initial: SurveyData
  /** Suggested survey name (typically the filename without extension). */
  suggestedName: string
  /** Original CSV text — kept so the dialog can re-parse when the
   *  user overrides the detected format. */
  rawCsv: string
  /** Format the auto-detector picked. The dropdown defaults to this. */
  detectedFormat: SurveyFormat
  /** False when the detector fell back to `generic` or matched
   *  ambiguously — surfaced as a "please confirm" hint. */
  detectionConfident: boolean
  /** User confirmed — pass back the name + the (possibly modified) survey. */
  onConfirm: (survey: SurveyData) => void
  /** User cancelled — abort this import. */
  onCancel: () => void
}

const FORMAT_LABELS: Record<SurveyFormat, string> = {
  surveymonkey: 'SurveyMonkey',
  'microsoft-forms': 'Microsoft Forms',
  generic: 'Generic (single header row)'
}

/** A single row in the editor — either a question or a stand-alone
 *  metadata column. Both are presented in the same grid so the user
 *  has one place to look. */
type EditorRow =
  | { kind: 'question'; question: SurveyQuestion }
  | { kind: 'metadata'; column: SurveyColumn }

/** All type values the dropdown can offer for a row.
 *  Multi-select rows are restricted (see TYPE_OPTIONS_FOR_ROW). */
const ALL_TYPES: { value: SurveyColumnType; label: string }[] = [
  { value: 'open-ended', label: 'Open-ended' },
  { value: 'single-choice', label: 'Single choice' },
  { value: 'numeric', label: 'Numeric' },
  { value: 'multi-select', label: 'Multi-select' },
  { value: 'metadata', label: 'Metadata' },
  { value: 'skip', label: 'Skip' }
]

function typeOptionsForRow(row: EditorRow): { value: SurveyColumnType; label: string }[] {
  if (row.kind === 'question') {
    if (row.question.type === 'multi-select') {
      // Multi-select groups can only stay multi-select or be skipped.
      return ALL_TYPES.filter((o) => o.value === 'multi-select' || o.value === 'skip')
    }
    // Single-column questions can flip freely except multi-select
    // (would require knowing which adjacent columns to absorb).
    return ALL_TYPES.filter((o) => o.value !== 'multi-select')
  }
  // Metadata columns can stay metadata or be skipped.
  return ALL_TYPES.filter((o) => o.value === 'metadata' || o.value === 'skip')
}

/** Pull a small text sample from the first N respondents for a row,
 *  used for the preview cell so the user can sanity-check the
 *  detected type. */
function sampleForRow(
  row: EditorRow,
  respondents: SurveyRespondent[],
  columns: SurveyColumn[]
): string {
  const N = 3
  if (row.kind === 'question') {
    const samples: string[] = []
    for (const r of respondents) {
      const v = r.answers[row.question.id]
      if (Array.isArray(v)) {
        if (v.length === 0) continue
        samples.push(v.join(', '))
      } else if (typeof v === 'string' && v.trim()) {
        samples.push(v.trim())
      }
      if (samples.length >= N) break
    }
    return samples.join(' · ')
  }
  // Metadata column: read by columnId from each respondent's metadata
  const samples: string[] = []
  for (const r of respondents) {
    const v = r.metadata[row.column.id]
    if (v && v.trim()) samples.push(v.trim())
    if (samples.length >= N) break
  }
  return samples.join(' · ')
}

/** Strip embedded HTML / collapse whitespace for display. */
function stripHtml(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function SurveyImportDialog({
  initial,
  suggestedName,
  rawCsv,
  detectedFormat,
  detectionConfident,
  onConfirm,
  onCancel
}: Props) {
  const [name, setName] = useState(suggestedName)
  // Active format. Changing this re-parses the CSV under the new
  // format and resets the per-row type overrides — the column ids
  // from the previous parse become meaningless once the structure
  // changes (different column counts, different groupings).
  const [format, setFormat] = useState<SurveyFormat>(detectedFormat)
  const [parseError, setParseError] = useState<string | null>(null)
  const [survey, setSurvey] = useState<SurveyData>(initial)
  // Per-question / per-metadata-column type overrides keyed by id.
  // We don't mutate `survey` directly so the user can cancel without
  // side effects.
  const [questionTypes, setQuestionTypes] = useState<Record<string, SurveyColumnType>>(
    () => Object.fromEntries(survey.questions.map((q) => [q.id, q.type as SurveyColumnType]))
  )
  const [metadataTypes, setMetadataTypes] = useState<Record<string, SurveyColumnType>>(
    () => Object.fromEntries(survey.metadataColumnIds.map((id) => [id, 'metadata' as SurveyColumnType]))
  )

  const handleFormatChange = (next: SurveyFormat) => {
    if (next === format) return
    try {
      const reparsed = parseSurveyCsvAs(rawCsv, name.trim() || suggestedName, next)
      setSurvey(reparsed)
      setFormat(next)
      setQuestionTypes(
        Object.fromEntries(reparsed.questions.map((q) => [q.id, q.type as SurveyColumnType]))
      )
      setMetadataTypes(
        Object.fromEntries(reparsed.metadataColumnIds.map((id) => [id, 'metadata' as SurveyColumnType]))
      )
      setParseError(null)
    } catch (err: any) {
      setParseError(err?.message || String(err))
    }
  }

  // Build the row list in original CSV order so the preview reads in
  // the same sequence as the file. Metadata columns interleave with
  // questions (in this file format they're all up front, but the
  // ordering rule is general).
  const rows: EditorRow[] = useMemo(() => {
    const out: EditorRow[] = []
    const questionByLeadColumnId = new Map<string, SurveyQuestion>()
    for (const q of survey.questions) {
      questionByLeadColumnId.set(q.columns[0].columnId, q)
    }
    const seenQuestionIds = new Set<string>()
    const metadataIdSet = new Set(survey.metadataColumnIds)
    for (const col of survey.columns) {
      if (metadataIdSet.has(col.id)) {
        out.push({ kind: 'metadata', column: col })
        continue
      }
      const q = questionByLeadColumnId.get(col.id)
      if (q && !seenQuestionIds.has(q.id)) {
        seenQuestionIds.add(q.id)
        out.push({ kind: 'question', question: q })
      }
      // Continuation columns of a multi-select group don't get their
      // own row — they'll be summarised under the lead question's
      // option list.
    }
    return out
  }, [survey])

  const handleConfirm = () => {
    // Build the SurveyData to return. Apply type overrides; drop
    // anything marked `skip`.
    const newColumns: SurveyColumn[] = []
    for (const col of survey.columns) {
      let nextType: SurveyColumnType = col.type
      if (metadataTypes[col.id]) nextType = metadataTypes[col.id]
      // Look up the question this column belongs to (lead OR
      // continuation) to pick up its potentially-overridden type.
      const owningQ = survey.questions.find((q) =>
        q.columns.some((c) => c.columnId === col.id)
      )
      if (owningQ) {
        const t = questionTypes[owningQ.id]
        if (t) nextType = t
      }
      if (nextType === 'skip') continue
      newColumns.push({ ...col, type: nextType })
    }

    const newQuestions: SurveyQuestion[] = []
    const newMetadataColumnIds: string[] = []
    const keptColumnIds = new Set(newColumns.map((c) => c.id))
    for (const col of newColumns) {
      if (col.type === 'metadata') newMetadataColumnIds.push(col.id)
    }
    for (const q of survey.questions) {
      const overriddenType = questionTypes[q.id] ?? q.type
      if (overriddenType === 'skip') continue
      // Skip questions whose columns are all gone (shouldn't happen
      // unless the user picked `skip` and `metadata` both).
      const remainingCols = q.columns.filter((c) => keptColumnIds.has(c.columnId))
      if (remainingCols.length === 0) continue
      // Re-classifying a question to `metadata` re-tags its columns
      // above; keep it out of the questions list itself.
      if (overriddenType === 'metadata') continue
      newQuestions.push({
        ...q,
        type: overriddenType as SurveyQuestionType,
        columns: remainingCols
      })
    }

    // Filter respondents' answers to only kept questions.
    const keptQuestionIds = new Set(newQuestions.map((q) => q.id))
    const newRespondents: SurveyRespondent[] = survey.respondents.map((r) => {
      const newAnswers: Record<string, string | string[]> = {}
      for (const qid of Object.keys(r.answers)) {
        if (keptQuestionIds.has(qid)) newAnswers[qid] = r.answers[qid]
      }
      const newMetadata: Record<string, string> = {}
      for (const colId of newMetadataColumnIds) {
        if (r.metadata[colId] != null) newMetadata[colId] = r.metadata[colId]
      }
      return { ...r, metadata: newMetadata, answers: newAnswers }
    })

    onConfirm({
      ...survey,
      name: name.trim() || suggestedName,
      columns: newColumns,
      questions: newQuestions,
      metadataColumnIds: newMetadataColumnIds,
      respondents: newRespondents
    })
  }

  return (
    <div className="modal-overlay">
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onCancel() }}
        style={{ minWidth: 720, maxWidth: 900, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
      >
        <h2 style={{ margin: 0 }}>Import Survey</h2>
        <p style={{ marginTop: 4, marginBottom: 12, fontSize: 12, color: 'var(--text-muted)' }}>
          {survey.respondents.length} respondent{survey.respondents.length === 1 ? '' : 's'},{' '}
          {survey.questions.length} question{survey.questions.length === 1 ? '' : 's'},{' '}
          {survey.metadataColumnIds.length} metadata column{survey.metadataColumnIds.length === 1 ? '' : 's'}.
          Adjust the detected type for any column before importing.
        </p>

        <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 2 }}>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Survey name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ fontSize: 13, padding: '4px 8px' }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              Source format
              {detectionConfident && format === detectedFormat && (
                <span style={{ marginLeft: 4, color: 'var(--text-muted)' }}>· auto-detected</span>
              )}
              {!detectionConfident && (
                <span style={{ marginLeft: 4, color: 'var(--text-muted)' }}>· please confirm</span>
              )}
            </span>
            <select
              value={format}
              onChange={(e) => handleFormatChange(e.target.value as SurveyFormat)}
              style={{ fontSize: 13, padding: '4px 8px' }}
            >
              <option value="surveymonkey">{FORMAT_LABELS.surveymonkey}</option>
              <option value="microsoft-forms">{FORMAT_LABELS['microsoft-forms']}</option>
              <option value="generic">{FORMAT_LABELS.generic}</option>
            </select>
          </label>
        </div>
        {parseError && (
          <div style={{ marginBottom: 12, padding: '6px 10px', background: 'var(--danger-bg, #fee)', color: 'var(--danger, #b00)', fontSize: 12, borderRadius: 'var(--radius-sm)' }}>
            Could not re-parse with that format: {parseError}
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--bg-secondary)', position: 'sticky', top: 0, zIndex: 1 }}>
                <th style={thStyle}>Type</th>
                <th style={{ ...thStyle, width: '100%' }}>Column / Question</th>
                <th style={thStyle}>Sample data</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const id = row.kind === 'question' ? row.question.id : row.column.id
                const currentType: SurveyColumnType =
                  row.kind === 'question' ? questionTypes[id] : metadataTypes[id]
                const label =
                  row.kind === 'question'
                    ? stripHtml(row.question.text)
                    : row.column.cleanHeader || '(empty header)'
                const opts = typeOptionsForRow(row)
                const sample = sampleForRow(row, survey.respondents, survey.columns)
                const isSkipped = currentType === 'skip'
                return (
                  <tr
                    key={id}
                    style={{
                      borderTop: i === 0 ? 'none' : '1px solid var(--border-color)',
                      background: isSkipped ? 'var(--bg-tertiary)' : undefined,
                      opacity: isSkipped ? 0.55 : 1
                    }}
                  >
                    <td style={tdStyle}>
                      <select
                        value={currentType}
                        onChange={(e) => {
                          const t = e.target.value as SurveyColumnType
                          if (row.kind === 'question') {
                            setQuestionTypes((prev) => ({ ...prev, [id]: t }))
                          } else {
                            setMetadataTypes((prev) => ({ ...prev, [id]: t }))
                          }
                        }}
                        style={{ fontSize: 11, padding: '2px 4px' }}
                      >
                        {opts.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </td>
                    <td style={tdStyle}>
                      <div style={{ fontWeight: row.kind === 'question' ? 500 : 400 }}>
                        {label}
                      </div>
                      {row.kind === 'question' && row.question.type === 'multi-select' && (
                        <div style={{ marginTop: 2, fontSize: 11, color: 'var(--text-muted)' }}>
                          {row.question.columns.length} options:{' '}
                          {row.question.columns.map((c) => c.optionLabel).filter(Boolean).join(' · ').slice(0, 200)}
                        </div>
                      )}
                    </td>
                    <td style={{ ...tdStyle, color: 'var(--text-muted)', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {sample || '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="modal-actions" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          <button className="secondary" onClick={onCancel}>Cancel</button>
          <button onClick={handleConfirm}>Import {survey.respondents.length} Respondents</button>
        </div>
      </div>
    </div>
  )
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '6px 10px',
  borderBottom: '1px solid var(--border-color)',
  fontWeight: 600,
  fontSize: 11,
  color: 'var(--text-secondary)',
  whiteSpace: 'nowrap'
}

const tdStyle: React.CSSProperties = {
  padding: '6px 10px',
  verticalAlign: 'top'
}
