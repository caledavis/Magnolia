/**
 * Says why a recording won't play, in place of a player that otherwise
 * just sits there. The webview decides what it can play. On Linux that's
 * the system's GStreamer codecs, which a fresh install may lack (H.264 and
 * AAC, as phones and Zoom record, need gstreamer1.0-libav), so there the
 * notice says what to install, except in the AppImage: it plays with the
 * codecs it carries and can't use the system's, so the notice suggests the
 * .deb or .rpm, which can.
 */
import { useTranslation } from 'react-i18next'

/** The player's error, or null: aborted loads (a new source) aren't one. */
export function playErrorOf(el: HTMLMediaElement): MediaError | null {
  const error = el.error
  return error && error.code !== MediaError.MEDIA_ERR_ABORTED ? error : null
}

export function MediaPlayError() {
  const { t } = useTranslation()
  return (
    <div
      role="alert"
      style={{
        flexShrink: 0,
        padding: '8px 12px',
        fontSize: 'var(--font-size-sm)',
        lineHeight: 1.45,
        color: 'var(--text-primary)',
        background: 'var(--bg-panel)',
        borderBottom: '1px solid var(--border-color)'
      }}
    >
      <strong>{t('media.cantPlay')}</strong>
      {window.api.platform === 'linux' && <> {t(window.__MAGNOLIA_APPIMAGE__ ? 'media.cantPlayAppImage' : 'media.cantPlayLinux')}</>}
    </div>
  )
}
