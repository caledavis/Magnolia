/**
 * Strip format-specific syntax from a text snippet for display purposes.
 * Used by query results, quotes, and anywhere raw document text is shown.
 */
import type { SourceType } from '../models/types'

/**
 * Remove markdown syntax characters from text, returning clean display text.
 * Handles: **, __, *, _, ~~, `, #, >, -, +, ordered list markers, [], (), !, |, \escapes
 */
function stripMarkdown(text: string): string {
  let result = text
  // Fenced code markers
  result = result.replace(/^```\w*\s*$/gm, '')
  result = result.replace(/^~~~\w*\s*$/gm, '')
  // Images: ![alt](url) → alt
  result = result.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
  // Links: [text](url) → text
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  // Reference links: [text][ref] → text
  result = result.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
  // Reference images: ![alt][ref] → alt
  result = result.replace(/!\[([^\]]*)\]\[[^\]]*\]/g, '$1')
  // Bold: **text** or __text__
  result = result.replace(/\*\*([^*]+)\*\*/g, '$1')
  result = result.replace(/__([^_]+)__/g, '$1')
  // Italic: *text* or _text_
  result = result.replace(/\*([^*]+)\*/g, '$1')
  result = result.replace(/_([^_]+)_/g, '$1')
  // Strikethrough: ~~text~~
  result = result.replace(/~~([^~]+)~~/g, '$1')
  // Inline code: `text`
  result = result.replace(/`([^`]+)`/g, '$1')
  // Headings: # at start of line
  result = result.replace(/^#{1,6}\s+/gm, '')
  // Blockquote: > at start of line
  result = result.replace(/^(?:>\s*)+/gm, '')
  // List markers: -, *, +, or 1. at start of line (with optional indent)
  result = result.replace(/^\s*[\-\*\+]\s/gm, '')
  result = result.replace(/^\s*\d+\.\s/gm, '')
  // Task list checkboxes
  result = result.replace(/\[[ xX]\]\s/g, '')
  // Horizontal rules
  result = result.replace(/^[-*_]{3,}\s*$/gm, '')
  // Backslash escapes: \* → *
  result = result.replace(/\\([\\`*_{}[\]()#+\-.!~|])/g, '$1')
  // Angle bracket autolinks: <url> → url
  result = result.replace(/<(https?:\/\/[^>]+)>/g, '$1')
  // Clean up multiple blank lines
  result = result.replace(/\n{3,}/g, '\n\n')
  return result.trim()
}

/**
 * Strip formatting syntax from text based on source type.
 * Returns clean display text suitable for UI snippets.
 */
export function stripFormatting(text: string, sourceType?: SourceType): string {
  if (!sourceType || sourceType === 'text') return text
  if (sourceType === 'markdown' || sourceType === 'note') return stripMarkdown(text)
  if (sourceType === 'pdf') return text // PDF extracted text is already clean
  if (sourceType === 'audio') return text // Audio transcript text is already clean
  return text
}
