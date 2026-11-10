/**
 * Pieces of the document bar (the one bar above a document, with its
 * name), including the Export menu every document has.
 *
 * Viewers that own document-level controls (PDF and image zoom, the
 * transcript editor's Coding Mode toggle, Import and Export) render them
 * into the bar's slots through a portal, so every document control sits
 * in one place while its state stays in the viewer.
 */
import { createContext, useContext, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { TextSource } from '../../models/types'
import { exportDocumentPdf } from '../../utils/coded-pdf/export-coded-pdf'

export interface DocumentToolbarSlots {
  /** After the document's name. */
  start: HTMLElement | null
  /** After `start`, before Export, Split and the memo button. */
  end: HTMLElement | null
}

export const DocumentToolbarContext = createContext<DocumentToolbarSlots>({ start: null, end: null })

/** Render `children` into a toolbar slot (nothing when there's no toolbar). */
export function DocumentToolbarPortal({ slot, children }: { slot: keyof DocumentToolbarSlots; children: React.ReactNode }) {
  const el = useContext(DocumentToolbarContext)[slot]
  return el ? createPortal(children, el) : null
}

/** Small button style shared by the bar's text buttons. */
export const toolbarButtonStyle: React.CSSProperties = {
  height: 26,
  padding: '0 10px',
  fontSize: 11,
  fontWeight: 600,
  border: '1px solid var(--border-color)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-primary)',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  flexShrink: 0,
  whiteSpace: 'nowrap'
}

/** Runs the document's PDF export, with or without its codes, tracking
 *  whether one is in progress. */
export function useDocumentPdfExport(source: TextSource | undefined, content: string) {
  const [busy, setBusy] = useState(false)
  const run = async (withCodes: boolean) => {
    if (!source || busy) return
    setBusy(true)
    try {
      await exportDocumentPdf(source, content, withCodes)
    } finally {
      setBusy(false)
    }
  }
  return { busy, run }
}

export interface ExportMenuItem {
  label: string
  title?: string
  run: () => void
  /** Marks the item for the layout checks. */
  withCodes?: boolean
}

/** "Export", opening a menu of the ways to export the document. */
export function ExportMenuButton({ items, busy, style, className }: {
  items: ExportMenuItem[]
  busy: boolean
  style?: React.CSSProperties
  className?: string
}) {
  const { t } = useTranslation()
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  return (
    <>
      <button
        className={className}
        style={{ ...(className ? {} : toolbarButtonStyle), ...style, opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer' }}
        disabled={busy}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setAt(at ? null : { x: r.right, y: r.bottom })
        }}
        data-export-menu=""
      >
        {busy ? t('viewer.exportingPdf') : t('common.export')}
      </button>
      {at && createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 99 }} onClick={() => setAt(null)} />
          <div className="context-menu" style={{ position: 'fixed', left: at.x, top: at.y, transform: 'translateX(-100%)', zIndex: 100, minWidth: 140 }}>
            {items.map((item) => (
              <div
                key={item.label}
                className="context-menu-item"
                title={item.title}
                {...(item.withCodes ? { 'data-export-coded-pdf': '' } : {})}
                onClick={() => {
                  setAt(null)
                  item.run()
                }}
              >
                {item.label}
              </div>
            ))}
          </div>
        </>,
        document.body
      )}
    </>
  )
}

/**
 * The two PDF exports every document has: with its codes, and without.
 * A viewer with its own layout for the export without codes passes it as
 * `plain`.
 */
export function usePdfExportItems(
  source: TextSource | undefined,
  content: string,
  options: { plain?: () => void; withCodesTitle?: string; plainTitle?: string } = {}
) {
  const { t } = useTranslation()
  const pdf = useDocumentPdfExport(source, content)
  const items: ExportMenuItem[] = [
    { label: t('viewer.exportPdfWithCodes'), title: options.withCodesTitle ?? t('viewer.exportCodedPdfTitle'), run: () => void pdf.run(true), withCodes: true },
    { label: t('viewer.exportPdfPlain'), title: options.plainTitle, run: options.plain ?? (() => void pdf.run(false)) }
  ]
  return { items, busy: pdf.busy }
}

/** The Export menu of a document with nothing else to export. */
export function DocumentExportButton({ source, content, style }: { source: TextSource; content: string; style?: React.CSSProperties }) {
  const { items, busy } = usePdfExportItems(source, content)
  return <ExportMenuButton items={items} busy={busy} style={style} />
}
