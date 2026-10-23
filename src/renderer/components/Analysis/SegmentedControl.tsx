/**
 * SegmentedControl — a row of joined buttons for picking one of a few
 * views, with the current one highlighted. Analysis tools use it for
 * choices that change how results are shown (Table / Visual / Sankey,
 * Counts / Binary), so those read apart from the plain action buttons
 * (Export CSV, …) beside them.
 */
export interface SegmentOption<T extends string> {
  value: T
  label: string
  title?: string
}

interface Props<T extends string> {
  options: SegmentOption<T>[]
  value: T
  onChange: (value: T) => void
  /** Accessible name for the group, e.g. "View". */
  label: string
}

export function SegmentedControl<T extends string>({ options, value, onChange, label }: Props<T>) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'active' : undefined}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** The grid tools' three ways of showing results. */
export type GridView = 'table' | 'visual' | 'sankey'
