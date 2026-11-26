/**
 * The AI services AI Assistance offers in Preferences. Each is one of two
 * kinds of API (see src-tauri/src/ai.rs): Anthropic's, or the
 * OpenAI-compatible one most others speak. "Local" ones run on this
 * computer, so nothing in the project leaves it, and need no key.
 */
import type { AiProviderSetting } from '../../stores/preferences-store'

export interface ProviderPreset {
  id: string
  /** Shown as is: these are products' names. */
  name: string
  kind: 'anthropic' | 'openai'
  baseUrl: string
  local: boolean
  /** Where to get a key, for a service that needs one. */
  keyUrl?: string
  /** A model to start with, if the list can't be fetched. */
  suggestedModel?: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'anthropic', name: 'Anthropic (Claude)', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', local: false, keyUrl: 'https://console.anthropic.com/settings/keys', suggestedModel: 'claude-sonnet-5-5' },
  { id: 'openai', name: 'OpenAI (ChatGPT)', kind: 'openai', baseUrl: 'https://api.openai.com/v1', local: false, keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'gemini', name: 'Google Gemini', kind: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', local: false, keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', local: false, keyUrl: 'https://openrouter.ai/keys' },
  { id: 'ollama', name: 'Ollama', kind: 'openai', baseUrl: 'http://localhost:11434/v1', local: true },
  { id: 'lmstudio', name: 'LM Studio', kind: 'openai', baseUrl: 'http://localhost:1234/v1', local: true },
  { id: 'custom', name: '', kind: 'openai', baseUrl: '', local: false }
]

export function presetOf(setting: AiProviderSetting | null): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === setting?.preset)
}

/** Whether an address is this computer. */
export function isLocalAddress(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
}

/** The address data goes to (scheme, host, port), as the user sees it. */
export function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin.toLowerCase()
  } catch {
    return baseUrl
  }
}

/** The provider's name for messages: the preset's, else its host. */
export function providerName(setting: AiProviderSetting): string {
  const preset = presetOf(setting)
  if (preset?.name) return preset.name
  try {
    return new URL(setting.baseUrl).host
  } catch {
    return setting.baseUrl
  }
}
