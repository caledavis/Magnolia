/**
 * Notes — timestamped, codeable Markdown documents that live in notebooks
 * (folders with kind 'notebook'). A note's name is derived from its
 * timestamp and title so the Document Browser, analysis tools and other
 * QDA software all see "YYMMDD HH:MM - Title".
 */
import type { DocumentFolder, NoteFormatData, TextSource } from '../models/types'

const pad = (n: number): string => String(n).padStart(2, '0')

/** "YYMMDD HH:MM" in local time. */
export function formatNoteStamp(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return `${pad(d.getFullYear() % 100)}${pad(d.getMonth() + 1)}${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The note's display / stored name: "YYMMDD HH:MM - Title", or just the
 *  stamp while the note is untitled. */
export function noteName(data: NoteFormatData): string {
  const stamp = formatNoteStamp(data.noteDateTime)
  const title = data.title.trim()
  return title ? `${stamp} - ${title}` : stamp
}

export function isNote(source: Pick<TextSource, 'sourceType'> | undefined): boolean {
  return source?.sourceType === 'note'
}

export function isNotebook(folder: Pick<DocumentFolder, 'kind'> | undefined): boolean {
  return folder?.kind === 'notebook'
}

export function noteData(source: TextSource): NoteFormatData {
  const fd = (source.formatData ?? {}) as Partial<NoteFormatData>
  return {
    title: fd.title ?? '',
    noteDateTime: fd.noteDateTime ?? source.creationDateTime ?? new Date(0).toISOString()
  }
}

/** Notes in a notebook, newest observation first. */
export function sortNotes(notes: TextSource[]): TextSource[] {
  return [...notes].sort((a, b) => noteData(b).noteDateTime.localeCompare(noteData(a).noteDateTime))
}

/** ISO timestamp → the value a <input type="datetime-local"> expects. */
export function toDateTimeLocal(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** <input type="datetime-local"> value → ISO timestamp (null if blank). */
export function fromDateTimeLocal(value: string): string | null {
  if (!value) return null
  const d = new Date(value)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

const LIST_ITEM = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/

/**
 * Enter on a Markdown list line in a note continues the list: the new line
 * starts with the next marker ("- ", "2. ", "- [ ] "). Enter on an item
 * with nothing after its marker ends the list by clearing the marker.
 * Returns the edit to make instead of a plain newline, or null when the
 * caret isn't after a list marker. `start`/`end` are codepoint offsets.
 */
export function continueListEdit(
  text: string,
  start: number,
  end: number
): { start: number; end: number; insert: string } | null {
  if (start !== end) return null
  const cps = [...text]
  let lineStart = start
  while (lineStart > 0 && cps[lineStart - 1] !== '\n') lineStart--
  let lineEnd = start
  while (lineEnd < cps.length && cps[lineEnd] !== '\n') lineEnd++
  const line = cps.slice(lineStart, lineEnd).join('')
  const m = line.match(LIST_ITEM)
  if (!m) return null
  const markerLen = [...m[0]].length
  if (start < lineStart + markerLen) return null
  if (lineEnd === lineStart + markerLen) return { start: lineStart, end: lineEnd, insert: '' }
  const [, indent, bullet, num, delim, space, task] = m
  const marker = bullet ?? `${Number(num) + 1}${delim}`
  return { start, end, insert: `\n${indent}${marker}${space}${task ? '[ ] ' : ''}` }
}

/**
 * Cmd+B / Cmd+I in a note: wrap the selection in `**` / `*`, or unwrap it
 * when it's already marked (markers just outside the selection, or the
 * selection's own ends). With no selection, insert the pair and put the
 * caret between. Returns the edit and the selection to restore afterwards
 * (codepoint offsets).
 */
export function toggleMarkEdit(
  text: string,
  start: number,
  end: number,
  mark: '**' | '*'
): { start: number; end: number; insert: string; selStart: number; selEnd: number } {
  const cps = [...text]
  const m = mark.length
  const inner = cps.slice(start, end)
  // Length of the run of '*' touching each side of the selection. A run of
  // 1 or 3 carries italic, 2 or more carries bold.
  let runBefore = 0
  while (start - runBefore > 0 && cps[start - runBefore - 1] === '*') runBefore++
  let runAfter = 0
  while (end + runAfter < cps.length && cps[end + runAfter] === '*') runAfter++
  const marked = (run: number) => (mark === '**' ? run >= 2 : run % 2 === 1)

  if (marked(runBefore) && marked(runAfter)) {
    return { start: start - m, end: end + m, insert: inner.join(''), selStart: start - m, selEnd: end - m }
  }
  const innerText = inner.join('')
  if (inner.length >= 2 * m && innerText.startsWith(mark) && innerText.endsWith(mark)) {
    const stripped = inner.slice(m, inner.length - m).join('')
    return { start, end, insert: stripped, selStart: start, selEnd: end - 2 * m }
  }
  return { start, end, insert: mark + innerText + mark, selStart: start + m, selEnd: end + m }
}
