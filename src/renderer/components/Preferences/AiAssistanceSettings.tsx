/**
 * Preferences → AI Assistance: which AI service to use, its address, its
 * model, and its key. The key goes straight to the system's keychain (see
 * src-tauri/src/ai.rs) and is never shown again or written to the
 * preferences file; Magnolia only knows whether one is saved.
 *
 * Nothing is sent anywhere from here except a request for the service's
 * list of models (no project data): each project is turned on separately,
 * in the AI Assistance pane.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AiProviderSetting } from '../../stores/preferences-store'
import { PROVIDER_PRESETS, isLocalAddress } from '../../utils/ai/providers'
import { aiErrorMessage } from '../../utils/ai/errors'
import type { AiError } from '../../models/types'

interface Prefs {
  aiProvider: AiProviderSetting | null
}

const heading: React.CSSProperties = { fontSize: 13, fontWeight: 600, marginBottom: 10, color: 'var(--text-secondary)' }
const note: React.CSSProperties = { fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }
const field: React.CSSProperties = {
  width: 320, padding: '4px 8px', fontSize: 12,
  border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-input)', color: 'var(--text-primary)'
}
const label: React.CSSProperties = { display: 'block', fontSize: 12, color: 'var(--text-secondary)', margin: '12px 0 4px' }

export function AiAssistanceSettings<P extends Prefs>({ prefs, save }: { prefs: P; save: (p: P) => void }) {
  const { t } = useTranslation()
  const ai = prefs.aiProvider
  const preset = PROVIDER_PRESETS.find((p) => p.id === ai?.preset)
  const local = !!ai && isLocalAddress(ai.baseUrl)

  const [keySaved, setKeySaved] = useState<boolean | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [keyError, setKeyError] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'busy'; text: string } | null>(null)

  const setAi = (next: AiProviderSetting | null) => save({ ...prefs, aiProvider: next })

  // Whether this address has a key (asked again when the address changes).
  const baseUrl = ai?.baseUrl ?? ''
  useEffect(() => {
    let cancelled = false
    setKeySaved(null)
    setModels([])
    setStatus(null)
    if (!baseUrl) return
    window.api.aiKeySaved(baseUrl).then(
      (saved) => { if (!cancelled) setKeySaved(saved) },
      () => { if (!cancelled) setKeySaved(false) }
    )
    return () => { cancelled = true }
  }, [baseUrl])

  const choosePreset = (id: string) => {
    if (!id) return setAi(null)
    const p = PROVIDER_PRESETS.find((x) => x.id === id)!
    setAi({ preset: p.id, kind: p.kind, baseUrl: p.baseUrl, model: p.suggestedModel ?? '' })
  }

  const saveKey = async (key: string) => {
    if (!ai) return
    setKeyError('')
    try {
      await window.api.aiKeySet(ai.baseUrl, key)
      setKeySaved(key.trim().length > 0)
      setKeyDraft('')
    } catch (err) {
      setKeyError(aiErrorMessage(err as AiError, t))
    }
  }

  // Asking for the list of models is also the test that the service, the
  // address and the key all work.
  const check = async () => {
    if (!ai) return
    setStatus({ kind: 'busy', text: t('ai.prefs.checking') })
    try {
      const list = await window.api.aiModels({ kind: ai.kind, baseUrl: ai.baseUrl, model: ai.model })
      setModels(list)
      setStatus({ kind: 'ok', text: t('ai.prefs.connected', { count: list.length }) })
      if (!ai.model && list.length > 0) setAi({ ...ai, model: list[0] })
    } catch (err) {
      setStatus({ kind: 'error', text: aiErrorMessage(err as AiError, t) })
    }
  }

  return (
    <div style={{ marginBottom: 24, maxWidth: 560 }}>
      <h3 style={heading}>{t('prefs.cat.aiAssistance')}</h3>
      <p style={note}>{t('ai.prefs.intro')}</p>
      <p style={note}>{t('ai.prefs.privacy')}</p>

      <label style={label} htmlFor="ai-service">{t('ai.prefs.service')}</label>
      <select
        id="ai-service"
        value={ai?.preset ?? ''}
        onChange={(e) => choosePreset(e.target.value)}
        style={{ ...field, cursor: 'pointer' }}
      >
        <option value="">{t('ai.prefs.none')}</option>
        {PROVIDER_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.id === 'custom' ? t('ai.prefs.custom') : p.local ? t('ai.prefs.onThisComputer', { name: p.name }) : p.name}
          </option>
        ))}
      </select>

      {ai && (
        <>
          {ai.preset === 'custom' && (
            <>
              <label style={label} htmlFor="ai-kind">{t('ai.prefs.kind')}</label>
              <select id="ai-kind" value={ai.kind} onChange={(e) => setAi({ ...ai, kind: e.target.value as 'anthropic' | 'openai' })} style={{ ...field, cursor: 'pointer' }}>
                <option value="openai">{t('ai.prefs.kindOpenai')}</option>
                <option value="anthropic">{t('ai.prefs.kindAnthropic')}</option>
              </select>
            </>
          )}

          <label style={label} htmlFor="ai-address">{t('ai.prefs.address')}</label>
          <input
            id="ai-address"
            type="url"
            value={ai.baseUrl}
            placeholder="https://…"
            spellCheck={false}
            onChange={(e) => setAi({ ...ai, baseUrl: e.target.value.trim() })}
            style={field}
          />
          {local && <p style={{ ...note, marginTop: 4 }}>{t('ai.prefs.localNote')}</p>}

          <label style={label} htmlFor="ai-key">{local ? t('ai.prefs.keyOptional') : t('ai.prefs.key')}</label>
          {keySaved ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <span>{t('ai.prefs.keySaved')}</span>
              <button type="button" className="secondary" onClick={() => saveKey('')}>{t('ai.prefs.removeKey')}</button>
            </div>
          ) : (
            <form
              style={{ display: 'flex', gap: 8 }}
              onSubmit={(e) => { e.preventDefault(); if (keyDraft.trim()) void saveKey(keyDraft) }}
            >
              <input
                id="ai-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                style={{ ...field, width: 240 }}
              />
              <button type="submit" disabled={!keyDraft.trim()}>{t('ai.prefs.saveKey')}</button>
            </form>
          )}
          {keyError && <p role="alert" style={{ ...note, color: 'var(--danger)', marginTop: 4 }}>{keyError}</p>}
          {!keySaved && preset?.keyUrl && (
            <p style={{ ...note, marginTop: 4 }}>
              <a href={preset.keyUrl}>{t('ai.prefs.getKey', { name: preset.name })}</a> {t('ai.prefs.keyCost')}
            </p>
          )}
          {!local && <p style={{ ...note, marginTop: 4 }}>{t('ai.prefs.keyKept')}</p>}

          <label style={label} htmlFor="ai-model">{t('ai.prefs.model')}</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              id="ai-model"
              list="ai-models"
              value={ai.model}
              spellCheck={false}
              onChange={(e) => setAi({ ...ai, model: e.target.value.trim() })}
              style={{ ...field, width: 240 }}
            />
            <datalist id="ai-models">
              {models.map((m) => <option key={m} value={m} />)}
            </datalist>
            <button type="button" className="secondary" onClick={check} disabled={status?.kind === 'busy'}>
              {t('ai.prefs.check')}
            </button>
          </div>
          {status && (
            <p
              role={status.kind === 'error' ? 'alert' : 'status'}
              style={{ ...note, marginTop: 6, color: status.kind === 'error' ? 'var(--danger)' : status.kind === 'ok' ? 'var(--success)' : undefined }}
            >
              {status.text}
            </p>
          )}
        </>
      )}
    </div>
  )
}
