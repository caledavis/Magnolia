import { Trans, useTranslation } from 'react-i18next'
import { Icon, faUpRightFromSquare } from '../Icon'

interface Props {
  open: boolean
  onClose: () => void
}

/** User-facing list of the main bundled libraries. Kept here (not
 *  generated from package.json) because the dialog is a curated
 *  summary, not a full attributions dump — that's what the
 *  THIRD-PARTY-LICENSES.txt button is for. Order is intentional:
 *  the bigger / more recognisable projects come first. */
/** `role` is the key of its description, licence.role.<role>. */
const BUNDLED_LIBRARIES: { name: string; role: string; licence: string }[] = [
  { name: 'Tauri', role: 'tauri', licence: 'Apache-2.0 / MIT' },
  { name: 'React', role: 'react', licence: 'MIT' },
  { name: 'TipTap', role: 'tiptap', licence: 'MIT' },
  { name: 'PDF.js', role: 'pdfjs', licence: 'Apache-2.0' },
  { name: 'zip', role: 'zip', licence: 'MIT' },
  { name: 'roxmltree', role: 'roxmltree', licence: 'MIT / Apache-2.0' },
  { name: 'lopdf', role: 'lopdf', licence: 'MIT' },
  { name: 'calamine', role: 'calamine', licence: 'MIT' },
  { name: 'zune-heic', role: 'zuneHeic', licence: 'MIT / Apache-2.0 / Zlib' },
  { name: 'image', role: 'image', licence: 'MIT / Apache-2.0' },
  { name: 'Lofty', role: 'lofty', licence: 'MIT / Apache-2.0' },
  { name: 'resvg', role: 'resvg', licence: 'Apache-2.0 / MIT' },
  { name: 'marked', role: 'marked', licence: 'MIT' },
  { name: 'react-resizable-panels', role: 'panels', licence: 'MIT' },
  { name: 'Zustand', role: 'zustand', licence: 'MIT' },
  { name: 'd3-force', role: 'd3force', licence: 'ISC' },
  { name: 'Lucide', role: 'lucide', licence: 'ISC' }
]

export function LicenceDialog({ open, onClose }: Props) {
  const { t } = useTranslation()
  if (!open) return null

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 560, maxWidth: '92vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
      >
        <h2 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 600 }}>{t('toolbar.licenceAttributions')}</h2>

        <div style={{ overflowY: 'auto', flex: 1, paddingRight: 4 }}>
          <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-base)', lineHeight: 1.5 }}>
            <strong>{t('licence.free')}</strong>
          </p>
          <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            <Trans i18nKey="licence.released" components={{ b: <strong style={{ color: 'var(--text-primary)' }} /> }} />
          </p>

          <button
            className="secondary"
            onClick={() => window.api.openLicence()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 4 }}
          >
            {t('licence.viewFull')} <Icon icon={faUpRightFromSquare} style={{ fontSize: 10 }} />
          </button>

          <h3
            style={{
              margin: '20px 0 4px',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.6px',
              textTransform: 'uppercase',
              color: 'var(--text-muted)'
            }}
          >
            {t('licence.bundled')}
          </h3>
          <p style={{ margin: '0 0 10px', fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {t('licence.bundledText')}
          </p>

          <div
            style={{
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-md)',
              overflow: 'hidden'
            }}
          >
            {BUNDLED_LIBRARIES.map((lib, i) => (
              <div
                key={lib.name}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto',
                  alignItems: 'baseline',
                  gap: 12,
                  padding: '8px 12px',
                  fontSize: 'var(--font-size-sm)',
                  borderTop: i === 0 ? 'none' : '1px solid var(--border-color)'
                }}
              >
                <span>
                  <strong>{lib.name}</strong>
                  <span style={{ color: 'var(--text-muted)' }}> — {t(`licence.role.${lib.role}`)}</span>
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--text-secondary)',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {lib.licence}
                </span>
              </div>
            ))}
          </div>

          <button
            className="secondary"
            onClick={() => window.api.openAcknowledgements()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 12 }}
          >
            {t('licence.viewAttributions')} <Icon icon={faUpRightFromSquare} style={{ fontSize: 10 }} />
          </button>
        </div>

        <div className="modal-actions" style={{ marginTop: 12 }}>
          <button onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  )
}
