import { describe, expect, it } from 'vitest'
import { LANGUAGE_IDS } from '../../src/renderer/i18n'
import { stopWords, stopWordsText, stopWordsLanguageOf, type StopWordLanguage } from '../../src/renderer/components/Analysis/stop-words'
import { countWords, wordFilter } from '../../src/renderer/components/Analysis/word-counts'

describe('stop words', () => {
  it('has a list for every interface language, in lower case', () => {
    for (const id of LANGUAGE_IDS) {
      const list = stopWords(id)
      expect(list.length, id).toBeGreaterThan(100)
      for (const w of list) expect(w, `${id} ${w}`).toBe(w.toLowerCase())
    }
  })

  it('leaves out each language\'s common words', () => {
    const count = (id: StopWordLanguage, text: string) =>
      [...countWords([text], wordFilter('', stopWordsText(id))).keys()]
    expect(count('es', 'Creo que la escuela no está muy bien para los estudiantes')).toEqual(['creo', 'escuela', 'estudiantes'])
    expect(count('nl', 'Ik vind dat de school niet zo goed is voor de leerlingen')).toEqual(['vind', 'school', 'goed', 'leerlingen'])
    expect(count('pt-BR', 'Eu acho que a escola não é muito boa para os alunos')).toEqual(['acho', 'escola', 'boa', 'alunos'])
    expect(count('ar', 'أعتقد أن المدرسة ليست جيدة جدا للطلاب في هذه المدينة')).toEqual(['أعتقد', 'المدرسة', 'جيدة', 'للطلاب', 'المدينة'])
  })

  it('names the language a Leave out box holds, until it is edited', () => {
    expect(stopWordsLanguageOf(stopWordsText('nl'))).toBe('nl')
    expect(stopWordsLanguageOf(stopWordsText('ar'))).toBe('ar')
    expect(stopWordsLanguageOf(stopWords('es').reverse().join('\n'))).toBe('es')
    expect(stopWordsLanguageOf(stopWordsText('en') + ', interview')).toBeNull()
    expect(stopWordsLanguageOf('')).toBeNull()
  })
})
