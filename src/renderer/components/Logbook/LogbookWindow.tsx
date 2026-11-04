import { useState, useCallback, useEffect } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { Icon, faPlus } from '../Icon'
import { Markdown } from '../Markdown'
import { MarkdownEditor } from '../MarkdownEditor'
import type { LogbookEntry, LogbookInitData } from '../../models/types'
import { generateGuid } from '../../utils/guid'
import { exportPdfWithHeader, buildPdfDocument, escHtml } from '../../utils/pdf-export'

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function EntryRow({
  entry,
  isSelected,
  onClick,
  onDoubleClick
}: {
  entry: LogbookEntry
  isSelected: boolean
  onClick: () => void
  onDoubleClick: () => void
}) {
  return (
    <div
      style={{
        padding: '6px 10px',
        borderBottom: '1px solid var(--border-color)',
        cursor: 'pointer',
        background: isSelected ? 'var(--selection-bg)' : undefined,
        transition: 'background 0.1s'
      }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <div style={{
        fontWeight: 600,
        fontSize: 'var(--font-size-sm)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }}>
        {entry.title || 'Untitled Entry'}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
        {formatDate(entry.createdDateTime)}
        {entry.modifiedDateTime && (
          <span> · edited {formatDate(entry.modifiedDateTime)}</span>
        )}
      </div>
    </div>
  )
}

function EditEntryDialog({
  entry,
  onSave,
  onClose
}: {
  entry: LogbookEntry | null
  onSave: (title: string, content: string) => void
  onClose: () => void
}) {
  const [title, setTitle] = useState(entry?.title || '')
  const [content, setContent] = useState(entry?.content || '')

  return (
    <div className="modal-overlay" style={{ position: 'fixed' }}>
      <div className="modal" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose() }} style={{ minWidth: 480 }}>
        <h2 style={{ margin: '0 0 12px' }}>{entry ? 'Edit Entry' : 'New Entry'}</h2>

        <div style={{ marginBottom: 10 }}>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && title.trim()) onSave(title.trim(), content)
            }}
            placeholder="Entry title..."
            autoFocus
            style={{ width: '100%' }}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
            Content
          </label>
          <MarkdownEditor
            value={content}
            onChange={setContent}
          />
        </div>

        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button
            onClick={() => {
              if (title.trim()) onSave(title.trim(), content)
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

function EntryDetailPane({ entry }: { entry: LogbookEntry | null }) {
  if (!entry) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
        Select an entry to see its details.
      </div>
    )
  }
  return (
    <div style={{ padding: 12 }}>
      <div style={{ fontWeight: 600, fontSize: 'var(--font-size-lg)', marginBottom: 4 }}>
        {entry.title || 'Untitled Entry'}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 10 }}>
        Created {formatDate(entry.createdDateTime)}
        {entry.modifiedDateTime && (
          <span> · edited {formatDate(entry.modifiedDateTime)}</span>
        )}
      </div>
      {entry.content ? (
        <Markdown
          text={entry.content}
          style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}
        />
      ) : (
        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)', fontStyle: 'italic' }}>
          No content
        </div>
      )}
    </div>
  )
}

export function LogbookWindow() {
  const [entries, setEntries] = useState<LogbookEntry[]>([])
  const [selectedGuid, setSelectedGuid] = useState<string | null>(null)
  const [editingEntry, setEditingEntry] = useState<LogbookEntry | null | 'new'>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [entryContextMenu, setEntryContextMenu] = useState<{ x: number; y: number; guid: string } | null>(null)

  const applyInitData = useCallback((initData: LogbookInitData) => {
    if (initData.theme !== undefined) {
      document.documentElement.setAttribute('data-theme', initData.theme)
    }
    setEntries(initData.entries)
  }, [])

  useEffect(() => {
    window.api.getLogbookData().then((initData) => {
      if (initData) applyInitData(initData)
    })
    const unsub = window.api.onLogbookData((initData) => {
      if (initData) applyInitData(initData)
    })
    return unsub
  }, [applyInitData])

  const handleNewEntry = useCallback(() => {
    setEditingEntry('new')
  }, [])

  const handleSaveEntry = useCallback((title: string, content: string) => {
    if (editingEntry === 'new') {
      const guid = generateGuid()
      const now = new Date().toISOString()
      const newEntry: LogbookEntry = { guid, title, content, createdDateTime: now }
      setEntries((prev) => [newEntry, ...prev])
      setSelectedGuid(guid)
      window.api.sendLogbookUpdate('add-entry', newEntry)
    } else if (editingEntry) {
      const updated = {
        ...editingEntry,
        title,
        content,
        modifiedDateTime: new Date().toISOString()
      }
      setEntries((prev) => prev.map((e) => (e.guid === updated.guid ? updated : e)))
      window.api.sendLogbookUpdate('update-entry', updated.guid, updated.title, updated.content)
    }
    setEditingEntry(null)
  }, [editingEntry])

  const handleDeleteEntry = useCallback((guid: string) => {
    setEntries((prev) => prev.filter((e) => e.guid !== guid))
    if (selectedGuid === guid) setSelectedGuid(null)
    window.api.sendLogbookUpdate('remove-entry', guid)
    setDeleteConfirm(null)
  }, [selectedGuid])

  const handleExportPdf = useCallback(async () => {
    const now = new Date().toLocaleString()
    const { markdownToHtml } = await import('../Markdown')

    const body = entries.map((e) => {
      const contentHtml = e.content ? markdownToHtml(e.content) : '<em>No content</em>'
      return `<div class="entry">
        <div class="entry-title">${escHtml(e.title || 'Untitled Entry')}</div>
        <div class="entry-date">${escHtml(formatDate(e.createdDateTime))}${e.modifiedDateTime ? ` · edited ${escHtml(formatDate(e.modifiedDateTime))}` : ''}</div>
        <div class="entry-content">${contentHtml}</div>
      </div>`
    }).join('')

    // Per-entry block styling lives here; shared body typography,
    // h1, .subtitle, and markdown chrome (code/pre/blockquote) are
    // provided by buildPdfDocument.
    const extraCss = `
  .entry { padding: 10px 0; border-bottom: 1px solid #eee; }
  .entry-title { font-weight: 600; font-size: 13px; margin-bottom: 2px; }
  .entry-date { font-size: 10px; color: #888; margin-bottom: 6px; }
  .entry-content { font-size: 11px; color: #444; }
  .entry-content p { margin: 0 0 6px; } .entry-content p:last-child { margin-bottom: 0; }
  .entry-content ul, .entry-content ol { margin: 0 0 6px; padding-left: 18px; }
`

    const html = buildPdfDocument({
      title: 'Logbook',
      subtitle: `${entries.length} entr${entries.length !== 1 ? 'ies' : 'y'} &mdash; exported ${escHtml(now)}`,
      body,
      extraCss
    })

    await exportPdfWithHeader(html, 'Logbook')
  }, [entries])

  const selectedEntry = selectedGuid ? entries.find((e) => e.guid === selectedGuid) ?? null : null

  return (
    // Laid out like the Queries pop-out: one card with the entries on the
    // left and the selected entry on the right, each under a pane header,
    // split by a draggable divider.
    <div className="panel logbook-window">
      <PanelGroup direction="horizontal" style={{ flex: 1, overflow: 'hidden' }}>
        <Panel defaultSize={40} minSize={25} maxSize={70}>
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div className="panel-header">
              <span style={{ flex: 1 }}>Entries</span>
              <span style={{ fontWeight: 400, letterSpacing: 0 }}>{entries.length}</span>
              <button className="panel-header-add" onClick={handleNewEntry} title="New entry" aria-label="New entry">
                <Icon icon={faPlus} />
              </button>
            </div>
            <div className="panel-content">
              {entries.length === 0 ? (
                <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
                  No entries yet. Click + to create one.
                </div>
              ) : (
                <>
                  {entries.map((entry) => (
                    <div
                      key={entry.guid}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        setSelectedGuid(entry.guid)
                        setEntryContextMenu({ x: e.clientX, y: e.clientY, guid: entry.guid })
                      }}
                    >
                      <EntryRow
                        entry={entry}
                        isSelected={selectedGuid === entry.guid}
                        onClick={() => setSelectedGuid(entry.guid)}
                        onDoubleClick={() => setEditingEntry(entry)}
                      />
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </Panel>
        <PanelResizeHandle className="queries-sidebar-divider" style={{ width: 1, background: 'var(--border-color)', cursor: 'col-resize' }} />
        <Panel defaultSize={60} minSize={30}>
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div className="panel-header">
              <span style={{ flex: 1 }}>Logbook</span>
              <button
                className="secondary"
                style={{ fontSize: 11, padding: '2px 8px', textTransform: 'none', letterSpacing: 0 }}
                onClick={handleExportPdf}
                title="Export the logbook as a PDF"
              >
                Export PDF
              </button>
            </div>
            <div className="panel-content">
              <EntryDetailPane entry={selectedEntry} />
            </div>
          </div>
        </Panel>
      </PanelGroup>

      {/* Edit/New entry dialog */}
      {editingEntry !== null && (
        <EditEntryDialog
          entry={editingEntry === 'new' ? null : editingEntry}
          onSave={handleSaveEntry}
          onClose={() => setEditingEntry(null)}
        />
      )}

      {/* Entry context menu */}
      {entryContextMenu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 99 }} onClick={() => setEntryContextMenu(null)} />
          <div
            className="context-menu"
            style={{ position: 'fixed', left: entryContextMenu.x, top: entryContextMenu.y, zIndex: 100 }}
          >
            <div className="context-menu-item" onClick={() => {
              const entry = entries.find((e) => e.guid === entryContextMenu.guid)
              setEntryContextMenu(null)
              if (entry) setEditingEntry(entry)
            }}>
              Edit Entry
            </div>
            <div className="context-menu-separator" />
            <div
              className="context-menu-item"
              style={{ color: 'var(--menu-fg-danger)' }}
              onClick={() => {
                setDeleteConfirm(entryContextMenu.guid)
                setEntryContextMenu(null)
              }}
            >
              Delete Entry
            </div>
          </div>
        </>
      )}

      {/* Delete confirmation */}
      {deleteConfirm && (
        <div className="modal-overlay" onClick={() => setDeleteConfirm(null)} style={{ position: 'fixed' }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ margin: '0 0 12px' }}>Delete Entry</h2>
            <p style={{ margin: '0 0 16px', fontSize: 'var(--font-size-sm)' }}>
              Are you sure you want to delete this logbook entry? This cannot be undone.
            </p>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setDeleteConfirm(null)}>Cancel</button>
              <button
                style={{ background: 'var(--danger)' }}
                onClick={() => handleDeleteEntry(deleteConfirm)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
