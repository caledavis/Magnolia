import { useState, useCallback, useEffect } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { Markdown, markdownToHtml } from '../Markdown'
import { MarkdownEditor } from '../MarkdownEditor'
import { Icon, faChevronDown, faChevronRight } from '../Icon'
import type { Code, CodebookInitData } from '../../models/types'
import { exportPdfWithHeader, buildPdfDocument, escHtml } from '../../utils/pdf-export'
import { modKey, isMac } from '../../utils/platform'
import { useCodeColourPresets } from '../../utils/code-colours'
import { useClampedMenuPosition } from '../../utils/use-clamped-menu-position'
import { useTranslation } from 'react-i18next'
import { t, formatDateTime } from '../../i18n'

function flattenCodes(codes: Code[]): Code[] {
  const result: Code[] = []
  for (const c of codes) {
    result.push(c)
    result.push(...flattenCodes(c.children))
  }
  return result
}

/** A row of the code list, drawn exactly like a row of the Codes pane
 *  (CodeTreeItem in CodeBrowser.tsx): chevron slot, colour pip, name,
 *  hotkey and coded-segment count, the same spacing and the same
 *  selection colour. Read-only here: click selects, the chevron folds,
 *  double-click edits. */
function CompactCodeEntry({
  code,
  depth,
  selectedGuid,
  codeCounts,
  renamingGuid,
  onEditCode,
  onSelectCode,
  onContextMenu,
  onRename,
  onStopRenaming
}: {
  code: Code
  depth: number
  selectedGuid: string | null
  codeCounts: Record<string, number>
  renamingGuid: string | null
  onEditCode: (guid: string) => void
  onSelectCode: (guid: string) => void
  onContextMenu: (guid: string, x: number, y: number) => void
  onRename: (guid: string, name: string) => void
  onStopRenaming: () => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(true)
  const count = codeCounts[code.guid] || 0
  const renaming = renamingGuid === code.guid
  const [editName, setEditName] = useState(code.name)
  useEffect(() => { if (renaming) setEditName(code.name) }, [renaming, code.name])
  const commit = () => {
    if (editName.trim() && editName.trim() !== code.name) onRename(code.guid, editName.trim())
    onStopRenaming()
  }
  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 8px',
          paddingLeft: 8 + depth * 16,
          cursor: 'pointer',
          borderRadius: 'var(--radius-sm)',
          background: selectedGuid === code.guid ? 'var(--selection-bg)' : 'transparent',
          fontSize: 'var(--font-size-sm)',
          transition: 'background 0.1s'
        }}
        onClick={(e) => {
          e.stopPropagation()
          onSelectCode(code.guid)
        }}
        onDoubleClick={() => onEditCode(code.guid)}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onSelectCode(code.guid)
          onContextMenu(code.guid, e.clientX, e.clientY)
        }}
        title={t('common.doubleClickToEdit')}
      >
        <span
          onClick={code.children.length > 0 ? (e) => {
            e.stopPropagation()
            setExpanded(!expanded)
          } : undefined}
          style={{
            fontSize: 9,
            flexShrink: 0,
            width: 10,
            textAlign: 'center',
            opacity: 0.6,
            cursor: code.children.length > 0 ? 'pointer' : 'default'
          }}
        >
          {code.children.length > 0 && <Icon icon={expanded ? faChevronDown : faChevronRight} />}
        </span>
        <span style={{ width: 14, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
          <span className="color-pip" style={{ background: code.color || '#888' }} />
        </span>
        {renaming ? (
          <input
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            ref={(el) => { if (el && !el.dataset.selected) { el.select(); el.dataset.selected = 'true' } }}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              else if (e.key === 'Escape') onStopRenaming()
            }}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            style={{ flex: 1, padding: '1px 4px' }}
          />
        ) : (
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {code.name}
          </span>
        )}
        <span style={{ width: isMac ? 24 : 40, minWidth: isMac ? 24 : 40, flexShrink: 0, fontSize: 10, color: 'var(--text-muted)', textAlign: 'right' }}>
          {code.hotkey !== undefined ? modKey(code.hotkey) : ''}
        </span>
        <span style={{ width: 28, minWidth: 28, flexShrink: 0, fontSize: 10, color: 'var(--text-muted)', textAlign: 'right' }}>
          {count > 0 ? count : ''}
        </span>
      </div>
      {expanded && code.children.map((child) => (
        <CompactCodeEntry
          key={child.guid}
          code={child}
          depth={depth + 1}
          selectedGuid={selectedGuid}
          codeCounts={codeCounts}
          renamingGuid={renamingGuid}
          onEditCode={onEditCode}
          onSelectCode={onSelectCode}
          onContextMenu={onContextMenu}
          onRename={onRename}
          onStopRenaming={onStopRenaming}
        />
      ))}
    </div>
  )
}

function EditCodeDialog({
  code,
  onSave,
  onClose
}: {
  code: Code
  onSave: (name: string, color: string, description: string, hotkey: number | undefined) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(code.name)
  const [color, setColor] = useState(code.color || '#888888')
  const [memo, setMemo] = useState(code.description || '')
  const [hotkeyStr, setHotkeyStr] = useState(code.hotkey !== undefined ? String(code.hotkey) : '')
  const [showColorPicker, setShowColorPicker] = useState(false)
  const colourPresets = useCodeColourPresets()

  return (
    <div className="modal-overlay" onClick={onClose} style={{ position: 'fixed' }}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ minWidth: 420 }}>
        <h2 style={{ margin: '0 0 12px' }}>{t('codes.editCode')}</h2>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <span
              className="color-pip"
              onClick={() => setShowColorPicker((v) => !v)}
              style={{
                background: color,
                width: 20,
                height: 20,
                cursor: 'pointer',
                border: '2px solid var(--border-color)',
                boxSizing: 'border-box'
              }}
              title={t('codes.chooseColor')}
            />
            {showColorPicker && (
              <div
                style={{
                  position: 'absolute',
                  top: 28,
                  left: 0,
                  zIndex: 10,
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-sm)',
                  padding: 8,
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 6,
                  width: 210
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {colourPresets.map((c) => (
                  <div
                    key={c}
                    onClick={() => {
                      setColor(c)
                      setShowColorPicker(false)
                    }}
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: '50%',
                      background: c,
                      cursor: 'pointer',
                      border: c === color ? '2px solid white' : '2px solid transparent',
                      boxSizing: 'border-box'
                    }}
                  />
                ))}
                <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                  <label style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{t('codes.custom')}</label>
                  <input
                    type="color"
                    value={color}
                    onChange={(e) => {
                      setColor(e.target.value)
                      setShowColorPicker(false)
                    }}
                    style={{ padding: 0, width: 24, height: 20, border: 'none', background: 'none', cursor: 'pointer' }}
                  />
                </div>
              </div>
            )}
          </div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) {
                const hk = hotkeyStr.match(/^[0-9]$/) ? parseInt(hotkeyStr, 10) : undefined
                onSave(name.trim(), color, memo, hk)
              }
            }}
            placeholder={t('codes.namePlaceholder')}
            autoFocus
            style={{ flex: 1 }}
          />
        </div>

        {/* Description */}
        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
            {t('codes.description')}
          </label>
          <MarkdownEditor
            value={memo}
            onChange={setMemo}
          />
        </div>

        {/* Hotkey */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <label style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
            {modKey('')}
          </label>
          <input
            type="text"
            value={hotkeyStr}
            onChange={(e) => {
              const v = e.target.value
              if (v === '' || /^[0-9]$/.test(v)) setHotkeyStr(v)
            }}
            placeholder="0–9"
            maxLength={1}
            style={{ width: 40, textAlign: 'center' }}
          />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {t('codes.hotkeyHint')}
          </span>
        </div>

        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button
            onClick={() => {
              if (name.trim()) {
                const hk = hotkeyStr.match(/^[0-9]$/) ? parseInt(hotkeyStr, 10) : undefined
                onSave(name.trim(), color, memo, hk)
              }
            }}
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

function buildCodebookHtml(codes: Code[]): string {
  const now = formatDateTime(new Date())
  const allCodes = flattenCodes(codes)

  const renderCode = (code: Code, depth: number): string => {
    const indent = depth * 20
    const memoHtml = code.description
      ? `<div class="memo">${markdownToHtml(code.description)}</div>`
      : `<div class="no-memo">${escHtml(t('codebook.noMemo'))}</div>`
    const children = code.children.map((c) => renderCode(c, depth + 1)).join('')
    return `<div class="code-entry" style="padding-left:${indent}px">
      <div class="code-header">
        <span class="pip" style="background:${code.color || '#888'}"></span>
        <span class="code-name">${escHtml(code.name)}</span>
      </div>
      ${memoHtml}
    </div>${children}`
  }

  const body = codes.map((c) => renderCode(c, 0)).join('')

  // Per-code styling: pip + name + memo block. Base CSS supplies
  // body typography, h1, .subtitle, and markdown chrome (code/pre/
  // blockquote).
  const extraCss = `
  .code-entry { padding: 8px 0; border-bottom: 1px solid #eee; }
  .code-header { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
  .pip { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
  .code-name { font-weight: 600; font-size: 12px; }
  .memo { font-size: 11px; color: #444; padding-left: 18px; line-height: 1.6; }
  .memo p { margin: 0 0 6px; } .memo p:last-child { margin-bottom: 0; }
  .memo ul, .memo ol { margin: 0 0 6px; padding-left: 18px; }
  .memo strong { font-weight: 600; }
  .no-memo { font-size: 11px; color: #aaa; font-style: italic; padding-left: 18px; }
`

  return buildPdfDocument({
    title: t('codebook.title'),
    subtitle: escHtml(t('codebook.pdfSubtitle', { count: allCodes.length, date: now })),
    body,
    extraCss
  })
}

// Detail pane: shows the selected code's full info
function CodeDetailPane({ code }: { code: Code | null }) {
  const { t } = useTranslation()
  if (!code) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
        {t('codebook.selectCode')}
      </div>
    )
  }
  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span className="color-pip" style={{ background: code.color || '#888', width: 12, height: 12 }} />
        <span style={{ fontWeight: 600, fontSize: 'var(--font-size-lg)' }}>{code.name}</span>
      </div>
      {code.description ? (
        <Markdown
          text={code.description}
          style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}
        />
      ) : (
        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)', fontStyle: 'italic' }}>
          {t('codebook.noMemo')}
        </div>
      )}
    </div>
  )
}

/** A pane-header button: the same size as the Queries pane's. */
const HEADER_BUTTON: React.CSSProperties = { fontSize: 11, padding: '2px 8px', textTransform: 'none', letterSpacing: 0 }

export function CodebookWindow() {
  const { t } = useTranslation()
  const [codes, setCodes] = useState<Code[]>([])
  const [codeCounts, setCodeCounts] = useState<Record<string, number>>({})
  // The right-click menu, the code being renamed in place and the code
  // whose colour is being chosen: the same menu as the Codes pane's.
  const [contextMenu, setContextMenu] = useState<{ guid: string; x: number; y: number } | null>(null)
  const [renamingGuid, setRenamingGuid] = useState<string | null>(null)
  const [colourGuid, setColourGuid] = useState<string | null>(null)
  const menuPos = useClampedMenuPosition(contextMenu)
  const colourPresets = useCodeColourPresets()
  const [editingCodeGuid, setEditingCodeGuid] = useState<string | null>(null)
  const [selectedCodeGuid, setSelectedCodeGuid] = useState<string | null>(null)

  const allCodes = flattenCodes(codes)

  const applyInitData = useCallback((initData: CodebookInitData) => {
    if (initData.theme !== undefined) {
      document.documentElement.setAttribute('data-theme', initData.theme)
    }
    setCodes(initData.codes)
    setCodeCounts(initData.codeCounts ?? {})
    if (initData.renameGuid) {
      setSelectedCodeGuid(initData.renameGuid)
      setRenamingGuid(initData.renameGuid)
    }
  }, [])

  useEffect(() => {
    window.api.getCodebookData().then((initData) => {
      if (initData) applyInitData(initData)
    })
    const unsub = window.api.onCodebookData((initData) => {
      if (initData) applyInitData(initData)
    })
    return unsub
  }, [applyInitData])

  const findCode = useCallback((guid: string): Code | undefined => {
    return allCodes.find((c) => c.guid === guid)
  }, [allCodes])

  const updateCodeInTree = useCallback((codes: Code[], guid: string, updater: (c: Code) => Code): Code[] => {
    return codes.map((c) => {
      if (c.guid === guid) return updater(c)
      if (c.children.length > 0) {
        return { ...c, children: updateCodeInTree(c.children, guid, updater) }
      }
      return c
    })
  }, [])

  const handleSaveCode = useCallback((guid: string, name: string, color: string, description: string, hotkey: number | undefined) => {
    setCodes((prev) => updateCodeInTree(prev, guid, (c) => ({ ...c, name, color, description, hotkey })))
    window.api.sendCodebookUpdate('save-code', guid, name, color, description, hotkey)
    setEditingCodeGuid(null)
  }, [updateCodeInTree])

  const handleExportPdf = useCallback(async () => {
    const html = buildCodebookHtml(codes)
    await exportPdfWithHeader(html, t('codebook.title'))
  }, [codes])

  const handleExportQdc = useCallback(async () => {
    await window.api.exportCodebook(codes)
  }, [codes])

  const handleImportQdc = useCallback(async () => {
    const imported = await window.api.importCodebook()
    if (imported && imported.length > 0) {
      setCodes((prev) => {
        const existingGuids = new Set(flattenCodes(prev).map((c) => c.guid))
        const newCodes = imported.filter((c) => !existingGuids.has(c.guid))
        return [...prev, ...newCodes]
      })
      window.api.sendCodebookUpdate('merge-codes', imported)
    }
  }, [])

  const selectedCode = selectedCodeGuid ? findCode(selectedCodeGuid) : null

  return (
    // Laid out like the Queries pop-out: one card with the list on the
    // left and the details on the right, each under a pane header, split
    // by a draggable divider.
    <div className="panel codebook-window">
      <PanelGroup direction="horizontal" style={{ flex: 1, overflow: 'hidden' }}>
        <Panel defaultSize={45} minSize={25} maxSize={70}>
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div className="panel-header">
              <span style={{ flex: 1 }}>{t('panes.codes')}</span>
              <span style={{ fontWeight: 400, letterSpacing: 0 }}>{allCodes.length}</span>
            </div>
            <div className="panel-content">
              {codes.length === 0 ? (
                <div className="empty-state" style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
                  {t('codes.empty')}
                </div>
              ) : (
                codes.map((code) => (
                  <CompactCodeEntry
                    key={code.guid}
                    code={code}
                    depth={0}
                    selectedGuid={selectedCodeGuid}
                    codeCounts={codeCounts}
                    renamingGuid={renamingGuid}
                    onEditCode={setEditingCodeGuid}
                    onSelectCode={setSelectedCodeGuid}
                    onContextMenu={(guid, x, y) => setContextMenu({ guid, x, y })}
                    onRename={(guid, name) => window.api.sendCodebookUpdate('rename-code', guid, name)}
                    onStopRenaming={() => setRenamingGuid(null)}
                  />
                ))
              )}
            </div>
          </div>
        </Panel>
        <PanelResizeHandle className="queries-sidebar-divider" style={{ width: 1, background: 'var(--border-color)', cursor: 'col-resize' }} />
        <Panel defaultSize={55} minSize={30}>
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div className="panel-header">
              <span style={{ flex: 1 }}>{t('codebook.title')}</span>
              <button className="secondary" style={HEADER_BUTTON} onClick={handleImportQdc} title={t('codebook.importQdcTitle')}>
                {t('codebook.importQdc')}
              </button>
              <button className="secondary" style={HEADER_BUTTON} onClick={handleExportQdc} title={t('codebook.exportQdcTitle')}>
                {t('codebook.exportQdc')}
              </button>
              <button className="secondary" style={HEADER_BUTTON} onClick={handleExportPdf} title={t('codebook.exportPdfTitle')}>
                {t('common.exportPdf')}
              </button>
            </div>
            <div className="panel-content">
              <CodeDetailPane code={selectedCode ?? null} />
            </div>
          </div>
        </Panel>
      </PanelGroup>

      {contextMenu && (() => {
        const guid = contextMenu.guid
        const send = (action: string, ...args: unknown[]) => {
          setContextMenu(null)
          window.api.sendCodebookUpdate(action, guid, ...args)
        }
        return (
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 99 }} onClick={() => setContextMenu(null)} onContextMenu={(e) => { e.preventDefault(); setContextMenu(null) }} />
            <div ref={menuPos.ref} className="context-menu" style={{ left: menuPos.x, top: menuPos.y, zIndex: 100 }} onClick={(e) => e.stopPropagation()}>
              <div className="context-menu-item" onClick={() => { setContextMenu(null); setRenamingGuid(guid) }}>{t('common.rename')}</div>
              <div className="context-menu-item" onClick={() => { setContextMenu(null); setColourGuid(guid) }}>{t('codes.changeColor')}</div>
              <div className="context-menu-item" onClick={() => { setContextMenu(null); setEditingCodeGuid(guid) }}>{t('codes.editCode')}</div>
              <div className="context-menu-separator" />
              <div className="context-menu-item" onClick={() => send('show-in-all-documents')}>{t('codes.showInAll')}</div>
              <div className="context-menu-item" onClick={() => send('show-in-active-document')}>{t('codes.showInActive')}</div>
              <div className="context-menu-separator" />
              <div className="context-menu-item" onClick={() => send('add-child-code')}>{t('codes.addChild')}</div>
              <div className="context-menu-item" onClick={() => send('move-code-to-top')}>{t('codes.moveToTop')}</div>
              <div className="context-menu-separator" />
              <div className="context-menu-item" style={{ color: 'var(--menu-fg-danger)' }} onClick={() => send('delete-code')}>{t('common.delete')}</div>
            </div>
          </>
        )
      })()}

      {colourGuid && (() => {
        const code = findCode(colourGuid)
        if (!code) return null
        const recolor = (color: string) => window.api.sendCodebookUpdate('recolor-code', colourGuid, color)
        return (
          <div className="modal-overlay" onClick={() => setColourGuid(null)} style={{ position: 'fixed' }}>
            <div className="modal" onClick={(e) => e.stopPropagation()} style={{ minWidth: 250 }}>
              <h2>{t('codes.chooseColorHeading')}</h2>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                {colourPresets.map((c) => (
                  <div
                    key={c}
                    onClick={() => { recolor(c); setColourGuid(null) }}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      background: c,
                      cursor: 'pointer',
                      border: c === code.color ? '2px solid white' : '2px solid transparent'
                    }}
                  />
                ))}
              </div>
              <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
                <label style={{ fontSize: 12 }}>{t('codes.custom')}</label>
                <input type="color" defaultValue={code.color || '#888888'} onChange={(e) => recolor(e.target.value)} />
              </div>
            </div>
          </div>
        )
      })()}

      {/* Edit code dialog */}
      {editingCodeGuid && (() => {
        const editCode = findCode(editingCodeGuid)
        if (!editCode) return null
        return (
          <EditCodeDialog
            code={editCode}
            onSave={(name, color, description, hotkey) => handleSaveCode(editingCodeGuid, name, color, description, hotkey)}
            onClose={() => setEditingCodeGuid(null)}
          />
        )
      })()}
    </div>
  )
}
