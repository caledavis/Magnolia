import { afterEach, describe, expect, it } from 'vitest'
import { i18n, t, formatPercent, formatFixed, formatNumber, compareText, isRtlLanguage, digitChoices, resolveNumbering } from '../../src/renderer/i18n'
import { sentencesOf } from '../../src/renderer/components/Analysis/word-counts'

afterEach(() => { void i18n.changeLanguage('en') })

describe('numbers in the interface language', () => {
  it('writes numbers put into messages as the language does', () => {
    expect(t('memos.nSelected', { count: 1234 })).toBe('1,234 memos selected.')
    void i18n.changeLanguage('nl')
    expect(t('memos.nSelected', { count: 1234 })).toBe("1.234 memo's geselecteerd.")
    void i18n.changeLanguage('pt-BR')
    expect(t('memos.nSelected', { count: 1234 })).toBe('1.234 memos selecionados.')
  })

  it('leaves text and respondent ids alone', () => {
    void i18n.changeLanguage('nl')
    expect(t('survey.respondentId', { id: 12345 })).toContain('12345')
    expect(t('app.progressOf', { current: '1x', total: 2 })).toBe('1x / 2')
  })

  it('formats percentages and decimals', () => {
    expect(formatPercent(12.5)).toBe('12.5%')
    expect(formatFixed(3.14159, 2)).toBe('3.14')
    void i18n.changeLanguage('es')
    expect(formatPercent(12.5).replace(/\s/g, ' ')).toBe('12,5 %')
    expect(formatFixed(3.14159, 2)).toBe('3,14')
    void i18n.changeLanguage('nl')
    expect(formatPercent(12.5)).toBe('12,5%')
    expect(formatNumber(1234567)).toBe('1.234.567')
  })

  it('sorts names in the language\'s alphabetical order', () => {
    expect(['b', 'Á', 'a', 'item 10', 'item 2'].sort(compareText)).toEqual(['a', 'Á', 'b', 'item 2', 'item 10'])
  })
})

describe('writing direction and sentences', () => {
  it('knows which languages are written right to left', () => {
    for (const l of ['ar', 'fa', 'he', 'ur', 'ar-EG']) expect(isRtlLanguage(l), l).toBe(true)
    for (const l of ['en', 'zh-Hans', 'ru', 'hi', 'pt-BR', 'nonsense!']) expect(isRtlLanguage(l), l).toBe(false)
  })

  it('ends sentences at Arabic and Devanagari marks', () => {
    expect(sentencesOf('هل هذا كافٍ؟ نعم.')).toEqual(['هل هذا كافٍ؟', 'نعم.'])
    expect(sentencesOf('यह अच्छा है। वह भी।')).toEqual(['यह अच्छा है।', 'वह भी।'])
  })
})

describe('digits', () => {
  it('offers a choice only where a language has one', () => {
    expect(digitChoices('ar')).toEqual(['latn', 'arab'])
    expect(digitChoices('en')).toEqual(['latn'])
    expect(digitChoices('nl')).toEqual(['latn'])
  })

  it('follows the computer, or the choice made', () => {
    expect(resolveNumbering('ar', 'system', 'ar_EG')).toBe('arab')
    expect(resolveNumbering('ar', 'system', 'ar_MA')).toBeNull()
    expect(resolveNumbering('ar', 'system', 'ar_EG@numbers=latn')).toBeNull()
    expect(resolveNumbering('ar', 'system', 'en_AU')).toBeNull()
    expect(resolveNumbering('ar', 'arab', 'en_AU')).toBe('arab')
    expect(resolveNumbering('ar', 'latn', 'ar_EG')).toBeNull()
    expect(resolveNumbering('en', 'arab', 'ar_EG')).toBeNull()
  })
})
