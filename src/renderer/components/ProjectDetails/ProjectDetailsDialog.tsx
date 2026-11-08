import { formatNumber } from '../../i18n'
import { useEffect, useState } from 'react'
import { useProjectStore } from '../../stores/project-store'
import { useDocumentStore } from '../../stores/document-store'
import { useCodeStore } from '../../stores/code-store'
import { MarkdownEditor } from '../MarkdownEditor'
import { useTranslation } from 'react-i18next'

interface Props {
  open: boolean
  onClose: () => void
}

function formatBytes(n: number): string {
  const num = (v: number, digits: number): string => formatNumber(v, { minimumFractionDigits: digits, maximumFractionDigits: digits })
  if (n < 1024) return `${num(n, 0)} B`
  const kb = n / 1024
  if (kb < 1024) return `${num(kb, 1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${num(mb, 2)} MB`
  return `${num(mb / 1024, 2)} GB`
}

export function ProjectDetailsDialog({ open, onClose }: Props) {
  const { t } = useTranslation()
  const name = useProjectStore((s) => s.name)
  const description = useProjectStore((s) => s.description)
  const filePath = useProjectStore((s) => s.filePath)
  const setName = useProjectStore((s) => s.setName)
  const setDescription = useProjectStore((s) => s.setDescription)
  const docCount = useDocumentStore((s) => s.sources.length)
  const codeCount = useCodeStore((s) => s.flatCodes().length)

  const [draftName, setDraftName] = useState(name)
  const [draftDescription, setDraftDescription] = useState(description ?? '')
  const [fileSize, setFileSize] = useState<number | null>(null)

  useEffect(() => {
    if (open) {
      setDraftName(name)
      setDraftDescription(description ?? '')
    }
  }, [open, name, description])

  useEffect(() => {
    if (!open || !filePath) {
      setFileSize(null)
      return
    }
    window.api.getFileSize(filePath).then(setFileSize)
  }, [open, filePath])

  if (!open) return null

  const commit = (): void => {
    const trimmed = draftName.trim()
    if (trimmed && trimmed !== name) setName(trimmed)
    if (draftDescription !== (description ?? '')) setDescription(draftDescription)
    onClose()
  }

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 480, maxWidth: '90vw' }}>
        <h2 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 600 }}>{t('projectDetails.title')}</h2>

        <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
          {t('projectDetails.name')}
        </label>
        <input
          type="text"
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') onClose()
          }}
          autoFocus
          style={{ width: '100%', marginBottom: 16 }}
        />

        <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
          {t('projectDetails.description')}
        </label>
        {/* The editor carries its own border/background; constrain it to the
            dialog width and give it a fixed max height with internal scroll
            so a long description never grows the dialog. */}
        <MarkdownEditor
          value={draftDescription}
          onChange={setDraftDescription}
          style={{ width: '100%', maxHeight: 200, overflowY: 'auto', marginBottom: 16 }}
        />

        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px', fontSize: 13, marginBottom: 20 }}>
          <span style={{ color: 'var(--text-secondary)' }}>{t('projectDetails.file')}</span>
          <span style={{ wordBreak: 'break-all' }}>{filePath ?? <em style={{ color: 'var(--text-secondary)' }}>{t('projectDetails.unsaved')}</em>}</span>
          <span style={{ color: 'var(--text-secondary)' }}>{t('projectDetails.documents')}</span>
          <span>{formatNumber(docCount)}</span>
          <span style={{ color: 'var(--text-secondary)' }}>{t('projectDetails.codes')}</span>
          <span>{formatNumber(codeCount)}</span>
          <span style={{ color: 'var(--text-secondary)' }}>{t('projectDetails.fileSize')}</span>
          <span>{filePath == null ? '—' : fileSize == null ? '…' : formatBytes(fileSize)}</span>
        </div>

        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button onClick={commit}>{t('common.done')}</button>
        </div>
      </div>
    </div>
  )
}
