import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertDialog } from './AlertDialog'

/**
 * Shown when saving the project fails — an autosave, an import's save, or
 * Save — so nobody works on for hours believing their changes are safe.
 * Magnolia keeps retrying; the pill ("Not saved") stays until a save
 * succeeds, and reopens this, which offers to try again now or to save
 * the project somewhere else.
 */
export function SaveFailedAlert({
  error,
  open,
  onRetry,
  onSaveAs,
  onClose
}: {
  error: string | null
  open: boolean
  onRetry: () => Promise<unknown>
  onSaveAs: () => Promise<unknown>
  onClose: () => void
}): ReactElement | null {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  if (!error || !open) return null

  const run = (action: () => Promise<unknown>) => async () => {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog
      title={t('saveFailed.title')}
      onClose={onClose}
      actions={
        <>
          <button className="secondary" disabled={busy} onClick={onClose}>{t('common.close')}</button>
          <button className="secondary" disabled={busy} onClick={run(onSaveAs)}>{t('saveFailed.saveAs')}</button>
          <button className="secondary" disabled={busy} onClick={run(onRetry)}>
            {busy ? t('saveFailed.saving') : t('saveFailed.tryAgain')}
          </button>
        </>
      }
    >
      <p style={{ margin: '0 0 6px' }}>{error}</p>
      <p style={{ margin: 0 }}>{t('saveFailed.retrying')}</p>
    </AlertDialog>
  )
}
