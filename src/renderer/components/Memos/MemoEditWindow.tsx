import { useState, useCallback, useEffect } from 'react'
import { MarkdownEditor } from '../MarkdownEditor'
import type { Memo, MemoEditInitData } from '../../models/types'

export function MemoEditWindow() {
  const [memo, setMemo] = useState<Memo | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [isNew, setIsNew] = useState(false)

  const applyInitData = useCallback((initData: MemoEditInitData) => {
    if (initData.theme !== undefined) {
      document.documentElement.setAttribute('data-theme', initData.theme)
    }
    setMemo(initData.memo)
    setTitle(initData.memo.title)
    setContent(initData.memo.content)
    setIsNew(initData.isNew ?? false)
    setDirty(false)
  }, [])

  useEffect(() => {
    window.api.getMemoEditData().then((initData) => {
      if (initData) applyInitData(initData)
    })
    const unsub = window.api.onMemoEditData((initData) => {
      if (initData) applyInitData(initData)
    })
    return unsub
  }, [applyInitData])

  // Mark dirty on any edit
  const handleTitleChange = useCallback((val: string) => {
    setTitle(val)
    setDirty(true)
  }, [])

  const handleContentChange = useCallback((val: string) => {
    setContent(val)
    setDirty(true)
  }, [])

  // Save: build the updated memo and send it via IPC
  const handleSave = useCallback(() => {
    if (!memo) return
    const updated: Memo = {
      ...memo,
      title,
      content,
      modifiedDateTime: new Date().toISOString()
    }
    // Send with isNew flag so the main window knows whether to create or update
    window.api.sendMemoUpdate({ ...updated, _isNew: isNew } as any)
    setMemo(updated)
    setIsNew(false) // After first save, subsequent saves are updates
    setDirty(false)
  }, [memo, title, content, isNew])

  const handleSaveAndClose = useCallback(() => {
    handleSave()
    setTimeout(() => window.close(), 200)
  }, [handleSave])

  const handleDelete = useCallback(() => {
    if (!memo) return
    if (!window.confirm(`Delete memo "${memo.title || 'Untitled'}"? This cannot be undone.`)) return
    // For an unsaved draft (isNew), there's nothing to remove from the
    // store yet — just close. Otherwise tell the main window to drop
    // it and propagate to anything that references the memo.
    if (!isNew) window.api.sendMemoDelete(memo.guid)
    window.close()
  }, [memo, isNew])

  if (!memo) {
    return (
      <div className="panel" style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>
        Loading...
      </div>
    )
  }

  return (
    // One card under a pane header, like the Codebook and Logbook windows
    // (the theme insets #root > .panel from the window's edges).
    <div className="panel memo-edit-window">
      <div className="panel-header">
        <span style={{ flex: 1 }}>{isNew ? 'New Memo' : 'Memo'}</span>
        {dirty && <span style={{ fontWeight: 400, letterSpacing: 0, textTransform: 'none' }}>Edited</span>}
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '4px 12px 10px' }}>
        <input
          type="text"
          value={title}
          onChange={(e) => handleTitleChange(e.target.value)}
          placeholder="Memo title..."
          aria-label="Memo title"
          autoFocus={isNew}
          style={{
            width: '100%',
            flexShrink: 0,
            fontSize: 16,
            fontWeight: 600,
            border: 'none',
            borderBottom: '1px solid var(--border-color)',
            borderRadius: 0,
            background: 'transparent',
            padding: '6px 0',
            marginBottom: 10,
            outline: 'none',
            color: 'var(--text-primary)'
          }}
        />
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <MarkdownEditor value={content} onChange={handleContentChange} />
        </div>
      </div>

      {/* Actions, on the panel's own surface below a hairline. */}
      <div style={{
        padding: '8px 12px',
        borderTop: '1px solid var(--border-color)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0
      }}>
        {!isNew && (
          <button className="danger" style={{ fontSize: 11, padding: '4px 14px', border: '1px solid transparent' }} onClick={handleDelete}>
            Delete
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button className="secondary" style={{ fontSize: 11, padding: '4px 14px' }} onClick={() => window.close()}>
          Cancel
        </button>
        <button className="secondary" style={{ fontSize: 11, padding: '4px 14px' }} onClick={handleSave} disabled={!dirty}>
          Save
        </button>
        {/* A transparent border, so it's the size of the bordered buttons beside it. */}
        <button style={{ fontSize: 11, padding: '4px 14px', border: '1px solid transparent' }} onClick={handleSaveAndClose}>
          Save &amp; Close
        </button>
      </div>
    </div>
  )
}
