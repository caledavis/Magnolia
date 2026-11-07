import { useState, type ReactElement } from 'react'
import { useDocumentStore } from '../stores/document-store'
import type { MissingBinary } from '../models/types'
import { useTranslation } from 'react-i18next'

/**
 * Surfaced after opening a project that declares PDF/image/audio/video
 * documents whose bytes aren't in the .qdpx (e.g. projects saved by an
 * older Magnolia that dropped the binary). Each entry offers a one-click
 * re-import that re-attaches the original file to the EXISTING document —
 * preserving its guid, codes, and selections — after which the next save
 * embeds the recovered bytes durably in the .qdpx.
 */
export function MissingBinariesBanner({
  missing,
  onResolved,
  onDismiss
}: {
  missing: MissingBinary[]
  onResolved: (guid: string) => void
  onDismiss: () => void
}): ReactElement | null {
  const { t } = useTranslation()
  const reattach = useDocumentStore((s) => s.reattachSourceBinary)
  const [busyGuid, setBusyGuid] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  if (missing.length === 0) return null

  const handleReimport = async (m: MissingBinary): Promise<void> => {
    setBusyGuid(m.guid)
    setErrors((e) => {
      const { [m.guid]: _removed, ...rest } = e
      void _removed
      return rest
    })
    try {
      const res = await window.api.reimportDocument(m.sourceType)
      if (!res) return // cancelled
      if ('error' in res) {
        setErrors((e) => ({ ...e, [m.guid]: res.error }))
        return
      }
      reattach(m.guid, res.formatting, res.content)
      onResolved(m.guid)
    } catch (err: any) {
      setErrors((e) => ({ ...e, [m.guid]: err?.message || String(err) }))
    } finally {
      setBusyGuid(null)
    }
  }


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
        background: '#fff7ed',
        border: '1px solid #fdba74',
        borderRadius: 8,
        boxShadow: '0 6px 24px rgba(0,0,0,0.18)',
        padding: '12px 14px',
        fontSize: 13,
        color: '#7c2d12'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span aria-hidden style={{ fontSize: 16, lineHeight: '18px' }}>
          ⚠
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            {t('missing.title', { count: missing.length })}
          </div>
          <div style={{ marginBottom: 8, color: '#9a3412' }}>
            {t('missing.text', { count: missing.length })}
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {missing.map((m) => (
              <li key={m.guid} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.name}
                </span>
                <button
                  type="button"
                  disabled={busyGuid === m.guid}
                  onClick={() => handleReimport(m)}
                  style={{
                    flexShrink: 0,
                    border: '1px solid #ea580c',
                    background: busyGuid === m.guid ? '#fed7aa' : '#fb923c',
                    color: '#fff',
                    borderRadius: 6,
                    padding: '3px 10px',
                    cursor: busyGuid === m.guid ? 'default' : 'pointer'
                  }}
                >
                  {busyGuid === m.guid ? t('missing.reimporting') : t('missing.reimport')}
                </button>
              </li>
            ))}
          </ul>
          {Object.keys(errors).length > 0 && (
            <div style={{ marginTop: 8, color: '#b91c1c' }}>
              {Object.entries(errors).map(([guid, msg]) => (
                <div key={guid}>{msg}</div>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          title={t('common.dismiss')}
          style={{
            flexShrink: 0,
            border: 'none',
            background: 'transparent',
            color: '#7c2d12',
            cursor: 'pointer',
            fontSize: 16,
            lineHeight: '16px',
            padding: 2
          }}
        >
          ×
        </button>
      </div>
    </div>
  )
}
