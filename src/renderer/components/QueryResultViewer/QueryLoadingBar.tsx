import { useTranslation } from 'react-i18next'
/** Thin indeterminate bar shown under the Query Results header while a
 *  query (re-)runs. Styles live in global.css (.query-loading-*). */
export function QueryLoadingBar({ active }: { active: boolean }) {
  const { t } = useTranslation()
  if (!active) return null
  return (
    <div className="query-loading-track" role="progressbar" aria-label={t('results.running')}>
      <div className="query-loading-bar" />
    </div>
  )
}
