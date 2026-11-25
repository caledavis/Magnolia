import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '../stores/project-store'
import { AlertDialog } from './AlertDialog'

/**
 * Shown when the open project was saved by a newer Magnolia, in a format
 * this one may not fully understand: it's open read-only, so saving can't
 * lose what the newer version added (the writer refuses too — see
 * magnolia-core's qdpx/format.rs). Its pill ("Read-only") stays while it's
 * open, and an edit that's refused brings this back (at most once a
 * minute: see markDirty).
 */
export function NewerFormatAlert(): ReactElement | null {
  const { t } = useTranslation()
  const savedBy = useProjectStore((s) => s.newerFormat)
  const shown = useProjectStore((s) => s.newerFormatNotice)
  const dismiss = useProjectStore((s) => s.dismissNewerFormatNotice)
  if (!savedBy || !shown) return null
  return (
    <AlertDialog
      title={t('newerFormat.title')}
      onClose={dismiss}
      actions={
        <>
          <button className="secondary" onClick={() => window.api.checkForUpdates()}>{t('prefs.checkForUpdates')}</button>
          <button className="secondary" onClick={dismiss}>{t('common.ok')}</button>
        </>
      }
    >
      <p style={{ margin: 0 }}>{t('newerFormat.text', { savedBy })}</p>
    </AlertDialog>
  )
}
