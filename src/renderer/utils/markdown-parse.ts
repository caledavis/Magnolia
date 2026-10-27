/**
 * Comprehensive markdown parser using `marked` lexer for full CommonMark + GFM support.
 * Walks the AST token tree and produces codepoint-range annotations for rendering.
 *
 * Each annotation marks a range of the original source text as either:
 * - `hidden`: syntax chars that should be visually hidden (zero-width)
 * - styled: content that should receive formatting (bold, italic, heading, etc.)
 */
import { marked, Marked, type Token } from 'marked'

/* ── Public types ── */

export interface MdAnnotation {
  cpStart: number
  cpEnd: number
  style: string           // CSS class name or inline style key
  hidden?: boolean        // if true, render as zero-width
}

export interface MdLineAnnotation {
  /** CSS class for the line container (heading, blockquote, list, code, etc.) */
  blockClass: string
  /** Inline annotations for ranges within this line */
  inline: MdAnnotation[]
}

/* ── Main entry point ── */

/** A lexer without setext headings ("Title" underlined with --- or ===).
 *  Used for notes, which are written in place: a "-" typed under a line
 *  to start a list would otherwise turn that line into a heading. */
const noSetextLexer = new Marked({ tokenizer: { lheading: () => undefined } })

/**
 * Parse full markdown text and return per-line annotations.
 * Each line index maps to block-level class + inline range annotations.
 *
 * Notes pass `setextHeadings: false` (see noSetextLexer) and
 * `showListMarkers: true` — a note's list keeps its "-" / "1." visible,
 * since nothing else would mark it as a list once the caret moves on.
 */
export function parseMarkdownDocument(
  text: string,
  opts?: { setextHeadings?: boolean; showListMarkers?: boolean }
): MdLineAnnotation[] {
  const lines = text.split('\n')
  const lineCount = lines.length
  const result: MdLineAnnotation[] = Array.from({ length: lineCount }, () => ({
    blockClass: '',
    inline: []
  }))

  // Compute codepoint offset of each line start
  const lineOffsets: number[] = []
  let cpOff = 0
  for (const line of lines) {
    lineOffsets.push(cpOff)
    cpOff += [...line].length + 1 // +1 for \n
  }

  // Find which line a character offset falls on
  function lineAt(charOffset: number): number {
    let off = 0
    for (let i = 0; i < lines.length; i++) {
      const lineLen = lines[i].length + 1 // include \n
      if (charOffset < off + lineLen) return i
      off += lineLen
    }
    return lines.length - 1
  }

  // Get codepoint offset from character offset in the full text
  function cpAt(charOffset: number): number {
    return [...text.slice(0, charOffset)].length
  }

  // Parse with marked
  const tokens = opts?.setextHeadings === false ? noSetextLexer.lexer(text) : marked.lexer(text)

  // Walk tokens and annotate
  walkTokens(tokens, 0)

  function walkTokens(tokens: Token[], searchFrom: number): void {
    for (const token of tokens) {
      processToken(token, searchFrom)
      // Update searchFrom to after this token's raw text
      const idx = text.indexOf(token.raw, searchFrom)
      if (idx !== -1) searchFrom = idx + token.raw.length
    }
  }

  function processToken(token: Token, searchFrom: number): void {
    const rawIdx = text.indexOf(token.raw, searchFrom)
    if (rawIdx === -1) return
    const rawEnd = rawIdx + token.raw.length

    switch (token.type) {
      case 'heading': {
        const line = lineAt(rawIdx)
        result[line].blockClass = `md-heading-${(token as any).depth}`
        // Hide the # prefix
        const hashes = (token as any).depth
        const cpStart = cpAt(rawIdx)
        result[line].inline.push({ cpStart, cpEnd: cpStart + hashes + 1, style: 'syntax', hidden: true })
        // Process inline content
        if ((token as any).tokens) {
          walkInlineTokens((token as any).tokens, rawIdx + hashes + 1, line)
        }
        break
      }

      case 'paragraph': {
        const line = lineAt(rawIdx)
        if ((token as any).tokens) {
          walkInlineTokens((token as any).tokens, rawIdx, line)
        }
        break
      }

      case 'blockquote': {
        // Mark each line in the blockquote
        const bqLines = token.raw.split('\n')
        let pos = rawIdx
        for (const bqLine of bqLines) {
          if (bqLine.length === 0) { pos++; continue }
          const ln = lineAt(pos)
          result[ln].blockClass = 'md-blockquote'
          // Hide > prefix
          const match = bqLine.match(/^((?:>\s*)+)/)
          if (match) {
            const cpStart = cpAt(pos)
            result[ln].inline.push({ cpStart, cpEnd: cpStart + [...match[1]].length, style: 'syntax', hidden: true })
          }
          pos += bqLine.length + 1
        }
        // Process blockquote content
        if ((token as any).tokens) {
          walkTokens((token as any).tokens, rawIdx)
        }
        break
      }

      case 'list': {
        const list = token as any
        for (const item of list.items) {
          const itemIdx = text.indexOf(item.raw, rawIdx)
          if (itemIdx === -1) continue
          const line = lineAt(itemIdx)
          result[line].blockClass = 'md-list-item'
          // Hide (or, for notes, mute) the bullet/number prefix
          const match = item.raw.match(/^(\s*(?:[\-\*\+]|\d+\.)\s)/)
          if (match) {
            const cpStart = cpAt(itemIdx)
            const cpEnd = cpStart + [...match[1]].length
            result[line].inline.push(opts?.showListMarkers
              ? { cpStart, cpEnd, style: 'list-marker' }
              : { cpStart, cpEnd, style: 'syntax', hidden: true })
          }
          // Task list checkbox
          if (item.task) {
            const checkMatch = item.raw.match(/^(\s*(?:[\-\*\+]|\d+\.)\s)(\[[ xX]\])\s/)
            if (checkMatch) {
              const cpStart = cpAt(itemIdx + checkMatch[1].length)
              const cpEnd = cpStart + [...checkMatch[2]].length
              result[line].inline.push({ cpStart, cpEnd, style: 'task-checkbox' })
            }
          }
          // Process inline content within list item
          if (item.tokens) {
            const contentStart = itemIdx + (item.raw.match(/^(\s*(?:[\-\*\+]|\d+\.)\s(?:\[[ xX]\]\s)?)/)?.[1]?.length || 0)
            walkInlineInItem(item.tokens, contentStart, line)
          }
        }
        break
      }

      case 'code': {
        // Fenced or indented code block
        const codeLines = token.raw.split('\n')
        let pos = rawIdx
        for (let i = 0; i < codeLines.length; i++) {
          const ln = lineAt(pos)
          if (ln < lineCount) {
            result[ln].blockClass = 'md-code-block'
            // Hide fence lines (first and last if fenced)
            const isFenceLine = /^(`{3,}|~{3,})/.test(codeLines[i])
            if (isFenceLine) {
              const cpStart = cpAt(pos)
              result[ln].inline.push({ cpStart, cpEnd: cpStart + [...codeLines[i]].length, style: 'syntax', hidden: true })
            }
          }
          pos += codeLines[i].length + 1
        }
        break
      }

      case 'table': {
        const table = token as any
        const tableLines = token.raw.split('\n').filter((l: string) => l.length > 0)
        let pos = rawIdx
        for (let i = 0; i < tableLines.length; i++) {
          const ln = lineAt(pos)
          if (ln < lineCount) {
            // Separator line (usually line index 1): hide it
            if (/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(tableLines[i])) {
              result[ln].blockClass = 'md-table-separator'
              const cpStart = cpAt(pos)
              result[ln].inline.push({ cpStart, cpEnd: cpStart + [...tableLines[i]].length, style: 'syntax', hidden: true })
            } else {
              result[ln].blockClass = i === 0 ? 'md-table-header' : 'md-table-row'
              // Style pipe characters as subtle separators
              for (let ci = 0; ci < tableLines[i].length; ci++) {
                if (tableLines[i][ci] === '|') {
                  const cp = cpAt(pos + ci)
                  result[ln].inline.push({ cpStart: cp, cpEnd: cp + 1, style: 'table-pipe' })
                }
              }
            }
            // Process inline formatting within cells
            const cells = i === 0 ? table.header : (table.rows[i - 2] || [])
            if (Array.isArray(cells)) {
              for (const cell of cells) {
                if (cell.tokens) {
                  const cellTextIdx = text.indexOf(cell.text, pos)
                  if (cellTextIdx !== -1) {
                    walkInlineTokens(cell.tokens, cellTextIdx, ln)
                  }
                }
              }
            }
          }
          pos += tableLines[i].length + 1
        }
        break
      }

      case 'hr': {
        const line = lineAt(rawIdx)
        result[line].blockClass = 'md-hr'
        const cpStart = cpAt(rawIdx)
        result[line].inline.push({ cpStart, cpEnd: cpStart + [...token.raw.trim()].length, style: 'syntax', hidden: true })
        break
      }

      case 'space': break // blank lines, ignore

      case 'html': {
        // Inline HTML blocks — show with muted styling
        const htmlLines = token.raw.split('\n')
        let pos = rawIdx
        for (const hl of htmlLines) {
          if (hl.length > 0) {
            const ln = lineAt(pos)
            const cpStart = cpAt(pos)
            result[ln].inline.push({ cpStart, cpEnd: cpStart + [...hl].length, style: 'html-tag' })
          }
          pos += hl.length + 1
        }
        break
      }

      default: {
        // For any other block-level token with sub-tokens, recurse
        if ((token as any).tokens) {
          walkInlineTokens((token as any).tokens, rawIdx, lineAt(rawIdx))
        }
        break
      }
    }
  }

  function walkInlineInItem(tokens: any[], searchFrom: number, defaultLine: number): void {
    for (const tok of tokens) {
      if (tok.type === 'text' && tok.tokens) {
        walkInlineTokens(tok.tokens, searchFrom, defaultLine)
      } else if (tok.type !== 'checkbox') {
        processInlineToken(tok, searchFrom, defaultLine)
      }
      const idx = text.indexOf(tok.raw, searchFrom)
      if (idx !== -1) searchFrom = idx + tok.raw.length
    }
  }

  function walkInlineTokens(tokens: any[], searchFrom: number, defaultLine: number): void {
    for (const tok of tokens) {
      processInlineToken(tok, searchFrom, defaultLine)
      const idx = text.indexOf(tok.raw, searchFrom)
      if (idx !== -1) searchFrom = idx + tok.raw.length
    }
  }

  /** File an inline annotation under every line it covers. A paragraph's
   *  inline tokens span all of its lines, so the line has to come from the
   *  annotation's own position, not the paragraph's first line. */
  function pushInline(ann: MdAnnotation): void {
    let ln = 0
    while (ln + 1 < lineOffsets.length && lineOffsets[ln + 1] <= ann.cpStart) ln++
    do {
      result[ln].inline.push(ann)
      ln++
    } while (ln < lineOffsets.length && lineOffsets[ln] < ann.cpEnd)
  }

  function processInlineToken(tok: any, searchFrom: number, line: number): void {
    const idx = text.indexOf(tok.raw, searchFrom)
    if (idx === -1) return
    const cpStart = cpAt(idx)

    switch (tok.type) {
      case 'strong': {
        // ** or __ delimiters
        const delim = tok.raw.startsWith('**') ? '**' : '__'
        const delimLen = [...delim].length
        const contentCpStart = cpStart + delimLen
        const contentCpEnd = cpStart + [...tok.raw].length - delimLen
        const cpEnd = cpStart + [...tok.raw].length
        // Hide delimiters
        pushInline({ cpStart, cpEnd: contentCpStart, style: 'syntax', hidden: true })
        pushInline({ cpStart: contentCpEnd, cpEnd, style: 'syntax', hidden: true })
        // Bold the content
        pushInline({ cpStart: contentCpStart, cpEnd: contentCpEnd, style: 'bold' })
        // Recurse for nested inline (e.g., bold+italic)
        if (tok.tokens) walkInlineTokens(tok.tokens, idx + delim.length, line)
        break
      }

      case 'em': {
        const delim = tok.raw.startsWith('*') ? '*' : '_'
        const delimLen = 1
        const contentCpStart = cpStart + delimLen
        const contentCpEnd = cpStart + [...tok.raw].length - delimLen
        const cpEnd = cpStart + [...tok.raw].length
        pushInline({ cpStart, cpEnd: contentCpStart, style: 'syntax', hidden: true })
        pushInline({ cpStart: contentCpEnd, cpEnd, style: 'syntax', hidden: true })
        pushInline({ cpStart: contentCpStart, cpEnd: contentCpEnd, style: 'italic' })
        if (tok.tokens) walkInlineTokens(tok.tokens, idx + delim.length, line)
        break
      }

      case 'codespan': {
        const backtickLen = tok.raw.startsWith('``') ? 2 : 1
        const contentCpStart = cpStart + backtickLen
        const cpEnd = cpStart + [...tok.raw].length
        const contentCpEnd = cpEnd - backtickLen
        pushInline({ cpStart, cpEnd: contentCpStart, style: 'syntax', hidden: true })
        pushInline({ cpStart: contentCpEnd, cpEnd, style: 'syntax', hidden: true })
        pushInline({ cpStart: contentCpStart, cpEnd: contentCpEnd, style: 'code' })
        break
      }

      case 'del': {
        const delimLen = 2
        const contentCpStart = cpStart + delimLen
        const cpEnd = cpStart + [...tok.raw].length
        const contentCpEnd = cpEnd - delimLen
        pushInline({ cpStart, cpEnd: contentCpStart, style: 'syntax', hidden: true })
        pushInline({ cpStart: contentCpEnd, cpEnd, style: 'syntax', hidden: true })
        pushInline({ cpStart: contentCpStart, cpEnd: contentCpEnd, style: 'strikethrough' })
        if (tok.tokens) walkInlineTokens(tok.tokens, idx + delimLen, line)
        break
      }

      case 'link': {
        const cpEnd = cpStart + [...tok.raw].length
        // Find the link text portion
        const bracketOpen = tok.raw.indexOf('[')
        const bracketClose = tok.raw.indexOf(']')
        if (bracketOpen !== -1 && bracketClose !== -1) {
          const textCpStart = cpStart + [...tok.raw.slice(0, bracketOpen + 1)].length
          const textCpEnd = cpStart + [...tok.raw.slice(0, bracketClose)].length
          // Hide everything except the link text
          pushInline({ cpStart, cpEnd: textCpStart, style: 'syntax', hidden: true })
          pushInline({ cpStart: textCpEnd, cpEnd, style: 'syntax', hidden: true })
          pushInline({ cpStart: textCpStart, cpEnd: textCpEnd, style: 'link-text' })
        }
        break
      }

      case 'image': {
        const cpEnd = cpStart + [...tok.raw].length
        // Show alt text in italic, hide everything else
        const bracketOpen = tok.raw.indexOf('[')
        const bracketClose = tok.raw.indexOf(']')
        if (bracketOpen !== -1 && bracketClose !== -1) {
          const altCpStart = cpStart + [...tok.raw.slice(0, bracketOpen + 1)].length
          const altCpEnd = cpStart + [...tok.raw.slice(0, bracketClose)].length
          pushInline({ cpStart, cpEnd: altCpStart, style: 'syntax', hidden: true })
          pushInline({ cpStart: altCpEnd, cpEnd, style: 'syntax', hidden: true })
          if (altCpEnd > altCpStart) {
            pushInline({ cpStart: altCpStart, cpEnd: altCpEnd, style: 'italic' })
          }
        }
        break
      }

      case 'escape': {
        // Backslash escape: hide the backslash
        pushInline({ cpStart, cpEnd: cpStart + 1, style: 'syntax', hidden: true })
        break
      }

      case 'br': break
      case 'text': {
        // Check for autolinks (bare URLs)
        const urlRe = /(https?:\/\/[^\s<>]+)/g
        let um: RegExpExecArray | null
        while ((um = urlRe.exec(tok.raw)) !== null) {
          const urlCpStart = cpStart + [...tok.raw.slice(0, um.index)].length
          const urlCpEnd = urlCpStart + [...um[0]].length
          pushInline({ cpStart: urlCpStart, cpEnd: urlCpEnd, style: 'autolink' })
        }
        break
      }

      case 'html': {
        const cpEnd = cpStart + [...tok.raw].length
        pushInline({ cpStart, cpEnd, style: 'html-tag' })
        break
      }

      default: break
    }
  }

  return result
}
