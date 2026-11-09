/**
 * No interface text is written straight into the components: every word a
 * person reads goes through t() so it can be translated. Reads each .tsx
 * file with the TypeScript parser and reports text between tags, text
 * attributes (title, placeholder, aria-label, alt, label) and string
 * literals placed directly in JSX that contain words.
 *
 * Text that should stay as written (a symbol, a unit) can be allowed with
 * an `i18n-ignore` comment on the line or the line above.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

/** Names and symbols that are the same in every language. */
const SAME_EVERYWHERE = ['Magnolia', 'PDF', 'CSV', 'SVG', 'PNG', 'QDPX', 'AND', 'OR', 'NOT', 'XOR', 'px', 'Aa']
const TEXT_ATTRIBUTES = new Set(['title', 'placeholder', 'aria-label', 'aria-description', 'aria-roledescription', 'aria-valuetext', 'alt', 'label'])

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', times: '×', hellip: '…', mdash: '—', ndash: '–', bull: '•' }
const decode = (s: string): string => s.replace(/&(#\d+|\w+);/g, (m, e: string) => (e.startsWith('#') ? String.fromCodePoint(+e.slice(1)) : ENTITIES[e] ?? m))
const sameEverywhere = new RegExp(`(?<!\\p{L})(${SAME_EVERYWHERE.join('|')})(?!\\p{L})`, 'gu')
const hasWords = (s: string): boolean => /\p{L}{2,}/u.test(decode(s).replace(sameEverywhere, ''))

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : path.endsWith('.tsx') ? [path] : []
  })
}

/** The string literals an expression can produce: `a ? 'x' : 'y'`, `'x'`,
 *  `` `x ${y}` ``, `c && 'x'`, `a || 'x'`. */
function literals(e: ts.Expression | undefined): string[] {
  if (!e) return []
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text]
  if (ts.isTemplateExpression(e)) return [[e.head.text, ...e.templateSpans.map((s) => s.literal.text)].join(' ')]
  if (ts.isParenthesizedExpression(e)) return literals(e.expression)
  if (ts.isConditionalExpression(e)) return [...literals(e.whenTrue), ...literals(e.whenFalse)]
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return literals(e.right)
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.PlusToken) return [...literals(e.left), ...literals(e.right)]
  }
  return []
}

/** Text in a component a person would read untranslated, as "line: text". */
function untranslated(source: string, file = 'component.tsx'): string[] {
  const lines = source.split('\n')
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[] = []
  const report = (node: ts.Node, text: string): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart()).line
    if (/i18n-ignore/.test(lines[line]) || /i18n-ignore/.test(lines[line - 1] ?? '')) return
    found.push(`${line + 1}: ${text.trim().replace(/\s+/g, ' ').slice(0, 80)}`)
  }
  const isStyleElement = (n: ts.Node): boolean => ts.isJsxElement(n) && n.openingElement.tagName.getText() === 'style'
  const visit = (node: ts.Node): void => {
    if (isStyleElement(node)) return
    if (ts.isJsxText(node) && hasWords(node.text)) report(node, node.text)
    if (ts.isJsxAttribute(node) && TEXT_ATTRIBUTES.has(node.name.getText()) && node.initializer) {
      const init = node.initializer
      const texts = ts.isStringLiteral(init) ? [init.text] : ts.isJsxExpression(init) ? literals(init.expression) : []
      for (const text of texts) if (hasWords(text)) report(node, `${node.name.getText()}="${text}"`)
    }
    if (ts.isJsxExpression(node) && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      for (const text of literals(node.expression)) if (hasWords(text)) report(node, text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

describe('interface text', () => {
  const files = filesUnder('src/renderer')

  it('finds the components', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it('goes through t() in every component', () => {
    const found = files.flatMap((f) => untranslated(readFileSync(f, 'utf-8'), f).map((s) => `${f}:${s}`))
    expect(found, 'text to put in src/renderer/locales/en.json and show with t()').toEqual([])
  })

  it('is found when written straight into a component', () => {
    const sample = (tsx: string): string[] => untranslated(tsx)
    expect(sample('const a = <div>Save &amp; Close</div>')).toHaveLength(1)
    expect(sample(`const a = <input placeholder={ok ? 'word' : t('x')} />`)).toHaveLength(1)
    expect(sample(`const a = <div>{busy ? 'Saving…' : t('x')}</div>`)).toHaveLength(1)
    expect(sample(`const a = <div title={t('x')}>{t('y')} PDF · 12px</div>`)).toHaveLength(0)
    expect(sample('const a = <style>{`.a { color: red }`}</style>')).toHaveLength(0)
    expect(sample('const a = <div>\n  {/* i18n-ignore */}\n  Aaa\n</div>')).toHaveLength(0)
  })
})
