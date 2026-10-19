/** Thin indeterminate bar shown under the Query Results header while a
 *  query (re-)runs. Styles live in global.css (.query-loading-*). */
export function QueryLoadingBar({ active }: { active: boolean }) {
  if (!active) return null
  return (
    <div className="query-loading-track" role="progressbar" aria-label="Running query">
      <div className="query-loading-bar" />
    </div>
  )
}
