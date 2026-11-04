import { useState } from 'react'

interface Props {
  /** The current name to render after the colon. */
  name: string
  /** Called with the trimmed new name when the user commits the edit
   *  (Enter or blur). Not called when the user hits Escape, when the
   *  trimmed value is empty, or when it equals the existing name. */
  onRename: (newName: string) => void
  /** Start in edit mode — e.g. a freshly-opened, unnamed report whose
   *  title should be focused and ready to type. */
  autoEdit?: boolean
  /** Shown when the name is empty (as placeholder text in the input and
   *  as muted display text in the span). */
  placeholder?: string
}

/**
 * Small ": <name>" suffix rendered after the static title in each tool's
 * header. Click to inline-edit; Enter / blur to commit, Escape to
 * discard. Used by every analysis tool, the Query Builder, and the
 * Relationships tool so the saved-thing's name reads as part of the
 * header without crowding it.
 */
export function EditableTitleSuffix({ name, onRename, autoEdit, placeholder }: Props) {
  const [editing, setEditing] = useState(!!autoEdit)
  const [draft, setDraft] = useState(autoEdit ? name : '')

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation()
    setDraft(name)
    setEditing(true)
  }

  const commit = () => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== name) onRename(trimmed)
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') setEditing(false)
          e.stopPropagation()
        }}
        onClick={(e) => e.stopPropagation()}
        onFocus={(e) => e.currentTarget.select()}
        style={{
          fontSize: 'inherit',
          fontWeight: 300,
          color: 'var(--text-secondary)',
          // Match the panel surface — same convention every other
          // text field inside the tools uses (.analysis-section
          // sets --bg-input to --bg-panel for the same reason).
          // The default --bg-input resolves to --bg-tertiary, the
          // window's canvas tone, which reads as out of place against
          // the tool's white surface.
          background: 'var(--bg-panel)',
          border: '1px solid var(--accent)',
          borderRadius: 'var(--radius-sm)',
          padding: '0 6px',
          minWidth: 80,
          fontFamily: 'inherit'
        }}
      />
    )
  }

  return (
    <span
      onClick={startEdit}
      title="Click to rename"
      style={{
        fontSize: 'inherit',
        fontWeight: 300,
        color: 'var(--text-secondary)',
        cursor: 'pointer'
      }}
    >
      {name || placeholder || ''}
    </span>
  )
}
