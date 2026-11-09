/**
 * Keyboard shortcuts and typing that work on every keyboard layout and
 * input method.
 *
 *  - Letter shortcuts (Cmd+A, Cmd+Z…) match the character on Latin layouts
 *    (QWERTY, AZERTY, Dvorak, where the letter may sit elsewhere) and the
 *    key in that letter's place on layouts that give another script
 *    (Russian "ф", Arabic, Greek, Hindi), as native apps do.
 *  - Digit shortcuts (Cmd+1–9 for code hotkeys) match the digit typed, or
 *    the digit key's position where the top row gives something else
 *    (AZERTY's "&é…", Arabic-Indic digits).
 *  - While an input method is composing text (Chinese, Japanese, Korean,
 *    Vietnamese…), Enter and Escape belong to it: they pick or cancel a
 *    candidate, so Magnolia's own Enter-to-save and Escape-to-close
 *    handlers must not see them (see guardComposition).
 */

interface KeyLike {
  key: string
  code: string
}

/** Whether the event is the letter `letter` (a–z). */
export function isLetterKey(e: KeyLike, letter: string): boolean {
  const key = e.key.toLowerCase()
  if (/^[a-z]$/.test(key)) return key === letter
  return e.code === `Key${letter.toUpperCase()}`
}

/** The digit 0–9 a key gives, or null. */
export function digitKey(e: KeyLike): number | null {
  if (/^[0-9]$/.test(e.key)) return Number(e.key)
  const m = e.code.match(/^(?:Digit|Numpad)([0-9])$/)
  return m ? Number(m[1]) : null
}

/** Whether a keydown belongs to an input method's composition. WebKit
 *  marks the Enter that confirms a composition with keyCode 229 rather
 *  than isComposing. */
export function isComposing(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229
}

/** Keep Enter and Escape away from the page's handlers while an input
 *  method is composing, so confirming a Chinese or Japanese word doesn't
 *  also save a half-typed name or close a dialog. Runs first (capture on
 *  the window); the input method still gets the key. Call once per window. */
export function guardComposition(target: Window = window): void {
  target.addEventListener('keydown', (e) => {
    if (isComposing(e) && (e.key === 'Enter' || e.key === 'Escape' || e.key === 'Process')) e.stopImmediatePropagation()
  }, true)
}

/** A shortcut as text ("Ctrl+Shift+F", "F9", " " for Space), the same on
 *  every layout: a letter or digit key outside Latin letters and digits
 *  (Russian "А", Option+P's "π" on a Mac) is named by its position, so a
 *  shortcut recorded in one layout still works after switching to another. */
export function keyCombo(e: KeyLike & { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return ''
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Cmd')
  let key = e.key.length === 1 ? e.key.toUpperCase() : e.key
  const byPlace = e.code.match(/^(?:Key([A-Z])|Digit([0-9]))$/)
  if (byPlace && !/^[A-Z0-9]$/.test(key)) key = byPlace[1] ?? byPlace[2]
  parts.push(key)
  return parts.join('+')
}
