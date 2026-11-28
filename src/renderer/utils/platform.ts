import { t } from '../i18n'
/**
 * True when running on macOS. Keyboard-shortcut hints elsewhere in the
 * renderer show the platform's actual modifier — the underlying handlers
 * already accept Cmd or Ctrl interchangeably (`e.metaKey || e.ctrlKey`), but
 * the macOS symbols (⌘/⌥) only make sense on macOS; every other platform
 * should read the literal key name ("Ctrl"/"Alt").
 */
export const isMac = window.api?.platform === 'darwin'

/** OS-appropriate "Cmd/Ctrl+<key>" label, e.g. modKey(5) → "⌘5" on macOS,
 *  "Ctrl+5" elsewhere. */
export function modKey(key: string | number): string {
  return isMac ? `⌘${key}` : `Ctrl+${key}`
}

/** Whether a click or marquee adds to the selection rather than replacing
 *  it: Option or Command on a Mac, as in the Finder; Shift elsewhere too,
 *  because Xfce, Cinnamon and MATE keep Alt-drag for moving windows. */
export function addsToSelection(e: { altKey: boolean; metaKey: boolean; shiftKey: boolean }): boolean {
  return e.altKey || e.metaKey || (!isMac && e.shiftKey)
}

/** How to click to select several, in the interface language. */
export const multiSelectClickHint = (): string => t(isMac ? 'platform.altClickMac' : 'platform.shiftClick')

/** A recorded key combination (utils/keys.ts keyCombo) as this platform
 *  names its keys. The combination itself always calls the Command /
 *  Windows / Super key "Cmd", so a saved mapping keeps working; only
 *  the label changes: the key is "Super" on Linux and "Win" on Windows. */
export function keyComboLabel(combo: string): string {
  if (isMac) return combo
  const meta = window.api?.platform === 'win32' ? 'Win' : 'Super'
  return combo.split('+').map((part, i, all) => (part === 'Cmd' && i < all.length - 1 ? meta : part)).join('+')
}
