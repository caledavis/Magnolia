import { useState, useCallback, useEffect, useRef } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { MarkdownEditor } from '../MarkdownEditor'
import { AlertDialog } from '../AlertDialog'
import type { Memo, MemoEditInitData } from '../../models/types'
import { useTranslation } from 'react-i18next'
import { isLetterKey } from '../../utils/keys'
import { noteWindowProject, sendMemoCloseCancelled, sendMemoDelete, sendMemoUpdate } from '../to-main-window'

export function MemoEditWindow() {
  const { t } = useTranslation()
  const [memo, setMemo] = useState<Memo | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [dirty, setDirtyState] = useState(false)
  const [isNew, setIsNew] = useState(false)
  // The editor takes its content when it's made, so showing a memo sent
  // again with a different body means making it afresh.
  const [editorKey, setEditorKey] = useState(0)
  // Read by the close guard and by init data arriving, which don't re-run
  // when they change; set at once, not on the next render.
  const dirtyRef = useRef(false)
  const setDirty = useCallback((d: boolean) => {
    dirtyRef.current = d
    setDirtyState(d)
  }, [])
  const contentRef = useRef(content)
  contentRef.current = content
  // "Close with unsaved changes?" is showing.
  const [closePrompt, setClosePrompt] = useState(false)

  const applyInitData = useCallback((initData: MemoEditInitData) => {
    if (initData.theme !== undefined) {
      document.documentElement.setAttribute('data-theme', initData.theme)
    }
    noteWindowProject(initData)
    // Opening a memo that's already open sends its data again. While the
    // user has unsaved edits, keep them: they're what the editor shows, and
    // Save must write them, not the body last saved.
    if (dirtyRef.current) return
    setMemo(initData.memo)
    setTitle(initData.memo.title)
    if (initData.memo.content !== contentRef.current) {
      setContent(initData.memo.content)
      setEditorKey((k) => k + 1)
    }
    setIsNew(initData.isNew ?? false)
    setDirty(false)
  }, [setDirty])

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
  }, [setDirty])

  const handleContentChange = useCallback((val: string) => {
    setContent(val)
    setDirty(true)
  }, [setDirty])

  // Save: build the updated memo and send it to the main window. Resolves
  // once it's sent (true) so a close can follow without losing it, or
  // couldn't be (false; the edits stay unsaved).
  const handleSave = useCallback((): Promise<boolean> => {
    if (!memo) return Promise.resolve(true)
    const updated: Memo = {
      ...memo,
      title,
      content,
      modifiedDateTime: new Date().toISOString()
    }
    // Send with isNew flag so the main window knows whether to create or update
    const sent = sendMemoUpdate({ ...updated, _isNew: isNew }).then(
      () => true,
      (err) => {
        console.error(err)
        setIsNew(isNew)
        setDirty(true)
        return false
      }
    )
    setMemo(updated)
    setIsNew(false) // After first save, subsequent saves are updates
    setDirty(false)
    return sent
  }, [memo, title, content, isNew, setDirty])

  // Close without asking: destroy() skips the close guard below.
  const closeNow = useCallback(() => { void getCurrentWindow().destroy() }, [])

  const handleSaveAndClose = useCallback(() => {
    void handleSave().then((sent) => { if (sent) closeNow() })
  }, [handleSave, closeNow])

  const handleDelete = useCallback(async () => {
    if (!memo) return
    if (!(await window.api.askConfirm(t('memoEdit.deleteConfirm', { title: memo.title || t('common.untitled') }), t('common.delete')))) return
    // For an unsaved draft (isNew), there's nothing to remove from the
    // store yet — just close. Otherwise tell the main window to drop
    // it and propagate to anything that references the memo.
    if (!isNew) await sendMemoDelete(memo.guid).catch(() => {})
    closeNow()
  }, [memo, t, isNew, closeNow])

  // Every close (the window's close button, Cmd/Ctrl+W, the Cancel button,
  // or the main window closing it for a project switch or quit) comes
  // here. With unsaved changes it asks first.
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let disposed = false
    void getCurrentWindow().onCloseRequested((event) => {
      if (!dirtyRef.current) return
      event.preventDefault()
      setClosePrompt(true)
    }).then((u) => {
      if (disposed) u()
      else unlisten = u
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  // Ctrl+W off macOS (on macOS the File menu's Cmd+W closes the window).
  useEffect(() => {
    if (window.api.platform === 'darwin') return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && isLetterKey(e, 'w')) {
        e.preventDefault()
        window.close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const promptSave = useCallback(() => {
    setClosePrompt(false)
    handleSaveAndClose()
  }, [handleSaveAndClose])
  const promptDiscard = useCallback(() => {
    setClosePrompt(false)
    closeNow()
  }, [closeNow])
  const promptCancel = useCallback(() => {
    setClosePrompt(false)
    // Whatever was closing the window (a project switch, quitting) stops.
    if (memo) void sendMemoCloseCancelled(memo.guid).catch(() => {})
  }, [memo])

  if (!memo) {
    return (
      <div className="panel" style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>
        {t('common.loading')}
      </div>
    )
  }

  return (
    // One card under a pane header, like the Codebook and Logbook windows
    // (the theme insets #root > .panel from the window's edges).
    <div className="panel memo-edit-window">
      <div className="panel-header">
        <span style={{ flex: 1 }}>{isNew ? t('memoEdit.newMemo') : t('memoEdit.memo')}</span>
        {dirty && <span style={{ fontWeight: 400, letterSpacing: 0, textTransform: 'none' }}>{t('memoEdit.edited')}</span>}
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '4px 12px 10px' }}>
        <input
          type="text"
          value={title}
          onChange={(e) => handleTitleChange(e.target.value)}
          placeholder={t('memoEdit.titlePlaceholder')}
          aria-label={t('memoEdit.titleLabel')}
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
          <MarkdownEditor key={editorKey} value={content} onChange={handleContentChange} label={t('memos.memoHeading')} />
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
            {t('common.delete')}
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button className="secondary" style={{ fontSize: 11, padding: '4px 14px' }} onClick={() => window.close()}>
          {t('common.cancel')}
        </button>
        <button className="secondary" style={{ fontSize: 11, padding: '4px 14px' }} onClick={() => void handleSave()} disabled={!dirty}>
          {t('common.save')}
        </button>
        {/* A transparent border, so it's the size of the bordered buttons beside it. */}
        <button style={{ fontSize: 11, padding: '4px 14px', border: '1px solid transparent' }} onClick={handleSaveAndClose}>
          {t('memoEdit.saveAndClose')}
        </button>
      </div>

      {closePrompt && (
        <AlertDialog
          title={t('tabs.unsavedChanges')}
          onClose={promptCancel}
          width={380}
          actions={
            <>
              <button className="secondary" onClick={promptCancel}>{t('common.cancel')}</button>
              <button className="secondary" onClick={promptDiscard}>{t('common.discard')}</button>
              <button onClick={promptSave}>{t('common.save')}</button>
            </>
          }
        >
          <p style={{ margin: 0 }}>{t('tabs.unsavedQuestion', { name: title || t('common.untitled') })}</p>
        </AlertDialog>
      )}
    </div>
  )
}
