/**
 * NoteHeader — the Document Viewer header for a note: its title and the
 * date/time of the observation, both editable in place. The note's name
 * ("YYMMDD HH:MM - Title") follows from these.
 */
import { useDocumentStore } from '../../stores/document-store'
import { useProjectStore, useCheckoutLockedBy, checkoutLockedTitle } from '../../stores/project-store'
import { noteData, toDateTimeLocal, fromDateTimeLocal } from '../../utils/notes'
import type { TextSource } from '../../models/types'

export function NoteHeader({ source }: { source: TextSource }) {
  const lockedBy = useCheckoutLockedBy()
  const updateNote = useDocumentStore((s) => s.updateNote)
  const { title, noteDateTime } = noteData(source)
  const lockProps = lockedBy
    ? {
        readOnly: true,
        title: checkoutLockedTitle(lockedBy),
        onMouseDown: (e: React.MouseEvent) => {
          e.preventDefault()
          useProjectStore.getState().promptCheckoutConflict()
        }
      }
    : {}

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
      <input
        type="text"
        className="note-title-input"
        value={title}
        placeholder="Untitled note"
        aria-label="Note title"
        onChange={(e) => updateNote(source.guid, { title: e.target.value })}
        onKeyDown={(e) => {
          // Enter moves on to writing the note.
          if (e.key === 'Enter') {
            e.preventDefault()
            ;(document.querySelector('[data-note-editor]') as HTMLElement | null)?.focus()
          }
        }}
        {...lockProps}
      />
      <input
        type="datetime-local"
        className="note-datetime-input"
        value={toDateTimeLocal(noteDateTime)}
        aria-label="Date and time of the observation"
        title={lockedBy ? checkoutLockedTitle(lockedBy) : 'Date and time of the observation'}
        onChange={(e) => {
          const iso = fromDateTimeLocal(e.target.value)
          if (iso) updateNote(source.guid, { noteDateTime: iso })
        }}
        {...(lockedBy ? { readOnly: true, onMouseDown: lockProps.onMouseDown } : {})}
      />
    </div>
  )
}
