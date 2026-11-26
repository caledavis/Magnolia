/**
 * The AI Assistance pane: where AI apps on this computer (Claude Desktop
 * and others, through Magnolia's connector) are let use the open project,
 * and what they did with it.
 *
 * Before an app can read anything, the pane asks, for each project; the
 * answer is kept with the project. Each thing an app reads is then listed
 * here, by session, so the user sees what was sent; its proposed changes
 * are listed too, with a link to the AI Assistance Viewer where they're
 * approved or denied.
 */
import { useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useAiStore, type AiSession, type SessionItem } from '../../stores/ai-store'
import { usePreferencesStore } from '../../stores/preferences-store'
import { useDocumentStore } from '../../stores/document-store'
import { Icon, faXmark, faSparkles } from '../Icon'
import { AI_REVIEW_TAB_ID, PREFERENCES_TAB_ID } from '../../utils/tab-ids'
import { requestPreferencesCategory } from '../Preferences/PreferencesWindow'
import { formatDateTime } from '../../i18n'

interface Props {
  onClose?: () => void
}

const linkStyle: React.CSSProperties = { padding: 0, border: 'none', background: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 11 }

function openReview() {
  useDocumentStore.getState().openToolTab(AI_REVIEW_TAB_ID)
}

function openSettings() {
  requestPreferencesCategory('ai-assistance')
  useDocumentStore.getState().openToolTab(PREFERENCES_TAB_ID)
}

export function AiAssistancePane({ onClose }: Props) {
  const { t } = useTranslation()
  const appsEnabled = usePreferencesStore((s) => s.aiAppsEnabled)
  const { appsAllowed, appRequest, sessions, activeSessionId, proposals } = useAiStore()
  const session = sessions.find((s) => s.id === activeSessionId) ?? sessions[0] ?? null
  const pending = proposals.filter((p) => p.status === 'pending').length

  return (
    <div className="panel" role="region" aria-label={t('panes.assistant')}>
      <div className="panel-header">
        <span style={{ flex: 1 }}>{t('panes.assistant')}</span>
        {pending > 0 && (
          <button
            type="button"
            onClick={openReview}
            title={t('ai.pane.reviewTitle', { count: pending })}
            style={{ textTransform: 'none', letterSpacing: 'normal', fontSize: 11, fontWeight: 600, padding: '1px 8px', borderRadius: 10, border: '1px solid var(--accent)', color: 'var(--accent)', background: 'transparent', cursor: 'pointer' }}
          >
            {t('ai.pane.review', { count: pending })}
          </button>
        )}
        {onClose && <button className="panel-header-close" onClick={onClose} title={t('panel.close')} aria-label={t('panel.close')}><Icon icon={faXmark} /></button>}
      </div>
      <div className="panel-content" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, padding: 0 }}>
        {!appsEnabled ? (
          <Notice>
            <Icon icon={faSparkles} />
            <p>{t('ai.pane.intro')}</p>
            <button type="button" onClick={openSettings}>{t('ai.pane.openSettings')}</button>
          </Notice>
        ) : !appsAllowed ? (
          <AppConsent name={appRequest} />
        ) : (
          <Sessions session={session} sessions={sessions} />
        )}
      </div>
    </div>
  )
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: 16, fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', lineHeight: 1.5, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start', overflowY: 'auto' }}>
      {children}
    </div>
  )
}

/** Asked once per project. */
function AppConsent({ name }: { name: string | null }) {
  const { t } = useTranslation()
  return (
    <Notice>
      <Icon icon={faSparkles} />
      <strong style={{ color: 'var(--text-primary)' }}>{name ? t('ai.pane.appAsks', { name }) : t('ai.pane.appsTitle')}</strong>
      <p>{t('ai.pane.appsConsent')}</p>
      <p>{t('ai.pane.consentReview')}</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={() => useAiStore.getState().allowApps(true)}>{t('ai.pane.allowApps')}</button>
        {name && <button type="button" className="secondary" onClick={() => useAiStore.getState().setAppRequest(null)}>{t('ai.pane.notNow')}</button>}
      </div>
    </Notice>
  )
}

function Sessions({ session, sessions }: { session: AiSession | null; sessions: AiSession[] }) {
  const { t } = useTranslation()
  const listRef = useRef<HTMLDivElement>(null)
  // Follow the session as it grows, unless the user has scrolled up.
  const stuck = useRef(true)
  useLayoutEffect(() => {
    const el = listRef.current
    if (el && stuck.current) el.scrollTop = el.scrollHeight
  }, [session?.items.length])

  return (
    <>
      {sessions.length > 1 && (
        <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border-color)', flexShrink: 0 }}>
          <select
            aria-label={t('ai.pane.sessions')}
            value={session?.id ?? ''}
            onChange={(e) => useAiStore.getState().selectSession(e.target.value)}
            style={{ width: '100%', fontSize: 12, padding: '2px 4px', background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)' }}
          >
            {sessions.map((s) => <option key={s.id} value={s.id}>{t('ai.review.session', { app: s.app, time: formatDateTime(s.createdAt) })}</option>)}
          </select>
        </div>
      )}
      <div
        ref={listRef}
        role="log"
        aria-label={t('ai.pane.activity')}
        tabIndex={0}
        onScroll={(e) => { const el = e.currentTarget; stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }}
        style={{ flex: 1, overflowY: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--font-size-sm)', lineHeight: 1.5 }}
      >
        {!session ? (
          <p style={{ color: 'var(--text-muted)' }}>{t('ai.pane.emptyApps')}</p>
        ) : (
          <>
            <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: 0 }}>{t('ai.pane.appSession', { name: session.app, time: formatDateTime(session.createdAt) })}</p>
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {session.items.map((item) => <Item key={item.id} item={item} />)}
            </ul>
          </>
        )}
      </div>
      <div style={{ padding: '4px 10px 6px', fontSize: 11, color: 'var(--text-muted)', flexShrink: 0, display: 'flex', gap: 10, alignItems: 'center', borderTop: '1px solid var(--border-color)' }}>
        <span style={{ flex: 1 }}>{t('ai.pane.appsOn')}</span>
        <button type="button" onClick={() => useAiStore.getState().allowApps(false)} style={linkStyle}>{t('ai.pane.stopApps')}</button>
      </div>
    </>
  )
}

/** What an app read, or proposed. */
function Item({ item }: { item: SessionItem }) {
  const { t } = useTranslation()
  const proposed = item.proposalIds?.length ?? 0
  return (
    <li style={{ fontSize: 12, color: item.isError ? 'var(--text-muted)' : 'var(--text-secondary)', fontStyle: item.isError ? 'italic' : undefined, borderInlineStart: '2px solid var(--border-color)', paddingInlineStart: 8 }}>
      {t(item.activity.key, item.activity.vars)}
      {proposed > 0 && (
        <>
          {' · '}
          <button type="button" onClick={openReview} style={linkStyle}>{t('ai.pane.proposed', { count: proposed })}</button>
        </>
      )}
    </li>
  )
}
