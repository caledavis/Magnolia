import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import type { AnalysisInitData } from '../../../models/types'
import { generateGuid } from '../../../utils/guid'
import type {
  MapElement,
  MapConnection,
  FreeTextElement,
  MapElementKind,
  RelationshipMapConfig
} from './types'
import { ELEMENT_DIMS, FREE_TEXT_DEFAULT_WIDTH, FREE_TEXT_DEFAULT_HEIGHT } from './types'
import { MapCanvas } from './MapCanvas'
import { MapSidebar } from './MapSidebar'
import { PdfFilePathsContext } from './PdfFilePathsContext'
import { buildExportSvg } from './svg-export'
import { buildExportSvgFromDom } from './dom-svg-export'
import {
  Icon,
  faFont,
  faBars,
  faDownLeftAndUpRightToCenter,
  faParagraph,
  faBold,
  faItalic,
  faUnderline,
  faListUl,
  faListOl,
  faAlignLeft,
  faAlignCenter,
  faAlignRight,
  faHeading1,
  faHeading2,
  faFontColor
} from '../../Icon'
import { ColourSwatchButton } from '../../ColourSwatchButton'

function ToolbarBtn({ active, disabled, onClick, title, children }: {
  active?: boolean; disabled?: boolean; onClick: () => void; title?: string; children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        padding: '3px 8px', fontSize: 12, fontWeight: active ? 700 : 500, lineHeight: '20px',
        background: active ? 'var(--accent-bg, #e0e7ff)' : 'transparent',
        color: active ? 'var(--accent-color, #3b82f6)' : 'var(--text-primary, #1d1d1f)',
        border: 'none', borderRadius: 4, cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.35 : 1, display: 'flex', alignItems: 'center', gap: 4
      }}
    >
      {children}
    </button>
  )
}

function ToolbarDivider() {
  return <div style={{ width: 1, height: 20, background: 'var(--border-color, #e0e0e0)', margin: '0 2px' }} />
}

interface Props {
  data: AnalysisInitData
  savedConfig?: RelationshipMapConfig & { guid?: string; name?: string }
}

export function RelationshipMap({ data, savedConfig }: Props) {
  const [analysisGuid] = useState(savedConfig?.guid ?? generateGuid())
  const [elements, setElements] = useState<MapElement[]>(() => {
    const saved = savedConfig?.elements ?? []
    // Sync memo elements to latest title/content at open time, in case the
    // memo was edited while this map was closed.
    const memoMap = new Map((data.memos ?? []).map((m) => [m.guid, m]))
    return saved.map((el) => {
      if (el.kind !== 'memo' || !el.entityGuid) return el
      const latest = memoMap.get(el.entityGuid)
      if (!latest) return el
      return { ...el, label: latest.title, snippet: latest.content ?? el.snippet }
    })
  })
  const [freeTexts, setFreeTexts] = useState<FreeTextElement[]>(savedConfig?.freeTexts ?? [])
  const [connections, setConnections] = useState<MapConnection[]>(savedConfig?.connections ?? [])
  const [pan, setPan] = useState(savedConfig?.pan ?? { x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [selectedElementIds, setSelectedElementIds] = useState<Set<string>>(new Set())
  const [selectedConnectionIds, setSelectedConnectionIds] = useState<Set<string>>(new Set())
  const [selectedFreeTextIds, setSelectedFreeTextIds] = useState<Set<string>>(new Set())
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [addTextMode, setAddTextMode] = useState(false)
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [saveName, setSaveName] = useState(savedConfig?.name ?? '')
  // True once the map has been saved at least once. Drives the Save vs
  // first-save dialog branch in the bottom action bar.
  const [isExisting, setIsExisting] = useState(!!savedConfig?.guid)
  const [showCloseDialog, setShowCloseDialog] = useState(false)
  // Snapshot of the last persisted state. Drives the dirty flag (current
  // state vs snapshot) and the Discard action (revert to snapshot).
  // Updated on every explicit save.
  const [lastSavedSnapshot, setLastSavedSnapshot] = useState<{
    elements: MapElement[]
    freeTexts: FreeTextElement[]
    connections: MapConnection[]
    pan: { x: number; y: number }
  }>(() => ({
    elements: savedConfig?.elements ?? [],
    freeTexts: savedConfig?.freeTexts ?? [],
    connections: savedConfig?.connections ?? [],
    pan: savedConfig?.pan ?? { x: 0, y: 0 }
  }))
  const dirty = useMemo(() => (
    JSON.stringify({ elements, freeTexts, connections, pan }) !==
    JSON.stringify(lastSavedSnapshot)
  ), [elements, freeTexts, connections, pan, lastSavedSnapshot])
  // Live-synced memos (initial data + updates pushed from the main window).
  // The sidebar reads from this so a memo edited after the map opens still
  // drops onto the canvas with its current title/content.
  const [liveMemos, setLiveMemos] = useState(data.memos ?? [])

  // Keep the open canvas live when a memo is edited/deleted elsewhere
  // (the memo editor round-trips through the main process, which pushes
  // memo-update / memo-delete to this window). App.tsx already keeps the
  // relationship-map store in sync for every map; these listeners cover
  // the *currently mounted* map, whose canvas runs on local state.
  useEffect(() => {
    const unsubUpdate = window.api.onMemoUpdate((memo) => {
      if (!memo?.guid) return
      setElements((prev) =>
        prev.map((el) =>
          el.kind === 'memo' && el.entityGuid === memo.guid
            ? { ...el, label: memo.title, snippet: memo.content }
            : el
        )
      )
      setLiveMemos((prev) => {
        const idx = prev.findIndex((m) => m.guid === memo.guid)
        if (idx < 0) return [...prev, memo]
        const copy = [...prev]
        copy[idx] = memo
        return copy
      })
    })
    const unsubDelete = window.api.onMemoDelete((guid) => {
      if (!guid) return
      setElements((prev) => {
        // Ids of the memo nodes being removed — used to drop only the
        // wires attached to them, leaving every other connection
        // (including free-text↔free-text wires) intact. Deriving the
        // ids here avoids closing over the freeTexts state, so this
        // listener can stay mounted once with no stale captures.
        const removedIds = new Set(
          prev.filter((el) => el.kind === 'memo' && el.entityGuid === guid).map((el) => el.id)
        )
        const stripped = prev
          .filter((el) => !(el.kind === 'memo' && el.entityGuid === guid))
          .map((el) => (el.memoGuid === guid ? { ...el, memoGuid: undefined } : el))
        if (removedIds.size) {
          setConnections((conns) =>
            conns.filter((c) => !removedIds.has(c.fromId) && !removedIds.has(c.toId))
          )
        }
        return stripped
      })
      setLiveMemos((prev) => prev.filter((m) => m.guid !== guid))
    })
    return () => { unsubUpdate(); unsubDelete() }
  }, [])

  // Build sidebar data with live memos substituted in
  const sidebarData = useMemo(() => ({ ...data, memos: liveMemos }), [data, liveMemos])
  const [focusedFreeTextId, setFocusedFreeTextId] = useState<string | null>(null)
  const [activeEditor, setActiveEditor] = useState<any>(null)
  const editorMapRef = useRef<Map<string, any>>(new Map())
  const panWrapperRef = useRef<HTMLDivElement | null>(null)


  const handleEditorReady = useCallback((id: string, editor: any) => {
    editorMapRef.current.set(id, editor)
    if (id === focusedFreeTextId || selectedFreeTextIds.has(id)) {
      setActiveEditor(editor)
    }
  }, [focusedFreeTextId, selectedFreeTextIds])

  // When free text selection changes, update the active editor
  const handleSetSelectedFreeTexts = useCallback((ids: Set<string>) => {
    setSelectedFreeTextIds(ids)
    if (ids.size === 1) {
      const id = [...ids][0]
      const editor = editorMapRef.current.get(id)
      if (editor) {
        setActiveEditor(editor)
        // Select all text so toolbar buttons apply to everything
        editor.commands.selectAll()
      }
    } else if (ids.size === 0 && !focusedFreeTextId) {
      setActiveEditor(null)
    }
  }, [focusedFreeTextId])

  const handleFocusFreeText = useCallback((id: string | null) => {
    setFocusedFreeTextId(id)
    setActiveEditor(id ? editorMapRef.current.get(id) || null : null)
  }, [])

  const handleElementDoubleClick = useCallback((element: MapElement) => {
    if (!element.entityGuid) return
    switch (element.kind) {
      case 'document':
        window.api.sendAnalysisAction('open-document', element.entityGuid)
        break
      case 'code':
        window.api.sendAnalysisAction('run-code-query', element.entityGuid)
        break
      case 'memo':
        window.api.sendAnalysisAction('open-memo', element.entityGuid)
        break
      case 'query':
        window.api.sendAnalysisAction('run-saved-query', element.entityGuid)
        break
      case 'query-result':
      case 'quote':
        if (element.sourceGuid && element.startPosition != null && element.endPosition != null) {
          window.api.sendAnalysisAction('view-document-at', element.sourceGuid, element.startPosition, element.endPosition)
        }
        break
      case 'tag':
        window.api.sendAnalysisAction('select-tag-documents', element.entityGuid)
        break
      case 'tag-category':
        window.api.sendAnalysisAction('select-tag-category-documents', element.entityGuid)
        break
      case 'folder':
        window.api.sendAnalysisAction('select-folder-documents', element.entityGuid)
        break
      case 'analysis': {
        const sa = (data.savedAnalyses || []).find((a) => a.guid === element.entityGuid)
        if (sa) {
          window.api.sendAnalysisAction('open-saved-analysis', sa.toolType, { guid: sa.guid, name: sa.name })
        }
        break
      }
    }
  }, [data.savedAnalyses])

  const handleDropElement = useCallback(
    (kind: string, dropData: any, x: number, y: number) => {
      const k = kind as MapElementKind
      const baseDims = ELEMENT_DIMS[k] || { w: 140, h: 44 }
      // For documents, estimate height from label length (header=18 + padding=6 + ~16px per line)
      const label = dropData.label || 'Untitled'
      const charsPerLine = Math.floor((baseDims.w - 16) / 7) // ~7px per char at 12px font
      const lines = Math.ceil(label.length / charsPerLine)
      const estimatedH = k === 'document' ? 18 + 6 + Math.max(1, lines) * 16 : baseDims.h
      const dims = { w: baseDims.w, h: estimatedH }
      // When a dropped quote/query-result has a pdfRegion, size the map
      // element to fit a thumbnail at the region's aspect ratio.
      const hasPdfRegion = !!dropData.pdfRegion
      const thumbMaxW = 220
      const thumbMaxH = 160
      let finalDims = dims
      if (hasPdfRegion) {
        const r = dropData.pdfRegion
        const aspect = r.width > 0 && r.height > 0 ? r.width / r.height : 1
        let w = thumbMaxW
        let h = Math.round(thumbMaxW / aspect)
        if (h > thumbMaxH) { h = thumbMaxH; w = Math.round(thumbMaxH * aspect) }
        // Add padding for the element's header / label area above the image
        finalDims = { w: Math.max(w, 140), h: h + 42 }
      }
      const newEl: MapElement = {
        id: generateGuid(),
        kind: k,
        label: dropData.label || 'Untitled',
        entityGuid: dropData.entityGuid,
        codeColor: dropData.codeColor,
        snippet: dropData.snippet,
        sourceGuid: dropData.sourceGuid,
        sourceType: dropData.sourceType,
        startPosition: dropData.startPosition,
        endPosition: dropData.endPosition,
        pdfRegion: dropData.pdfRegion,
        analysisToolType: dropData.toolType,
        // Survey-node passthrough — surveyGuid identifies the parent
        // survey source for respondent / question / cell kinds;
        // questionId + questionLabel only set on survey-cell (the id
        // pairs with entityGuid = respondent id to identify a single
        // answer; the label is the question text denormalised for
        // rendering inside the cell card without survey lookups).
        surveyGuid: dropData.surveyGuid,
        questionId: dropData.questionId,
        questionLabel: dropData.questionLabel,
        x: x - finalDims.w / 2,
        y: y - finalDims.h / 2,
        width: finalDims.w,
        height: finalDims.h
      }
      setElements((prev) => [...prev, newEl])
    },
    []
  )

  const handleElementMove = useCallback((id: string, x: number, y: number) => {
    setElements((prev) => prev.map((e) => (e.id === id ? { ...e, x, y } : e)))
  }, [])

  const handleMultiElementMove = useCallback(
    (ids: string[], dx: number, dy: number) => {
      setElements((prev) =>
        prev.map((e) => (ids.includes(e.id) ? { ...e, x: e.x + dx, y: e.y + dy } : e))
      )
    },
    []
  )

  const handleCreateConnection = useCallback(
    (fromId: string, toId: string) => {
      // Prevent duplicate connections
      const exists = connections.some(
        (c) =>
          (c.fromId === fromId && c.toId === toId) ||
          (c.fromId === toId && c.toId === fromId)
      )
      if (exists) return

      const newConn: MapConnection = {
        id: generateGuid(),
        fromId,
        toId,
        arrowFrom: false,
        arrowTo: false,
        label: ''
      }
      setConnections((prev) => [...prev, newConn])
    },
    [connections]
  )

  const handleToggleArrow = useCallback((connId: string, end: 'from' | 'to') => {
    setConnections((prev) =>
      prev.map((c) => {
        if (c.id !== connId) return c
        return end === 'from'
          ? { ...c, arrowFrom: !c.arrowFrom }
          : { ...c, arrowTo: !c.arrowTo }
      })
    )
  }, [])

  const handleUpdateConnectionLabel = useCallback((connId: string, label: string) => {
    setConnections((prev) => prev.map((c) => (c.id === connId ? { ...c, label } : c)))
  }, [])

  const handleCreateFreeText = useCallback(
    (x: number, y: number) => {
      const ft: FreeTextElement = {
        id: generateGuid(),
        kind: 'freetext',
        x,
        y,
        width: FREE_TEXT_DEFAULT_WIDTH,
        height: FREE_TEXT_DEFAULT_HEIGHT,
        content: ''
      }
      setFreeTexts((prev) => [...prev, ft])
      setAddTextMode(false)
      // Set focus synchronously alongside the create so the FreeTextNode
      // mounts with focused=true from its first render. That lets
      // useEditor's `editable: focused` config initialise as `true`, and
      // the editor's own useEffect runs its `focus('start')` once the
      // ProseMirror view is attached — no race against a
      // setEditable(false)→true flip. The earlier 100ms setTimeout left
      // the editor mounting non-editable, which dropped the caret.
      setFocusedFreeTextId(ft.id)
    },
    []
  )

  const handleUpdateFreeText = useCallback((id: string, content: any) => {
    setFreeTexts((prev) => prev.map((f) => (f.id === id ? { ...f, content } : f)))
  }, [])

  const handleMoveFreeText = useCallback((id: string, x: number, y: number) => {
    setFreeTexts((prev) => prev.map((f) => (f.id === id ? { ...f, x, y } : f)))
  }, [])

  const handleResizeFreeText = useCallback(
    (id: string, update: { x: number; y: number; width: number; height: number }) => {
      setFreeTexts((prev) => prev.map((f) => (f.id === id ? { ...f, ...update } : f)))
    },
    []
  )

  // ResizeObserver-driven height updates are layout corrections, not
  // semantic edits. Update both the live elements *and* the snapshot
  // so the dirty diff doesn't flag the map as edited just because the
  // browser remeasured it (e.g. on first mount or a tab show/hide).
  const handleElementRenderedHeight = useCallback((id: string, height: number) => {
    setElements((prev) => prev.map((e) => (e.id === id && e.height !== height ? { ...e, height } : e)))
    setLastSavedSnapshot((prev) => ({
      ...prev,
      elements: prev.elements.map((e) => (e.id === id && e.height !== height ? { ...e, height } : e))
    }))
  }, [])

  // Right-click "Add Memo" handlers for the popped-out window. The
  // memoStore lives in the main window, so we mint a Memo object
  // locally and send it via sendMemoUpdate with _isNew=true — the main
  // window then treats it as a fresh memo and adds it to its store.
  // Local state updates + existing auto-save persist the map config so
  // the sidebar can group the memo under this map.
  const buildNewAnalysisMemo = useCallback((): { guid: string; payload: any } => {
    const guid = generateGuid()
    const now = new Date().toISOString()
    const memo = {
      guid,
      type: 'analysis' as const,
      title: '',
      content: '',
      createdDateTime: now,
      analysisGuid
    }
    window.api.sendMemoUpdate({ ...memo, _isNew: true } as any)
    return { guid, payload: memo }
  }, [analysisGuid])

  const handleAddMemoToElement = useCallback((elementId: string) => {
    const { guid: memoGuid, payload } = buildNewAnalysisMemo()
    setElements((prev) => prev.map((el) => el.id === elementId ? { ...el, memoGuid } : el))
    // The memo is already being created in the main window's memoStore
    // via sendMemoUpdate({_isNew:true}) inside buildNewAnalysisMemo, so
    // open the editor in "existing" mode — its Save will dispatch
    // updateMemo, not addMemoFromDraft (which would duplicate).
    window.api.openMemoEditWindow({
      memo: payload,
      theme: document.documentElement.getAttribute('data-theme') || ''
    })
  }, [buildNewAnalysisMemo])

  const handleAddMemoOnCanvas = useCallback((x: number, y: number) => {
    const { guid: memoGuid, payload } = buildNewAnalysisMemo()
    const dims = ELEMENT_DIMS.memo
    const newEl: MapElement = {
      id: generateGuid(),
      kind: 'memo',
      label: '',
      entityGuid: memoGuid,
      snippet: '',
      x: x - dims.w / 2,
      y: y - dims.h / 2,
      width: dims.w,
      height: dims.h
    }
    setElements((prev) => [...prev, newEl])
    window.api.openMemoEditWindow({
      memo: payload,
      theme: document.documentElement.getAttribute('data-theme') || ''
    })
  }, [buildNewAnalysisMemo])

  const handleOpenAttachedMemo = useCallback((elementId: string) => {
    const el = elements.find((e) => e.id === elementId)
    if (!el?.memoGuid) return
    const memo = liveMemos.find((m) => m.guid === el.memoGuid)
    if (!memo) return
    window.api.openMemoEditWindow({
      memo: memo as any,
      theme: document.documentElement.getAttribute('data-theme') || ''
    })
  }, [elements, liveMemos])

  const handleSelectElements = useCallback(
    (ids: Set<string>, additive?: boolean) => {
      if (additive) {
        setSelectedElementIds((prev) => {
          const next = new Set(prev)
          for (const id of ids) next.add(id)
          return next
        })
      } else {
        setSelectedElementIds(ids)
      }
    },
    []
  )

  const handleDeleteSelected = useCallback(() => {
    const delEls = selectedElementIds
    const delFts = selectedFreeTextIds
    const delConns = selectedConnectionIds

    // Remove elements
    setElements((prev) => prev.filter((e) => !delEls.has(e.id)))
    // Remove free texts
    setFreeTexts((prev) => prev.filter((f) => !delFts.has(f.id)))
    // Remove selected connections AND any connections to deleted
    // elements OR freetexts. Now that freetexts can be wire
    // endpoints, leaving the orphan filter set to delEls would
    // strand wires pointing at deleted text boxes.
    setConnections((prev) =>
      prev.filter(
        (c) =>
          !delConns.has(c.id) &&
          !delEls.has(c.fromId) &&
          !delEls.has(c.toId) &&
          !delFts.has(c.fromId) &&
          !delFts.has(c.toId)
      )
    )

    setSelectedElementIds(new Set())
    setSelectedConnectionIds(new Set())
    setSelectedFreeTextIds(new Set())
    if (delFts.has(focusedFreeTextId || '')) {
      setFocusedFreeTextId(null)
    }
  }, [selectedElementIds, selectedConnectionIds, selectedFreeTextIds, focusedFreeTextId])

  // Fire-and-forget save. Used by the manual Save button and the
  // first-save dialog. Saves are explicit only — no auto-save.
  const handleSave = useCallback(() => {
    const name = saveName.trim() || 'Relationship Map'
    const config: RelationshipMapConfig = { elements, freeTexts, connections, pan }
    window.api.sendAnalysisAction('save-analysis', {
      guid: analysisGuid,
      toolType: 'relationship-map',
      name,
      config
    })
    setIsExisting(true)
    setLastSavedSnapshot({ elements, freeTexts, connections, pan })
  }, [analysisGuid, saveName, elements, freeTexts, connections, pan])

  const handleDiscardChanges = useCallback(() => {
    setElements(lastSavedSnapshot.elements)
    setFreeTexts(lastSavedSnapshot.freeTexts)
    setConnections(lastSavedSnapshot.connections)
    setPan(lastSavedSnapshot.pan)
  }, [lastSavedSnapshot])

  // First-save flow for new maps: open the name dialog.
  const handleSaveNew = useCallback(() => {
    setShowSaveDialog(true)
  }, [])

  // First-save confirm button (inside the dialog) — saves without closing
  // so the user can keep working with auto-save on.
  const handleConfirmFirstSave = useCallback(() => {
    handleSave()
    setShowSaveDialog(false)
  }, [handleSave])

  // Close request: if dirty, prompt Save / Discard / Cancel; otherwise
  // close immediately. The dialog is rendered below alongside the
  // first-save dialog.
  const handleCloseRequest = useCallback(() => {
    if (dirty) {
      setShowCloseDialog(true)
    } else {
      window.close()
    }
  }, [dirty])

  const handleDiscardAndClose = useCallback(() => {
    setShowCloseDialog(false)
    window.close()
  }, [])

  const handleSaveFromCloseDialog = useCallback(() => {
    if (isExisting) {
      handleSave()
      setShowCloseDialog(false)
      setTimeout(() => window.close(), 200)
    } else {
      // Brand-new map: route to the name dialog. The user will Save (or
      // Cancel) there; we close after the name dialog confirms.
      setShowCloseDialog(false)
      setShowSaveDialog(true)
    }
  }, [isExisting, handleSave])

  const handleClose = useCallback(() => {
    handleCloseRequest()
  }, [handleCloseRequest])

  // Intercept the OS window-close (X button / Cmd-W). When dirty, route
  // through the in-window confirm dialog instead of letting the window
  // disappear silently — autosave no longer rescues unsaved edits.
  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent): void => {
      e.preventDefault()
      e.returnValue = ''
      setShowCloseDialog(true)
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  const handleExportSvg = useCallback(() => {
    const svg = panWrapperRef.current
      ? buildExportSvgFromDom(panWrapperRef.current, elements, freeTexts)
      : buildExportSvg(elements, connections, freeTexts)
    window.api.exportSvg(svg, 'relationship-map.svg')
  }, [elements, connections, freeTexts])

  return (
    <PdfFilePathsContext.Provider value={data.pdfFilePaths ?? {}}>
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-primary, #fff)' }}>
      {/* Top toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          borderBottom: '1px solid var(--border-color, #e0e0e0)',
          background: 'var(--bg-secondary, #fafafa)',
          flexShrink: 0
        }}
      >
        {/* Palette toggle */}
        <ToolbarBtn active={sidebarVisible} onClick={() => setSidebarVisible(!sidebarVisible)} title="Toggle palette">
          <Icon icon={faBars} style={{ fontSize: 13 }} />
        </ToolbarBtn>

        <ToolbarDivider />

        {/* Canvas modes */}
        <ToolbarBtn
          active={addTextMode}
          onClick={() => setAddTextMode(!addTextMode)}
          title="Add Text — click canvas to place text"
        >
          <Icon icon={faFont} style={{ fontSize: 13 }} />
        </ToolbarBtn>

        <ToolbarDivider />

        {/* Text formatting (mirrors MarkdownEditor toolbar) — active when editing text */}
        <ToolbarBtn disabled={!activeEditor} active={!!activeEditor?.isActive('paragraph')} onClick={() => { activeEditor?.chain().focus().setParagraph().run() }} title="Paragraph (body text)">
          <Icon icon={faParagraph} style={{ fontSize: 11 }} />
        </ToolbarBtn>
        <ToolbarBtn disabled={!activeEditor} active={!!activeEditor?.isActive('heading', { level: 1 })} onClick={() => { activeEditor?.chain().focus().toggleHeading({ level: 1 }).run() }} title="Heading 1">
          <Icon icon={faHeading1} style={{ fontSize: 14 }} />
        </ToolbarBtn>
        <ToolbarBtn disabled={!activeEditor} active={!!activeEditor?.isActive('heading', { level: 2 })} onClick={() => { activeEditor?.chain().focus().toggleHeading({ level: 2 }).run() }} title="Heading 2">
          <Icon icon={faHeading2} style={{ fontSize: 14 }} />
        </ToolbarBtn>
        <ToolbarDivider />
        <ToolbarBtn disabled={!activeEditor} active={!!activeEditor?.isActive('bold')} onClick={() => { activeEditor?.chain().focus().toggleBold().run() }} title="Bold">
          <Icon icon={faBold} style={{ fontSize: 14 }} />
        </ToolbarBtn>
        <ToolbarBtn disabled={!activeEditor} active={!!activeEditor?.isActive('italic')} onClick={() => { activeEditor?.chain().focus().toggleItalic().run() }} title="Italic">
          <Icon icon={faItalic} style={{ fontSize: 14 }} />
        </ToolbarBtn>
        <ToolbarBtn disabled={!activeEditor} active={!!activeEditor?.isActive('underline')} onClick={() => { activeEditor?.chain().focus().toggleUnderline().run() }} title="Underline">
          <Icon icon={faUnderline} style={{ fontSize: 14 }} />
        </ToolbarBtn>
        <ToolbarDivider />
        <ToolbarBtn disabled={!activeEditor} active={!!activeEditor?.isActive('bulletList')} onClick={() => { activeEditor?.chain().focus().toggleBulletList().run() }} title="Bullet List">
          <Icon icon={faListUl} style={{ fontSize: 14 }} />
        </ToolbarBtn>
        <ToolbarBtn disabled={!activeEditor} active={!!activeEditor?.isActive('orderedList')} onClick={() => { activeEditor?.chain().focus().toggleOrderedList().run() }} title="Numbered List">
          <Icon icon={faListOl} style={{ fontSize: 14 }} />
        </ToolbarBtn>
        <ToolbarDivider />
        {/* Text alignment */}
        <ToolbarBtn disabled={!activeEditor} active={!!activeEditor?.isActive({ textAlign: 'left' })} onClick={() => { activeEditor?.chain().focus().setTextAlign('left').run() }} title="Align Left">
          <Icon icon={faAlignLeft} style={{ fontSize: 14 }} />
        </ToolbarBtn>
        <ToolbarBtn disabled={!activeEditor} active={!!activeEditor?.isActive({ textAlign: 'center' })} onClick={() => { activeEditor?.chain().focus().setTextAlign('center').run() }} title="Align Center">
          <Icon icon={faAlignCenter} style={{ fontSize: 14 }} />
        </ToolbarBtn>
        <ToolbarBtn disabled={!activeEditor} active={!!activeEditor?.isActive({ textAlign: 'right' })} onClick={() => { activeEditor?.chain().focus().setTextAlign('right').run() }} title="Align Right">
          <Icon icon={faAlignRight} style={{ fontSize: 14 }} />
        </ToolbarBtn>
        <ToolbarDivider />
        <ColourSwatchButton
          title="Font colour"
          disabled={!activeEditor}
          value={activeEditor?.getAttributes('textStyle')?.color}
          onChange={(hex) => { activeEditor?.chain().focus().setColor(hex).run() }}
        >
          <Icon icon={faFontColor} style={{ fontSize: 14 }} />
        </ColourSwatchButton>

        <div style={{ flex: 1 }} />
        {/* Pop back in — closing the window also pops back in. */}
        <ToolbarBtn onClick={() => window.close()} title="Pop back into the main window">
          <Icon icon={faDownLeftAndUpRightToCenter} style={{ fontSize: 12 }} />
        </ToolbarBtn>

      </div>

      {/* Main content area */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <MapSidebar data={sidebarData} visible={sidebarVisible} />
        <MapCanvas
          elements={elements}
          freeTexts={freeTexts}
          connections={connections}
          pan={pan}
          zoom={zoom}
          selectedElementIds={selectedElementIds}
          selectedConnectionIds={selectedConnectionIds}
          selectedFreeTextIds={selectedFreeTextIds}
          addTextMode={addTextMode}
          onPanChange={setPan}
          onZoomChange={setZoom}
          onElementMove={handleElementMove}
          onMultiElementMove={handleMultiElementMove}
          onSelectElements={handleSelectElements}
          onSelectConnections={setSelectedConnectionIds}
          onSelectFreeTexts={handleSetSelectedFreeTexts}
          onCreateConnection={handleCreateConnection}
          onToggleArrow={handleToggleArrow}
          onUpdateConnectionLabel={handleUpdateConnectionLabel}
          onDropElement={handleDropElement}
          onCreateFreeText={handleCreateFreeText}
          onUpdateFreeText={handleUpdateFreeText}
          onMoveFreeText={handleMoveFreeText}
          onDeleteSelected={handleDeleteSelected}
          onFocusFreeText={handleFocusFreeText}
          focusedFreeTextId={focusedFreeTextId}
          onElementDoubleClick={handleElementDoubleClick}
          onEditorReady={handleEditorReady}
          onResizeFreeText={handleResizeFreeText}
          onElementRenderedHeight={handleElementRenderedHeight}
          onAddMemoToElement={handleAddMemoToElement}
          onAddMemoOnCanvas={handleAddMemoOnCanvas}
          onOpenAttachedMemo={handleOpenAttachedMemo}
          panWrapperRef={panWrapperRef}
        />
      </div>

      {/* ── Bottom action bar (matches other analysis tools) ── */}
      <div style={{
        padding: '10px 20px',
        borderTop: '1px solid var(--border-color)',
        background: 'var(--bg-secondary)',
        display: 'flex',
        justifyContent: 'flex-end',
        gap: 8,
        flexShrink: 0
      }}>
        <button className="secondary" style={{ fontSize: 11, padding: '4px 14px' }} onClick={handleExportSvg}>
          Export SVG
        </button>
        <div style={{ flex: 1 }} />
        <button className="secondary" style={{ fontSize: 11, padding: '4px 14px' }} onClick={handleCloseRequest}>
          Close
        </button>
        {isExisting && dirty && (
          <button
            className="secondary"
            style={{ fontSize: 11, padding: '4px 14px' }}
            onClick={handleDiscardChanges}
          >
            Discard Changes
          </button>
        )}
        {isExisting ? (
          <button
            style={{ fontSize: 11, padding: '4px 14px' }}
            disabled={!dirty}
            onClick={handleSave}
          >
            {dirty ? 'Save' : 'Saved'}
          </button>
        ) : (
          <button style={{ fontSize: 11, padding: '4px 14px' }} onClick={handleSaveNew}>
            Save
          </button>
        )}
      </div>

      {/* Close-with-unsaved-changes dialog */}
      {showCloseDialog && (
        <div
          className="modal-overlay"
          onClick={() => setShowCloseDialog(false)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ minWidth: 360 }}>
            <h2>Unsaved changes</h2>
            <p style={{ margin: '8px 0 16px', color: 'var(--text-secondary)' }}>
              This map has unsaved changes. What would you like to do?
            </p>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setShowCloseDialog(false)}>
                Cancel
              </button>
              <button className="secondary" onClick={handleDiscardAndClose}>
                Discard
              </button>
              <button onClick={handleSaveFromCloseDialog}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Save dialog */}
      {showSaveDialog && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') setShowSaveDialog(false) }} style={{ minWidth: 320 }}>
            <h2>Save Relationship Map</h2>
            <input
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="Analysis name"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleConfirmFirstSave()}
              style={{ width: '100%' }}
            />
            <div className="modal-actions">
              <button className="secondary" onClick={() => setShowSaveDialog(false)}>
                Cancel
              </button>
              <button onClick={handleConfirmFirstSave}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </PdfFilePathsContext.Provider>
  )
}
