import { describe, expect, it } from 'vitest'
// @ts-expect-error -- a plain .mjs script, without type declarations
import { buildWorkbook, readWorkbook, placeholders } from '../../scripts/translation-review.mjs'

describe('translation review spreadsheets', () => {
  it('read back what they were written with, in any script', async () => {
    const rows = [['Key', 'English', 'Translation'], ['a.b', 'Delete {{count}} memos', 'حذف {{count}} مذكرات'], ['c', 'Line one\nline two & <b>three</b>', '一行 "引号"']]
    const buf = await buildWorkbook([{ name: 'Translations', rows, widths: [10, 10, 10] }])
    const book = await readWorkbook(buf)
    expect(book.Translations).toEqual(rows)
  })

  it('compare placeholders by name', () => {
    expect(placeholders('{{b}} and {{ a }}')).toEqual(['a', 'b'])
  })
})
