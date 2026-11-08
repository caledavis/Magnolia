/**
 * App-wide PDF export helpers.
 *
 * Every PDF the app generates (Survey Summary, Query Results, Logbook,
 * Codebook, Transcripts, …) shares the same chrome and page layout:
 *
 *  - The Magnolia wordmark in the top-right of every page
 *    (`MAGNOLIA_PDF_HEADER_TEMPLATE`, plugged in automatically by
 *    `exportPdfWithHeader`).
 *  - The same DOCTYPE / head / body skeleton with a common typography
 *    baseline, an `<h1>` title, and an optional `.subtitle` line
 *    underneath (`buildPdfDocument`).
 *
 * Callers shouldn't hand-roll a doctype or repeat the base CSS — they
 * provide a title, subtitle, body HTML, and optional content-specific
 * CSS to `buildPdfDocument`, then pass the result to
 * `exportPdfWithHeader`. A future change to the layout lands
 * everywhere in one edit.
 */

// Raw SVG content of the full-product MagnoliaQDA wordmark — the
// same asset the WelcomeScreen paints above the recent-projects list
// (the in-app toolbar uses the shorter magnolia.svg variant; PDFs
// and the welcome screen both carry the longer, product-name form so
// exported documents are clearly attributed to MagnoliaQDA). Imported
// as raw text so we can inline it as a base64 data URI; the hidden
// print window the main process spins up to render PDFs doesn't
// share the renderer's file-serving context, so it can't resolve a
// relative URL.
import magnoliaSvg from '../assets/magnoliaqda.svg?raw'

const MAGNOLIA_LOGO_DATA_URI = `data:image/svg+xml;base64,${btoa(magnoliaSvg)}`

/** HTML fragment Chromium repeats at the top of every printed page.
 *  Lives in the page's top margin (the main-process export-pdf IPC
 *  bumps the top print margin to 0.95" when a header is supplied), so
 *  it never overlaps body content. Inline styles only — Chromium
 *  ignores `<style>` tags and external CSS inside header/footer
 *  templates.
 *
 *  Padding inside the template keeps the wordmark clear of the
 *  unprintable strip on home / office printers (typically 0.125"–
 *  0.25"), and opacity 0.7 keeps the mark recognisable but
 *  unobtrusive on every page. */
export const MAGNOLIA_PDF_HEADER_TEMPLATE =
  `<div style="width:100%; padding:28px 48px 0 28px; box-sizing:border-box; display:flex; justify-content:flex-end; align-items:center;">` +
  `<img src="${MAGNOLIA_LOGO_DATA_URI}" style="height:24px; opacity:0.7;" />` +
  `</div>`

/** HTML fragment Chromium repeats at the bottom of every printed
 *  page: "x/y" page numbering in the bottom-right corner. Chromium
 *  recognises a handful of special class names inside header/footer
 *  templates and fills them in at print time — `.pageNumber` becomes
 *  the current page, `.totalPages` becomes the page count. The
 *  surrounding div mirrors the header's right inset (48px) so the
 *  page count sits directly under the wordmark, and uses the same
 *  generous bottom padding to stay clear of the unprintable strip on
 *  home / office printers. */
export const MAGNOLIA_PDF_FOOTER_TEMPLATE =
  `<div style="width:100%; padding:0 48px 28px 28px; box-sizing:border-box; display:flex; justify-content:flex-end; align-items:center; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; font-size:10px; color:#888;">` +
  `<span class="pageNumber"></span>/<span class="totalPages"></span>` +
  `</div>`

/** Drop-in replacement for `window.api.exportPdf` that defaults both
 *  the header and footer templates to the shared Magnolia chrome —
 *  the wordmark in the top-right, "x/y" page numbering in the
 *  bottom-right — so every PDF export across the app reads as part of
 *  the same document family.
 *
 *  Callers that need different chrome (or none) can pass overrides
 *  explicitly; an empty string still triggers Chromium's default
 *  URL/date/page-number templates in main, so don't pass `''` to
 *  mean "no header/footer" — the only escape hatch is calling
 *  `window.api.exportPdf` directly without those args. In practice
 *  every existing PDF caller benefits from the shared chrome, so no
 *  escape is needed today. */
export function exportPdfWithHeader(
  html: string,
  defaultName: string,
  dialogTitle?: string,
  headerTemplate?: string,
  footerTemplate?: string
): Promise<string | null> {
  return window.api.exportPdf(
    html,
    defaultName,
    dialogTitle,
    headerTemplate ?? MAGNOLIA_PDF_HEADER_TEMPLATE,
    footerTemplate ?? MAGNOLIA_PDF_FOOTER_TEMPLATE
  )
}

// ── Shared page layout ─────────────────────────────────────────────

/** Escape user-supplied text for safe interpolation into HTML
 *  attributes / text nodes. Exported so callers building their own
 *  body markup can use the same helper instead of rolling another
 *  copy. */
export function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Shared CSS that every PDF export inherits. Provides the body
 *  typography baseline, h1 title styling, the `.subtitle` line under
 *  the title, a small set of utility classes (`.muted`, `.empty`,
 *  `.section-heading`), and base styling for tables, code, pre, and
 *  blockquotes that several exports rely on. Body margin is 0 because
 *  the main-process export-pdf IPC already sets the printToPDF margins
 *  (0.5" all sides, 0.95" top when a header template is set). */
const BASE_PDF_CSS = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 11px; color: #222; line-height: 1.5; margin: 0; }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 4px; }
  .subtitle { font-size: 11px; color: #888; margin-bottom: 20px; }
  .section-heading { font-size: 12px; font-weight: 600; color: #555; margin: 24px 0 8px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th { text-align: start; padding: 6px 10px; border-bottom: 1px solid #ccc; font-weight: 600; font-size: 10px; color: #888; }
  td { padding: 8px 10px; border-bottom: 1px solid #eee; vertical-align: top; color: #222; word-wrap: break-word; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  code { font-size: 0.92em; background: #f3f4f6; padding: 1px 3px; border-radius: 2px; }
  pre { background: #f3f4f6; padding: 6px; border-radius: 3px; overflow-x: auto; margin: 0 0 6px; }
  pre code { background: none; padding: 0; }
  blockquote { border-inline-start: 2px solid #ddd; margin: 0 0 6px; padding: 2px 0 2px 10px; color: #666; }
  .muted { color: #888; }
  .empty { color: #aaa; font-style: italic; font-size: 10.5px; }
`

export interface PdfDocumentOptions {
  /** Shown as the document's `<h1>` and (unless overridden by
   *  `documentTitle`) as the `<title>` in `<head>`. Escaped before
   *  insertion. */
  title: string
  /** Optional metadata line rendered under the h1 — typically
   *  "N items · … exported {date}". Inserted as raw HTML, so the
   *  caller is responsible for escaping any untrusted text. */
  subtitle?: string
  /** Body content as a raw HTML string. Inserted after the title
   *  block. Caller is responsible for escaping any untrusted text. */
  body: string
  /** Optional CSS appended after the shared base. Use this for any
   *  content-specific classes the body references — table layouts,
   *  per-entry blocks, etc. */
  extraCss?: string
  /** Override the `<title>` in `<head>`. Defaults to `title`. */
  documentTitle?: string
}

/** Wrap caller-provided content in the shared PDF document skeleton.
 *  Returns a complete HTML string ready to hand to
 *  `exportPdfWithHeader`. */
export function buildPdfDocument(opts: PdfDocumentOptions): string {
  const documentTitle = opts.documentTitle ?? opts.title
  const subtitleHtml = opts.subtitle ? `<div class="subtitle">${opts.subtitle}</div>` : ''
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escHtml(documentTitle)}</title>
<style>${BASE_PDF_CSS}${opts.extraCss ?? ''}</style></head><body>
<h1>${escHtml(opts.title)}</h1>
${subtitleHtml}
${opts.body}
</body></html>`
}
