/**
 * The "Stop words" select above a Leave out box: shows which language's
 * stop words the box holds ("Custom" once edited) and fills the box with
 * another language's list, for texts in a language other than the
 * interface's.
 */
import { useTranslation } from 'react-i18next'
import { LANGUAGE_IDS, type LanguageId } from '../../i18n'
import { stopWordsLanguageOf, stopWordsText } from './stop-words'

export function StopWordsPicker({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const { t } = useTranslation()
  const current = stopWordsLanguageOf(value, LANGUAGE_IDS)
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
      {t('words.stopWordsLanguage')}
      <select
        value={current ?? ''}
        onChange={(e) => { if (e.target.value) onChange(stopWordsText(e.target.value as LanguageId)) }}
        style={{ padding: '2px 4px', fontSize: 11 }}
      >
        {current === null && <option value="">{value.trim() ? t('words.stopWordsCustom') : t('words.stopWordsNone')}</option>}
        {LANGUAGE_IDS.map((id) => <option key={id} value={id}>{t(`language.name.${id}`)}</option>)}
      </select>
    </label>
  )
}
