import { useState, useCallback } from 'react'
import { useCodeStore } from '../../stores/code-store'
import { useProjectStore } from '../../stores/project-store'
import { Markdown, markdownToHtml } from '../Markdown'
import { MarkdownEditor } from '../MarkdownEditor'
import type { Code } from '../../models/types'
import { exportPdfWithHeader, buildPdfDocument, escHtml } from '../../utils/pdf-export'
import { modKey } from '../../utils/platform'
import { useCodeColourPresets } from '../../utils/code-colours'

interface Props {
  onClose: () => void
}

function CodebookEntry({
  code,
  depth,
  onEditCode
}: {
  code: Code
  depth: number
  onEditCode: (guid: string) => void
}) {
  return (
    <>
      <div
        className="codebook-entry"
        style={{
          padding: '10px 14px',
          paddingLeft: 14 + depth * 20,
          borderBottom: '1px solid var(--border-color)',
          cursor: 'pointer',
          transition: 'background 0.1s'
        }}
        onDoubleClick={() => onEditCode(code.guid)}
        title="Double-click to edit"
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span
            className="color-pip"
            style={{ background: code.color || '#888', width: 10, height: 10, flexShrink: 0 }}
          />
          <span style={{ fontWeight: 600, fontSize: 'var(--font-size-base)' }}>
            {code.name}
          </span>
        </div>
        {code.description ? (
          <Markdown
            text={code.description}
            style={{
              fontSize: 'var(--font-size-sm)',
              color: 'var(--text-secondary)',
              paddingLeft: 18
            }}
          />
        ) : (
          <div
            style={{
              fontSize: 'var(--font-size-sm)',
              color: 'var(--text-muted)',
              fontStyle: 'italic',
              paddingLeft: 18
            }}
          >
            No memo
          </div>
        )}
      </div>
      {code.children.map((child) => (
        <CodebookEntry
          key={child.guid}
          code={child}
          depth={depth + 1}
          onEditCode={onEditCode}
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
      {/* Fixed width so the modal doesn't grow as the user types a
          description — the auto-width TipTap editor would otherwise size
          the modal to its longest line. A definite width makes it wrap. */}
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 420 }}>
        <h2 style={{ margin: '0 0 12px' }}>Edit Code</h2>

        {/* Name + color pip */}
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
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) {
                e.preventDefault()
                const hk = hotkeyStr.match(/^[0-9]$/) ? parseInt(hotkeyStr, 10) : undefined
                onSave(name.trim(), color, memo, hk)
              }
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

function flattenCodes(codes: Code[]): Code[] {
  const result: Code[] = []
  for (const c of codes) {
    result.push(c)
    result.push(...flattenCodes(c.children))
  }
  return result
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

  // Per-code styling: pip + name + memo block. Memo nesting uses the
  // base CSS's code/pre/blockquote rules; we only need the memo's
  // outer wrapper + the memo-only table styling (codebook memos
  // occasionally include markdown tables, which need a different
  // border style from the main document tables).
  const extraCss = `
  .code-entry { padding: 8px 0; border-bottom: 1px solid #eee; }
  .code-header { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
  .pip { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
  .code-name { font-weight: 600; font-size: 12px; }
  .memo { font-size: 11px; color: #444; padding-left: 18px; line-height: 1.6; }
  .memo p { margin: 0 0 6px; }
  .memo p:last-child { margin-bottom: 0; }
  .memo ul, .memo ol { margin: 0 0 6px; padding-left: 18px; }
  .memo strong { font-weight: 600; }
  .memo table { width: auto; margin: 0 0 6px; }
  .memo th, .memo td { border: 1px solid #ddd; padding: 3px 6px; }
  .memo th { background: #f3f4f6; }
  .no-memo { font-size: 11px; color: #aaa; font-style: italic; padding-left: 18px; }
`

  return buildPdfDocument({
    title: 'Codebook',
    subtitle: `${allCodes.length} code${allCodes.length !== 1 ? 's' : ''} &mdash; exported ${escHtml(now)}`,
    body,
    extraCss
  })
}

export function CodebookDialog({ onClose }: Props) {
  const codes = useCodeStore((s) => s.codes)
  const setCodeDescription = useCodeStore((s) => s.setCodeDescription)
  const setCodeHotkey = useCodeStore((s) => s.setCodeHotkey)
  const renameCode = useCodeStore((s) => s.renameCode)
  const recolorCode = useCodeStore((s) => s.recolorCode)
  const findCode = useCodeStore((s) => s.findCode)
  const mergeCodes = useCodeStore((s) => s.mergeCodes)
  const markDirty = useProjectStore((s) => s.markDirty)
  const [editingCodeGuid, setEditingCodeGuid] = useState<string | null>(null)

  const allCodes = flattenCodes(codes)

  const handleSaveCode = useCallback((guid: string, name: string, color: string, description: string, hotkey: number | undefined) => {
    renameCode(guid, name)
    recolorCode(guid, color)
    setCodeDescription(guid, description)
    setCodeHotkey(guid, hotkey)
    setEditingCodeGuid(null)
  }, [renameCode, recolorCode, setCodeDescription, setCodeHotkey])

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
      mergeCodes(imported)
      markDirty()
    }
  }, [mergeCodes, markDirty])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ minWidth: 550, maxWidth: 700, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ flex: 1, margin: 0 }}>Codebook</h2>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 12 }}>
            {allCodes.length} code{allCodes.length !== 1 ? 's' : ''}
          </span>
          <button
            className="secondary"
            style={{ fontSize: 11, padding: '3px 10px', marginRight: 4 }}
            onClick={handleImportQdc}
            title="Import a REFI-QDA Codebook (.qdc) file"
          >
            Import QDC
          </button>
          <button
            className="secondary"
            style={{ fontSize: 11, padding: '3px 10px', marginRight: 4 }}
            onClick={handleExportQdc}
            title="Export codebook as REFI-QDA Codebook (.qdc) file"
          >
            Export QDC
          </button>
          <button
            className="secondary"
            style={{ fontSize: 11, padding: '3px 10px' }}
            onClick={handleExportPdf}
          >
            Export PDF
          </button>
        </div>

        {codes.length > 0 && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, flexShrink: 0 }}>
            Double-click a code to edit its name, color, or memo.
          </div>
        )}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)' }}>
          {codes.length === 0 && (
            <div className="empty-state" style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
              No codes yet. Create codes first, then add memos here.
            </div>
          )}
          {codes.map((code) => (
            <CodebookEntry
              key={code.guid}
              code={code}
              depth={0}
              onEditCode={setEditingCodeGuid}
            />
          ))}
        </div>

        <div className="modal-actions">
          <button onClick={onClose}>Done</button>
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
    </div>
  )
}
