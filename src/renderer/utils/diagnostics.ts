/**
 * Help → Copy Diagnostic Information: what a bug report needs, as plain
 * text to paste. Magnolia's and the system's versions, the settings that
 * change how it behaves, the project's size (counts, not content), and
 * the last errors this window met. Nothing from the project itself: no
 * names, text or codes.
 */
import { i18n } from '../i18n'
import { useDocumentStore } from '../stores/document-store'
import { useCodeStore } from '../stores/code-store'
import { useMemoStore } from '../stores/memo-store'
import { useQueryStore } from '../stores/query-store'
import { useProjectStore } from '../stores/project-store'
import { usePreferencesStore } from '../stores/preferences-store'
import { errorMessage } from './error-message'

const KEPT = 20
const errors: { at: string; message: string }[] = []

function remember(message: string): void {
  errors.push({ at: new Date().toISOString(), message: message.replace(/\s+/g, ' ').slice(0, 300) })
  if (errors.length > KEPT) errors.shift()
}

/** Keep the window's last errors (uncaught, unhandled, and those it logs). */
export function installErrorLog(): void {
  if ((window as { __errorLog?: boolean }).__errorLog) return
  ;(window as { __errorLog?: boolean }).__errorLog = true
  window.addEventListener('error', (e) => remember(e.message || errorMessage(e.error)))
  window.addEventListener('unhandledrejection', (e) => remember('Unhandled: ' + errorMessage(e.reason)))
  const original = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    remember(args.map((a) => (typeof a === 'string' ? a : errorMessage(a))).join(' '))
    original(...args)
  }
}

interface SystemInfo {
  appVersion: string
  os: string
  arch: string
  osVersion: string | null
  webview: string | null
  projectFileBytes: number | null
}

const n = (x: number) => x.toLocaleString('en')

export async function buildDiagnostics(): Promise<string> {
  const project = useProjectStore.getState()
  const sys: Partial<SystemInfo> = await window.api.diagnosticsInfo(project.filePath ?? null).catch(() => ({}))
  const docs = useDocumentStore.getState()
  const kinds = new Map<string, number>()
  let codings = 0
  for (const s of docs.sources) {
    const k = s.sourceType ?? 'text'
    kinds.set(k, (kinds.get(k) ?? 0) + 1)
    for (const sel of s.selections) codings += sel.codings.length
  }
  const prefs = usePreferencesStore.getState()
  const bytes = sys.projectFileBytes
  const size = bytes == null ? 'not saved' : bytes < 1048576 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`
  const lines = [
    'Magnolia diagnostic information',
    `Magnolia: ${sys.appVersion ?? 'unknown'}`,
    `System: ${sys.os ?? navigator.platform} ${sys.osVersion ?? ''} (${sys.arch ?? '?'})`.replace(/\s+\(/, ' ('),
    `Web view: ${sys.webview ?? 'unknown'}`,
    `Language: ${i18n.language} (setting: ${prefs.language}); theme: ${document.documentElement.getAttribute('data-theme') ?? '?'}; toolbar: ${prefs.toolbarStyle}`,
    `Window: ${window.innerWidth} × ${window.innerHeight} at ${window.devicePixelRatio}×`,
    `Project: ${n(docs.sources.length)} documents (${[...kinds].map(([k, c]) => `${k} ${n(c)}`).join(', ') || 'none'}), ` +
      `${n(useCodeStore.getState().flatCodes().length)} codes, ${n(codings)} codings, ${n(useMemoStore.getState().memos.length)} memos, ` +
      `${n(useQueryStore.getState().savedQueries.length)} saved queries, ${n(project.savedAnalyses?.length ?? 0)} saved analyses; file ${size}`,
    `Open tabs: ${docs.openTabs.length}`,
    '',
    errors.length ? 'Recent errors (oldest first):' : 'Recent errors: none',
    ...errors.map((e) => `${e.at}  ${e.message}`)
  ]
  return lines.join('\n')
}
