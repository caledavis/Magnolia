/**
 * Preferences store — user settings persisted to disk via IPC.
 * Stores foot pedal key mappings and audio defaults.
 */
import { create } from 'zustand'

export interface FootPedalMappings {
  playPause: string       // e.g. "F5", "Ctrl+Space"
  rewind: string          // e.g. "F6"
  fastForward: string     // e.g. "F7"
  rewindSeconds: number   // default 5
  fastForwardSeconds: number // default 5
}

/** Theme id stored in preferences. Lab is the new-install default
 *  (Lab Dark when the OS reports prefers-color-scheme: dark, per
 *  apply-theme.ts); the empty string is preserved as a valid id
 *  ("Clean") for backwards compatibility with older preference files. */
export type ThemeId = '' | 'dark' | 'granola' | 'granola-dark' | 'high-contrast' | 'magnolia' | 'magnolia-dark'

/** Paper size for PDFs Magnolia exports. Values are Electron
 *  printToPDF `pageSize` strings. */
export type PaperSize = 'A4' | 'A3' | 'A5' | 'Letter' | 'Legal' | 'Tabloid'

/** Toolbar button display: 'icons' is the compact macOS Mail-style
 *  icon-only row (grouped in pills); 'icons-and-text' shows the label
 *  under/beside each icon, as the toolbar looked before that redesign. */
export type ToolbarStyle = 'icons' | 'icons-and-text'

export interface Preferences {
  footPedalMappings: FootPedalMappings
  defaultPlaybackSpeed: number
  theme: ThemeId
  paperSize: PaperSize
  /** Interface scale, applied as a native page zoom factor (1 = 100%). */
  interfaceScale: number
  /** Shown to teammates when this user checks out a shared project. */
  userName: string
  toolbarStyle: ToolbarStyle
}

const DEFAULT_PREFERENCES: Preferences = {
  footPedalMappings: {
    playPause: 'F5',
    rewind: 'F6',
    fastForward: 'F7',
    rewindSeconds: 5,
    fastForwardSeconds: 5
  },
  defaultPlaybackSpeed: 1.0,
  theme: 'magnolia',
  paperSize: 'A4',
  interfaceScale: 1,
  userName: '',
  toolbarStyle: 'icons'
}

interface PreferencesState extends Preferences {
  loaded: boolean
  load: () => Promise<void>
  save: () => Promise<void>
  updateMapping: (key: keyof FootPedalMappings, value: string | number) => void
  setDefaultPlaybackSpeed: (speed: number) => void
  setTheme: (theme: ThemeId) => void
  setInterfaceScale: (scale: number) => void
  setUserName: (userName: string) => void
  setToolbarStyle: (toolbarStyle: ToolbarStyle) => void
}

export const usePreferencesStore = create<PreferencesState>((set, get) => ({
  ...DEFAULT_PREFERENCES,
  loaded: false,

  load: async () => {
    try {
      const prefs = await window.api.loadPreferences()
      if (prefs) {
        set({
          footPedalMappings: { ...DEFAULT_PREFERENCES.footPedalMappings, ...prefs.footPedalMappings },
          defaultPlaybackSpeed: prefs.defaultPlaybackSpeed ?? DEFAULT_PREFERENCES.defaultPlaybackSpeed,
          theme: (prefs.theme ?? DEFAULT_PREFERENCES.theme) as ThemeId,
          paperSize: (prefs.paperSize ?? DEFAULT_PREFERENCES.paperSize) as PaperSize,
          interfaceScale: typeof prefs.interfaceScale === 'number' ? prefs.interfaceScale : DEFAULT_PREFERENCES.interfaceScale,
          userName: typeof prefs.userName === 'string' ? prefs.userName : DEFAULT_PREFERENCES.userName,
          toolbarStyle: prefs.toolbarStyle === 'icons-and-text' ? 'icons-and-text' : DEFAULT_PREFERENCES.toolbarStyle,
          loaded: true
        })
      } else {
        set({ loaded: true })
      }
    } catch {
      set({ loaded: true })
    }
  },

  save: async () => {
    const { footPedalMappings, defaultPlaybackSpeed, theme, paperSize, interfaceScale, userName, toolbarStyle } = get()
    try {
      await window.api.savePreferences({ footPedalMappings, defaultPlaybackSpeed, theme, paperSize, interfaceScale, userName, toolbarStyle })
    } catch { /* ignore */ }
  },

  updateMapping: (key, value) => {
    set((state) => ({
      footPedalMappings: { ...state.footPedalMappings, [key]: value }
    }))
    // Auto-save after update
    setTimeout(() => get().save(), 0)
  },

  setDefaultPlaybackSpeed: (speed) => {
    set({ defaultPlaybackSpeed: speed })
    setTimeout(() => get().save(), 0)
  },

  setTheme: (theme) => {
    set({ theme })
    setTimeout(() => get().save(), 0)
  },

  setInterfaceScale: (interfaceScale) => {
    set({ interfaceScale })
    setTimeout(() => get().save(), 0)
  },

  setUserName: (userName) => {
    set({ userName })
    setTimeout(() => get().save(), 0)
  },

  setToolbarStyle: (toolbarStyle) => {
    set({ toolbarStyle })
    setTimeout(() => get().save(), 0)
  }
}))

// Stay in sync with changes made in any other window (the Preferences
// popup, or the in-main-window Preferences tab). Those write to disk
// AND broadcast a `preferences-update` IPC, which the main process
// forwards back to the main window. Without this subscription, the
// store stays on whatever values it loaded at mount, so the foot-pedal
// listeners in AudioDocumentViewer / VideoDocumentViewer keep matching
// against stale key mappings — i.e. the user changes their pedal key
// in Preferences, the viewer still listens for the old one, and
// nothing happens when the pedal fires.
//
// The subscription is installed once per renderer at module load. The
// unsubscribe is intentionally discarded — the store lives for the
// lifetime of the window, so does this listener.
if (typeof window !== 'undefined' && window.api?.onPreferencesUpdate) {
  window.api.onPreferencesUpdate((prefs) => {
    if (!prefs) return
    usePreferencesStore.setState({
      footPedalMappings: { ...DEFAULT_PREFERENCES.footPedalMappings, ...(prefs.footPedalMappings || {}) },
      defaultPlaybackSpeed: prefs.defaultPlaybackSpeed ?? DEFAULT_PREFERENCES.defaultPlaybackSpeed,
      theme: (prefs.theme ?? DEFAULT_PREFERENCES.theme) as ThemeId,
      paperSize: (prefs.paperSize ?? DEFAULT_PREFERENCES.paperSize) as PaperSize,
      interfaceScale: typeof prefs.interfaceScale === 'number' ? prefs.interfaceScale : DEFAULT_PREFERENCES.interfaceScale,
      userName: typeof prefs.userName === 'string' ? prefs.userName : DEFAULT_PREFERENCES.userName,
      toolbarStyle: prefs.toolbarStyle === 'icons-and-text' ? 'icons-and-text' : DEFAULT_PREFERENCES.toolbarStyle,
      loaded: true
    })
  })
}
