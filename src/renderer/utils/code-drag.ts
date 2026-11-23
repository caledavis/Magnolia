/**
 * Codes dragged from the Codes panel (or anywhere else codes are dragged
 * from): one code as `application/x-magnolia-code`, a multi-selection as
 * `application/x-magnolia-codes` (a JSON list), each code at least
 * `{ guid }`, usually with its name and colour.
 */

export const CODE_DRAG_TYPE = 'application/x-magnolia-code'
export const CODES_DRAG_TYPE = 'application/x-magnolia-codes'

type WithData = { dataTransfer: DataTransfer }

/** Whether a drag carries codes (readable during dragover, unlike the data). */
export function isCodeDrag(e: WithData): boolean {
  const types = e.dataTransfer.types
  return types.includes(CODE_DRAG_TYPE) || types.includes(CODES_DRAG_TYPE)
}

/** The guids in a JSON list of codes; none if it isn't one. */
export function codeGuidsFromJson(json: string): string[] {
  return codesFromJson(json, true).map((c) => c.guid)
}

function codesFromJson<T extends { guid: string }>(json: string, list: boolean): T[] {
  try {
    const parsed: unknown = JSON.parse(json)
    const items = list ? (Array.isArray(parsed) ? parsed : []) : [parsed]
    return items.filter((c): c is T => !!c && typeof (c as { guid?: unknown }).guid === 'string')
  } catch {
    return [] // not a code drag after all
  }
}

/** The dropped codes: the multi-selection if there is one, else the single
 *  code; none for malformed data. Read it on drop (data isn't readable
 *  during dragover). */
export function draggedCodes<T extends { guid: string } = { guid: string }>(e: WithData): T[] {
  const multi = e.dataTransfer.getData(CODES_DRAG_TYPE)
  if (multi) return codesFromJson<T>(multi, true)
  const single = e.dataTransfer.getData(CODE_DRAG_TYPE)
  return single ? codesFromJson<T>(single, false) : []
}

/** The dropped codes' guids (see draggedCodes). */
export function draggedCodeGuids(e: WithData): string[] {
  return draggedCodes(e).map((c) => c.guid)
}
