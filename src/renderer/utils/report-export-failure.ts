import { errorMessage } from './error-message'
import { t } from '../i18n'

/** An export whose file couldn't be written (a full disk, a folder the
 *  user can't write to): say so, rather than nothing. */
export function reportExportFailure(err: unknown): void {
  console.error('Export failed:', err)
  void window.api.showMessage(t('common.exportFailed', { detail: errorMessage(err) }), 'error')
}
