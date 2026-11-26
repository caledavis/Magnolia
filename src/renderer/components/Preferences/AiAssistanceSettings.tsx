/**
 * Preferences → AI Assistance: letting AI apps on this computer (Claude
 * Desktop, and others that speak the Model Context Protocol) use Magnolia
 * through its connector (src-tauri/src/mcp.rs). Someone with a Claude
 * subscription uses it there, so no API key is needed; each project is
 * still asked first, in its AI Assistance pane.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface Prefs {
  aiAppsEnabled: boolean
}

const heading: React.CSSProperties = { fontSize: 13, fontWeight: 600, marginBottom: 10, color: 'var(--text-secondary)' }
const note: React.CSSProperties = { fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }

export function AiAssistanceSettings<P extends Prefs>({ prefs, save }: { prefs: P; save: (p: P) => void }) {
  const { t } = useTranslation()
  const [claudeFound, setClaudeFound] = useState(false)
  const [settings, setSettings] = useState('')
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => {
    window.api.mcpClaudeDesktopFound().then(setClaudeFound, () => setClaudeFound(false))
    window.api.mcpConnectorSettings().then((v) => setSettings(JSON.stringify(v, null, 2)), () => setSettings(''))
  }, [])
  const toggle = (on: boolean) => {
    save({ ...prefs, aiAppsEnabled: on })
    void window.api.mcpSetEnabled(on)
  }
  const addToClaude = async () => {
    try {
      await window.api.mcpAddToClaudeDesktop()
      setStatus({ ok: true, text: t('ai.apps.added') })
    } catch (err) {
      const code = String(err)
      setStatus({ ok: false, text: code.includes('badClaudeSettings') ? t('ai.apps.badSettings') : code.includes('noClaudeDesktop') ? t('ai.apps.noClaude') : t('ai.apps.addFailed', { detail: code }) })
    }
  }
  return (
    <div style={{ marginBottom: 24, maxWidth: 560 }}>
      <h3 style={heading}>{t('prefs.cat.aiAssistance')}</h3>
      <p style={note}>{t('ai.apps.intro')}</p>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
        <input type="checkbox" checked={prefs.aiAppsEnabled} onChange={(e) => toggle(e.target.checked)} />
        {t('ai.apps.allow')}
      </label>
      {prefs.aiAppsEnabled && (
        <>
          <p style={{ ...note, marginTop: 8 }}>{t('ai.apps.howProjects')}</p>
          {claudeFound && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <button type="button" onClick={addToClaude}>{t('ai.apps.addToClaude')}</button>
            </div>
          )}
          {status && <p role={status.ok ? 'status' : 'alert'} style={{ ...note, color: status.ok ? 'var(--success)' : 'var(--danger)' }}>{status.text}</p>}
          {settings && (
            <details style={{ fontSize: 12 }}>
              <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}>{t('ai.apps.otherApps')}</summary>
              <p style={{ ...note, marginTop: 6 }}>{t('ai.apps.otherAppsText')}</p>
              <pre style={{ fontSize: 11, padding: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', overflowX: 'auto', userSelect: 'text' }}>{settings}</pre>
            </details>
          )}
        </>
      )}
    </div>
  )
}
