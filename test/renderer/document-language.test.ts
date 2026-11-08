import { describe, expect, it } from 'vitest'
import { withDocumentLanguage } from '../../src/renderer/utils/document-language'

const root = (lang: string, dir: string) => ({ lang, dir }) as HTMLElement

describe('exported documents', () => {
  it('take the interface language and direction', () => {
    const out = withDocumentLanguage('<!DOCTYPE html>\n<html><head><title>x</title></head><body></body></html>', root('ar', 'rtl'))
    expect(out).toContain('<html lang="ar" dir="rtl">')
    expect(out).toContain('unicode-bidi: plaintext')
  })

  it('keep a direction or language the document already has', () => {
    expect(withDocumentLanguage('<html lang="fr" dir="ltr"><head></head></html>', root('ar', 'rtl'))).toContain('<html lang="fr" dir="ltr">')
    expect(withDocumentLanguage('<html lang="fr"><head></head></html>', root('ar', 'rtl'))).toContain('<html dir="rtl" lang="fr">')
  })
})
