import { t } from '../i18n'
/**
 * True when running on macOS. Keyboard-shortcut hints elsewhere in the
 * renderer show the platform's actual modifier — the underlying handlers
 * already accept Cmd or Ctrl interchangeably (`e.metaKey || e.ctrlKey`), but
 * the macOS symbols (⌘/⌥) only make sense on macOS; every other platform
 * should read the literal key name ("Ctrl"/"Alt").
 */
export const isMac = ((window as any).api?.platform as string | undefined) === 'darwin'

/** OS-appropriate "Cmd/Ctrl+<key>" label, e.g. modKey(5) → "⌘5" on macOS,
 *  "Ctrl+5" elsewhere. */
export function modKey(key: string | number): string {
  return isMac ? `⌘${key}` : `Ctrl+${key}`
}

/** OS-appropriate label for an Option/Alt click-modifier hint. */
/** How to Alt-click on this platform, in the interface language. */
export const altClickHint = (): string => t(isMac ? 'platform.altClickMac' : 'platform.altClick')
