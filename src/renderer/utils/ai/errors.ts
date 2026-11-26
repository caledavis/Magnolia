/** What went wrong talking to an AI service, in the user's language. */
import type { TFunction } from 'i18next'
import type { AiError } from '../../models/types'

const KNOWN = ['tooManySteps', 'noKey', 'auth', 'notFound', 'rateLimit', 'overloaded', 'unreachable', 'badAddress', 'keychain', 'cancelled']

export function aiErrorMessage(err: AiError | string | unknown, t: TFunction): string {
  const e = typeof err === 'object' && err && 'code' in err ? (err as AiError) : { code: 'provider', detail: String(err ?? '') }
  const code = KNOWN.includes(e.code) ? e.code : 'provider'
  const text = t(`ai.error.${code}`)
  // The service's own words, where they add something.
  return e.detail && code !== 'noKey' && code !== 'cancelled' ? `${text} (${e.detail})` : text
}
