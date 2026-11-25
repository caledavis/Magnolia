/**
 * Help → Diagnostic Information: what a bug report needs (utils/
 * diagnostics.ts), shown so the user sees exactly what they'd share, with
 * a button to copy it. Copying from the button, rather than straight from
 * the menu, is a click in the page, which the web view requires.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { buildDiagnostics } from '../utils/diagnostics'

interface Props {
  open: boolean
  onClose: () => void
}

export function DiagnosticsDialog({ open, onClose }: Props) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null)
  const copyRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()

  useEffect(() => {
    if (!open) return
    setText('')
    setCopied(null)
    let cancelled = false
    void buildDiagnostics().then((s) => { if (!cancelled) setText(s) })
    return () => { cancelled = true }
  }, [open])

  useEffect(() => {
    if (open && text) copyRef.current?.focus()
  }, [open, text])

  if (!open) return null

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied('yes')
    } catch {
      setCopied('failed')
    }
  }

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        style={{ width: 600, maxWidth: '92vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
      >
        <h2 id={titleId} style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>{t('diagnostics.title')}</h2>
        <p style={{ margin: '0 0 10px', fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {t('diagnostics.explain')}
        </p>
        <textarea
          readOnly
          aria-label={t('diagnostics.title')}
          value={text || t('diagnostics.gathering')}
          style={{
            flex: 1, minHeight: 220, resize: 'none', fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.5,
            padding: 8, border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)',
            background: 'var(--bg-primary)', color: 'var(--text-primary)', direction: 'ltr'
          }}
        />
        <div className="modal-actions" style={{ marginTop: 12, alignItems: 'center' }}>
          <span aria-live="polite" style={{ flex: 1, fontSize: 'var(--font-size-sm)', color: copied === 'failed' ? 'var(--danger)' : 'var(--text-secondary)' }}>
            {copied === 'yes' ? t('diagnostics.copied') : copied === 'failed' ? t('diagnostics.copyFailed') : ''}
          </span>
          <button className="secondary" onClick={onClose}>{t('common.close')}</button>
          <button ref={copyRef} disabled={!text} onClick={() => void copy()}>{t('diagnostics.copy')}</button>
        </div>
      </div>
    </div>
  )
}
