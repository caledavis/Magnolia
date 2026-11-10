/**
 * A notebook's overview page, opened from the notebook in the Documents
 * panel (as a survey opens on its summary): the notebook's notes, newest
 * first, with when each was written, the start of its text, its length
 * and how much of it is coded, a New note button, and an Export menu for the whole notebook,
 * with or without codes.
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDocumentStore } from '../../stores/document-store'
import { formatDateTime, formatNumber } from '../../i18n'
import { isNote, noteData, notePreview, sortNotes } from '../../utils/notes'
import { wordTokens } from '../../utils/words'
import { exportNotebookPdf } from '../../utils/coded-pdf/export-coded-pdf'
import { ExportMenuButton, type ExportMenuItem } from './DocumentToolbar'
import { Icon, faPlus } from '../Icon'
import { useProjectStore, useCheckoutLockedBy } from '../../stores/project-store'

export function NotebookOverview({ folderGuid }: { folderGuid: string }) {
  const { t } = useTranslation()
  const folder = useDocumentStore((s) => s.folders.find((f) => f.guid === folderGuid))
  const sources = useDocumentStore((s) => s.sources)
  const sourceFolder = useDocumentStore((s) => s.sourceFolder)
  const contents = useDocumentStore((s) => s.sourceContents)
  const viewDocument = useDocumentStore((s) => s.viewDocument)
  const [busy, setBusy] = useState(false)
  const lockedBy = useCheckoutLockedBy()

  const notes = useMemo(
    () => sortNotes(sources.filter((s) => isNote(s) && sourceFolder[s.guid] === folderGuid)),
    [sources, sourceFolder, folderGuid]
  )
  const rows = useMemo(() => notes.map((note) => {
    const data = noteData(note)
    return {
      note,
      title: data.title.trim(),
      when: new Date(data.noteDateTime),
      words: wordTokens(contents[note.guid] ?? '').length,
      preview: notePreview(contents[note.guid] ?? ''),
      coded: note.selections.filter((s) => s.codings.length > 0).length
    }
  }), [notes, contents])

  if (!folder) return null

  // The newest note comes first, so the range runs from the last row;
  // notes all from one day show that day once.
  const dated = rows.filter((r) => !isNaN(r.when.getTime()))
  const first = dated.length ? formatDateTime(dated[dated.length - 1].when, { dateStyle: 'medium' }) : ''
  const last = dated.length ? formatDateTime(dated[0].when, { dateStyle: 'medium' }) : ''
  const range = first === last ? first : t('notebook.dateRange', { from: first, to: last })

  // As the + beside the notebook in the Documents panel does.
  const newNote = () => {
    if (lockedBy) { useProjectStore.getState().promptCheckoutConflict(); return }
    const store = useDocumentStore.getState()
    const guid = store.addNote(folderGuid)
    store.selectDocuments(new Set([guid]))
    store.viewDocument(guid)
  }

  const exportPdf = async (withCodes: boolean) => {
    if (busy) return
    setBusy(true)
    try {
      await exportNotebookPdf(folder.name, notes, useDocumentStore.getState().sourceContents, withCodes)
    } finally {
      setBusy(false)
    }
  }
  const items: ExportMenuItem[] = [
    { label: t('viewer.exportPdfWithCodes'), title: t('notebook.exportCodedTitle'), run: () => void exportPdf(true), withCodes: true },
    { label: t('viewer.exportPdfPlain'), title: t('notebook.exportPlainTitle'), run: () => void exportPdf(false) }
  ]

  return (
    <div className="panel-content" style={{ overflow: 'auto' }}>
      <div style={{ padding: 24 }}>
        <style>{`
          .notebook-row { cursor: pointer; transition: background 0.08s; }
          .notebook-row:hover { background: var(--bg-tertiary); }
        `}</style>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{ margin: 0, fontSize: 18, color: 'var(--text-secondary)', userSelect: 'none' }}>{folder.name}</h1>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, userSelect: 'none' }}>
              {t('notebook.noteCount', { count: notes.length })}
              {range && <> · {range}</>}
            </div>
          </div>
          <button
            className="secondary"
            style={{ fontSize: 11, padding: '3px 10px', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 5 }}
            onClick={newNote}
            data-new-note=""
          >
            <Icon icon={faPlus} style={{ fontSize: 10 }} />
            {t('documents.newNote')}
          </button>
          {notes.length > 0 && (
            <ExportMenuButton
              className="secondary"
              style={{ fontSize: 11, padding: '3px 10px', flexShrink: 0 }}
              items={items}
              busy={busy}
            />
          )}
        </div>

        {notes.length === 0 ? (
          <p style={{ marginTop: 28, color: 'var(--text-muted)', fontSize: 13 }}>{t('notebook.empty')}</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 28 }}>
            <thead>
              <tr>
                <th style={thStyle}>{t('notebook.colDate')}</th>
                <th style={{ ...thStyle, width: '100%' }}>{t('notebook.colTitle')}</th>
                <th style={{ ...thStyle, textAlign: 'end' }}>{t('notebook.colWords')}</th>
                <th style={{ ...thStyle, textAlign: 'end' }}>{t('notebook.colCoded')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.note.guid}
                  className="notebook-row"
                  onClick={() => viewDocument(r.note.guid)}
                  title={t('notebook.openNote')}
                >
                  <td style={{ ...tdStyle, whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                    {isNaN(r.when.getTime()) ? '' : formatDateTime(r.when, { dateStyle: 'medium', timeStyle: 'short' })}
                  </td>
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 600 }}>
                      {r.title || <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>{t('notes.untitled')}</span>}
                    </div>
                    {/* The start of the note, at most two lines. */}
                    {r.preview && (
                      <div
                        style={{
                          marginTop: 2,
                          fontSize: 11.5,
                          lineHeight: 1.45,
                          color: 'var(--text-muted)',
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                          unicodeBidi: 'plaintext'
                        }}
                      >
                        {r.preview}
                      </div>
                    )}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'end', fontVariantNumeric: 'tabular-nums' }}>{formatNumber(r.words)}</td>
                  <td style={{ ...tdStyle, textAlign: 'end', fontVariantNumeric: 'tabular-nums' }}>{formatNumber(r.coded)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

const thStyle: React.CSSProperties = {
  textAlign: 'start',
  padding: '6px 10px',
  borderBottom: '1px solid var(--border-color)',
  fontWeight: 600,
  fontSize: 11,
  color: 'var(--text-muted)',
  whiteSpace: 'nowrap',
  userSelect: 'none'
}

const tdStyle: React.CSSProperties = {
  padding: '7px 10px',
  borderBottom: '1px solid var(--border-color)',
  verticalAlign: 'top',
  color: 'var(--text-primary)'
}
