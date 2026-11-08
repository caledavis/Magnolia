import { formatDateTime, currentLanguage, formatNumber } from '../../i18n'
/**
 * The Memos window: every memo in the project, wherever it is attached.
 * The Saved Memos pane shows only project memos and the memos of the
 * document that's open; this lists them all, grouped by what they're
 * attached to, with a search box.
 *
 * Laid out like the Logbook and Queries windows: the memos on the left
 * and the selected memo on the right, under pane headers, split by a
 * draggable divider.
 *
 * The main window owns the memos and works out where each one lives
 * (utils/memo-places.ts); it sends them here and again whenever they
 * change. Everything that changes a memo (New, Edit, Delete) and Show
 * are carried out by the main window, which prompts first while someone
 * else has the project checked out.
 */
import { useState, useCallback, useEffect, useMemo } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { Icon, faChevronDown, faChevronRight, faPlus, faMagnifyingGlass, faXmark } from '../Icon'
import { Markdown } from '../Markdown'
import type { Memo, MemosWindowData, MemosWindowAction } from '../../models/types'
import { groupMemos, memoMatches, type MemoPlace } from '../../utils/memo-places'
import { exportPdfWithHeader, buildPdfDocument, escHtml } from '../../utils/pdf-export'
import { useClampedMenuPosition } from '../../utils/use-clamped-menu-position'
import { useTranslation } from 'react-i18next'

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(currentLanguage(), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function MemoRow({ memo, place, selected, onClick, onDoubleClick, onContextMenu }: {
  memo: Memo
  place: MemoPlace | undefined
  selected: boolean
  onClick: (e: React.MouseEvent) => void
  onDoubleClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const { t } = useTranslation()
  return (
    <div
      className="codebook-entry"
      style={{ padding: '5px 10px 5px 26px', cursor: 'pointer', background: selected ? 'var(--selection-bg)' : undefined }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e) }}
    >
      <div style={{ fontWeight: 500, fontSize: 'var(--font-size-sm)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {memo.title || t('memos.untitled')}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {place && place.groupKey !== 'project' ? `${place.detail} · ` : ''}{formatDate(memo.modifiedDateTime ?? memo.createdDateTime)}
      </div>
    </div>
  )
}

function MemoDetail({ memo, place, onEdit, onShow }: {
  memo: Memo | null
  place: MemoPlace | undefined
  onEdit: () => void
  onShow: () => void
}) {
  const { t } = useTranslation()
  if (!memo) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
        {t('memos.selectToRead')}
      </div>
    )
  }
  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 4 }}>
        <div style={{ flex: 1, fontWeight: 600, fontSize: 'var(--font-size-lg)' }}>{memo.title || t('memos.untitled')}</div>
        {place?.canShow && <button className="secondary" style={{ fontSize: 11, padding: '2px 10px' }} onClick={onShow} title={t('memos.showTitle')}>{t('common.show')}</button>}
        {/* A transparent border, so it matches Show's 1px border. */}
        <button style={{ fontSize: 11, padding: '2px 10px', border: '1px solid transparent' }} onClick={onEdit}>{t('common.edit')}</button>
      </div>
      {place && (
        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', marginBottom: 2 }}>
          {place.groupKey.startsWith('doc:') ? `${place.groupLabel} · ${place.detail}` : place.detail}
        </div>
      )}
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 10 }}>
        Created {formatDate(memo.createdDateTime)}
        {memo.modifiedDateTime && <span> · edited {formatDate(memo.modifiedDateTime)}</span>}
      </div>
      {memo.content ? (
        <Markdown text={memo.content} style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }} />
      ) : (
        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)', fontStyle: 'italic' }}>{t('common.noContent')}</div>
      )}
    </div>
  )
}

export function MemosWindow() {
  const { t } = useTranslation()
  const [data, setData] = useState<MemosWindowData>({ memos: [], places: {}, lockedBy: null, theme: '' })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<Memo[] | null>(null)
  const menuPos = useClampedMenuPosition(menu)

  const apply = useCallback((d: MemosWindowData) => {
    if (d.theme) document.documentElement.setAttribute('data-theme', d.theme)
    setData(d)
    // Drop selections of memos that have gone.
    const alive = new Set(d.memos.map((m) => m.guid))
    setSelected((prev) => new Set([...prev].filter((g) => alive.has(g))))
  }, [])

  useEffect(() => {
    window.api.getMemosWindowData().then((d) => { if (d) apply(d) })
    return window.api.onMemosWindowData((d) => { if (d) apply(d) })
  }, [apply])

  const send = useCallback((action: MemosWindowAction, ...args: unknown[]) => {
    window.api.sendMemosWindowAction(action, ...args)
    // Show goes to the main window, and while the project is checked out
    // the prompt to take over appears there.
    if (action === 'show' || data.lockedBy) window.api.focusMainWindow()
  }, [data.lockedBy])

  const visible = useMemo(
    () => data.memos.filter((m) => memoMatches(m, data.places[m.guid], search)),
    [data, search]
  )
  const groups = useMemo(() => groupMemos(visible, data.places), [visible, data.places])
  const ordered = useMemo(() => groups.flatMap((g) => (collapsed.has(g.key) && !search ? [] : g.memos)), [groups, collapsed, search])

  const handleClick = useCallback((e: React.MouseEvent, memo: Memo) => {
    if (e.shiftKey && anchor) {
      const a = ordered.findIndex((m) => m.guid === anchor)
      const b = ordered.findIndex((m) => m.guid === memo.guid)
      if (a >= 0 && b >= 0) {
        const [from, to] = a < b ? [a, b] : [b, a]
        setSelected(new Set(ordered.slice(from, to + 1).map((m) => m.guid)))
        return
      }
    }
    if (e.metaKey || e.ctrlKey) {
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(memo.guid)) next.delete(memo.guid)
        else next.add(memo.guid)
        return next
      })
    } else {
      setSelected(new Set([memo.guid]))
    }
    setAnchor(memo.guid)
  }, [anchor, ordered])

  const handleContextMenu = useCallback((e: React.MouseEvent, memo: Memo) => {
    if (!selected.has(memo.guid)) {
      setSelected(new Set([memo.guid]))
      setAnchor(memo.guid)
    }
    setMenu({ x: e.clientX, y: e.clientY })
  }, [selected])

  const selectedMemos = data.memos.filter((m) => selected.has(m.guid))
  const shown = selectedMemos.length === 1 ? selectedMemos[0] : null

  const handleExportPdf = useCallback(async () => {
    const { markdownToHtml } = await import('../Markdown')
    const body = groupMemos(data.memos, data.places).map((g) => `
      <h2 class="group">${escHtml(g.label)}</h2>
      ${g.memos.map((m) => {
        const place = data.places[m.guid]
        const where = place && place.groupKey !== 'project' ? `<div class="memo-where">${escHtml(place.detail)}</div>` : ''
        return `<div class="memo">
          <div class="memo-title">${escHtml(m.title || t('memos.untitled'))}</div>
          ${where}
          <div class="memo-date">${escHtml(formatDate(m.createdDateTime))}${m.modifiedDateTime ? ` · ${escHtml(t('common.editedOn', { date: formatDate(m.modifiedDateTime) }))}` : ''}</div>
          <div class="memo-content">${m.content ? markdownToHtml(m.content) : `<em>${escHtml(t('common.noContent'))}</em>`}</div>
        </div>`
      }).join('')}`).join('')
    const extraCss = `
  h2.group { font-size: 13px; margin: 18px 0 4px; padding-bottom: 3px; border-bottom: 1px solid #ccc; }
  .memo { padding: 8px 0; border-bottom: 1px solid #eee; break-inside: avoid; }
  .memo-title { font-weight: 600; font-size: 12px; margin-bottom: 2px; }
  .memo-where { font-size: 10px; color: #555; }
  .memo-date { font-size: 10px; color: #888; margin-bottom: 6px; }
  .memo-content { font-size: 11px; color: #444; }
  .memo-content p { margin: 0 0 6px; } .memo-content p:last-child { margin-bottom: 0; }
  .memo-content ul, .memo-content ol { margin: 0 0 6px; padding-inline-start: 18px; }
`
    const html = buildPdfDocument({
      title: t('memos.windowTitle'),
      subtitle: escHtml(t('memos.pdfSubtitle', { count: data.memos.length, date: formatDateTime(new Date()) })),
      body,
      extraCss
    })
    await exportPdfWithHeader(html, t('memos.windowTitle'))
  }, [data])

  const toggleGroup = (key: string) => setCollapsed((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  return (
    <div className="panel memos-window">
      <PanelGroup direction="horizontal" style={{ flex: 1, overflow: 'hidden' }}>
        <Panel defaultSize={42} minSize={25} maxSize={70}>
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div className="panel-header">
              <span style={{ flex: 1 }}>{t('memos.windowTitle')}</span>
              <span style={{ fontWeight: 400, letterSpacing: 0 }}>{formatNumber(data.memos.length)}</span>
              <button
                className="panel-header-add"
                onClick={() => send('new')}
                title={t('memos.newProjectMemo')}
                aria-label={t('memos.newProjectMemo')}
                style={data.lockedBy ? { opacity: 0.4 } : undefined}
              >
                <Icon icon={faPlus} />
              </button>
            </div>
            <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Icon icon={faMagnifyingGlass} style={{ color: 'var(--text-muted)', fontSize: 12 }} />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setSearch('') }}
                placeholder={t('memos.searchPlaceholder')}
                aria-label={t('memos.searchPlaceholder')}
                style={{ flex: 1, minWidth: 0 }}
              />
              {search && (
                <button className="panel-header-close" onClick={() => setSearch('')} title={t('common.clearSearch')} aria-label={t('common.clearSearch')}>
                  <Icon icon={faXmark} />
                </button>
              )}
            </div>
            <div className="panel-content">
              {data.memos.length === 0 ? (
                <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
                  {t('memos.windowEmpty')}
                </div>
              ) : groups.length === 0 ? (
                <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
                  No memos match "{search.trim()}".
                </div>
              ) : groups.map((g, i) => {
                const open = !collapsed.has(g.key) || !!search
                return (
                  <div key={g.key}>
                    <div
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
                        ...(i > 0 ? { borderTop: '1px solid var(--border-color)' } : {}),
                        cursor: 'pointer', fontSize: 'var(--font-size-sm)', fontWeight: 600,
                        color: 'var(--text-secondary)', userSelect: 'none'
                      }}
                      onClick={() => toggleGroup(g.key)}
                    >
                      <span style={{ fontSize: 10, width: 12, textAlign: 'center', opacity: 0.6 }}>
                        <Icon icon={open ? faChevronDown : faChevronRight} />
                      </span>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.label}</span>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>{formatNumber(g.memos.length)}</span>
                    </div>
                    {open && g.memos.map((m) => (
                      <MemoRow
                        key={m.guid}
                        memo={m}
                        place={data.places[m.guid]}
                        selected={selected.has(m.guid)}
                        onClick={(e) => handleClick(e, m)}
                        onDoubleClick={() => send('edit', m.guid)}
                        onContextMenu={(e) => handleContextMenu(e, m)}
                      />
                    ))}
                  </div>
                )
              })}
            </div>
          </div>
        </Panel>
        <PanelResizeHandle className="queries-sidebar-divider" style={{ width: 1, background: 'var(--border-color)', cursor: 'col-resize' }} />
        <Panel defaultSize={58} minSize={30}>
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div className="panel-header">
              <span style={{ flex: 1 }}>{t('memos.memoHeading')}</span>
              <button
                className="secondary"
                style={{ fontSize: 11, padding: '2px 8px', textTransform: 'none', letterSpacing: 0 }}
                onClick={handleExportPdf}
                disabled={data.memos.length === 0}
                title={t('memos.exportAllTitle')}
              >
                {t('common.exportPdf')}
              </button>
            </div>
            <div className="panel-content">
              {selectedMemos.length > 1 ? (
                <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
                  {t('memos.nSelected', { count: selectedMemos.length })}
                </div>
              ) : (
                <MemoDetail
                  memo={shown}
                  place={shown ? data.places[shown.guid] : undefined}
                  onEdit={() => shown && send('edit', shown.guid)}
                  onShow={() => shown && send('show', shown.guid)}
                />
              )}
            </div>
          </div>
        </Panel>
      </PanelGroup>

      {menu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 99 }} onMouseDown={() => setMenu(null)} />
          <div ref={menuPos.ref} className="context-menu" style={{ position: 'fixed', left: menuPos.x, top: menuPos.y, zIndex: 100 }}>
            {selectedMemos.length === 1 && (
              <>
                <div className="context-menu-item" onClick={() => { setMenu(null); send('edit', selectedMemos[0].guid) }}>{t('memos.edit')}</div>
                {data.places[selectedMemos[0].guid]?.canShow && (
                  <div className="context-menu-item" onClick={() => { setMenu(null); send('show', selectedMemos[0].guid) }}>{t('memos.showInDocument')}</div>
                )}
                <div className="context-menu-separator" />
              </>
            )}
            <div
              className="context-menu-item"
              style={{ color: 'var(--menu-fg-danger)' }}
              onClick={() => {
                setMenu(null)
                if (data.lockedBy) { send('delete', selectedMemos.map((m) => m.guid)); return }
                setDeleteConfirm(selectedMemos)
              }}
            >
              {selectedMemos.length > 1 ? t('memos.deleteCountTitle', { count: selectedMemos.length }) : t('memos.deleteOne')}
            </div>
          </div>
        </>
      )}

      {deleteConfirm && (
        <div className="modal-overlay" onClick={() => setDeleteConfirm(null)} style={{ position: 'fixed' }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ margin: '0 0 12px' }}>{deleteConfirm.length > 1 ? t('memos.deleteCountTitle', { count: deleteConfirm.length }) : t('memos.deleteOne')}</h2>
            <p style={{ margin: '0 0 16px', fontSize: 'var(--font-size-sm)' }}>
              {deleteConfirm.length > 1
                ? t('memos.deleteCountConfirm', { count: deleteConfirm.length })
                : t('memos.deleteOneConfirm', { title: deleteConfirm[0].title || t('memos.untitled') })}
            </p>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setDeleteConfirm(null)}>{t('common.cancel')}</button>
              <button
                style={{ background: 'var(--danger)' }}
                onClick={() => { send('delete', deleteConfirm.map((m) => m.guid)); setDeleteConfirm(null) }}
              >
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
