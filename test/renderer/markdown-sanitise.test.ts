// @vitest-environment jsdom
/**
 * Markdown from projects (memos, code descriptions, logbook entries) is
 * shown as HTML, and projects are shared: nothing in it may run as script.
 */
import { describe, expect, it } from 'vitest'
import { markdownToHtml } from '../../src/renderer/components/Markdown'

const ATTACKS = [
  '<img src=x onerror="alert(1)">',
  '<script>alert(1)</script>',
  '[click](javascript:alert(1))',
  '<a href="javascript:alert(1)">x</a>',
  '<iframe src="https://example.com"></iframe>',
  '<svg><script>alert(1)</script></svg>',
  '<svg onload="alert(1)"></svg>',
  '<math><mtext><img src=x onerror=alert(1)></mtext></math>',
  '<details open ontoggle="alert(1)">x</details>',
  '<object data="x"></object><embed src="x">',
  '<form action="https://example.com"><input name=a><button>Go</button></form>',
  '<div style="position:fixed;inset:0">cover</div>',
  '<style>body{display:none}</style>',
  '<a href="data:text/html,<script>alert(1)</script>">x</a>',
  '<base href="https://example.com/">',
  '<meta http-equiv="refresh" content="0;url=https://example.com">'
]

describe('markdownToHtml', () => {
  for (const attack of ATTACKS) {
    it(`neutralises ${attack.slice(0, 40)}`, () => {
      const html = markdownToHtml(attack).toLowerCase()
      expect(html).not.toMatch(/<script|<iframe|<object|<embed|<form|<input|<button|<style|<base|<meta|<svg|<math/)
      expect(html).not.toMatch(/\son[a-z]+\s*=/)
      expect(html).not.toMatch(/javascript:|data:text\/html/)
      expect(html).not.toMatch(/style=/)
    })
  }

  it('keeps ordinary formatting', () => {
    const html = markdownToHtml('# Title\n\n**bold** _it_ `code`\n\n- one\n- two\n\n[site](https://example.com)\n\n| a | b |\n|---|---|\n| 1 | 2 |')
    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>it</em>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<li>one</li>')
    expect(html).toContain('<a href="https://example.com">site</a>')
    expect(html).toContain('<table>')
  })

  it('keeps line breaks and empty input', () => {
    expect(markdownToHtml('a\nb')).toContain('<br>')
    expect(markdownToHtml('')).toBe('')
  })
})
