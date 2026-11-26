/**
 * The report as it will be exported, beside its builder (GitHub #38): the
 * same page the PDF is made from (report-export's buildReportHtml), kept up
 * to date as the report or the project changes. Its text and tables can
 * be selected and copied into a word processor.
 *
 * It's drawn in the page itself, not a frame (frames are off in Magnolia,
 * frame-src 'none') or a shadow root (text there can't be selected in
 * every web view): its styles are rewritten to apply only inside it, and
 * Magnolia's are reset there, so it looks as the PDF does; the scroll
 * position survives each update. No script in it runs (innerHTML doesn't
 * run scripts); the export's own script, which fits wide tables to the
 * page, doesn't apply, so a wide table scrolls sideways here instead.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { buildReportPreviewHtml, reportPageWidth, type DocAsset, type ReportItem } from './report-export'
import { useDocumentStore } from '../../stores/document-store'
import { useCodeStore } from '../../stores/code-store'
import { useMemoStore } from '../../stores/memo-store'
import { useQuoteStore } from '../../stores/quote-store'
import { useQueryStore } from '../../stores/query-store'
import { useTagStore } from '../../stores/tag-store'
import { useProjectStore } from '../../stores/project-store'

/** The page's margin around its content, in CSS pixels (half an inch). */
const MARGIN = 48

/** The report page's styles, applying only inside `scope` (its `html` and
 *  `body` rules to `scope` itself), after Magnolia's are reset there. Rules
 *  for print only (@page, @media print) are left out. */
function scopedCss(css: string, scope: string): string {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(css)
  const rules = (list: CSSRuleList): string[] =>
    [...list].map((r) => {
      if (r instanceof CSSStyleRule) {
        const selector = r.selectorText
          .split(',')
          .map((part) => {
            const sel = part.trim()
            if (/^(html|body)$/.test(sel)) return scope
            return `${scope} ${sel.replace(/^(html|body)\s+/, '')}`
          })
          .join(', ')
        return `${selector} { ${r.style.cssText} }`
      }
      if (r instanceof CSSMediaRule && !/print/.test(r.media.mediaText)) {
        return `@media ${r.media.mediaText} { ${rules(r.cssRules).join('\n')} }`
      }
      return ''
    })
  return [`${scope}, ${scope} * { all: revert; }`, ...rules(sheet.cssRules)].join('\n')
}

export function ReportPreview({ title, items }: { title: string; items: ReportItem[] }) {
  const { t } = useTranslation()
  const hostRef = useRef<HTMLDivElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const assets = useRef(new Map<string, DocAsset>())
  const [scale, setScale] = useState(1)
  const [building, setBuilding] = useState(true)
  const pageW = reportPageWidth()

  // Anything the report shows can change it: the project's data, as well
  // as the report itself.
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1)
    // Only the data a report shows (not, say, which document is selected).
    const watch = <S,>(store: { subscribe: (l: (s: S, p: S) => void) => () => void }, keys: (keyof S)[]) =>
      store.subscribe((s, p) => { if (keys.some((k) => s[k] !== p[k])) bump() })
    const unsubs = [
      watch(useDocumentStore, ['sources', 'sourceContents', 'folders']),
      watch(useCodeStore, ['codes']),
      watch(useMemoStore, ['memos']),
      watch(useQuoteStore, ['quotes']),
      watch(useQueryStore, ['savedQueries']),
      watch(useTagStore, ['tags', 'categories']),
      watch(useProjectStore, ['savedAnalyses'])
    ]
    return () => unsubs.forEach((u) => u())
  }, [])

  // Build after a pause in changes (a report with analyses takes a moment).
  useEffect(() => {
    let cancelled = false
    setBuilding(true)
    const timer = setTimeout(async () => {
      try {
        const html = await buildReportPreviewHtml(title, items, assets.current)
        if (cancelled || !hostRef.current) return
        const doc = new DOMParser().parseFromString(html, 'text/html')
        const css = [...doc.head.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n')
        hostRef.current.innerHTML = `<style>${scopedCss(css, '.rp-body')}</style><div class="rp-body">${doc.body.innerHTML}</div>`
      } catch (err) {
        console.error('Report preview failed:', err)
      } finally {
        if (!cancelled) setBuilding(false)
      }
    }, 400)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [title, items, version])

  // The page fits the pane's width (never larger than life).
  useEffect(() => {
    const pane = paneRef.current
    if (!pane) return
    const fit = () => setScale(Math.min(1, (pane.clientWidth - 32) / (pageW + MARGIN * 2)))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(pane)
    return () => ro.disconnect()
  }, [pageW])

  // Its links (the table of contents) move within the preview, not the window.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const onClick = (e: Event) => {
      const a = (e.target as Element | null)?.closest?.('a')
      if (!a) return
      e.preventDefault()
      const href = a.getAttribute('href') ?? ''
      if (href.startsWith('#')) host.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`)?.scrollIntoView({ block: 'start' })
    }
    host.addEventListener('click', onClick)
    return () => host.removeEventListener('click', onClick)
  }, [])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', height: 'var(--report-bar-height)', boxSizing: 'border-box', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-panel)', flexShrink: 0, fontSize: 11, color: 'var(--text-muted)' }}>
        <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>{t('reports.preview')}</span>
        <span aria-live="polite">{building ? t('reports.previewUpdating') : ''}</span>
      </div>
      <div
        ref={paneRef}
        role="region"
        aria-label={t('reports.preview')}
        tabIndex={0}
        style={{ flex: 1, overflow: 'auto', background: 'var(--bg-tertiary)', padding: 16 }}
      >
        <div
          style={{
            width: pageW + MARGIN * 2,
            zoom: scale,
            margin: '0 auto',
            padding: MARGIN,
            boxSizing: 'border-box',
            background: '#fff',
            color: '#222',
            boxShadow: '0 1px 4px rgba(0,0,0,0.18)',
            userSelect: 'text'
          } as React.CSSProperties}
        >
          <div ref={hostRef} />
        </div>
      </div>
    </div>
  )
}
