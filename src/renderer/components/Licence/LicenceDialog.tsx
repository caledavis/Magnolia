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
const BUNDLED_LIBRARIES: { name: string; role: string; licence: string }[] = [
  { name: 'Tauri', role: 'desktop runtime', licence: 'Apache-2.0 / MIT' },
  { name: 'React', role: 'UI framework', licence: 'MIT' },
  { name: 'TipTap', role: 'rich-text editor for memos', licence: 'MIT' },
  { name: 'PDF.js', role: 'PDF rendering', licence: 'Apache-2.0' },
  { name: 'zip', role: 'QDPX project archive read/write', licence: 'MIT' },
  { name: 'roxmltree', role: 'QDPX XML parsing', licence: 'MIT / Apache-2.0' },
  { name: 'lopdf', role: 'PDF page geometry and export chrome', licence: 'MIT' },
  { name: 'calamine', role: '.xlsx survey import', licence: 'MIT' },
  { name: 'zune-heic', role: 'HEIC / HEIF image decoding', licence: 'MIT / Apache-2.0 / Zlib' },
  { name: 'image', role: 'TIFF image decoding', licence: 'MIT / Apache-2.0' },
  { name: 'Lofty', role: 'audio metadata', licence: 'MIT / Apache-2.0' },
  { name: 'resvg', role: 'SVG rendering for PDF exports', licence: 'Apache-2.0 / MIT' },
  { name: 'marked', role: 'Markdown rendering', licence: 'MIT' },
  { name: 'react-resizable-panels', role: 'split-pane layout', licence: 'MIT' },
  { name: 'Zustand', role: 'state management', licence: 'MIT' },
  { name: 'Lucide', role: 'icon set', licence: 'ISC' }
]

export function LicenceDialog({ open, onClose }: Props) {
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
        <h2 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 600 }}>Licence & Attributions</h2>

        <div style={{ overflowY: 'auto', flex: 1, paddingRight: 4 }}>
          <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-base)', lineHeight: 1.5 }}>
            <strong>Magnolia is free and open-source software.</strong>
          </p>
          <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            Released under the{' '}
            <strong style={{ color: 'var(--text-primary)' }}>European Union Public Licence (EUPL) v1.2</strong>.
            You are free to use, study, copy, modify, and redistribute Magnolia, including for commercial
            purposes. Derivative works must be distributed under the EUPL or one of its compatible licences,
            and their source code must be made available.
          </p>

          <button
            className="secondary"
            onClick={() => window.api.openLicence()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 4 }}
          >
            View full licence text <Icon icon={faUpRightFromSquare} style={{ fontSize: 10 }} />
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
            Bundled Libraries
          </h3>
          <p style={{ margin: '0 0 10px', fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            Magnolia is built on top of these open-source projects. Full attribution and licence text
            for every dependency is bundled with the app.
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
                  <span style={{ color: 'var(--text-muted)' }}> — {lib.role}</span>
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
            View full attributions <Icon icon={faUpRightFromSquare} style={{ fontSize: 10 }} />
          </button>
        </div>

        <div className="modal-actions" style={{ marginTop: 12 }}>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
