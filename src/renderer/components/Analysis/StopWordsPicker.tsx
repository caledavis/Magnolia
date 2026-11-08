/**
 * The "Stop words" select above a Leave out box: shows which language's
 * stop words the box holds ("Custom" once edited) and fills the box with
 * another language's list, for texts in a language other than the
 * interface's. Languages are named in the interface language by the
 * browser (Intl.DisplayNames), so a new list needs no translations.
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { compareText } from '../../i18n'
import { STOP_WORD_LANGUAGES, stopWordsLanguageOf, stopWordsText, type StopWordLanguage } from './stop-words'

export function StopWordsPicker({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const { t, i18n } = useTranslation()
  const current = stopWordsLanguageOf(value)
  const options = useMemo(() => {
    const names = new Intl.DisplayNames([i18n.language], { type: 'language' })
    return STOP_WORD_LANGUAGES
      .map((id) => ({ id, name: names.of(id) ?? id }))
      .sort((a, b) => compareText(a.name, b.name))
  }, [i18n.language])
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
      {t('words.stopWordsLanguage')}
      <select
        value={current ?? ''}
        onChange={(e) => { if (e.target.value) onChange(stopWordsText(e.target.value as StopWordLanguage)) }}
        style={{ padding: '2px 4px', fontSize: 11 }}
      >
        {current === null && <option value="">{value.trim() ? t('words.stopWordsCustom') : t('words.stopWordsNone')}</option>}
        {options.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
      </select>
    </label>
  )
}
