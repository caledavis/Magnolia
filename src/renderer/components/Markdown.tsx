import { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({
  breaks: true,    // Convert \n to <br>
  gfm: true        // GitHub-flavoured markdown (tables, strikethrough, etc.)
})

/**
 * Markdown → HTML that is safe to put in the page. marked passes any HTML
 * written in the Markdown straight through, and this text comes from
 * projects (memos, code descriptions, logbook entries), which people
 * share: without sanitising, `<img onerror="…">` in a memo would run as
 * script in Magnolia. Formatting survives; scripts, event handlers,
 * javascript: links, embedded frames, forms and inline styles don't.
 */
export function markdownToHtml(text: string): string {
  if (!text) return ''
  const html = marked.parse(text, { async: false }) as string
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'option'],
    FORBID_ATTR: ['style']
  })
}

interface Props {
  text: string
  className?: string
  style?: React.CSSProperties
}

/**
 * Renders a markdown string as sanitised HTML (see markdownToHtml).
 * Used for code memos and similar user-authored rich text.
 */
export function Markdown({ text, className, style }: Props) {
  const html = useMemo(() => markdownToHtml(text), [text])

  return (
    <div
      className={`markdown-content ${className ?? ''}`}
      style={style}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
