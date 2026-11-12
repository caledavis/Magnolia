/**
 * How an import is going: every document being imported, each with its
 * stage (Waiting, Reading or Converting to PDF, Reading text, Done or
 * Couldn't import), and an overall bar. It closes itself when every
 * document came in; if any couldn't, it stays open with the reasons.
 */
import { useTranslation } from 'react-i18next'
import type { ImportItem, ImportState } from '../models/types'
import { Icon, faCheck, faXmark } from './Icon'

function StageIcon({ stage }: { stage: ImportItem['stage'] }) {
  switch (stage) {
    case 'done':
      return <Icon icon={faCheck} className="import-progress-icon" style={{ color: 'var(--success)' }} />
    case 'failed':
      return <Icon icon={faXmark} className="import-progress-icon" style={{ color: 'var(--danger)' }} />
    case 'waiting':
      return <span className="import-progress-icon import-progress-waiting" />
    default:
      return <span className="import-progress-icon import-progress-spinner" />
  }
}

export function ImportProgressDialog({ state, onClose }: { state: ImportState; onClose: () => void }) {
  const { t } = useTranslation()
  const total = state.items.length
  const finishedCount = state.items.filter((it) => it.stage === 'done' || it.stage === 'failed').length
  const failed = state.items.filter((it) => it.stage === 'failed').length
  const title = !state.finished
    ? t('importProgress.title', { count: total })
    : failed > 0
      ? t('importProgress.someFailed', { count: failed })
      : t('importProgress.finished', { count: total })
  return (
    <div className="modal-overlay" style={{ zIndex: 20000 }}>
      <div className="modal import-progress" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <div
          className="import-progress-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={finishedCount}
        >
          <div style={{ width: `${total ? (finishedCount / total) * 100 : 0}%` }} />
        </div>
        <ul className="import-progress-list">
          {state.items.map((it, i) => (
            <li key={i} data-stage={it.stage}>
              <StageIcon stage={it.stage} />
              <div className="import-progress-text">
                <div className="import-progress-row">
                  <span className="import-progress-name" title={it.name}>{it.name}</span>
                  <span className="import-progress-stage">{t(`importProgress.${it.stage}`)}</span>
                </div>
                {it.error && <div className="import-progress-error">{it.error}</div>}
              </div>
            </li>
          ))}
        </ul>
        {state.finished && (
          <div className="modal-actions">
            <button onClick={onClose} autoFocus>{t('common.close')}</button>
          </div>
        )}
      </div>
    </div>
  )
}
