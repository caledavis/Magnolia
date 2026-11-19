/**
 * Checks a query's condition tree before it runs, for the Query Builder.
 * Kept out of query-engine.ts so the query worker, which imports the
 * engine, doesn't pull in i18n and every language's catalogue with it.
 */
import type { CodeCondition } from '../models/types'
import { t } from '../i18n'
import { isAllTextCondition } from './query-engine'

/** Validate a condition tree; returns an error message or null */
export function validateCondition(cond: CodeCondition, nested = false): string | null {
  if (cond.type === 'sameSentence' && nested) {
    return t('queryValidate.sameSentence')
  }
  if (cond.type === 'and' || cond.type === 'xor') {
    if (cond.conditions.every((c) => isAllTextCondition(c))) {
      return t('queryValidate.textOnlyOr')
    }
    for (const c of cond.conditions) {
      const err = validateCondition(c, true)
      if (err) return err
    }
  }
  if (cond.type === 'or') {
    for (const c of cond.conditions) {
      const err = validateCondition(c, true)
      if (err) return err
    }
  }
  if (cond.type === 'not') {
    return validateCondition(cond.condition, true)
  }
  if ('condition1' in cond && 'condition2' in cond) {
    const c = cond as { condition1: CodeCondition; condition2: CodeCondition }
    return validateCondition(c.condition1, true) || validateCondition(c.condition2, true)
  }
  return null
}
