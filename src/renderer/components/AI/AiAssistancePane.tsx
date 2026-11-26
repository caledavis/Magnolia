/**
 * The AI Assistance pane: a chat with the user's own AI service about the
 * open project (see stores/ai-store.ts).
 *
 * Before anything is sent, the pane asks, for each project, whether this
 * project's data may go to the chosen service (named, with its address);
 * the answer is kept with the project, and asked again if the service
 * changes. Each thing the AI reads is listed in the chat, so the user sees
 * what was sent; its proposed changes are listed too, with a link to the
 * AI Assistance Viewer where they're approved or denied.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAiStore, type AiChat, type ChatItem } from '../../stores/ai-store'
import { usePreferencesStore } from '../../stores/preferences-store'
import { useDocumentStore } from '../../stores/document-store'
import { isLocalAddress, originOf, providerName } from '../../utils/ai/providers'
import { aiErrorMessage } from '../../utils/ai/errors'
import { markdownToHtml } from '../Markdown'
import { Icon, faXmark, faPlus, faArrowUp, faStop, faSparkles } from '../Icon'
import { AI_REVIEW_TAB_ID, PREFERENCES_TAB_ID } from '../../utils/tab-ids'
import { requestPreferencesCategory } from '../Preferences/PreferencesWindow'

interface Props {
  onClose?: () => void
}

/** An AI reply as HTML, its passage references ([P12]) as links. */
function replyHtml(text: string, chat: AiChat): string {
  const linked = text.replace(/\[(P\d+)\]/g, (whole, ref: string) => (chat.refs.passages[ref] ? `[${ref}](#ai-passage-${ref})` : whole))
  return markdownToHtml(linked)
}

function openReview() {
  useDocumentStore.getState().openToolTab(AI_REVIEW_TAB_ID)
}

function openSettings() {
  requestPreferencesCategory('ai-assistance')
  useDocumentStore.getState().openToolTab(PREFERENCES_TAB_ID)
}

export function AiAssistancePane({ onClose }: Props) {
  const { t } = useTranslation()
  const provider = usePreferencesStore((s) => s.aiProvider)
  const { enabledFor, chats, activeChatId, running, proposals } = useAiStore()
  const chat = chats.find((c) => c.id === activeChatId) ?? null
  const origin = provider ? originOf(provider.baseUrl) : ''
  const enabled = !!provider && !!provider.model && enabledFor === origin
  const pending = proposals.filter((p) => p.status === 'pending').length

  return (
    <div className="panel" role="region" aria-label={t('panes.assistant')}>
      <div className="panel-header">
        <span style={{ flex: 1 }}>{t('panes.assistant')}</span>
        {enabled && pending > 0 && (
          <button
            type="button"
            className="ai-review-chip"
            onClick={openReview}
            title={t('ai.pane.reviewTitle', { count: pending })}
            style={{ textTransform: 'none', letterSpacing: 'normal', fontSize: 11, fontWeight: 600, padding: '1px 8px', borderRadius: 10, border: '1px solid var(--accent)', color: 'var(--accent)', background: 'transparent', cursor: 'pointer' }}
          >
            {t('ai.pane.review', { count: pending })}
          </button>
        )}
        {enabled && (
          <button className="panel-header-add" onClick={() => useAiStore.getState().newChat()} disabled={!!running} title={t('ai.pane.newChat')} aria-label={t('ai.pane.newChat')}>
            <Icon icon={faPlus} />
          </button>
        )}
        {onClose && <button className="panel-header-close" onClick={onClose} title={t('panel.close')} aria-label={t('panel.close')}><Icon icon={faXmark} /></button>}
      </div>
      <div className="panel-content" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, padding: 0 }}>
        {!provider || !provider.model ? (
          <Notice>
            <p>{t('ai.pane.noService')}</p>
            <button type="button" onClick={openSettings}>{t('ai.pane.openSettings')}</button>
          </Notice>
        ) : !enabled ? (
          <Consent providerLabel={providerName(provider)} origin={origin} local={isLocalAddress(provider.baseUrl)} changed={!!enabledFor} />
        ) : (
          <Chat chat={chat} />
        )}
      </div>
    </div>
  )
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: 16, fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', lineHeight: 1.5, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
      {children}
    </div>
  )
}

/** Asked once per project (and again if the service changes). */
function Consent({ providerLabel, origin, local, changed }: { providerLabel: string; origin: string; local: boolean; changed: boolean }) {
  const { t } = useTranslation()
  return (
    <Notice>
      <Icon icon={faSparkles} />
      <strong style={{ color: 'var(--text-primary)' }}>{changed ? t('ai.pane.consentChanged') : t('ai.pane.consentTitle')}</strong>
      <p>{local ? t('ai.pane.consentLocal', { name: providerLabel }) : t('ai.pane.consentRemote', { name: providerLabel, address: origin })}</p>
      <p>{t('ai.pane.consentReview')}</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={() => useAiStore.getState().enable(origin)}>{t('ai.pane.turnOn')}</button>
        <button type="button" className="secondary" onClick={openSettings}>{t('ai.pane.openSettings')}</button>
      </div>
    </Notice>
  )
}

function Chat({ chat }: { chat: AiChat | null }) {
  const { t } = useTranslation()
  const running = useAiStore((s) => s.running)
  const chats = useAiStore((s) => s.chats)
  const provider = usePreferencesStore((s) => s.aiProvider)!
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const mine = running && running.chatId === chat?.id
  const busy = !!running

  // Follow the conversation as it grows, unless the user has scrolled up.
  const stuck = useRef(true)
  useLayoutEffect(() => {
    const el = listRef.current
    if (el && stuck.current) el.scrollTop = el.scrollHeight
  }, [chat?.items.length, running?.text])

  useEffect(() => { inputRef.current?.focus() }, [chat?.id])

  const send = () => {
    const text = draft.trim()
    if (!text || busy) return
    setDraft('')
    stuck.current = true
    void useAiStore.getState().send(text)
  }

  // Passage links open the passage.
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as Element).closest('a')
    const href = a?.getAttribute('href') ?? ''
    if (!a || !chat) return
    if (href.startsWith('#ai-passage-')) {
      e.preventDefault()
      const p = chat.refs.passages[href.slice('#ai-passage-'.length)]
      if (p) useDocumentStore.getState().viewDocumentAt(p.sourceGuid, p.start, p.end)
    }
  }

  return (
    <>
      {chats.length > 0 && (
        <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border-color)', flexShrink: 0 }}>
          <select
            aria-label={t('ai.pane.chats')}
            value={chat?.id ?? ''}
            disabled={busy}
            onChange={(e) => (e.target.value ? useAiStore.getState().selectChat(e.target.value) : useAiStore.getState().newChat())}
            style={{ width: '100%', fontSize: 12, padding: '2px 4px', background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)' }}
          >
            <option value="">{t('ai.pane.newChatOption')}</option>
            {chats.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
        </div>
      )}
      <div
        ref={listRef}
        role="log"
        aria-label={t('ai.pane.conversation')}
        aria-busy={busy}
        tabIndex={0}
        onClick={onClick}
        onScroll={(e) => { const el = e.currentTarget; stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }}
        style={{ flex: 1, overflowY: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10, fontSize: 'var(--font-size-sm)', lineHeight: 1.5 }}
      >
        {!chat && !mine && <p style={{ color: 'var(--text-muted)' }}>{t('ai.pane.empty')}</p>}
        {chat?.items.map((item) => <Item key={item.id} item={item} chat={chat} />)}
        {mine && (
          running!.text
            ? <div className="markdown-content ai-reply" dangerouslySetInnerHTML={{ __html: replyHtml(running!.text, chat!) }} />
            : <p style={{ color: 'var(--text-muted)' }} aria-live="polite">{t('ai.pane.working')}</p>
        )}
      </div>
      <form
        onSubmit={(e) => { e.preventDefault(); send() }}
        style={{ borderTop: '1px solid var(--border-color)', padding: 8, display: 'flex', gap: 6, alignItems: 'flex-end', flexShrink: 0 }}
      >
        <textarea
          ref={inputRef}
          value={draft}
          rows={2}
          aria-label={t('ai.pane.message')}
          placeholder={t('ai.pane.placeholder')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() }
          }}
          style={{ flex: 1, resize: 'none', fontSize: 12, padding: '4px 6px', background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', fontFamily: 'inherit', maxHeight: 160 }}
        />
        {busy ? (
          <button type="button" className="secondary" onClick={() => useAiStore.getState().stop()} title={t('ai.pane.stop')} aria-label={t('ai.pane.stop')}>
            <Icon icon={faStop} />
          </button>
        ) : (
          <button type="submit" disabled={!draft.trim()} title={t('ai.pane.send')} aria-label={t('ai.pane.send')}>
            <Icon icon={faArrowUp} />
          </button>
        )}
      </form>
      <div style={{ padding: '0 10px 6px', fontSize: 10.5, color: 'var(--text-muted)', flexShrink: 0 }}>
        {t('ai.pane.using', { name: providerName(provider), model: provider.model })}
      </div>
    </>
  )
}

function Item({ item, chat }: { item: ChatItem; chat: AiChat }) {
  const { t } = useTranslation()
  const html = useMemo(() => (item.kind === 'assistant' && item.text ? replyHtml(item.text, chat) : ''), [item, chat])
  if (item.kind === 'user') {
    return (
      <div style={{ alignSelf: 'flex-end', maxWidth: '90%', background: 'var(--bg-tertiary)', borderRadius: 8, padding: '6px 10px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {item.text}
      </div>
    )
  }
  if (item.kind === 'assistant') {
    return html ? <div className="markdown-content ai-reply" style={{ overflowWrap: 'anywhere' }} dangerouslySetInnerHTML={{ __html: html }} /> : null
  }
  if (item.kind === 'error') {
    return <p role="alert" style={{ color: 'var(--danger)' }}>{aiErrorMessage(item.error, t)}</p>
  }
  // What the AI read, and what it proposed.
  const proposed = item.results.reduce((n, r) => n + (r.proposalIds?.length ?? 0), 0)
  return (
    <div style={{ fontSize: 11, color: 'var(--text-muted)', borderInlineStart: '2px solid var(--border-color)', paddingInlineStart: 8 }}>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {item.results.map((r) => (
          <li key={r.id} style={r.isError ? { fontStyle: 'italic' } : undefined}>{t(r.activity.key, r.activity.vars)}</li>
        ))}
      </ul>
      {proposed > 0 && (
        <button type="button" className="link-button" onClick={openReview} style={{ marginTop: 2, padding: 0, border: 'none', background: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 11 }}>
          {t('ai.pane.proposed', { count: proposed })}
        </button>
      )}
    </div>
  )
}
