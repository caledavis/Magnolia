/**
 * Exported documents (PDFs) in the interface's language and direction:
 * the page's lang and dir go on the document's <html>, so an Arabic
 * report is laid out right to left and the PDF engine picks fonts for the
 * right script; and each paragraph, list item and table cell takes the
 * direction of its own first letter, as the user's text does in the app,
 * so an English quote in an Arabic report (or the reverse) reads right.
 */
// The user's text in each export: headings (document and section names),
// paragraphs, list items and cells, plus
// the blocks and names the exports write in divs and spans — query
// results' passages (.context), reports' documents, survey answers,
// quotes, memos, coded documents and notes (.coded, where each line is
// its own paragraph), logbook and notebook titles, respondent and code
// names. On an inline name it isolates the name in its own direction.
const BIDI_CSS = '<style>h1, h2, h3, p, li, td, th, blockquote, dd, .context, .doc-content, .sv-ans-text, .quote, .memo-body, .memo-title, .coded, .entry-title, .nb-title, .resp, .who, .what, .code-name { unicode-bidi: plaintext; }</style>'

export function withDocumentLanguage(html: string, root: HTMLElement = document.documentElement): string {
  const lang = root.lang || 'en'
  const dir = root.dir === 'rtl' ? 'rtl' : 'ltr'
  let out = html.replace(/<html(?![^>]*\bdir=)([^>]*)>/i, (_m, attrs: string) =>
    `<html${/\blang=/.test(attrs) ? '' : ` lang="${lang}"`} dir="${dir}"${attrs}>`)
  out = out.includes('</head>') ? out.replace('</head>', `${BIDI_CSS}</head>`) : BIDI_CSS + out
  return out
}
