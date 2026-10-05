import { useState, useCallback, useEffect } from 'react'
import { Markdown, markdownToHtml } from '../Markdown'
import { MarkdownEditor } from '../MarkdownEditor'
import { Icon, MEMO_ICON } from '../Icon'
import type { Code, CodebookInitData } from '../../models/types'
import { exportPdfWithHeader, buildPdfDocument, escHtml } from '../../utils/pdf-export'
import { modKey } from '../../utils/platform'
import { useCodeColourPresets } from '../../utils/code-colours'

function flattenCodes(codes: Code[]): Code[] {
  const result: Code[] = []
  for (const c of codes) {
    result.push(c)
    result.push(...flattenCodes(c.children))
  }
  return result
}

function CompactCodeEntry({
  code,
  depth,
  onEditCode,
  onSelectCode
}: {
  code: Code
  depth: number
  onEditCode: (guid: string) => void
  onSelectCode: (guid: string) => void
}) {
  const hasMemo = !!code.description
  return (
    <>
      <div
        className="codebook-entry"
        style={{
          padding: '4px 10px',
          paddingLeft: 10 + depth * 16,
          borderBottom: '1px solid var(--border-color)',
          cursor: 'pointer',
          transition: 'background 0.1s',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 'var(--font-size-sm)'
        }}
        onClick={(e) => {
          e.stopPropagation()
          onSelectCode(code.guid)
        }}
        onDoubleClick={() => onEditCode(code.guid)}
        title="Double-click to edit"
      >
        <span
          className="color-pip"
          style={{ background: code.color || '#888', width: 8, height: 8, flexShrink: 0 }}
        />
        <span style={{ fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {code.name}
        </span>
        {hasMemo && (
          <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }} title={code.description}>
            <Icon icon={MEMO_ICON} />
          </span>
        )}
      </div>
      {code.children.map((child) => (
        <CompactCodeEntry
          key={child.guid}
          code={child}
          depth={depth + 1}
          onEditCode={onEditCode}
          onSelectCode={onSelectCode}
        />
      ))}
    </>
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
  const [name, setName] = useState(code.name)
  const [color, setColor] = useState(code.color || '#888888')
  const [memo, setMemo] = useState(code.description || '')
  const [hotkeyStr, setHotkeyStr] = useState(code.hotkey !== undefined ? String(code.hotkey) : '')
  const [showColorPicker, setShowColorPicker] = useState(false)
  const colourPresets = useCodeColourPresets()

  return (
    <div className="modal-overlay" onClick={onClose} style={{ position: 'fixed' }}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ minWidth: 420 }}>
        <h2 style={{ margin: '0 0 12px' }}>Edit Code</h2>

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
              title="Choose color"
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
                  <label style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Custom:</label>
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
            placeholder="Code name..."
            autoFocus
            style={{ flex: 1 }}
          />
        </div>

        {/* Description */}
        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
            Description
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
            Hotkey for quick coding
          </span>
        </div>

        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button
            onClick={() => {
              if (name.trim()) {
                const hk = hotkeyStr.match(/^[0-9]$/) ? parseInt(hotkeyStr, 10) : undefined
                onSave(name.trim(), color, memo, hk)
              }
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

function buildCodebookHtml(codes: Code[]): string {
  const now = new Date().toLocaleString()
  const allCodes = flattenCodes(codes)

  const renderCode = (code: Code, depth: number): string => {
    const indent = depth * 20
    const memoHtml = code.description
      ? `<div class="memo">${markdownToHtml(code.description)}</div>`
      : `<div class="no-memo">No memo</div>`
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
    title: 'Codebook',
    subtitle: `${allCodes.length} code${allCodes.length !== 1 ? 's' : ''} &mdash; exported ${escHtml(now)}`,
    body,
    extraCss
  })
}

// Detail pane: shows the selected code's full info
function CodeDetailPane({ code }: { code: Code | null }) {
  if (!code) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
        Select a code to see its details.
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
          No memo
        </div>
      )}
    </div>
  )
}

export function CodebookWindow() {
  const [codes, setCodes] = useState<Code[]>([])
  const [editingCodeGuid, setEditingCodeGuid] = useState<string | null>(null)
  const [selectedCodeGuid, setSelectedCodeGuid] = useState<string | null>(null)

  const allCodes = flattenCodes(codes)

  const applyInitData = useCallback((initData: CodebookInitData) => {
    if (initData.theme !== undefined) {
      document.documentElement.setAttribute('data-theme', initData.theme)
    }
    setCodes(initData.codes)
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
    await exportPdfWithHeader(html, 'Codebook')
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
    <div className="codebook-window" style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-panel)', color: 'var(--text-primary)' }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        padding: '6px 10px',
        background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border-color)',
        gap: 6,
        flexShrink: 0,
        WebkitAppRegion: 'drag' as any
      }}>
        <span style={{ fontWeight: 600, fontSize: 'var(--font-size-base)', flex: 1 }}>
          Codebook
          <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>
            {allCodes.length} code{allCodes.length !== 1 ? 's' : ''}
          </span>
        </span>
        <button
          className="secondary"
          style={{ fontSize: 11, padding: '3px 8px', WebkitAppRegion: 'no-drag' as any }}
          onClick={handleImportQdc}
          title="Import .qdc"
        >
          Import QDC
        </button>
        <button
          className="secondary"
          style={{ fontSize: 11, padding: '3px 8px', WebkitAppRegion: 'no-drag' as any }}
          onClick={handleExportQdc}
          title="Export .qdc"
        >
          Export QDC
        </button>
        <button
          className="secondary"
          style={{ fontSize: 11, padding: '3px 8px', WebkitAppRegion: 'no-drag' as any }}
          onClick={handleExportPdf}
        >
          Export PDF
        </button>
      </div>

      {/* Main content: two-pane — compact list on left, detail on right */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Code list */}
        <div style={{ width: '50%', borderRight: '1px solid var(--border-color)', overflowY: 'auto' }}>
          {codes.length === 0 ? (
            <div className="empty-state" style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
              No codes yet.
            </div>
          ) : (
            <>
              {codes.map((code) => (
                <CompactCodeEntry
                  key={code.guid}
                  code={code}
                  depth={0}
                  onEditCode={setEditingCodeGuid}
                  onSelectCode={setSelectedCodeGuid}
                />
              ))}
            </>
          )}
        </div>

        {/* Detail pane */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <CodeDetailPane code={selectedCode ?? null} />
        </div>
      </div>

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
