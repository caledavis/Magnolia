import { useState, useEffect } from 'react'
// ES imports so Vite bundles and hashes the assets — plain `url(./assets/…)`
// strings only resolve in dev; production builds drop them.
// Welcome background lives in graphic_files/ alongside the icon sources so
// all app artwork is in one place. Replace that one file (1440×1040 ideal)
// to change the welcome image.
import welcomeBgUrl from '../../../../graphic_files/welcome-bg.png'
import magnoliaUrl from '../../assets/magnoliaqda-welcome.svg'

export function WelcomeScreen() {
  const [recentProjects, setRecentProjects] = useState<{ name: string; path: string }[]>([])

  useEffect(() => {
    const refresh = () => {
      window.api.getRecentProjects().then((projects) => {
        setRecentProjects(projects ?? [])
      })
    }
    refresh()
    const unsub = window.api.onRecentProjectsChanged(refresh)
    return unsub
  }, [])

  return (
    <div style={{
      position: 'relative',
      height: '100vh',
      width: '100vw',
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      backgroundImage: `url("${welcomeBgUrl}")`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      fontFamily: 'var(--font-family)',
      color: 'var(--text-primary)',
      userSelect: 'none'
    }}>
      <div style={{
        background: 'var(--bg-panel)',
        // No bottom padding: the sponsor link's flex:1 region extends to the
        // true window bottom so it centres between the buttons and that edge.
        padding: '40px 48px 0',
        boxShadow: '16px 0 60px rgba(0,0,0,0.18), 4px 0 16px rgba(0,0,0,0.10)',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto'
      }}>
        {/* Top spacer — pairs with the equal-weight spacer holding the sponsor
            link below. The two keep the wordmark / projects / buttons stack
            vertically centred, while the sponsor link sits centred in the gap
            between the buttons and the bottom of the window. */}
        <div style={{ flex: 1 }} />
        {/* Wordmark — same mask-recolour pattern the toolbar uses. The
            welcome screen and PDF exports share the full-product
            wordmark (magnoliaqda.svg); the in-app toolbar uses the
            shorter magnolia.svg variant. Both take their colour from
            --text-secondary so the brand reads consistently across
            surfaces. */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div
            aria-label="Magnolia"
            style={{
              display: 'inline-block',
              width: 240,
              height: 45,
              // Same hue as the toolbar wordmark (--text-secondary) so
              // the brand reads consistently across welcome and main app.
              background: 'var(--text-secondary)',
              WebkitMaskImage: `url("${magnoliaUrl}")`,
              maskImage: `url("${magnoliaUrl}")`,
              WebkitMaskRepeat: 'no-repeat',
              maskRepeat: 'no-repeat',
              WebkitMaskSize: 'contain',
              maskSize: 'contain',
              WebkitMaskPosition: 'center',
              maskPosition: 'center'
            }}
          />
        </div>

        <div style={{ marginBottom: 20 }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 8
          }}>
            <div style={{
              fontSize: 'var(--font-size-sm)',
              fontWeight: 600,
              color: 'var(--text-secondary)'
            }}>
              Recent Projects
            </div>
            {recentProjects.length > 0 && (
              <button
                onClick={() => {
                  window.api.sendWelcomeAction('clear-recent')
                  setRecentProjects([])
                }}
                title="Clear recent projects"
                className="secondary"
                style={{
                  fontSize: 11,
                  padding: '2px 8px'
                }}
              >
                Clear
              </button>
            )}
          </div>
          <div style={{
            maxHeight: 200,
            overflowY: 'auto',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-color)',
            background: 'var(--bg-primary)'
          }}>
            {recentProjects.length === 0 ? (
              <div style={{
                padding: '16px 12px',
                fontSize: 'var(--font-size-sm)',
                color: 'var(--text-muted)',
                textAlign: 'center',
                fontStyle: 'italic'
              }}>
                No recent projects yet
              </div>
            ) : (
              recentProjects.map((proj, i) => (
                <div
                  key={proj.path}
                  onClick={() => window.api.sendWelcomeAction('open-recent:' + proj.path)}
                  style={{
                    padding: '8px 12px',
                    cursor: 'pointer',
                    borderBottom: i < recentProjects.length - 1 ? '1px solid var(--border-color)' : undefined,
                    transition: 'background 0.1s'
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-secondary)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {proj.path.split('/').pop()?.replace(/\.qdpx$/i, '') || proj.name}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
                    {proj.path}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="secondary"
            onClick={() => window.api.sendWelcomeAction('quit')}
            style={{ flex: 1, padding: '7px 12px', fontSize: 12, fontWeight: 600 }}
          >
            Quit
          </button>
          <button
            className="secondary"
            onClick={() => window.api.sendWelcomeAction('open-project')}
            style={{ flex: 1, padding: '7px 12px', fontSize: 12, fontWeight: 600 }}
          >
            Open…
          </button>
          <button
            onClick={() => window.api.sendWelcomeAction('new-project')}
            style={{ flex: 1, padding: '7px 12px', fontSize: 12, fontWeight: 600 }}
          >
            New
          </button>
        </div>

        {/* Sponsor link — centred in the gap between the buttons and the
            bottom of the window via this flex:1 region (paired with the top
            spacer). Routed through the 'sponsor' welcome action so it opens in
            the default browser (the welcome window has no setWindowOpenHandler). */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          <span
            role="button"
            tabIndex={0}
            onClick={() => window.api.sendWelcomeAction('sponsor')}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') window.api.sendWelcomeAction('sponsor') }}
            style={{
              fontSize: 11.5,
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--accent)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-secondary)')}
          >
            <span aria-hidden>♥</span>
            Sponsor Magnolia's development
          </span>
          <span style={{ fontSize: 11.5, color: 'var(--text-secondary)', textAlign: 'center' }}>
            Use Magnolia at your own risk.
            <br />
            Coded by Claude.
          </span>
        </div>
      </div>
      <div />

      {/* App version — bottom-right corner, over the welcome artwork.
          White with a soft shadow so it stays legible on any image. */}
      <div style={{
        position: 'absolute',
        bottom: 10,
        right: 14,
        fontSize: 11,
        fontWeight: 500,
        color: 'rgba(255, 255, 255, 0.9)',
        textShadow: '0 1px 3px rgba(0, 0, 0, 0.55)',
        letterSpacing: 0.2,
        pointerEvents: 'none'
      }}>
        v{__APP_VERSION__}
      </div>
    </div>
  )
}
