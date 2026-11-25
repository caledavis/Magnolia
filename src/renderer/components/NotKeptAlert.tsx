import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { NotKeptKind } from '../models/types'
import { AlertDialog } from './AlertDialog'

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

/** The kinds a file holds that Magnolia can't keep (none: nothing to say). */
export function notKeptKinds(counts: Partial<Record<NotKeptKind, number>> | null): NotKeptKind[] {
  return KINDS.filter((k) => (counts?.[k] ?? 0) > 0)
}

/**
 * Shown after opening a project (usually from another program) that holds
 * things Magnolia can't keep — what magnolia-core's `not_kept` counted.
 * Opening it changes nothing, but the first save over the original file
 * leaves them out, so it offers Save As before any work is done. Its pill
 * ("Not all kept") stays until then.
 */
export function NotKeptAlert({
  counts,
  open,
  onSaveAs,
  onClose
}: {
  counts: Partial<Record<NotKeptKind, number>> | null
  open: boolean
  onSaveAs: () => Promise<unknown>
  onClose: () => void
}): ReactElement | null {
  const { t } = useTranslation()
  const kinds = notKeptKinds(counts)
  if (!open || kinds.length === 0) return null
  return (
    <AlertDialog
      title={t('notKept.title')}
      onClose={onClose}
      actions={
        <>
          <button className="secondary" onClick={() => { onClose(); void onSaveAs() }}>{t('saveFailed.saveAs')}</button>
          <button className="secondary" onClick={onClose}>{t('common.ok')}</button>
        </>
      }
    >
      <p style={{ margin: '0 0 6px' }}>{t('notKept.intro')}</p>
      <ul style={{ margin: '0 0 8px', paddingInlineStart: 20 }}>
        {kinds.map((k) => (
          <li key={k}>{t(`notKept.${k}`, { count: counts![k] })}</li>
        ))}
      </ul>
      <p style={{ margin: 0 }}>{t('notKept.advice')}</p>
    </AlertDialog>
  )
}
