/**
 * A zero in an analysis table: it shouldn't stand out from the counts
 * around it, so it is smaller, lighter and in the muted grey, faded as
 * far as it can be while still readable (4.5:1, WCAG AA: the muted grey
 * is the faintest that passes on every cell background, the shaded
 * subtotal columns included).
 */
import type { CSSProperties } from 'react'

export const ZERO_CELL: CSSProperties = { color: 'var(--text-muted)', fontSize: 10, fontWeight: 400 }
