import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { NotKeptKind } from '../models/types'

/** In the order they're listed. */
const KINDS: NotKeptKind[] = [
  'documentCodings',
  'memoCodings',
  'memoAttachments',
  'descriptions',
  'attachedTexts',
  'links',
  'caseLinks',
  'setMemos',
  'extraTranscripts'
]

/**
 * Shown after opening a project (usually from another program) that holds
 * things Magnolia can't keep — what magnolia-core's `not_kept` counted.
 * Opening it changes nothing, but the first save over the original file
 * leaves them out, so it offers Save As before any work is done.
 */
export function NotKeptBanner({
  counts,
  onSaveAs,
  onDismiss
}: {
  counts: Partial<Record<NotKeptKind, number>> | null
  onSaveAs: () => Promise<unknown>
  onDismiss: () => void
}): ReactElement | null {
  const { t } = useTranslation()
  const kinds = KINDS.filter((k) => (counts?.[k] ?? 0) > 0)
  if (kinds.length === 0) return null

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
        zIndex: 9000,
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
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('notKept.title')}</div>
      <div style={{ marginBottom: 6 }}>{t('notKept.intro')}</div>
      <ul style={{ margin: '0 0 8px', paddingInlineStart: 20 }}>
        {kinds.map((k) => (
          <li key={k}>{t(`notKept.${k}`, { count: counts![k] })}</li>
        ))}
      </ul>
      <div style={{ marginBottom: 10, color: 'var(--text-muted)' }}>{t('notKept.advice')}</div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          type="button"
          style={button}
          onClick={() => {
            void onSaveAs()
          }}
        >
          {t('saveFailed.saveAs')}
        </button>
        <button type="button" style={button} onClick={onDismiss}>
          {t('common.ok')}
        </button>
      </div>
    </div>
  )
}
