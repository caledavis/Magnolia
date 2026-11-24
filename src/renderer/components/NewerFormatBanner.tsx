import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '../stores/project-store'

/**
 * Shown when the open project was saved by a newer Magnolia, in a format
 * this one may not fully understand: it's open read-only, so saving can't
 * lose what the newer version added (the writer refuses too — see
 * magnolia-core's qdpx/format.rs). It comes back whenever an edit is
 * refused, so nobody works on believing their changes are kept.
 */
export function NewerFormatBanner(): ReactElement | null {
  const { t } = useTranslation()
  const savedBy = useProjectStore((s) => s.newerFormat)
  const shown = useProjectStore((s) => s.newerFormatNotice)
  const dismiss = useProjectStore((s) => s.dismissNewerFormatNotice)
  if (!savedBy || !shown) return null

  const button = {
    flexShrink: 0,
    border: '1px solid var(--border-color)',
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    borderRadius: 6,
    padding: '3px 10px',
    cursor: 'pointer'
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
        border: '1px solid var(--accent)',
        borderInlineStartWidth: 4,
        borderRadius: 8,
        boxShadow: '0 6px 24px rgba(0,0,0,0.18)',
        padding: '12px 14px',
        fontSize: 13,
        color: 'var(--text-primary)'
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('newerFormat.title')}</div>
      <div style={{ marginBottom: 10 }}>{t('newerFormat.text', { savedBy })}</div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" style={button} onClick={() => window.api.checkForUpdates()}>
          {t('prefs.checkForUpdates')}
        </button>
        <button type="button" style={button} onClick={dismiss}>
          {t('common.ok')}
        </button>
      </div>
    </div>
  )
}
