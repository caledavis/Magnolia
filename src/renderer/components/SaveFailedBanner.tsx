import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Shown while saving the project is failing — an autosave, an import's
 * save, or Save — so nobody works on for hours believing their changes
 * are safe. It stays until a save succeeds (Magnolia keeps retrying), and
 * offers to try again now or to save the project somewhere else.
 */
export function SaveFailedBanner({
  error,
  onRetry,
  onSaveAs
}: {
  error: string | null
  onRetry: () => Promise<unknown>
  onSaveAs: () => Promise<unknown>
}): ReactElement | null {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  if (!error) return null

  const run = (action: () => Promise<unknown>) => async () => {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }
  const button = {
    flexShrink: 0,
    border: '1px solid var(--border-color)',
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    borderRadius: 6,
    padding: '3px 10px',
    cursor: busy ? 'default' : 'pointer'
  } as const

  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        top: 0,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9001,
        marginTop: 8,
        maxWidth: 560,
        width: 'calc(100vw - 32px)',
        background: 'var(--bg-panel)',
        border: '1px solid var(--danger)',
        borderInlineStartWidth: 4,
        borderRadius: 8,
        boxShadow: '0 6px 24px rgba(0,0,0,0.18)',
        padding: '12px 14px',
        fontSize: 13,
        color: 'var(--text-primary)'
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--danger)' }}>{t('saveFailed.title')}</div>
      <div style={{ marginBottom: 4 }}>{error}</div>
      <div style={{ marginBottom: 10, color: 'var(--text-muted)' }}>{t('saveFailed.retrying')}</div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" style={button} disabled={busy} onClick={run(onSaveAs)}>
          {t('saveFailed.saveAs')}
        </button>
        <button type="button" style={button} disabled={busy} onClick={run(onRetry)}>
          {busy ? t('saveFailed.saving') : t('saveFailed.tryAgain')}
        </button>
      </div>
    </div>
  )
}
