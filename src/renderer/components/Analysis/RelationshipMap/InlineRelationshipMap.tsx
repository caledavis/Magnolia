import { useState, useCallback, useRef, useMemo } from 'react'
import { MemoFab } from '../../Memos/MemoFab'
import { useRelationshipMapStore } from '../../../stores/relationship-map-store'
import { useDocumentStore } from '../../../stores/document-store'
import { useMemoStore } from '../../../stores/memo-store'
import { useQuoteStore } from '../../../stores/quote-store'
import { useCodeStore } from '../../../stores/code-store'
import { useTagStore } from '../../../stores/tag-store'
import { useQueryStore } from '../../../stores/query-store'
import { useProjectStore } from '../../../stores/project-store'
import { useSurveyViewStore } from '../../../stores/survey-view-store'
import { generateGuid } from '../../../utils/guid'
import type {
  MapElement,
  MapConnection,
  FreeTextElement,
  MapElementKind
} from './types'
import { ELEMENT_DIMS, FREE_TEXT_DEFAULT_WIDTH, FREE_TEXT_DEFAULT_HEIGHT } from './types'
import { MapCanvas } from './MapCanvas'
import { PdfFilePathsContext } from './PdfFilePathsContext'
import {
  Icon,
  faFont,
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
  faFontColor,
  faCircleNodes
} from '../../Icon'
import { ColourSwatchButton } from '../../ColourSwatchButton'
import { makeMapTabId } from '../../../utils/tab-ids'
import { flushMapToProject } from '../../../utils/flush-map-to-project'
import { useRegisterToolSave } from '../../../hooks/use-register-tool-save'
import { buildExportSvg } from './svg-export'
import { buildExportSvgFromDom } from './dom-svg-export'
import { EditableTitleSuffix } from '../../EditableTitleSuffix'

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
  mapGuid: string
}

export function InlineRelationshipMap({ mapGuid }: Props) {
  const map = useRelationshipMapStore((s) => s.maps[mapGuid])
  const setElementsStore = useRelationshipMapStore((s) => s.setElements)
  const setFreeTextsStore = useRelationshipMapStore((s) => s.setFreeTexts)
  const setConnectionsStore = useRelationshipMapStore((s) => s.setConnections)
  const setPanStore = useRelationshipMapStore((s) => s.setPan)
  const setZoomStore = useRelationshipMapStore((s) => s.setZoom)

  // Store-backed state (authoritative)
  const elements = map?.elements ?? []
  const freeTexts = map?.freeTexts ?? []
  const connections = map?.connections ?? []
  const pan = map?.pan ?? { x: 0, y: 0 }
  const zoom = map?.zoom ?? 1

  // Ephemeral UI state — selections, editor focus, etc.
  const [selectedElementIds, setSelectedElementIds] = useState<Set<string>>(new Set())
  const [selectedConnectionIds, setSelectedConnectionIds] = useState<Set<string>>(new Set())
  const [selectedFreeTextIds, setSelectedFreeTextIds] = useState<Set<string>>(new Set())
  const [addTextMode, setAddTextMode] = useState(false)
  const [focusedFreeTextId, setFocusedFreeTextId] = useState<string | null>(null)
  const [activeEditor, setActiveEditor] = useState<any>(null)
  const editorMapRef = useRef<Map<string, any>>(new Map())
  const panWrapperRef = useRef<HTMLDivElement | null>(null)

  // PDF file paths for thumbnails
  const sources = useDocumentStore((s) => s.sources)
  const pdfFilePaths = useMemo(() => {
    const out: Record<string, string> = {}
    for (const src of sources) {
      const fp = (src as any).formatData?.pdfFilePath ?? (src as any).formatData?.imageFilePath
      if (fp) out[src.guid] = fp
    }
    return out
  }, [sources])

  const handleEditorReady = useCallback((id: string, editor: any) => {
    editorMapRef.current.set(id, editor)
    if (id === focusedFreeTextId || selectedFreeTextIds.has(id)) {
      setActiveEditor(editor)
    }
  }, [focusedFreeTextId, selectedFreeTextIds])

  const handleSetSelectedFreeTexts = useCallback((ids: Set<string>) => {
    setSelectedFreeTextIds(ids)
    if (ids.size === 1) {
      const id = [...ids][0]
      const editor = editorMapRef.current.get(id)
      if (editor) {
        setActiveEditor(editor)
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

  // Mutations dispatched back to the store.
  const setElements = useCallback(
    (updater: (prev: MapElement[]) => MapElement[]) => {
      const current = useRelationshipMapStore.getState().maps[mapGuid]?.elements ?? []
      setElementsStore(mapGuid, updater(current))
    },
    [mapGuid, setElementsStore]
  )
  const setFreeTexts = useCallback(
    (updater: (prev: FreeTextElement[]) => FreeTextElement[]) => {
      const current = useRelationshipMapStore.getState().maps[mapGuid]?.freeTexts ?? []
      setFreeTextsStore(mapGuid, updater(current))
    },
    [mapGuid, setFreeTextsStore]
  )
  const setConnections = useCallback(
    (updater: (prev: MapConnection[]) => MapConnection[]) => {
      const current = useRelationshipMapStore.getState().maps[mapGuid]?.connections ?? []
      setConnectionsStore(mapGuid, updater(current))
    },
    [mapGuid, setConnectionsStore]
  )

  // Handlers forwarded to MapCanvas — dispatch store actions.
  const onPanChange = useCallback((next: { x: number; y: number }) => setPanStore(mapGuid, next), [mapGuid, setPanStore])
  const onZoomChange = useCallback((next: number) => setZoomStore(mapGuid, next), [mapGuid, setZoomStore])

  const handleElementMove = useCallback((id: string, x: number, y: number) => {
    setElements((prev) => prev.map((e) => (e.id === id ? { ...e, x, y } : e)))
  }, [setElements])

  const handleMultiElementMove = useCallback((ids: string[], dx: number, dy: number) => {
    setElements((prev) => prev.map((e) => (ids.includes(e.id) ? { ...e, x: e.x + dx, y: e.y + dy } : e)))
  }, [setElements])

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

  const handleCreateConnection = useCallback((fromId: string, toId: string) => {
    const existing = useRelationshipMapStore.getState().maps[mapGuid]?.connections ?? []
    const dup = existing.some(
      (c) => (c.fromId === fromId && c.toId === toId) || (c.fromId === toId && c.toId === fromId)
    )
    if (dup) return
    const newConn: MapConnection = {
      id: generateGuid(),
      fromId,
      toId,
      arrowFrom: false,
      arrowTo: false,
      label: ''
    }
    setConnections((prev) => [...prev, newConn])
  }, [mapGuid, setConnections])

  const handleToggleArrow = useCallback((connId: string, end: 'from' | 'to') => {
    setConnections((prev) =>
      prev.map((c) => {
        if (c.id !== connId) return c
        return end === 'from' ? { ...c, arrowFrom: !c.arrowFrom } : { ...c, arrowTo: !c.arrowTo }
      })
    )
  }, [setConnections])

  const handleUpdateConnectionLabel = useCallback((connId: string, label: string) => {
    setConnections((prev) => prev.map((c) => (c.id === connId ? { ...c, label } : c)))
  }, [setConnections])

  const handleCreateFreeText = useCallback((x: number, y: number) => {
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
    setTimeout(() => handleFocusFreeText(ft.id), 100)
  }, [setFreeTexts, handleFocusFreeText])

  const handleUpdateFreeText = useCallback((id: string, content: any) => {
    setFreeTexts((prev) => prev.map((f) => (f.id === id ? { ...f, content } : f)))
  }, [setFreeTexts])

  const handleMoveFreeText = useCallback((id: string, x: number, y: number) => {
    setFreeTexts((prev) => prev.map((f) => (f.id === id ? { ...f, x, y } : f)))
  }, [setFreeTexts])

  const handleResizeFreeText = useCallback(
    (id: string, update: { x: number; y: number; width: number; height: number }) => {
      setFreeTexts((prev) => prev.map((f) => (f.id === id ? { ...f, ...update } : f)))
    },
    [setFreeTexts]
  )

  // Height updates come from the per-element ResizeObserver, which
  // fires whenever the tab transitions display:none → display:flex on
  // a tab switch. Route these through updateElementHeight so they
  // don't mark a freshly-saved map as dirty.
  const updateElementHeight = useRelationshipMapStore((s) => s.updateElementHeight)
  const handleElementRenderedHeight = useCallback((id: string, height: number) => {
    updateElementHeight(mapGuid, id, height)
  }, [mapGuid, updateElementHeight])

  const handleDeleteSelected = useCallback(() => {
    const delEls = selectedElementIds
    const delFts = selectedFreeTextIds
    const delConns = selectedConnectionIds
    setElements((prev) => prev.filter((e) => !delEls.has(e.id)))
    setFreeTexts((prev) => prev.filter((f) => !delFts.has(f.id)))
    setConnections((prev) => prev.filter((c) => !delConns.has(c.id) && !delEls.has(c.fromId) && !delEls.has(c.toId)))
    setSelectedElementIds(new Set())
    setSelectedConnectionIds(new Set())
    setSelectedFreeTextIds(new Set())
    if (delFts.has(focusedFreeTextId || '')) setFocusedFreeTextId(null)
  }, [selectedElementIds, selectedFreeTextIds, selectedConnectionIds, focusedFreeTextId, setElements, setFreeTexts, setConnections])

  const handleDropElement = useCallback(
    (kind: string, dropData: any, x: number, y: number) => {
      const k = kind as MapElementKind
      const baseDims = ELEMENT_DIMS[k] || { w: 140, h: 44 }
      const label = dropData.label || 'Untitled'
      const charsPerLine = Math.floor((baseDims.w - 16) / 7)
      const lines = Math.ceil(label.length / charsPerLine)
      const estimatedH = k === 'document' ? 18 + 6 + Math.max(1, lines) * 16 : baseDims.h
      const dims = { w: baseDims.w, h: estimatedH }
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
    [setElements]
  )

  // Double-click on map element → invoke the same project-level actions
  // the popped-out window routes through IPC, but act on the main-window
  // stores directly since we ARE the main window.
  const handleElementDoubleClick = useCallback((el: MapElement) => {
    if (!el.entityGuid) return
    switch (el.kind) {
      case 'document':
        useDocumentStore.getState().viewDocument(el.entityGuid)
        break
      case 'code': {
        // Mirror the RelationshipMap window's behaviour: build a single-code
        // query and send it to the Query Builder pane.
        useQueryStore.getState().setComplexQuery({
          documentFilter: {},
          codeCondition: { type: 'code', codeGuid: el.entityGuid }
        } as any)
        break
      }
      case 'query':
        useQueryStore.getState().runSavedQuery(el.entityGuid)
        break
      case 'memo': {
        const memo = useMemoStore.getState().findMemo(el.entityGuid)
        if (memo) {
          window.api.openMemoEditWindow({
            memo,
            theme: document.documentElement.getAttribute('data-theme') || ''
          })
        }
        break
      }
      case 'query-result':
      case 'quote':
        if (el.sourceGuid && el.startPosition != null && el.endPosition != null) {
          useDocumentStore.getState().viewDocumentAt(el.sourceGuid, el.startPosition, el.endPosition)
        }
        break
      case 'tag': {
        const tag = useTagStore.getState().tags.find((t) => t.guid === el.entityGuid)
        if (tag) useDocumentStore.getState().selectDocuments(new Set(tag.memberSourceGuids))
        break
      }
      case 'tag-category': {
        const tgStore = useTagStore.getState()
        const categoryTags = tgStore.tags.filter((t) => t.categoryGuid === el.entityGuid)
        const allGuids = new Set<string>()
        for (const t of categoryTags) for (const g of t.memberSourceGuids) allGuids.add(g)
        useDocumentStore.getState().selectDocuments(allGuids)
        break
      }
      case 'folder': {
        // Select every document that lives anywhere beneath the folder
        // (recursively walking sub-folders), mirroring how Group-by-folder
        // resolves a folder entry's source set elsewhere.
        const ds = useDocumentStore.getState()
        const folderSet = new Set<string>([el.entityGuid])
        let added = true
        while (added) {
          added = false
          for (const f of ds.folders) {
            if (f.parentGuid && folderSet.has(f.parentGuid) && !folderSet.has(f.guid)) {
              folderSet.add(f.guid)
              added = true
            }
          }
        }
        const docs = new Set<string>()
        for (const s of ds.sources) {
          const fg = ds.sourceFolder[s.guid]
          if (fg && folderSet.has(fg)) docs.add(s.guid)
        }
        ds.selectDocuments(docs)
        break
      }
      case 'analysis': {
        const ps = useProjectStore.getState()
        const sa = (ps.savedAnalyses ?? []).find((a) => a.guid === el.entityGuid)
        if (!sa) return
        // Route Relationship Maps as a tab; everything else opens as a
        // window via the existing saved-analysis IPC path.
        if (sa.toolType === 'relationship-map') {
          const rmStore = useRelationshipMapStore.getState()
          if (rmStore.maps[sa.guid]?.poppedOut) return
          rmStore.loadSavedMap(sa.guid, sa.name, {
            elements: sa.config.elements ?? [],
            freeTexts: sa.config.freeTexts ?? [],
            connections: sa.config.connections ?? [],
            pan: sa.config.pan ?? { x: 0, y: 0 }
          })
          useDocumentStore.getState().openToolTab(makeMapTabId(sa.guid))
        } else {
          window.api.sendAnalysisAction('open-saved-analysis', sa.toolType, {
            guid: sa.guid,
            name: sa.name
          })
        }
        break
      }
      case 'survey-respondent':
      case 'survey-question':
      case 'survey-cell': {
        // Open the parent survey tab and switch its in-tab view to
        // the matching respondent / question. Also set a scroll
        // target so the SurveyViewer brings the relevant content
        // into view regardless of which sub-view is rendered.
        // Mirrors the path the Document Browser uses for the same
        // actions.
        if (!el.surveyGuid) return
        const setView = useSurveyViewStore.getState().setView
        const setScrollTarget = useSurveyViewStore.getState().setScrollTarget
        if (el.kind === 'survey-respondent') {
          setView(el.surveyGuid, 'respondent', el.entityGuid)
        } else if (el.kind === 'survey-question') {
          setView(el.surveyGuid, 'question', el.entityGuid)
          // Ask the viewer to scroll to any cell tagged with this
          // questionId. The scrollTarget effect falls back to a
          // questionId-only match when no respondentId is set, so it
          // finds the first matching cell and scrolls it under the
          // sticky header — the same behaviour cells use, applied to
          // the question itself.
          setScrollTarget({
            surveyGuid: el.surveyGuid,
            questionId: el.entityGuid
          })
        } else {
          // survey-cell — entityGuid is respondent id, questionId is
          // set on the element. Land on the respondent's answers view
          // and ask the viewer to scroll the cell into focus.
          setView(el.surveyGuid, 'respondent', el.entityGuid)
          if (el.questionId) {
            setScrollTarget({
              surveyGuid: el.surveyGuid,
              respondentId: el.entityGuid,
              questionId: el.questionId
            })
          }
        }
        useDocumentStore.getState().viewDocument(el.surveyGuid)
        break
      }
    }
  }, [])

  // Persistence is explicit: the user clicks Save Analysis / Update
  // Analysis (or confirms Save in the unsaved-changes dialog). There is
  // no autosave for relationship maps.
  const dirty = map?.dirty ?? false
  const markSaved = useRelationshipMapStore((s) => s.markSaved)
  const revertToSnapshot = useRelationshipMapStore((s) => s.revertToSnapshot)

  const flushMapSave = useCallback(() => {
    const current = useRelationshipMapStore.getState().maps[mapGuid]
    if (!current) return
    flushMapToProject(current)
    markSaved(mapGuid)
  }, [mapGuid, markSaved])

  const handleDiscardChanges = useCallback(() => {
    revertToSnapshot(mapGuid)
  }, [mapGuid, revertToSnapshot])

  // First-save flow mirrors the other six analysis tools: clicking
  // "Save Analysis" on a never-saved map opens a Name dialog rather
  // than persisting silently with the default "Relationship Map".
  // Existing maps fall straight through to flushMapSave.
  const [showSaveDialog, setShowSaveDialog] = useState(false)

  // Right-click "Add Memo" handlers. Create an Analysis Memo tied to
  // this map (analysisGuid = mapGuid), attach it either to the clicked
  // element or as a new memo map-element at the click point, flush the
  // map save immediately so the sidebar can resolve the map by guid,
  // then open the memo edit window for the fresh memo.
  //
  // The map save here is a side effect of *creating a memo* (which has
  // nowhere to attach until the map exists in savedAnalyses), not an
  // autosave on user edits — those are explicit only.
  const handleAddMemoToElement = useCallback((elementId: string) => {
    const memoStore = useMemoStore.getState()
    const memoGuid = memoStore.addMemo('analysis', '', { analysisGuid: mapGuid })
    setElements((prev) => prev.map((el) => el.id === elementId ? { ...el, memoGuid } : el))
    flushMapSave()
    const memo = memoStore.findMemo(memoGuid)
    if (memo) {
      // Memo is already persisted — open the editor in "existing" mode
      // so its Save fires updateMemo instead of addMemoFromDraft
      // (otherwise the first save would create a second copy).
      window.api.openMemoEditWindow({
        memo,
        theme: document.documentElement.getAttribute('data-theme') || ''
      })
    }
  }, [mapGuid, setElements, flushMapSave])

  const handleAddMemoOnCanvas = useCallback((x: number, y: number) => {
    const memoStore = useMemoStore.getState()
    const memoGuid = memoStore.addMemo('analysis', '', { analysisGuid: mapGuid })
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
    flushMapSave()
    const memo = memoStore.findMemo(memoGuid)
    if (memo) {
      window.api.openMemoEditWindow({
        memo,
        theme: document.documentElement.getAttribute('data-theme') || ''
      })
    }
  }, [mapGuid, setElements, flushMapSave])


  // Whether the map already exists in project.savedAnalyses — drives the
  // Save vs Update Analysis label, mirroring the rest of the analysis
  // tools. Subscribed (not getState) so the label flips the instant the
  // user's first explicit save inserts the entry.
  const savedAnalyses = useProjectStore((s) => s.savedAnalyses)
  const isExisting = useMemo(
    () => (savedAnalyses ?? []).some((a) => a.guid === mapGuid),
    [savedAnalyses, mapGuid]
  )

  // Close-tab handler. The TabBar's confirm-on-dirty dialog runs before
  // this, so by the time we get here the user has either saved or
  // discarded — we just close.
  const handleCloseTab = useCallback(() => {
    useDocumentStore.getState().closeTab(makeMapTabId(mapGuid))
  }, [mapGuid])

  const handleRenameMap = useCallback((newName: string) => {
    useRelationshipMapStore.getState().setName(mapGuid, newName)
  }, [mapGuid])

  // Save-button click. Existing maps fall straight through to
  // flushMapSave. Brand-new maps open the Save Analysis name dialog so
  // the user explicitly names the entry before it lands in
  // project.savedAnalyses, matching the other analysis tools.
  const handleSaveClick = useCallback(() => {
    if (isExisting) {
      flushMapSave()
    } else {
      setShowSaveDialog(true)
    }
  }, [isExisting, flushMapSave])

  const handleConfirmSave = useCallback((name: string) => {
    const trimmed = name.trim() || 'Untitled'
    useRelationshipMapStore.getState().setName(mapGuid, trimmed)
    setShowSaveDialog(false)
    flushMapSave()
  }, [mapGuid, flushMapSave])

  // Register the save handler so the TabBar's unsaved-changes dialog
  // can fire it when the user picks Save while closing this tab.
  // Mirrors the analysis-tool registration: existing → save; new →
  // open the name dialog and report false (the close defers).
  useRegisterToolSave(makeMapTabId(mapGuid), () => {
    if (isExisting) {
      flushMapSave()
      return true
    }
    setShowSaveDialog(true)
    return false
  })

  if (!map) return null

  return (
    <PdfFilePathsContext.Provider value={pdfFilePaths}>
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', position: 'relative' }}>
        {/* Title row — mirrors the layout used by every analysis tool
            and the Query Builder so the Relationships tool reads as
            part of the same family. Action buttons (Export SVG /
            Cancel / Close / Save-or-Update Analysis) live here next
            to the MemoFab; the formatting toolbar below is purely for
            free-text formatting. */}
        <div
          style={{
            padding: '14px 20px 6px',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 8
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: 18,
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              color: 'var(--text-secondary)'
            }}
          >
            <Icon icon={faCircleNodes} className="analysis-header-icon" style={{ fontSize: 16 }} />
            Relationships:
            <EditableTitleSuffix
              name={map.name?.trim() || 'Untitled map'}
              onRename={handleRenameMap}
            />
          </h2>
          <div style={{ flex: 1 }} />
          <button
            className="secondary"
            style={{ fontSize: 11, padding: '4px 14px' }}
            onClick={() => {
              const current = useRelationshipMapStore.getState().maps[mapGuid]
              if (!current) return
              const svg = panWrapperRef.current
                ? buildExportSvgFromDom(panWrapperRef.current, current.elements, current.freeTexts)
                : buildExportSvg(current.elements, current.connections, current.freeTexts)
              window.api.exportSvg(svg, `${current.name?.trim() || 'relationship-map'}.svg`)
            }}
            title="Export as SVG"
          >
            Export SVG
          </button>
          <button
            className="secondary"
            style={{ fontSize: 11, padding: '4px 14px' }}
            onClick={handleCloseTab}
          >
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
          <button
            style={{ fontSize: 11, padding: '4px 14px' }}
            disabled={isExisting && !dirty}
            onClick={handleSaveClick}
          >
            {isExisting ? (dirty ? 'Update Analysis' : 'Saved') : 'Save Analysis'}
          </button>
          {/* Clearance for the floating MemoFab (28 px circle + ~8 gap)
              so the action buttons don't slide under it. Matches the
              other six analysis tools so the title row's content
              height (and the buttons' vertical position) is identical
              across the family. The FAB itself is absolutely
              positioned below as a sibling of the title row. */}
          <div style={{ width: 36, flexShrink: 0 }} />
        </div>

        {showSaveDialog && (
          <div className="modal-overlay">
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h2>Save Analysis</h2>
              <input
                autoFocus
                type="text"
                defaultValue={map.name?.trim() ?? ''}
                placeholder="Analysis name"
                style={{ width: '100%' }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleConfirmSave((e.target as HTMLInputElement).value)
                  if (e.key === 'Escape') setShowSaveDialog(false)
                }}
              />
              <div className="modal-actions">
                <button className="secondary" onClick={() => setShowSaveDialog(false)}>Cancel</button>
                <button onClick={(e) => {
                  const input = (e.target as HTMLElement).parentElement!.parentElement!.querySelector('input') as HTMLInputElement
                  handleConfirmSave(input.value)
                }}>Save</button>
              </div>
            </div>
          </div>
        )}

        {/* Free-text formatting toolbar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 12px',
            borderBottom: '1px solid var(--border-color, #e0e0e0)',
            background: 'var(--bg-panel)',
            flexShrink: 0
          }}
        >
          <ToolbarBtn
            active={addTextMode}
            onClick={() => setAddTextMode(!addTextMode)}
            title="Add Text — click canvas to place text"
          >
            <Icon icon={faFont} style={{ fontSize: 13 }} />
          </ToolbarBtn>
          <ToolbarDivider />
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
        </div>

        {/* Canvas */}
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
          onPanChange={onPanChange}
          onZoomChange={onZoomChange}
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
          onOpenAttachedMemo={(elementId) => {
            const el = useRelationshipMapStore.getState().maps[mapGuid]?.elements.find((e) => e.id === elementId)
            if (!el?.memoGuid) return
            const memo = useMemoStore.getState().findMemo(el.memoGuid)
            if (!memo) return
            window.api.openMemoEditWindow({
              memo,
              theme: document.documentElement.getAttribute('data-theme') || ''
            })
          }}
          panWrapperRef={panWrapperRef}
        />
        {/* Absolutely-positioned MemoFab — matches the other tools'
            placement so the title row's height (and the buttons'
            vertical centring) is identical across the family. The
            outer wrapper gets `position: relative` to anchor it. */}
        <MemoFab kind="saved-analysis" targetGuid={mapGuid} />
      </div>
    </PdfFilePathsContext.Provider>
  )
}

