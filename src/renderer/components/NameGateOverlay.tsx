import { useState } from 'react'

/**
 * One-time, mandatory "enter your name" gate shown the very first time the
 * app is used with no name set in Preferences. Blocks all interaction
 * (no dismiss) until a name is entered — every save now stamps this name
 * into the project (see writer.ts's magnolia-editor.json), and features
 * like merge need it to attribute changes to a person. Reuses the same
 * full-viewport overlay convention as the project-load progress overlay
 * in App.tsx, at a higher z-index so it always takes priority.
 */
export function NameGateOverlay({ onSubmit }: { onSubmit: (name: string) => void }): JSX.Element {
  const [draft, setDraft] = useState('')
  const trimmed = draft.trim()

  const submit = (): void => {
    if (trimmed) onSubmit(trimmed)
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 30000,
        backdropFilter: 'blur(2px)'
      }}
    >
      <div
        style={{
          background: 'var(--bg-primary)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-md, 8px)',
          padding: '24px 28px',
          width: 360,
          boxShadow: '0 10px 40px rgba(0,0,0,0.3)'
        }}
      >
        <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>Welcome to Magnolia</h2>
        <p style={{ margin: '0 0 16px', color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)', lineHeight: 1.5 }}>
          Before you get started, what's your name? It's shown to teammates when you check out or make changes to a shared project.
        </p>
        <input
          type="text"
          autoFocus
          value={draft}
          placeholder="Your name"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          style={{
            width: '100%',
            padding: '6px 10px',
            fontSize: 13,
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--bg-input)',
            color: 'var(--text-primary)',
            marginBottom: 16,
            boxSizing: 'border-box'
          }}
        />
        <div className="modal-actions">
          <button onClick={submit} disabled={!trimmed}>Continue</button>
        </div>
      </div>
    </div>
  )
}
