/**
 * PreferencesWindow — user settings, two-column layout. Categories on the
 * left, the selected category's settings on the right. Categories today
 * are Appearance (theme) and Media Playback (foot-pedal mappings + speed).
 *
 * Hosted as a tab in the main window (renders inside DocumentViewer's
 * tool-tab slot) and historically also as a standalone popout window
 * via preferences-entry.tsx. The optional `onClose` callback lets the
 * tab host close the tab; if absent (popout mode) we fall back to
 * `window.close()`.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { normaliseThemeId, type ThemeId } from '../../utils/theme-id'
import { Icon, faGear } from '../Icon'
import { COLOURFUL_INTERFACE_ENABLED, colourfulInterfaceFromSaved } from '../../utils/colourful-interface'
import { useTranslation } from 'react-i18next'
import { LANGUAGE_IDS, normaliseLanguagePreference, resolveLanguage, setLanguagePreference, type LanguagePreference } from '../../i18n'

interface FootPedalMappings {
  playPause: string
  rewind: string
  fastForward: string
  rewindSeconds: number
  fastForwardSeconds: number
}


/** Paper size for exported PDFs (see src-tauri/src/print). */
type PaperSize = 'A4' | 'A3' | 'A5' | 'Letter' | 'Legal' | 'Tabloid'

/** Toolbar button display: 'ribbon' (the default) is the tabbed ribbon
 *  (see Toolbar/Ribbon.tsx); 'icons' is the compact macOS Mail-style
 *  icon-only row (grouped in pills). */
type ToolbarStyle = 'icons' | 'ribbon'

interface Preferences {
  footPedalMappings: FootPedalMappings
  defaultPlaybackSpeed: number
  theme: ThemeId
  paperSize: PaperSize
  /** Interface scale, applied as a native page zoom factor (1 = 100%). */
  interfaceScale: number
  /** Shown to teammates when this user checks out a shared project. */
  userName: string
  toolbarStyle: ToolbarStyle
  /** Dark toolbar plus colour-coded icons. */
  colourfulInterface: boolean
  /** The interface language, or "system" to follow the computer's. */
  language: LanguagePreference
}

const DEFAULT_PREFS: Preferences = {
  footPedalMappings: {
    playPause: 'F5',
    rewind: 'F6',
    fastForward: 'F7',
    rewindSeconds: 5,
    fastForwardSeconds: 5
  },
  defaultPlaybackSpeed: 1.0,
  // Magnolia is the default for new installs (Lab Dark when the OS
  // reports prefers-color-scheme: dark — handled by apply-theme.ts
  // on first paint). Existing pref files that already carry a saved
  // theme override this (an unknown one, such as the removed Clean,
  // falls back to Magnolia).
  theme: 'magnolia',
  paperSize: 'A4',
  interfaceScale: 1,
  userName: '',
  toolbarStyle: 'ribbon',
  colourfulInterface: COLOURFUL_INTERFACE_ENABLED,
  language: 'system'
}

const TOOLBAR_STYLE_OPTIONS: { id: ToolbarStyle; labelKey: string }[] = [
  { id: 'ribbon', labelKey: 'prefs.toolbarStyle.ribbon' },
  { id: 'icons', labelKey: 'prefs.toolbarStyle.icons' }
]

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2]

const PAPER_SIZE_OPTIONS: PaperSize[] = ['A4', 'A3', 'A5', 'Letter', 'Legal', 'Tabloid']

const INTERFACE_SCALE_OPTIONS = [1, 1.25, 1.5, 2]

interface ThemeOption {
  id: ThemeId
  labelKey: string
  /** Three swatch colors used to render a small preview of the palette. */
  swatch: { bg: string; surface: string; accent: string }
}

const THEME_OPTIONS: ThemeOption[] = [
  { id: 'magnolia',      labelKey: 'prefs.theme.magnolia',      swatch: { bg: '#E9EDF3', surface: '#FFFFFF', accent: '#2563EB' } },
  { id: 'magnolia-dark', labelKey: 'prefs.theme.magnoliaDark', swatch: { bg: '#14181E', surface: '#252B35', accent: '#5B8FFF' } },
  { id: 'high-contrast', labelKey: 'prefs.theme.highContrast', swatch: { bg: '#000000', surface: '#ffffff', accent: '#ffff00' } }
]

type CategoryId = 'appearance' | 'general' | 'media-playback' | 'paper-size' | 'updates' | 'support'

interface Category {
  id: CategoryId
  labelKey: string
}

const CATEGORIES: Category[] = [
  { id: 'general',        labelKey: 'prefs.cat.general' },
  { id: 'appearance',     labelKey: 'prefs.cat.appearance' },
  { id: 'media-playback', labelKey: 'prefs.cat.mediaPlayback' },
  { id: 'paper-size',     labelKey: 'prefs.cat.paperSize' },
  { id: 'updates',        labelKey: 'prefs.cat.updates' },
  { id: 'support',        labelKey: 'prefs.cat.support' }
]

// Lets callers outside this module (e.g. the toolbar wordmark, when it's
// showing an update badge) open Preferences to a specific category. If the
// pane is already mounted, listeners switch it live; otherwise the request is
// held and consumed when the pane next mounts. Held value is cleared on the
// mount read so a later plain open (menu / Cmd+,) still lands on the default.
let pendingCategory: CategoryId | null = null
const categoryListeners = new Set<(c: CategoryId) => void>()

export function requestPreferencesCategory(category: CategoryId): void {
  if (categoryListeners.size > 0) {
    categoryListeners.forEach((l) => l(category))
  } else {
    pendingCategory = category
  }
}

/** GitHub Sponsors page for funding Magnolia's development. */
const SPONSOR_URL = 'https://github.com/sponsors/caledavis'

/** Latest release page — where users on builds that can't self-update (e.g.
 *  the portable Windows exe) download the newest version. */
const RELEASES_URL = 'https://github.com/caledavis/Magnolia/releases/latest'

/** Capture a key combination from a keyboard event */
function keyComboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Cmd')

  const key = e.key
  // Skip modifier-only presses
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return ''

  // Normalize key names
  const normalized = key.length === 1 ? key.toUpperCase() : key
  parts.push(normalized)
  return parts.join('+')
}

function KeyCaptureInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const { t } = useTranslation()
  const [capturing, setCapturing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!capturing) return
    const handler = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const combo = keyComboFromEvent(e)
      if (combo) {
        onChange(combo)
        setCapturing(false)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [capturing, onChange])

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      <label style={{ width: 120, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{label}</label>
      <input
        ref={inputRef}
        readOnly
        value={capturing ? t('prefs.pressKey') : value}
        onClick={() => setCapturing(true)}
        onBlur={() => setCapturing(false)}
        style={{
          flex: 1,
          padding: '4px 8px',
          fontSize: 12,
          fontFamily: 'var(--font-mono)',
          border: `1px solid ${capturing ? 'var(--accent)' : 'var(--border-color)'}`,
          borderRadius: 'var(--radius-sm)',
          background: capturing ? 'var(--selection-bg)' : 'var(--bg-primary)',
          color: 'var(--text-primary)',
          cursor: 'pointer',
          outline: 'none',
          textAlign: 'center'
        }}
      />
    </div>
  )
}

function AppearanceSettings({
  value,
  onChange,
  scale,
  onScaleChange,
  toolbarStyle,
  onToolbarStyleChange,
  colourful,
  onColourfulChange
}: {
  value: ThemeId
  onChange: (v: ThemeId) => void
  scale: number
  onScaleChange: (v: number) => void
  toolbarStyle: ToolbarStyle
  onToolbarStyleChange: (v: ToolbarStyle) => void
  colourful: boolean
  onColourfulChange: (v: boolean) => void
}) {
  const { t } = useTranslation()
  return (
    <div style={{ marginBottom: 24 }}>
      <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 14, color: 'var(--text-secondary)' }}>{t('prefs.themeHeading')}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {THEME_OPTIONS.map((opt) => {
          const selected = opt.id === value
          return (
            <div
              key={opt.id}
              onClick={() => onChange(opt.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '8px 10px',
                border: `1px solid ${selected ? 'var(--accent)' : 'var(--border-color)'}`,
                borderRadius: 'var(--radius-md)',
                // Unselected rows match the toolbar surface (--bg-secondary)
                // rather than the deeper page chrome (--bg-primary), so the
                // theme cards read as "lifted UI" instead of "filled with
                // chrome". Selected stays on --selection-bg to keep the
                // active card visually distinct.
                background: selected ? 'var(--selection-bg)' : 'var(--bg-secondary)',
                cursor: 'pointer',
                transition: 'background 0.12s, border-color 0.12s'
              }}
            >
              {/* Swatch — three stacked colors */}
              <div style={{
                width: 44, height: 28, flexShrink: 0,
                borderRadius: 4, overflow: 'hidden',
                border: '1px solid var(--border-color)',
                display: 'grid', gridTemplateColumns: '1fr 1fr 1fr'
              }}>
                <div style={{ background: opt.swatch.bg }} />
                <div style={{ background: opt.swatch.surface }} />
                <div style={{ background: opt.swatch.accent }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {t(opt.labelKey)}
                  {opt.id === 'magnolia' && (
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 500, marginLeft: 6 }}>{t('prefs.default')}</span>
                  )}
                </div>
              </div>
              {selected && (
                <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 700 }}>✓</span>
              )}
            </div>
          )
        })}
      </div>

      <h3 style={{ fontSize: 13, fontWeight: 600, marginTop: 24, marginBottom: 10, color: 'var(--text-secondary)' }}>{t('prefs.interfaceScale')}</h3>
      <select
        value={scale}
        onChange={(e) => onScaleChange(parseFloat(e.target.value))}
        style={{
          padding: '4px 8px', fontSize: 12,
          border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)',
          background: 'var(--bg-input)', color: 'var(--text-primary)', cursor: 'pointer'
        }}
      >
        {INTERFACE_SCALE_OPTIONS.map((s) => (
          <option key={s} value={s}>{Math.round(s * 100)}%</option>
        ))}
      </select>

      <h3 style={{ fontSize: 13, fontWeight: 600, marginTop: 24, marginBottom: 10, color: 'var(--text-secondary)' }}>{t('prefs.toolbarStyleHeading')}</h3>
      <select
        value={toolbarStyle}
        onChange={(e) => onToolbarStyleChange(e.target.value as ToolbarStyle)}
        style={{
          padding: '4px 8px', fontSize: 12,
          border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)',
          background: 'var(--bg-input)', color: 'var(--text-primary)', cursor: 'pointer'
        }}
      >
        {TOOLBAR_STYLE_OPTIONS.map((opt) => (
          <option key={opt.id} value={opt.id}>{t(opt.labelKey)}</option>
        ))}
      </select>

      {/* Hidden while the Colourful interface is switched off — see
          COLOURFUL_INTERFACE_ENABLED in utils/colourful-interface.ts. */}
      {COLOURFUL_INTERFACE_ENABLED && (
        <>
          <h3 style={{ fontSize: 13, fontWeight: 600, marginTop: 24, marginBottom: 10, color: 'var(--text-secondary)' }}>{t('prefs.colour')}</h3>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-primary)', cursor: 'pointer' }}>
            <input type="checkbox" checked={colourful} onChange={(e) => onColourfulChange(e.target.checked)} />
            {t('prefs.colourful')}
          </label>
        </>
      )}
    </div>
  )
}

function GeneralSettings({
  prefs,
  save,
  onLanguageChange
}: {
  prefs: Preferences
  save: (updated: Preferences) => void
  onLanguageChange: (language: LanguagePreference) => void
}) {
  const { t } = useTranslation()
  const systemLanguage = resolveLanguage('system', navigator.languages ?? [navigator.language])
  return (
    <div style={{ marginBottom: 24 }}>
      <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: 'var(--text-secondary)' }}>{t('preferences.language.heading')}</h3>
      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
        {t('preferences.language.description')}
      </p>
      <select
        value={prefs.language}
        onChange={(e) => onLanguageChange(e.target.value as LanguagePreference)}
        aria-label={t('preferences.language.heading')}
        style={{ fontSize: 12, padding: '3px 6px', marginBottom: 24 }}
      >
        <option value="system">{t('language.system', { language: t(`language.name.${systemLanguage}`) })}</option>
        {LANGUAGE_IDS.map((id) => (
          <option key={id} value={id}>{t(`language.name.${id}`)}</option>
        ))}
      </select>

      <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: 'var(--text-secondary)' }}>{t('prefs.yourName')}</h3>
      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
        {t('prefs.yourNameText')}
      </p>
      <input
        type="text"
        value={prefs.userName}
        placeholder={t('prefs.enterName')}
        onChange={(e) => save({ ...prefs, userName: e.target.value })}
        style={{
          width: 240, padding: '4px 8px', fontSize: 12,
          border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)',
          background: 'var(--bg-input)', color: 'var(--text-primary)'
        }}
      />
    </div>
  )
}

function MediaPlaybackSettings({
  prefs,
  updateMapping,
  save
}: {
  prefs: Preferences
  updateMapping: (key: keyof FootPedalMappings, value: string | number) => void
  save: (updated: Preferences) => void
}) {
  const { t } = useTranslation()
  return (
    <>
      {/* Foot Pedal / Key Mappings */}
      <div style={{ marginBottom: 24 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: 'var(--text-secondary)' }}>
          {t('prefs.keyMappings')}
        </h3>
        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
          {t('prefs.keyMappingsText')}
        </p>
        <KeyCaptureInput
          label={t('prefs.playPause')}
          value={prefs.footPedalMappings.playPause}
          onChange={(v) => updateMapping('playPause', v)}
        />
        <KeyCaptureInput
          label={t('prefs.rewind')}
          value={prefs.footPedalMappings.rewind}
          onChange={(v) => updateMapping('rewind', v)}
        />
        <KeyCaptureInput
          label={t('prefs.fastForward')}
          value={prefs.footPedalMappings.fastForward}
          onChange={(v) => updateMapping('fastForward', v)}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, marginTop: 12 }}>
          <label style={{ width: 120, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{t('prefs.rewindSeconds')}</label>
          <input
            type="number"
            min={1}
            max={60}
            value={prefs.footPedalMappings.rewindSeconds}
            onChange={(e) => updateMapping('rewindSeconds', parseInt(e.target.value) || 5)}
            style={{
              width: 60, padding: '4px 8px', fontSize: 12,
              border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-input)', color: 'var(--text-primary)', textAlign: 'center'
            }}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <label style={{ width: 120, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{t('prefs.forwardSeconds')}</label>
          <input
            type="number"
            min={1}
            max={60}
            value={prefs.footPedalMappings.fastForwardSeconds}
            onChange={(e) => updateMapping('fastForwardSeconds', parseInt(e.target.value) || 5)}
            style={{
              width: 60, padding: '4px 8px', fontSize: 12,
              border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-input)', color: 'var(--text-primary)', textAlign: 'center'
            }}
          />
        </div>
      </div>

      {/* Default playback speed */}
      <div style={{ marginBottom: 24 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: 'var(--text-secondary)' }}>{t('prefs.defaultSpeed')}</h3>
        <select
          value={prefs.defaultPlaybackSpeed}
          onChange={(e) => save({ ...prefs, defaultPlaybackSpeed: parseFloat(e.target.value) })}
          style={{
            padding: '4px 8px', fontSize: 12,
            border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)',
            background: 'var(--bg-input)', color: 'var(--text-primary)', cursor: 'pointer'
          }}
        >
          {SPEED_OPTIONS.map((s) => (
            <option key={s} value={s}>{s}x</option>
          ))}
        </select>
      </div>
    </>
  )
}

/** Paper Size — its own Preferences category. Page size for the PDFs
 *  Magnolia exports. */
function PaperSizeSettings({
  prefs,
  save
}: {
  prefs: Preferences
  save: (updated: Preferences) => void
}) {
  const { t } = useTranslation()
  return (
    <div style={{ marginBottom: 24 }}>
      <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: 'var(--text-secondary)' }}>{t('prefs.cat.paperSize')}</h3>
      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
        {t('prefs.paperSizeText')}
      </p>
      <select
        value={prefs.paperSize}
        onChange={(e) => save({ ...prefs, paperSize: e.target.value as PaperSize })}
        style={{
          padding: '4px 8px', fontSize: 12,
          border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)',
          background: 'var(--bg-input)', color: 'var(--text-primary)', cursor: 'pointer'
        }}
      >
        {PAPER_SIZE_OPTIONS.map((s) => (
          <option key={s} value={s}>{t(`prefs.paper.${s}`)}</option>
        ))}
      </select>
    </div>
  )
}

type UpdateStatus = {
  state: 'checking' | 'up-to-date' | 'available' | 'error' | 'dev-disabled'
  version?: string
  message?: string
}

/** Render the inline result of a manual update check. Colour and wording
 *  track the state reported by the main process over 'update:status'. */
function UpdateStatusLine({ status }: { status: UpdateStatus }) {
  const { t } = useTranslation()
  const map: Record<UpdateStatus['state'], { color: string; text: string }> = {
    checking:      { color: 'var(--text-muted)',   text: t('prefs.status.checking') },
    'up-to-date':  { color: 'var(--success)',      text: status.version ? t('prefs.status.upToDateVersion', { version: status.version }) : t('prefs.status.upToDate') },
    available:     { color: 'var(--accent)',       text: status.version ? t('prefs.status.availableVersion', { version: status.version }) : t('prefs.status.available') },
    error:         { color: 'var(--danger)',       text: t('prefs.status.error', { message: status.message ?? t('prefs.status.unknownError') }) },
    'dev-disabled':{ color: 'var(--text-muted)',   text: t('prefs.status.devDisabled') }
  }
  const { color, text } = map[status.state]
  return <div style={{ fontSize: 11.5, color, marginTop: 12, lineHeight: 1.5 }}>{text}</div>
}

function UpdatesSettings() {
  const { t } = useTranslation()
  const [version, setVersion] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [badge, setBadge] = useState<{ available: boolean; latestVersion: string | null }>({
    available: false,
    latestVersion: null
  })
  const fallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.getAppVersion().then((v) => {
      if (!cancelled) setVersion(v)
    })
    // Initial nudge-badge state + live updates (same source as the toolbar dot).
    window.api.getUpdateBadge().then((s) => {
      if (!cancelled) setBadge({ available: !!s?.available, latestVersion: s?.latestVersion ?? null })
    })
    const offBadge = window.api.onUpdateBadge((s) =>
      setBadge({ available: !!s?.available, latestVersion: s?.latestVersion ?? null })
    )
    // The main process reports the outcome inline (up-to-date / available /
    // error / dev-disabled) rather than via a native dialog.
    const off = window.api.onUpdateStatus((s) => {
      if (fallbackRef.current) clearTimeout(fallbackRef.current)
      setChecking(false)
      setStatus(s)
    })
    return () => {
      cancelled = true
      off()
      offBadge()
      if (fallbackRef.current) clearTimeout(fallbackRef.current)
    }
  }, [])

  const check = useCallback(() => {
    setStatus(null)
    setChecking(true)
    window.api.checkForUpdates()
    // Safety net: a status event should always arrive, but don't leave the
    // spinner stuck forever if one somehow doesn't.
    if (fallbackRef.current) clearTimeout(fallbackRef.current)
    fallbackRef.current = setTimeout(() => setChecking(false), 30000)
  }, [])

  return (
    <div style={{ marginBottom: 24 }}>
      <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: 'var(--text-secondary)' }}>{t('prefs.softwareUpdates')}</h3>
      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.5 }}>
        {t('prefs.updatesText')}
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{t('prefs.currentVersion')}</span>
        <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
          {version ?? '…'}
        </span>
      </div>

      {/* Persistent nudge when a newer release exists. Shown on every build so
          it also catches a silently-failed auto-update; the Download link is
          the reliable path for builds that can't self-update (portable exe).
          The main window routes target=_blank through shell.openExternal. */}
      {badge.available && (
        <div
          style={{
            marginBottom: 16,
            padding: '10px 12px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--accent)',
            background: 'var(--selection-bg)'
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
            {badge.latestVersion ? t('prefs.newVersionNumbered', { version: badge.latestVersion }) : t('prefs.newVersion')}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.5 }}>
            {t('prefs.updateItself')}
          </div>
          <a
            href={RELEASES_URL}
            target="_blank"
            rel="noreferrer"
            style={{
              display: 'inline-block',
              padding: '6px 16px',
              fontSize: 12,
              fontWeight: 600,
              color: '#fff',
              background: 'var(--accent)',
              borderRadius: 'var(--radius-md)',
              textDecoration: 'none'
            }}
          >
            {t('prefs.downloadLatest')}
          </a>
        </div>
      )}

      <button
        className="secondary"
        disabled={checking}
        onClick={check}
        style={{ fontSize: 12, padding: '6px 16px' }}
      >
        {checking ? t('prefs.checking') : t('prefs.checkForUpdates')}
      </button>

      {checking
        ? <UpdateStatusLine status={{ state: 'checking' }} />
        : status && <UpdateStatusLine status={status} />}
    </div>
  )
}

function SupportSettings() {
  const { t } = useTranslation()
  return (
    <div style={{ marginBottom: 24 }}>
      <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: 'var(--text-secondary)' }}>
        {t('prefs.cat.support')}
      </h3>
      <p style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.6 }}>
        {t('prefs.supportText1')}
      </p>
      <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 16, lineHeight: 1.6 }}>
        {t('prefs.supportText2')}
      </p>

      <p style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.6 }}>
        {t('prefs.createdBy')}
      </p>

      {/* The main window's setWindowOpenHandler routes target=_blank links
          through shell.openExternal, so this opens in the default browser. */}
      <a
        href={SPONSOR_URL}
        target="_blank"
        rel="noreferrer"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 18px',
          fontSize: 12.5,
          fontWeight: 600,
          color: '#fff',
          background: 'var(--accent)',
          borderRadius: 'var(--radius-md)',
          textDecoration: 'none'
        }}
      >
        <span aria-hidden style={{ fontSize: 13 }}>♥</span>
        {t('prefs.sponsorOnGithub')}
      </a>

      <p style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 14, fontFamily: 'var(--font-mono)' }}>
        {SPONSOR_URL}
      </p>
    </div>
  )
}

interface PreferencesWindowProps {
  /** Tab-host close callback. When present, the Close button calls
   *  this; otherwise (popout-window mode) it falls back to window.close. */
  onClose?: () => void
}

export function PreferencesWindow({ onClose }: PreferencesWindowProps = {}) {
  const { t } = useTranslation()
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFS)
  const [loaded, setLoaded] = useState(false)
  // Open to a category requested before mount (e.g. the wordmark badge asking
  // for Updates), else the default. Consume-and-clear so a later plain open
  // lands on the default.
  const [selectedCategory, setSelectedCategory] = useState<CategoryId>(() => {
    const requested = pendingCategory
    pendingCategory = null
    return requested ?? CATEGORIES[0].id
  })

  // Switch category live when a request arrives while already mounted (the tab
  // was already open and just refocused, so no remount happens).
  useEffect(() => {
    const listener = (c: CategoryId): void => setSelectedCategory(c)
    categoryListeners.add(listener)
    return () => { categoryListeners.delete(listener) }
  }, [])

  // Load preferences on mount
  useEffect(() => {
    let cancelled = false

    // Preferences live in the main-window tab now (toolbar wordmark →
    // openToolTab). Read once from disk on mount; the previous
    // popped-out window's staged-init / on-refocus paths are gone.
    ;(async () => {
      const data = await window.api.loadPreferences()
      if (cancelled) return
      if (data) {
        setPrefs({
          ...DEFAULT_PREFS,
          ...data,
          theme: normaliseThemeId(data.theme),
          interfaceScale: typeof data.interfaceScale === 'number' ? data.interfaceScale : DEFAULT_PREFS.interfaceScale,
          toolbarStyle: (data.toolbarStyle === 'icons' || data.toolbarStyle === 'ribbon') ? data.toolbarStyle : DEFAULT_PREFS.toolbarStyle,
          colourfulInterface: colourfulInterfaceFromSaved(data.colourfulInterface),
          language: normaliseLanguagePreference(data.language),
          footPedalMappings: { ...DEFAULT_PREFS.footPedalMappings, ...(data.footPedalMappings || {}) }
        })
      }
      setLoaded(true)
    })()

    return () => {
      cancelled = true
    }
  }, [])

  const save = useCallback((updated: Preferences) => {
    setPrefs(updated)
    window.api.savePreferences(updated)
    window.api.sendPreferencesUpdate(updated)
  }, [])

  const updateMapping = useCallback((key: keyof FootPedalMappings, value: string | number) => {
    const updated = { ...prefs, footPedalMappings: { ...prefs.footPedalMappings, [key]: value } }
    save(updated)
  }, [prefs, save])

  const setTheme = useCallback((theme: ThemeId) => {
    const updated = { ...prefs, theme }
    save(updated)
    // Apply locally and broadcast so every other open window updates too.
    document.documentElement.setAttribute('data-theme', theme)
    window.api.broadcastTheme(theme)
  }, [prefs, save])

  const setInterfaceScale = useCallback((interfaceScale: number) => {
    const updated = { ...prefs, interfaceScale }
    save(updated)
    // Apply locally and broadcast so every other open window rezooms too.
    window.api.setZoomFactor(interfaceScale)
    window.api.broadcastZoomFactor(interfaceScale)
  }, [prefs, save])

  const setLanguage = useCallback((language: LanguagePreference) => {
    save({ ...prefs, language })
    // Switch this window, the others and the backend's menus.
    setLanguagePreference(language)
  }, [prefs, save])

  const setToolbarStyle = useCallback((toolbarStyle: ToolbarStyle) => {
    save({ ...prefs, toolbarStyle })
  }, [prefs, save])

  const setColourfulInterface = useCallback((colourfulInterface: boolean) => {
    save({ ...prefs, colourfulInterface })
    // Preferences is a main-window tab, so this applies it to the main
    // window at once; popped-out windows pick it up when next opened.
    document.documentElement.toggleAttribute('data-colourful', colourfulInterface)
  }, [prefs, save])

  if (!loaded) return <div style={{ padding: 20, color: 'var(--text-muted)' }}>{t('common.loading')}</div>

  const selected = CATEGORIES.find((c) => c.id === selectedCategory) ?? CATEGORIES[0]

  return (
    <div
      className="preferences-window"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        fontFamily: 'var(--font-family)',
        fontSize: 'var(--font-size-base)',
        color: 'var(--text-primary)',
        // Inherit the panel surface so the tab matches the analysis
        // tools / query builder / relationships tab.
        overflow: 'hidden'
      }}
    >
      {/* Title row — mirrors the analysis-tools pattern: padding,
          h2 with leading icon, flex spacer, Close button. */}
      <div style={{ padding: '14px 20px 6px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)' }}>
          <Icon icon={faGear} className="analysis-header-icon" style={{ fontSize: 16 }} />
          {t('toolbar.preferences')}
        </h2>
        <div style={{ flex: 1 }} />
        <button
          className="secondary"
          style={{ fontSize: 11, padding: '4px 14px' }}
          onClick={() => (onClose ? onClose() : window.close())}
        >
          {t('common.close')}
        </button>
      </div>

      {/* Body — two-column layout (categories sidebar + selected
          category's settings). Fills remaining height. */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Categories sidebar */}
        <div style={{
          width: 180,
          flexShrink: 0,
          borderRight: '1px solid var(--border-color)',
          padding: '8px 0',
          overflow: 'auto'
        }}>
          {CATEGORIES.map((cat) => {
            const active = cat.id === selectedCategory
            return (
              <div
                key={cat.id}
                onClick={() => setSelectedCategory(cat.id)}
                style={{
                  padding: '6px 20px',
                  fontSize: 12,
                  fontWeight: active ? 600 : 500,
                  color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                  background: active ? 'var(--selection-bg)' : 'transparent',
                  cursor: 'pointer',
                  userSelect: 'none'
                }}
              >
                {t(cat.labelKey)}
              </div>
            )
          })}
        </div>

        {/* Selected category's settings */}
        <div style={{ flex: 1, padding: '14px 20px', overflow: 'auto' }}>
          {selected.id === 'general' && (
            <GeneralSettings prefs={prefs} save={save} onLanguageChange={setLanguage} />
          )}
          {selected.id === 'appearance' && (
            <AppearanceSettings
              value={prefs.theme}
              onChange={setTheme}
              scale={prefs.interfaceScale}
              onScaleChange={setInterfaceScale}
              toolbarStyle={prefs.toolbarStyle}
              onToolbarStyleChange={setToolbarStyle}
              colourful={prefs.colourfulInterface}
              onColourfulChange={setColourfulInterface}
            />
          )}
          {selected.id === 'media-playback' && (
            <MediaPlaybackSettings prefs={prefs} updateMapping={updateMapping} save={save} />
          )}
          {selected.id === 'paper-size' && (
            <PaperSizeSettings prefs={prefs} save={save} />
          )}
          {selected.id === 'updates' && <UpdatesSettings />}
          {selected.id === 'support' && <SupportSettings />}
        </div>
      </div>
    </div>
  )
}
