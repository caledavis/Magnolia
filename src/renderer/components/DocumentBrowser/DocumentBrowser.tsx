import { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { useDocumentStore, surveyEntityKey, parseSurveyEntityKey, type DocumentFolder } from '../../stores/document-store'
import { useTagStore } from '../../stores/tag-store'
import { Icon, faFolder, faFolderPlus, faFile, faFileAlt, faTags, faChevronDown, faChevronRight, faXmark, faUpRightFromSquare, faDownLeftAndUpRightToCenter, faHeadphones, faVideo, faImage, faPlus, faMagnifyingGlass, SURVEY_ICON, SURVEY_RESPONDENT_ICON, SURVEY_QUESTION_ICON } from '../Icon'
import type { TextSource, TagCategory, TagCategoryType, SurveyFormatData } from '../../models/types'
import { toolColors } from '../../utils/tool-colors'
import { sourceTypeFromExtension, sourceTypeFromFilename } from '../../utils/format-registry'
import { useClampedMenuPosition } from '../../utils/use-clamped-menu-position'
import { sortTagsForCategory, sortListOptions } from '../../utils/sort-tags'
import { useSurveyViewStore } from '../../stores/survey-view-store'
import { buildCellText } from '../../utils/survey/cell-text'
import { RESPONDENTS_GROUP_MIME } from '../Analysis/group-by'
import { useProjectStore, useCheckoutLockedBy, checkoutLockedTitle } from '../../stores/project-store'

function iconForSource(source: { name: string; sourceType?: string }) {
  // Prefer the source's declared type (set on import for audio/video/image/
  // pdf). Only fall back to sniffing the filename for sources whose type is
  // unset or whose name carries a telling extension. Foreign QDPX imports
  // (e.g. MAXQDA) name sources WITHOUT extensions — "New Recording 11",
  // "magnoliasolid" — so a filename-only sniff mis-icons every media file as
  // a generic document; trusting sourceType fixes that.
  const st: string = (source.sourceType as string) || sourceTypeFromFilename(source.name)
  if (st === 'audio') return faHeadphones
  if (st === 'video') return faVideo
  if (st === 'image') return faImage
  return faFile
}

interface Props {
  onImport: () => void
  /** Called when the user drags a CSV onto the document browser. The
   *  caller is responsible for parsing the CSV, queuing the survey-
   *  preview dialog, and (on confirm) adding the source to the right
   *  folder. We hand the raw bytes + suggested name + folder so the
   *  preview UI can stay in App.tsx alongside the queue state. */
  onSurveyImport?: (csv: string, suggestedName: string, folderGuid?: string) => void
  showManageDocTags?: boolean
  onCloseManageDocTags?: () => void
  onClose?: () => void
  onPopOut?: () => void
  isPoppedOut?: boolean
}

type TagDropTarget =
  | { kind: 'document'; guid: string }
  | { kind: 'respondent' | 'question'; sourceGuid: string; id: string }

/** Apply dropped tags to the right place: if the drop target is part of
 *  the current multi-selection, tag every selected document AND survey
 *  respondent/question; otherwise just the target. Reads store state
 *  directly so both the document and survey-row drop handlers share one
 *  implementation. */
function applyTagDropToSelection(tagGuids: string[], target: TagDropTarget): void {
  const tag = useTagStore.getState()
  const { selectedDocumentGuids, selectedSurveyEntities } = useDocumentStore.getState()
  const targetSelected =
    target.kind === 'document'
      ? selectedDocumentGuids.has(target.guid)
      : selectedSurveyEntities.has(
          surveyEntityKey(target.kind === 'respondent' ? 'resp' : 'quest', target.sourceGuid, target.id)
        )

  let entities: TagDropTarget[]
  if (targetSelected) {
    entities = []
    for (const g of selectedDocumentGuids) entities.push({ kind: 'document', guid: g })
    for (const key of selectedSurveyEntities) {
      const p = parseSurveyEntityKey(key)
      if (p) entities.push({ kind: p.kind === 'resp' ? 'respondent' : 'question', sourceGuid: p.sourceGuid, id: p.id })
    }
  } else {
    entities = [target]
  }

  for (const tg of tagGuids) {
    for (const e of entities) {
      if (e.kind === 'document') tag.assignTagToDocument(tg, e.guid)
      else if (e.kind === 'respondent') tag.assignTagToSurveyRespondent(tg, e.sourceGuid, e.id)
      else tag.assignTagToSurveyQuestion(tg, e.sourceGuid, e.id)
    }
  }
}

function FolderItem({
  folder,
  allFolders,
  sources,
  sourceFolder,
  selectedGuids,
  viewedGuid,
  depth,
  onSelectDocument,
  onViewDocument,
  onContextMenuDoc,
  onContextMenuFolder,
  onRenameDoc,
  onFileDrop,
  editingDocGuid,
  onStartEditingDoc,
  onStopEditingDoc,
  getTagsForDocument,
  onTagDrop,
  onReorderDoc,
  onViewSurveyChild,
  onContextMenuSurveyChild,
  selectedSurveyEntities,
  onToggleSurveyEntity,
  searchQuery

}: {
  folder: DocumentFolder
  allFolders: DocumentFolder[]
  sources: TextSource[]
  sourceFolder: Record<string, string>
  selectedGuids: Set<string>
  viewedGuid: string | null
  depth: number
  onSelectDocument: (guid: string, e: React.MouseEvent) => void
  onViewDocument: (guid: string) => void
  onContextMenuDoc: (e: React.MouseEvent, guid: string) => void
  onContextMenuFolder: (e: React.MouseEvent, guid: string) => void
  onRenameDoc: (guid: string, name: string) => void
  onFileDrop: (filePaths: string[], folderGuid?: string) => void
  editingDocGuid: string | null
  onStartEditingDoc: (guid: string) => void
  onStopEditingDoc: () => void
  getTagsForDocument: (guid: string) => { guid: string; name: string }[]
  onTagDrop: (tagGuids: string[], sourceGuid: string) => void
  onReorderDoc: (draggedGuids: string[], siblingGuid: string, position: 'before' | 'after') => void
  onViewSurveyChild: (
    surveyGuid: string,
    kind: 'summary' | 'respondent' | 'question',
    childId?: string
  ) => void
  onContextMenuSurveyChild: (
    e: React.MouseEvent,
    sourceGuid: string,
    kind: 'respondent' | 'question',
    id: string,
    label: string
  ) => void
  selectedSurveyEntities: Set<string>
  onToggleSurveyEntity: (sourceGuid: string, kind: 'respondent' | 'question', id: string) => void
  /** Trimmed, lowercased active search filter ('' when no search is
   *  running). `sources`/`allFolders` already arrive pre-filtered to
   *  what should be visible — this is only used to tell whether THIS
   *  folder is a genuine name match (full opacity) or shown purely as
   *  ancestor context for a match further down (dimmed), and to force
   *  the tree open so nested matches aren't hidden by a manual collapse. */
  searchQuery: string

}) {
  const [expanded, setExpanded] = useState(true)
  const [isDragOver, setIsDragOver] = useState(false)
  const searchActive = searchQuery.length > 0
  const isSearchMatch = !searchActive || folder.name.toLowerCase().includes(searchQuery)
  const effectiveExpanded = expanded || searchActive
  const dragCounterRef = useRef(0)
  const moveSourceToFolder = useDocumentStore((s) => s.moveSourceToFolder)
  const moveFolderToFolder = useDocumentStore((s) => s.moveFolderToFolder)

  const childFolders = allFolders.filter((f) => f.parentGuid === folder.guid)
  const childSources = sources.filter((s) => sourceFolder[s.guid] === folder.guid)

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px',
          paddingLeft: 8 + depth * 16,
          cursor: 'pointer',
          borderRadius: 'var(--radius-sm)',
          background: isDragOver ? 'var(--accent)' : 'transparent',
          fontSize: 'var(--font-size-sm)',
          fontWeight: 600,
          outline: isDragOver ? '1px dashed var(--accent-hover)' : 'none',
          opacity: isSearchMatch ? 1 : 0.45,
          transition: 'background 0.1s'
        }}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-magnolia-folder', folder.guid)
          // Side-channel MIME carrying the folder name so analysis-window
          // chips can render it even when the analysis window's snapshot
          // of docStore.folders is stale (e.g. window was opened before
          // the folder was created). The original guid-only MIME stays
          // for legacy receivers (DocumentBrowser's own move targets).
          e.dataTransfer.setData('application/x-magnolia-folder-info', JSON.stringify({
            guid: folder.guid,
            name: folder.name
          }))
          // Relationship-map JSON payload — drop a folder onto a map and
          // it lands as a single chip-style element representing the
          // folder. Mirrors how categories drop as one node.
          e.dataTransfer.setData('application/json', JSON.stringify({
            kind: 'folder',
            entityGuid: folder.guid,
            label: folder.name
          }))
          // copyMove (not just move) so analysis tools that drop a folder
          // as a "Group by" entry can request dropEffect 'copy' without
          // the browser rejecting the drag. The DocumentBrowser's own
          // targets continue to use 'move' semantics for reparenting.
          e.dataTransfer.effectAllowed = 'copyMove'
        }}
        onDragEnter={(e) => {
          if (
            e.dataTransfer.types.includes('application/x-magnolia-doc-reorder') ||
            e.dataTransfer.types.includes('application/x-magnolia-folder') ||
            e.dataTransfer.types.includes('Files')
          ) {
            e.preventDefault()
            dragCounterRef.current++
            setIsDragOver(true)
          }
        }}
        onDragOver={(e) => {
          if (
            e.dataTransfer.types.includes('application/x-magnolia-doc-reorder') ||
            e.dataTransfer.types.includes('application/x-magnolia-folder') ||
            e.dataTransfer.types.includes('Files')
          ) {
            e.preventDefault()
            e.dataTransfer.dropEffect = e.dataTransfer.types.includes('Files') ? 'copy' : 'move'
          }
        }}
        onDragLeave={() => {
          dragCounterRef.current--
          if (dragCounterRef.current <= 0) {
            dragCounterRef.current = 0
            setIsDragOver(false)
          }
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          dragCounterRef.current = 0
          setIsDragOver(false)

          // Handle file drops from OS
          if (e.dataTransfer.files.length > 0) {
            const paths = Array.from(e.dataTransfer.files).map((f) => f.path).filter(Boolean)
            if (paths.length > 0) {
              onFileDrop(paths, folder.guid)
              setExpanded(true)
              return
            }
          }

          const docsData = e.dataTransfer.getData('application/x-magnolia-docs')
          const docGuid = e.dataTransfer.getData('application/x-magnolia-doc-reorder')
          const docGuids: string[] = docsData ? JSON.parse(docsData) : docGuid ? [docGuid] : []
          if (docGuids.length > 0) {
            for (const g of docGuids) moveSourceToFolder(g, folder.guid)
            setExpanded(true)
            return
          }
          const folderGuid = e.dataTransfer.getData('application/x-magnolia-folder')
          if (folderGuid && folderGuid !== folder.guid) {
            moveFolderToFolder(folderGuid, folder.guid)
            setExpanded(true)
          }
        }}
        onClick={() => setExpanded(!expanded)}
        onContextMenu={(e) => onContextMenuFolder(e, folder.guid)}
      >
        <Icon icon={effectiveExpanded ? faChevronDown : faChevronRight} style={{ fontSize: 9, flexShrink: 0, width: 10, textAlign: 'center', opacity: 0.6 }} />
        <Icon icon={faFolder} style={{ fontSize: 11, flexShrink: 0, width: 14, textAlign: 'center', opacity: 0.75, color: 'var(--text-muted)' }} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {folder.name}
        </span>
      </div>
      {effectiveExpanded && (
        <>
          {childFolders.map((cf) => (
            <FolderItem
              key={cf.guid}
              folder={cf}
              allFolders={allFolders}
              sources={sources}
              sourceFolder={sourceFolder}
              selectedGuids={selectedGuids}
              viewedGuid={viewedGuid}
              depth={depth + 1}
              onSelectDocument={onSelectDocument}
              onViewDocument={onViewDocument}
              onContextMenuDoc={onContextMenuDoc}
              onContextMenuFolder={onContextMenuFolder}
              onRenameDoc={onRenameDoc}
              onFileDrop={onFileDrop}
              editingDocGuid={editingDocGuid}
              onStartEditingDoc={onStartEditingDoc}
              onStopEditingDoc={onStopEditingDoc}
              getTagsForDocument={getTagsForDocument}
              onTagDrop={onTagDrop}
              onReorderDoc={onReorderDoc}
              onViewSurveyChild={onViewSurveyChild}
              onContextMenuSurveyChild={onContextMenuSurveyChild}
              selectedSurveyEntities={selectedSurveyEntities}
              onToggleSurveyEntity={onToggleSurveyEntity}
              searchQuery={searchQuery}
            />
          ))}
          {childSources.map((source) =>
            source.sourceType === 'survey' ? (
              <SurveyItem
                key={source.guid}
                source={source}
                selectedGuids={selectedGuids}
                viewedGuid={viewedGuid}
                depth={depth + 1}
                editing={editingDocGuid === source.guid}
                onSelectDocument={onSelectDocument}
                onContextMenu={onContextMenuDoc}
                onRename={onRenameDoc}
                onStopEditing={onStopEditingDoc}
                onViewSurveyChild={onViewSurveyChild}
                onContextMenuSurveyChild={onContextMenuSurveyChild}
                selectedSurveyEntities={selectedSurveyEntities}
                onToggleSurveyEntity={onToggleSurveyEntity}
              />
            ) : (
              <DocItem
                key={source.guid}
                source={source}
                selectedGuids={selectedGuids}
                viewedGuid={viewedGuid}
                depth={depth + 1}
                editing={editingDocGuid === source.guid}
                onSelectDocument={onSelectDocument}
                onViewDocument={onViewDocument}
                onContextMenu={onContextMenuDoc}
                onRename={onRenameDoc}
                onStopEditing={onStopEditingDoc}
                getTagsForDocument={getTagsForDocument}
                onTagDrop={onTagDrop}
                onReorder={onReorderDoc}
              />
            )
          )}
        </>
      )}
    </div>
  )
}

function DocItem({
  source,
  selectedGuids,
  viewedGuid,
  depth,
  editing,
  onSelectDocument,
  onViewDocument,
  onContextMenu,
  onRename,
  onStopEditing,
  getTagsForDocument,
  onTagDrop,
  onReorder,

}: {
  source: TextSource
  selectedGuids: Set<string>
  viewedGuid: string | null
  depth: number
  editing: boolean
  onSelectDocument: (guid: string, e: React.MouseEvent) => void
  onViewDocument: (guid: string) => void
  onContextMenu: (e: React.MouseEvent, guid: string) => void
  onRename: (guid: string, name: string) => void
  onStopEditing: () => void
  getTagsForDocument: (guid: string) => { guid: string; name: string }[]
  onTagDrop: (tagGuids: string[], sourceGuid: string) => void
  onReorder: (draggedGuids: string[], siblingGuid: string, position: 'before' | 'after') => void

}) {
  const docTags = getTagsForDocument(source.guid)
  const isSelected = selectedGuids.has(source.guid)
  const isViewed = viewedGuid === source.guid
  const [editName, setEditName] = useState(source.name)
  const [isTagDragOver, setIsTagDragOver] = useState(false)
  const [dropPosition, setDropPosition] = useState<'before' | 'after' | null>(null)
  const tagDragCounter = useRef(0)
  const reorderDragCounter = useRef(0)
  const rowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (editing) setEditName(source.name)
  }, [editing, source.name])

  return (
    <div
      ref={rowRef}
      draggable={!editing}
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-magnolia-doc-reorder', source.guid)
        // Also include all selected guids for multi-drag
        const guids = selectedGuids.has(source.guid) && selectedGuids.size > 1
          ? Array.from(selectedGuids)
          : [source.guid]
        e.dataTransfer.setData('application/x-magnolia-docs', JSON.stringify(guids))
        // Relationship-map JSON payload. Names for multi-drag come from
        // the doc-store so each dragged doc lands with its real label.
        const allSources = useDocumentStore.getState().sources
        const nameByGuid = new Map(allSources.map((s) => [s.guid, s.name]))
        const sourceTypeByGuid = new Map(
          allSources.map((s) => [s.guid, (s as { sourceType?: string }).sourceType])
        )
        if (guids.length === 1) {
          e.dataTransfer.setData('application/json', JSON.stringify({
            kind: 'document',
            entityGuid: source.guid,
            label: source.name,
            sourceType: (source as { sourceType?: string }).sourceType
          }))
        } else {
          e.dataTransfer.setData('application/json', JSON.stringify({
            kind: 'multi',
            items: guids.map((g) => ({
              kind: 'document',
              entityGuid: g,
              label: nameByGuid.get(g) ?? 'Document',
              sourceType: sourceTypeByGuid.get(g)
            }))
          }))
        }
        e.dataTransfer.effectAllowed = 'move'

        // Custom drag ghost for multi-drag
        if (guids.length > 1) {
          const ghost = document.createElement('div')
          ghost.textContent = `${guids.length} documents`
          ghost.style.cssText = 'position:fixed;left:-9999px;top:0;padding:4px 10px;border-radius:4px;background:var(--accent,#4a9eff);color:#fff;font-size:12px;font-weight:600;white-space:nowrap;'
          document.body.appendChild(ghost)
          e.dataTransfer.setDragImage(ghost, 0, 0)
          requestAnimationFrame(() => document.body.removeChild(ghost))
        }
      }}
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes('application/x-magnolia-tag')) {
          e.preventDefault()
          tagDragCounter.current++
          setIsTagDragOver(true)
        }
        if (e.dataTransfer.types.includes('application/x-magnolia-doc-reorder')) {
          e.preventDefault()
          reorderDragCounter.current++
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-magnolia-tag')) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }
        if (e.dataTransfer.types.includes('application/x-magnolia-doc-reorder')) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          // Compute drop position based on mouse Y
          if (rowRef.current) {
            const rect = rowRef.current.getBoundingClientRect()
            const y = e.clientY - rect.top
            const ratio = y / rect.height
            setDropPosition(ratio < 0.5 ? 'before' : 'after')
          }
        }
      }}
      onDragLeave={(e) => {
        tagDragCounter.current--
        if (tagDragCounter.current <= 0) {
          tagDragCounter.current = 0
          setIsTagDragOver(false)
        }
        reorderDragCounter.current--
        if (reorderDragCounter.current <= 0) {
          reorderDragCounter.current = 0
          setDropPosition(null)
        }
      }}
      onDrop={(e) => {
        const tagData = e.dataTransfer.getData('application/x-magnolia-tag')
        if (tagData) {
          e.preventDefault()
          e.stopPropagation()
          tagDragCounter.current = 0
          setIsTagDragOver(false)
          const tagGuids = JSON.parse(tagData) as string[]
          onTagDrop(tagGuids, source.guid)
          return
        }
        const reorderData = e.dataTransfer.getData('application/x-magnolia-docs')
        const singleDoc = e.dataTransfer.getData('application/x-magnolia-doc-reorder')
        if (reorderData || singleDoc) {
          e.preventDefault()
          e.stopPropagation()
          reorderDragCounter.current = 0
          const pos = dropPosition || 'after'
          setDropPosition(null)
          const guids: string[] = reorderData ? JSON.parse(reorderData) : [singleDoc]
          // Don't drop on self
          if (guids.length === 1 && guids[0] === source.guid) return
          onReorder(guids, source.guid, pos)
        }
      }}
      style={{
        padding: '5px 8px',
        // When a document is inside a folder (depth > 0) bump the indent
        // by an extra 16 px so the doc icon sits under the folder name,
        // not aligned with the folder's chevron/icon column.
        paddingLeft: 8 + depth * 16 + (depth > 0 ? 16 : 0),
        cursor: 'pointer',
        borderRadius: 'var(--radius-sm)',
        background: isTagDragOver ? 'var(--accent)' : isSelected ? 'var(--selection-bg)' : 'transparent',
        color: isTagDragOver ? '#fff' : undefined,
        fontWeight: isViewed ? 700 : undefined,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        overflow: 'hidden',
        minWidth: 0,
        position: 'relative'
      }}
      onClick={(e) => {
        if (!editing) onSelectDocument(source.guid, e)
      }}
      onDoubleClick={() => {
        if (!editing) onViewDocument(source.guid)
      }}
      onContextMenu={(e) => onContextMenu(e, source.guid)}
    >
      {/* Drop position indicator line */}
      {dropPosition && (
        <div
          style={{
            position: 'absolute',
            left: 8 + depth * 16 + (depth > 0 ? 16 : 0),
            right: 8,
            height: 2,
            background: 'var(--accent)',
            borderRadius: 1,
            ...(dropPosition === 'before' ? { top: -1 } : { bottom: -1 }),
            pointerEvents: 'none',
            zIndex: 10
          }}
        />
      )}
      <Icon icon={iconForSource(source)} style={{ fontSize: 11, opacity: 0.75, flexShrink: 0, width: 14, textAlign: 'center', color: 'var(--text-muted)' }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {editing ? (
          <input
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={() => {
              if (editName.trim()) onRename(source.guid, editName.trim())
              onStopEditing()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (editName.trim()) onRename(source.guid, editName.trim())
                onStopEditing()
              } else if (e.key === 'Escape') {
                onStopEditing()
              }
            }}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            style={{ width: '100%', padding: '1px 4px', fontSize: 'var(--font-size-sm)' }}
          />
        ) : (
          <>
            <div
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: 'var(--font-size-sm)'
              }}
            >
              {source.name}
            </div>
            {docTags.length > 0 && (
              <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginTop: 2 }}>
                {docTags.map((tag) => (
                  <span
                    key={tag.guid}
                    style={{
                      fontSize: 10,
                      background: 'var(--bg-tertiary)',
                      borderRadius: 3,
                      padding: '1px 5px',
                      color: 'var(--text-secondary)'
                    }}
                  >
                    {tag.name}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Renders a survey source as a three-level tree:
 *
 *   ▾ 💬  Survey name           ← clicking this opens the summary view
 *     ▾  Respondents (N)
 *         · Respondent A         ← opens that respondent's projection
 *         · Respondent B
 *     ▾  Questions (M)
 *         · Q1 text
 *         · Q2 text
 *
 * Sub-item clicks all flow through `onViewSurveyChild` so the host
 * component (App.tsx) can route to the right tab + viewer. Stage 3
 * is just the visual tree; routing/rendering arrives in stage 4.
 */
function SurveyItem({
  source,
  viewedGuid,
  selectedGuids,
  depth,
  editing,
  onSelectDocument,
  onContextMenu,
  onRename,
  onStopEditing,
  onViewSurveyChild,
  onContextMenuSurveyChild,
  selectedSurveyEntities,
  onToggleSurveyEntity
}: {
  source: TextSource
  viewedGuid: string | null
  selectedGuids: Set<string>
  depth: number
  editing: boolean
  onSelectDocument: (guid: string, e: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent, guid: string) => void
  onRename: (guid: string, name: string) => void
  onStopEditing: () => void
  onViewSurveyChild: (
    surveyGuid: string,
    kind: 'summary' | 'respondent' | 'question',
    childId?: string
  ) => void
  onContextMenuSurveyChild: (
    e: React.MouseEvent,
    sourceGuid: string,
    kind: 'respondent' | 'question',
    id: string,
    label: string
  ) => void
  selectedSurveyEntities: Set<string>
  onToggleSurveyEntity: (sourceGuid: string, kind: 'respondent' | 'question', id: string) => void
}) {
  const [respondentsOpen, setRespondentsOpen] = useState(false)
  const [questionsOpen, setQuestionsOpen] = useState(false)
  // Inline rename state for the survey root row, mirroring DocItem so
  // the context-menu "Rename" action works on surveys too.
  const [editName, setEditName] = useState(source.name)
  useEffect(() => {
    if (editing) setEditName(source.name)
  }, [editing, source.name])
  // Which respondents are currently expanded to show their answer cells.
  // Keyed by respondent id (already unique within a survey). Collapsed
  // by default so the survey tree doesn't explode in row count — most
  // users want to drag a respondent / question, not individual cells,
  // so the cells are an opt-in drill-down.
  const [expandedRespondents, setExpandedRespondents] = useState<Set<string>>(new Set())
  const toggleRespondent = useCallback((id: string) => {
    setExpandedRespondents((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  // Which respondent/question row is currently a tag drop target (for
  // the drag-over highlight). Keyed by the leaf id.
  const [tagDropTargetId, setTagDropTargetId] = useState<string | null>(null)

  // Tags applied to this survey's respondents / questions, for the
  // chips rendered under each leaf row. Read straight from the store
  // (SurveyItem already taps stores directly).
  const allTags = useTagStore((s) => s.tags)

  // Accept a tag drag (application/x-magnolia-tag = JSON tag-guid[])
  // dropped onto a respondent / question row. If the row is part of the
  // current selection, the tag applies to the whole selection.
  const handleTagDropOnChild = (
    e: React.DragEvent,
    kind: 'respondent' | 'question',
    id: string
  ) => {
    const tagData = e.dataTransfer.getData('application/x-magnolia-tag')
    if (!tagData) return
    e.preventDefault()
    e.stopPropagation()
    setTagDropTargetId(null)
    const tagGuids = JSON.parse(tagData) as string[]
    applyTagDropToSelection(tagGuids, { kind, sourceGuid: source.guid, id })
  }

  /** Drag-over handlers for a leaf row — only react to tag drags. */
  const tagDropHandlers = (kind: 'respondent' | 'question', id: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes('application/x-magnolia-tag')) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy' as const
        setTagDropTargetId(id)
      }
    },
    onDragLeave: () => setTagDropTargetId((cur) => (cur === id ? null : cur)),
    onDrop: (e: React.DragEvent) => handleTagDropOnChild(e, kind, id)
  })
  const tagsForRespondent = (id: string) =>
    allTags.filter((t) =>
      (t.memberSurveyRespondents ?? []).some((m) => m.sourceGuid === source.guid && m.id === id)
    )
  const tagsForQuestion = (id: string) =>
    allTags.filter((t) =>
      (t.memberSurveyQuestions ?? []).some((m) => m.sourceGuid === source.guid && m.id === id)
    )

  const survey = (source.formatData as SurveyFormatData | undefined)?.survey
  const isSelected = selectedGuids.has(source.guid)
  const isViewed = viewedGuid === source.guid
  // Active sub-view (summary / respondent / question) for THIS
  // survey. Lets the leaf rows visually highlight the currently-
  // viewed respondent or question without needing extra props.
  const surveyView = useSurveyViewStore((s) => s.viewBySurveyGuid[source.guid])
  const activeMode = surveyView?.mode
  const activeChildId = surveyView?.childId
  // Scroll-target setter — used when a cell row is clicked so the
  // SurveyViewer scrolls the matching (respondentId, questionId)
  // cell into view alongside the standard "switch to respondent
  // view" navigation. Same mechanism the Relationship Map cell
  // double-click uses.
  const setScrollTarget = useSurveyViewStore((s) => s.setScrollTarget)
  // Highlight the survey root only when its summary view is active.
  // Sub-view modes light up the matching leaf instead.
  const rootIsActiveView = isViewed && (!surveyView || activeMode === 'summary')

  // Indentation rules mirror DocItem so survey roots align with peer
  // documents at the same depth. Children indent by 14 px per level
  // beneath the survey root.
  const baseIndent = 8 + depth * 16 + (depth > 0 ? 16 : 0)

  const rowStyle = (extraIndent: number, viewed: boolean): React.CSSProperties => ({
    padding: '4px 8px',
    paddingLeft: baseIndent + extraIndent,
    cursor: 'pointer',
    borderRadius: 'var(--radius-sm)',
    background: viewed ? 'var(--selection-bg)' : 'transparent',
    fontWeight: viewed ? 700 : undefined,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 'var(--font-size-sm)',
    overflow: 'hidden',
    minWidth: 0
  })

  const renderChips = (chipTags: typeof allTags) =>
    chipTags.length > 0 ? (
      <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginTop: 2 }}>
        {chipTags.map((tag) => (
          <span
            key={tag.guid}
            style={{
              fontSize: 10,
              background: 'var(--bg-tertiary)',
              borderRadius: 3,
              padding: '1px 5px',
              color: 'var(--text-secondary)'
            }}
          >
            {tag.value || tag.name}
          </span>
        ))}
      </div>
    ) : null

  return (
    <div>
      {/* Survey root row — draggable like a DocItem so users can drop
          it into a folder (or reorder it among sibling sources). The
          drag payload mirrors DocItem's so existing folder / root
          drop targets accept surveys unchanged. */}
      <div
        draggable={!editing}
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-magnolia-doc-reorder', source.guid)
          const guids = selectedGuids.has(source.guid) && selectedGuids.size > 1
            ? Array.from(selectedGuids)
            : [source.guid]
          e.dataTransfer.setData('application/x-magnolia-docs', JSON.stringify(guids))
          const allSources = useDocumentStore.getState().sources
          const nameByGuid = new Map(allSources.map((s) => [s.guid, s.name]))
          const sourceTypeByGuid = new Map(
            allSources.map((s) => [s.guid, (s as { sourceType?: string }).sourceType])
          )
          if (guids.length === 1) {
            e.dataTransfer.setData('application/json', JSON.stringify({
              kind: 'document',
              entityGuid: source.guid,
              label: source.name,
              // Pass the source's type along so consumers (e.g. the
              // Relationship Map) can pick a type-specific icon —
              // SURVEY_ICON for surveys, etc. — mirroring how the
              // Document Browser itself glyphs each source kind.
              sourceType: (source as { sourceType?: string }).sourceType
            }))
          } else {
            e.dataTransfer.setData('application/json', JSON.stringify({
              kind: 'multi',
              items: guids.map((g) => ({
                kind: 'document',
                entityGuid: g,
                label: nameByGuid.get(g) ?? 'Document',
                sourceType: sourceTypeByGuid.get(g)
              }))
            }))
          }
          e.dataTransfer.effectAllowed = 'move'
        }}
        style={{
          ...rowStyle(0, isSelected || rootIsActiveView),
          background: (isSelected || rootIsActiveView) ? 'var(--selection-bg)' : 'transparent'
        }}
        onClick={(e) => {
          if (editing) return
          onSelectDocument(source.guid, e)
          onViewSurveyChild(source.guid, 'summary')
        }}
        onContextMenu={(e) => onContextMenu(e, source.guid)}
      >
        {/* No chevron on the survey root — surveys are always
            expanded, so the survey icon aligns with peer DocItems
            at the same depth. */}
        <Icon icon={SURVEY_ICON} style={{ fontSize: 12, opacity: 0.85, flexShrink: 0, width: 14, color: 'var(--text-muted)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {editing ? (
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={() => {
                if (editName.trim()) onRename(source.guid, editName.trim())
                onStopEditing()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (editName.trim()) onRename(source.guid, editName.trim())
                  onStopEditing()
                } else if (e.key === 'Escape') {
                  onStopEditing()
                }
              }}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              style={{ width: '100%', padding: '1px 4px', fontSize: 'var(--font-size-sm)' }}
            />
          ) : (
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {source.name}
            </div>
          )}
        </div>
      </div>

      {survey && (
        <>
          {/* Respondents category. Draggable onto an analysis tool's
              "Group by" box to cluster the survey's results by
              respondent (the RESPONDENTS_GROUP_MIME marker is all the
              Group By drop handler needs). */}
          <div
            style={rowStyle(20, false)}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'copy'
              e.dataTransfer.setData(RESPONDENTS_GROUP_MIME, '1')
              e.dataTransfer.setData('text/plain', 'Respondents')
            }}
            onClick={() => setRespondentsOpen(!respondentsOpen)}
            title="Drag onto an analysis tool's Group by box to group results by respondent"
          >
            <span style={{ width: 12, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
              <Icon icon={respondentsOpen ? faChevronDown : faChevronRight} style={{ fontSize: 9, color: 'var(--text-muted)' }} />
            </span>
            <span style={{ flex: 1, color: 'var(--text-secondary)', fontWeight: 500 }}>
              Respondents
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              {survey.respondents.length}
            </span>
          </div>
          {respondentsOpen && survey.respondents.map((r) => {
            const active = isViewed && activeMode === 'respondent' && activeChildId === r.id
            const selected = selectedSurveyEntities.has(surveyEntityKey('resp', source.guid, r.id))
            const isExpanded = expandedRespondents.has(r.id)
            // Build the per-respondent cell list eagerly so we know
            // whether to show the chevron (no cells → no chevron). A
            // cell is one (respondent, question) pair where the
            // respondent gave a non-empty answer; buildCellText
            // normalises single-string vs multi-select answers down
            // to a single text snippet.
            const cells = survey.questions
              .map((q, qIdx) => {
                const text = buildCellText(r.answers[q.id])
                if (!text) return null
                return { q, qIdx, text }
              })
              .filter((c): c is { q: typeof survey.questions[number]; qIdx: number; text: string } => c !== null)
            return (
              <div key={r.id}>
                <div
                  draggable
                  onDragStart={(e) => {
                    // Payload format matches what the Relationship Map's
                    // drop handler reads (application/json with kind +
                    // surveyGuid + entityGuid).
                    e.dataTransfer.setData('application/json', JSON.stringify({
                      kind: 'survey-respondent',
                      entityGuid: r.id,
                      label: r.displayName,
                      surveyGuid: source.guid
                    }))
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                  style={{
                    ...rowStyle(40, active || selected),
                    ...(tagDropTargetId === r.id ? { background: 'var(--accent)', color: '#fff' } : {})
                  }}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (e.metaKey || e.ctrlKey || e.altKey) onToggleSurveyEntity(source.guid, 'respondent', r.id)
                    else onViewSurveyChild(source.guid, 'respondent', r.id)
                  }}
                  onContextMenu={(e) => onContextMenuSurveyChild(e, source.guid, 'respondent', r.id, r.displayName)}
                  {...tagDropHandlers('respondent', r.id)}
                  title={r.rawRespondentId ? `RespondentID: ${r.rawRespondentId}` : undefined}
                >
                  {/* Chevron — clicking it expands/collapses the cells
                      list. Stop propagation so the click doesn't fall
                      through to the row's onClick (which would switch
                      the survey view). When the respondent has no
                      answers, render an empty 12 px spacer instead so
                      the indentation still lines up with neighbours. */}
                  {cells.length > 0 ? (
                    <span
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleRespondent(r.id)
                      }}
                      style={{ width: 12, display: 'inline-flex', justifyContent: 'center', flexShrink: 0, cursor: 'pointer' }}
                    >
                      <Icon icon={isExpanded ? faChevronDown : faChevronRight} style={{ fontSize: 9, color: 'var(--text-muted)' }} />
                    </span>
                  ) : (
                    <span style={{ width: 12, flexShrink: 0 }} />
                  )}
                  <Icon icon={SURVEY_RESPONDENT_ICON} style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0, width: 12 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)' }}>
                      {r.displayName}
                    </div>
                    {renderChips(tagsForRespondent(r.id))}
                  </div>
                </div>
                {/* Cell rows — one per non-empty answer. Each is its
                    own draggable source carrying a survey-cell payload
                    (entityGuid = respondent id, questionId identifies
                    the question, snippet carries the answer text).
                    Indented at 60 px to sit below the respondent. */}
                {isExpanded && cells.map(({ q, qIdx, text }) => {
                  const truncated = text.length > 80 ? text.slice(0, 80) + '…' : text
                  return (
                    <div
                      key={`${r.id}:${q.id}`}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('application/json', JSON.stringify({
                          kind: 'survey-cell',
                          entityGuid: r.id,
                          questionId: q.id,
                          questionLabel: q.text,
                          label: r.displayName,
                          snippet: text,
                          surveyGuid: source.guid,
                          sourceGuid: source.guid
                        }))
                        e.dataTransfer.effectAllowed = 'copy'
                      }}
                      onClick={(e) => {
                        // Open the survey on the respondent's answers
                        // view, then set a scrollTarget so the
                        // SurveyViewer scrolls the specific cell into
                        // place under the sticky header. Same hook
                        // the Relationship Map's cell double-click
                        // uses — single behaviour, two entry points.
                        e.stopPropagation()
                        onViewSurveyChild(source.guid, 'respondent', r.id)
                        setScrollTarget({
                          surveyGuid: source.guid,
                          respondentId: r.id,
                          questionId: q.id
                        })
                      }}
                      style={{ ...rowStyle(60, false), cursor: 'pointer' }}
                      title={`${q.text}\n\n${text}`}
                    >
                      <span style={{ flexShrink: 0, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', marginRight: 4, minWidth: 14, fontSize: 10 }}>
                        {qIdx + 1}
                      </span>
                      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)', fontSize: 11 }}>
                        {truncated}
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })}

          {/* Questions category */}
          <div
            style={rowStyle(20, false)}
            onClick={() => setQuestionsOpen(!questionsOpen)}
          >
            <span style={{ width: 12, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
              <Icon icon={questionsOpen ? faChevronDown : faChevronRight} style={{ fontSize: 9, color: 'var(--text-muted)' }} />
            </span>
            <span style={{ flex: 1, color: 'var(--text-secondary)', fontWeight: 500 }}>
              Questions
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              {survey.questions.length}
            </span>
          </div>
          {questionsOpen && survey.questions.map((q, i) => {
            const active = isViewed && activeMode === 'question' && activeChildId === q.id
            const selected = selectedSurveyEntities.has(surveyEntityKey('quest', source.guid, q.id))
            return (
              <div
                key={q.id}
                draggable
                onDragStart={(e) => {
                  // application/json payload mirrors the Relationship
                  // Map sidebar's question drag source, so dropping a
                  // question from the Document Browser onto the map
                  // creates a survey-question node identically.
                  e.dataTransfer.setData('application/json', JSON.stringify({
                    kind: 'survey-question',
                    entityGuid: q.id,
                    label: q.text,
                    surveyGuid: source.guid
                  }))
                  e.dataTransfer.effectAllowed = 'copy'
                }}
                style={{
                  ...rowStyle(40, active || selected),
                  ...(tagDropTargetId === q.id ? { background: 'var(--accent)', color: '#fff' } : {})
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  if (e.metaKey || e.ctrlKey || e.altKey) onToggleSurveyEntity(source.guid, 'question', q.id)
                  else onViewSurveyChild(source.guid, 'question', q.id)
                }}
                onContextMenu={(e) => onContextMenuSurveyChild(e, source.guid, 'question', q.id, q.text)}
                {...tagDropHandlers('question', q.id)}
                title={q.text}
              >
                <span style={{ width: 12, flexShrink: 0 }} />
                <Icon icon={SURVEY_QUESTION_ICON} style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0, width: 12 }} />
                <span style={{ flexShrink: 0, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', marginRight: 2, minWidth: 14 }}>
                  {i + 1}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)' }}>
                    {q.text}
                  </div>
                  {renderChips(tagsForQuestion(q.id))}
                </div>
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}

function TagItem({
  tag,
  depth,
  isSelected,
  selectedTagGuids,
  onClick,
  onDoubleClick,
  onContextMenu
}: {
  tag: import('../../models/types').QDASet
  depth: number
  isSelected?: boolean
  selectedTagGuids?: Set<string>
  onClick?: (e: React.MouseEvent) => void
  onDoubleClick?: (e: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        // If this tag is selected and there are other selected tags, drag them all
        const guids = isSelected && selectedTagGuids && selectedTagGuids.size > 1
          ? Array.from(selectedTagGuids)
          : [tag.guid]
        e.dataTransfer.setData('application/x-magnolia-tag', JSON.stringify(guids))
        // Relationship-map JSON payload.
        const tags = useTagStore.getState().tags
        const nameByGuid = new Map(tags.map((t) => [t.guid, t.value || t.name]))
        if (guids.length === 1) {
          e.dataTransfer.setData('application/json', JSON.stringify({
            kind: 'tag',
            entityGuid: tag.guid,
            label: tag.value || tag.name
          }))
        } else {
          e.dataTransfer.setData('application/json', JSON.stringify({
            kind: 'multi',
            items: guids.map((g) => ({ kind: 'tag', entityGuid: g, label: nameByGuid.get(g) ?? 'Tag' }))
          }))
        }
        e.dataTransfer.effectAllowed = 'copy'
      }}
      style={{
        padding: '3px 8px',
        paddingLeft: 8 + depth * 16,
        fontSize: 'var(--font-size-sm)',
        cursor: 'pointer',
        borderRadius: 'var(--radius-sm)',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        background: isSelected ? 'var(--selection-bg)' : undefined
      }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <span style={{ width: 12 }} />
      <span style={{
        flex: 1,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: isSelected ? 'var(--text-primary)' : 'var(--text-primary)'
      }}>
        {tag.value || tag.name}
      </span>
      <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
        {tag.memberSourceGuids.length}
      </span>
    </div>
  )
}

function TagCategoryItem({
  category,
  tags,
  selectedTagGuids,
  onTagClick,
  onTagDoubleClick,
  onContextMenu,
  dimmed,
  forceExpanded
}: {
  category: import('../../models/types').TagCategory
  tags: import('../../models/types').QDASet[]
  selectedTagGuids: Set<string>
  onTagClick: (tagGuid: string, e: React.MouseEvent) => void
  onTagDoubleClick?: (tagGuid: string, e: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent, tagGuid: string) => void
  /** True while a search is active and this category is shown only as
   *  ancestor context (its own name didn't match, one of its tags did). */
  dimmed?: boolean
  /** Force the category open regardless of its own collapse state, so a
   *  search match stays visible under a manually-collapsed category. */
  forceExpanded?: boolean
}) {
  const [expanded, setExpanded] = useState(true)
  const effectiveExpanded = expanded || !!forceExpanded

  return (
    <div>
      <div
        draggable
        onDragStart={(e) => {
          // Drag all tags in this category
          e.dataTransfer.setData('application/x-magnolia-tag', JSON.stringify(tags.map((t) => t.guid)))
          // Category-aware payload: drop targets that understand grouping
          // (e.g. Results in Documents) read this to nest the tags under
          // their parent category in the results grid. Targets that don't
          // understand it just see the bundled tag guids above and behave
          // as before.
          e.dataTransfer.setData('application/x-magnolia-category', JSON.stringify({
            categoryGuid: category.guid,
            name: category.name,
            tagGuids: tags.map((t) => t.guid)
          }))
          // Relationship-map JSON payload — whole category as a single node.
          e.dataTransfer.setData('application/json', JSON.stringify({
            kind: 'tag-category',
            entityGuid: category.guid,
            label: category.name
          }))
          e.dataTransfer.effectAllowed = 'copy'
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 8px',
          paddingLeft: 24,
          cursor: 'pointer',
          fontSize: 'var(--font-size-sm)',
          fontWeight: 600,
          color: 'var(--text-secondary)',
          opacity: dimmed ? 0.45 : 1
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <Icon icon={effectiveExpanded ? faChevronDown : faChevronRight} style={{ fontSize: 9, width: 12, textAlign: 'center', opacity: 0.6 }} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {category.name}
        </span>
      </div>
      {effectiveExpanded && tags.map((tag) => (
        <TagItem
          key={tag.guid}
          tag={tag}
          depth={2}
          isSelected={selectedTagGuids.has(tag.guid)}
          selectedTagGuids={selectedTagGuids}
          onClick={(e) => onTagClick(tag.guid, e)}
          onDoubleClick={onTagDoubleClick ? (e) => onTagDoubleClick(tag.guid, e) : undefined}
          onContextMenu={(e) => onContextMenu(e, tag.guid)}
        />
      ))}
    </div>
  )
}

/**
 * Apply Document Tags — shown per-document to toggle tag assignments.
 * Each category section is collapsible and the body scrolls to prevent overflow.
 */
/** What the Apply-Tags dialog is acting on. A whole document/survey is
 *  identified by its sourceGuid; a survey respondent/question also needs
 *  its sub-entity id (and a label for the dialog heading). */
type TagDialogTarget =
  | { kind: 'document'; sourceGuid: string }
  | { kind: 'respondent'; sourceGuid: string; id: string; label: string }
  | { kind: 'question'; sourceGuid: string; id: string; label: string }

function ApplyDocumentTagsDialog({
  title,
  tags,
  categories,
  isAssigned,
  onAssign,
  onRemove,
  createTag,
  onOpenManage,
  onClose
}: {
  /** Full dialog heading, e.g. "Edit Tags". */
  title: string
  tags: import('../../models/types').QDASet[]
  categories: TagCategory[]
  isAssigned: (tag: import('../../models/types').QDASet) => boolean
  onAssign: (tagGuid: string) => void
  onRemove: (tagGuid: string) => void
  createTag: (name: string, categoryGuid?: string, value?: string) => string
  onOpenManage: () => void
  onClose: () => void
}) {
  // Collapse all sections by default
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => {
    const all = new Set<string>()
    all.add('__general')
    for (const cat of categories) all.add(cat.guid)
    return all
  })

  const toggleSection = (key: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const uncategorised = sortTagsForCategory(tags.filter((t) => !t.categoryGuid), undefined)

  const renderTagCheckbox = (tag: import('../../models/types').QDASet, label: string) => {
    const assigned = isAssigned(tag)
    return (
      <label
        key={tag.guid}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', cursor: 'pointer' }}
      >
        <input
          type="checkbox"
          checked={assigned}
          onChange={() => assigned ? onRemove(tag.guid) : onAssign(tag.guid)}
        />
        {label}
      </label>
    )
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ minWidth: 420, maxWidth: 500 }}>
        <h2>{title}</h2>
        <div style={{ maxHeight: '50vh', overflowY: 'auto', marginBottom: 8 }}>
          {/* General (uncategorised) */}
          {uncategorised.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div
                onClick={() => toggleSection('__general')}
                style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 4, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, userSelect: 'none' }}
              >
                <Icon icon={collapsedSections.has('__general') ? faChevronRight : faChevronDown} style={{ fontSize: 8 }} />
                General
              </div>
              {!collapsedSections.has('__general') && uncategorised.map((tag) => renderTagCheckbox(tag, tag.name))}
            </div>
          )}

          {/* Categories */}
          {categories.map((cat) => {
            const catTags = sortTagsForCategory(tags.filter((t) => t.categoryGuid === cat.guid), cat)
            const isCollapsed = collapsedSections.has(cat.guid)

            return (
              <div key={cat.guid} style={{ marginBottom: 8 }}>
                <div
                  onClick={() => toggleSection(cat.guid)}
                  style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 4, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, userSelect: 'none' }}
                >
                  <Icon icon={isCollapsed ? faChevronRight : faChevronDown} style={{ fontSize: 8 }} />
                  {cat.name}
                  <span style={{ fontSize: 10, opacity: 0.6 }}>({cat.type})</span>
                </div>

                {!isCollapsed && cat.type === 'text' && (
                  <>
                    {catTags.map((tag) => renderTagCheckbox(tag, tag.value || tag.name))}
                    <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                      <input
                        type="text"
                        placeholder={`Add ${cat.name} value...`}
                        style={{ flex: 1, fontSize: 11 }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const val = (e.target as HTMLInputElement).value.trim()
                            if (val) {
                              const newGuid = createTag(`${cat.name}:${val}`, cat.guid, val)
                              onAssign(newGuid)
                              ;(e.target as HTMLInputElement).value = ''
                            }
                          }
                        }}
                      />
                    </div>
                  </>
                )}

                {!isCollapsed && cat.type === 'date' && (
                  <>
                    {catTags.map((tag) => renderTagCheckbox(tag, tag.value || tag.name))}
                    <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                      <input
                        type="text"
                        placeholder="dd/mm/yyyy, mm/yyyy, yyyy, etc."
                        style={{ flex: 1, fontSize: 11 }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const val = (e.target as HTMLInputElement).value.trim()
                            if (val && !catTags.some((t) => t.value === val)) {
                              const newGuid = createTag(`${cat.name}:${val}`, cat.guid, val)
                              onAssign(newGuid)
                              ;(e.target as HTMLInputElement).value = ''
                            }
                          }
                        }}
                      />
                    </div>
                  </>
                )}

                {!isCollapsed && cat.type === 'numeric' && (
                  <>
                    {catTags.map((tag) => renderTagCheckbox(tag, tag.value || tag.name))}
                    <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                      <input
                        type="number"
                        placeholder={`Add ${cat.name} value...`}
                        style={{ flex: 1, fontSize: 11 }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const val = (e.target as HTMLInputElement).value.trim()
                            if (val && !isNaN(parseFloat(val)) && !catTags.some((t) => t.value === val)) {
                              const newGuid = createTag(`${cat.name}:${val}`, cat.guid, val)
                              onAssign(newGuid)
                              ;(e.target as HTMLInputElement).value = ''
                            }
                          }
                        }}
                      />
                    </div>
                  </>
                )}

                {!isCollapsed && cat.type === 'list' && (
                  <div style={{ maxHeight: 150, overflowY: 'auto', paddingRight: 4 }}>
                    {sortListOptions(cat.listOptions).map((opt) => {
                      const tag = catTags.find((t) => t.value === opt)
                      const assigned = tag ? isAssigned(tag) : false
                      return (
                        <label
                          key={opt}
                          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', cursor: 'pointer' }}
                        >
                          <input
                            type="checkbox"
                            checked={assigned}
                            onChange={() => {
                              if (tag) {
                                if (assigned) onRemove(tag.guid)
                                else onAssign(tag.guid)
                              } else {
                                const newGuid = createTag(`${cat.name}:${opt}`, cat.guid, opt)
                                onAssign(newGuid)
                              }
                            }}
                          />
                          {opt}
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}

          {tags.length === 0 && categories.length === 0 && (
            <div className="empty-state" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              No tags yet. Use Documents &gt; Manage Document Tags to create categories and tags.
            </div>
          )}
        </div>

        <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
          <button className="secondary" onClick={onOpenManage}>
            Manage Document Tags...
          </button>
          <button onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}

/**
 * Manage Document Tags — create/delete/rename categories and tags.
 * Accessible from Documents menu, toolbar and from Apply Document Tags.
 *
 * Layout: an accordion of categories (each expandable to show its tags),
 * followed by a General (uncategorised) section, then an "Add Category" form.
 */
function ManageDocumentTagsDialog({
  categories,
  tags,
  createCategory,
  deleteCategory,
  renameCategory,
  createTag,
  deleteTag,
  renameTag,
  updateCategoryListOptions,
  onClose
}: {
  categories: TagCategory[]
  tags: import('../../models/types').QDASet[]
  createCategory: (name: string, type: TagCategoryType, listOptions?: string[]) => string
  deleteCategory: (guid: string) => void
  renameCategory: (guid: string, name: string) => void
  createTag: (name: string, categoryGuid?: string, value?: string) => string
  deleteTag: (guid: string) => void
  renameTag: (guid: string, name: string) => void
  updateCategoryListOptions: (guid: string, options: string[]) => void
  onClose: () => void
}) {
  // Accordion state — which sections are expanded
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    // Expand all by default so the user can immediately see everything
    const all = new Set<string>()
    for (const c of categories) all.add(c.guid)
    if (tags.some((t) => !t.categoryGuid)) all.add('__general')
    return all
  })

  // Sort-on-mount-only behaviour. We snapshot the sorted guid order per
  // category once when the dialog opens and reuse it for the lifetime
  // of the dialog so live edits (rename, add, delete) don't shuffle the
  // list under the user's cursor. New tags appended in this session
  // show up at the bottom of their category; the next time the user
  // re-opens the dialog, the snapshot is rebuilt and everything sorts
  // freshly.
  const initialOrderRef = useRef<Map<string, string[]> | null>(null)
  if (initialOrderRef.current === null) {
    const m = new Map<string, string[]>()
    for (const c of categories) {
      const ts = tags.filter((t) => t.categoryGuid === c.guid)
      m.set(c.guid, sortTagsForCategory(ts, c).map((t) => t.guid))
    }
    m.set('__general', sortTagsForCategory(tags.filter((t) => !t.categoryGuid), undefined).map((t) => t.guid))
    initialOrderRef.current = m
  }
  const orderTagsByInitial = (catTags: import('../../models/types').QDASet[], key: string): import('../../models/types').QDASet[] => {
    const order = initialOrderRef.current?.get(key) ?? []
    const used = new Set<string>()
    const ordered: import('../../models/types').QDASet[] = []
    for (const guid of order) {
      const t = catTags.find((x) => x.guid === guid)
      if (t) { ordered.push(t); used.add(guid) }
    }
    for (const t of catTags) if (!used.has(t.guid)) ordered.push(t)
    return ordered
  }
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })

  // Inline rename state
  const [renamingCat, setRenamingCat] = useState<string | null>(null)
  const [renameCatVal, setRenameCatVal] = useState('')
  const [renamingTag, setRenamingTag] = useState<string | null>(null)
  const [renameTagVal, setRenameTagVal] = useState('')

  // Inline "add value" state per category
  const [addValueText, setAddValueText] = useState<Record<string, string>>({})

  // New-category form
  const [newCatName, setNewCatName] = useState('')
  const [newCatType, setNewCatType] = useState<TagCategoryType>('text')
  const [newListOpts, setNewListOpts] = useState('')

  // Edit list options sub-dialog
  const [editingListCat, setEditingListCat] = useState<string | null>(null)
  const [editListOpts, setEditListOpts] = useState('')

  // New uncategorised tag
  const [newTagName, setNewTagName] = useState('')

  const sectionHeaderStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '7px 8px',
    cursor: 'pointer',
    userSelect: 'none',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--bg-secondary)',
    marginBottom: 1
  }

  const tagRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 8px 4px 28px',
    fontSize: 'var(--font-size-sm)'
  }

  const typeLabel = (t: string) => (
    <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--bg-tertiary)', padding: '1px 6px', borderRadius: 3, flexShrink: 0 }}>
      {t}
    </span>
  )

  const deleteX = (onClick: () => void) => (
    <span
      role="button"
      title="Delete"
      onClick={(e) => { e.stopPropagation(); onClick() }}
      style={{
        cursor: 'pointer',
        color: 'var(--text-muted)',
        fontSize: 14,
        lineHeight: 1,
        padding: '0 2px',
        flexShrink: 0,
        fontWeight: 400
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--danger)' }}
      onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)' }}
    >
      <Icon icon={faXmark} />
    </span>
  )

  /** Render an individual tag row */
  const renderTagRow = (tag: import('../../models/types').QDASet) => {
    const label = tag.value || tag.name
    const isRenaming = renamingTag === tag.guid
    return (
      <div key={tag.guid} style={tagRowStyle}>
        {isRenaming ? (
          <input
            autoFocus
            type="text"
            value={renameTagVal}
            onChange={(e) => setRenameTagVal(e.target.value)}
            onBlur={() => {
              if (renameTagVal.trim() && renameTagVal.trim() !== label) {
                renameTag(tag.guid, renameTagVal.trim())
              }
              setRenamingTag(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              else if (e.key === 'Escape') setRenamingTag(null)
            }}
            style={{ flex: 1, fontSize: 'var(--font-size-sm)' }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'text' }}
            onClick={(e) => { e.stopPropagation(); setRenamingTag(tag.guid); setRenameTagVal(label) }}
          >
            {label}
          </span>
        )}
        <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
          {tag.memberSourceGuids.length} doc{tag.memberSourceGuids.length !== 1 ? 's' : ''}
        </span>
        {deleteX(() => deleteTag(tag.guid))}
      </div>
    )
  }

  /** Render the inline "add value" input for a category */
  const renderAddValue = (cat: TagCategory) => {
    const val = addValueText[cat.guid] || ''
    const isDate = cat.type === 'date'
    const isNumeric = cat.type === 'numeric'
    const placeholder = isDate
      ? 'Add value (dd/mm/yyyy, yyyy, etc.)...'
      : isNumeric
        ? `Add ${cat.name} value...`
        : `Add ${cat.name} value...`
    return (
      <div style={{ ...tagRowStyle, gap: 4 }}>
        <input
          type={isNumeric ? 'number' : 'text'}
          placeholder={placeholder}
          value={val}
          onChange={(e) => setAddValueText((p) => ({ ...p, [cat.guid]: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const v = val.trim()
              if (!v) return
              if (isNumeric && isNaN(parseFloat(v))) return
              createTag(`${cat.name}:${v}`, cat.guid, v)
              setAddValueText((p) => ({ ...p, [cat.guid]: '' }))
            }
          }}
          style={{ flex: 1, fontSize: 11 }}
        />
        <button
          style={{ padding: '2px 8px', fontSize: 11 }}
          onClick={() => {
            const v = val.trim()
            if (!v) return
            if (isNumeric && isNaN(parseFloat(v))) return
            createTag(`${cat.name}:${v}`, cat.guid, v)
            setAddValueText((p) => ({ ...p, [cat.guid]: '' }))
          }}
        >
          Add
        </button>
      </div>
    )
  }

  const uncategorised = orderTagsByInitial(tags.filter((t) => !t.categoryGuid), '__general')

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 520, maxWidth: '90vw' }}>
        <h2>Manage Document Tags</h2>

        <div style={{ maxHeight: '60vh', overflowY: 'auto', marginBottom: 10 }}>
          {/* ── Category sections ── */}
          {categories.map((cat) => {
            const catTags = orderTagsByInitial(tags.filter((t) => t.categoryGuid === cat.guid), cat.guid)
            const isOpen = expanded.has(cat.guid)
            const isRenamingCat = renamingCat === cat.guid

            return (
              <div key={cat.guid} style={{ marginBottom: 2 }}>
                {/* Header row */}
                <div style={sectionHeaderStyle} onClick={() => toggle(cat.guid)}>
                  <Icon
                    icon={isOpen ? faChevronDown : faChevronRight}
                    style={{ fontSize: 9, color: 'var(--text-muted)', width: 10, textAlign: 'center' }}
                  />
                  {isRenamingCat ? (
                    <input
                      autoFocus
                      type="text"
                      value={renameCatVal}
                      onChange={(e) => setRenameCatVal(e.target.value)}
                      onBlur={() => {
                        if (renameCatVal.trim() && renameCatVal.trim() !== cat.name) {
                          renameCategory(cat.guid, renameCatVal.trim())
                        }
                        setRenamingCat(null)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                        else if (e.key === 'Escape') setRenamingCat(null)
                      }}
                      style={{ flex: 1, fontSize: 'var(--font-size-sm)', fontWeight: 600 }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span
                      style={{ flex: 1, fontSize: 'var(--font-size-sm)', fontWeight: 600, cursor: 'text' }}
                      onClick={(e) => { e.stopPropagation(); setRenamingCat(cat.guid); setRenameCatVal(cat.name) }}
                    >
                      {cat.name}
                    </span>
                  )}
                  {typeLabel(cat.type)}
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                    {catTags.length} value{catTags.length !== 1 ? 's' : ''}
                  </span>
                  {cat.type === 'list' && (
                    <button
                      className="secondary"
                      style={{ padding: '1px 6px', fontSize: 10, flexShrink: 0 }}
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditingListCat(cat.guid)
                        setEditListOpts((cat.listOptions || []).join('\n'))
                      }}
                    >
                      Edit Options
                    </button>
                  )}
                  {deleteX(() => deleteCategory(cat.guid))}
                </div>

                {/* Expanded: tag list + add input */}
                {isOpen && (
                  <div style={{ marginBottom: 4 }}>
                    {catTags.length === 0 && (
                      <div style={{ ...tagRowStyle, color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 11 }}>
                        No values yet — add one below.
                      </div>
                    )}
                    {catTags.map(renderTagRow)}
                    {cat.type !== 'list' && renderAddValue(cat)}
                  </div>
                )}
              </div>
            )
          })}

          {/* ── General (uncategorised) section ── */}
          {(uncategorised.length > 0 || categories.length === 0) && (
            <div style={{ marginBottom: 2 }}>
              <div style={sectionHeaderStyle} onClick={() => toggle('__general')}>
                <Icon
                  icon={expanded.has('__general') ? faChevronDown : faChevronRight}
                  style={{ fontSize: 9, color: 'var(--text-muted)', width: 10, textAlign: 'center' }}
                />
                <span style={{ flex: 1, fontSize: 'var(--font-size-sm)', fontWeight: 600 }}>
                  General
                </span>
                {typeLabel('uncategorised')}
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  {uncategorised.length} tag{uncategorised.length !== 1 ? 's' : ''}
                </span>
              </div>
              {expanded.has('__general') && (
                <div style={{ marginBottom: 4 }}>
                  {uncategorised.length === 0 && (
                    <div className="empty-state" style={{ ...tagRowStyle, color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 11 }}>
                      No tags yet — add one below.
                    </div>
                  )}
                  {uncategorised.map(renderTagRow)}
                  <div style={{ ...tagRowStyle, gap: 4 }}>
                    <input
                      type="text"
                      value={newTagName}
                      onChange={(e) => setNewTagName(e.target.value)}
                      placeholder="Add tag..."
                      style={{ flex: 1, fontSize: 11 }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && newTagName.trim()) {
                          createTag(newTagName.trim())
                          setNewTagName('')
                        }
                      }}
                    />
                    <button
                      style={{ padding: '2px 8px', fontSize: 11 }}
                      onClick={() => {
                        if (newTagName.trim()) {
                          createTag(newTagName.trim())
                          setNewTagName('')
                        }
                      }}
                    >
                      Add
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Empty state ── */}
          {categories.length === 0 && uncategorised.length === 0 && (
            <div className="empty-state" style={{ color: 'var(--text-muted)', fontSize: 12, padding: '12px 8px', textAlign: 'center' }}>
              No tags or categories yet. Create a category below to get started.
            </div>
          )}
        </div>

        {/* ── Add Category ── */}
        <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 6 }}>
            Add Category
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <input
              type="text"
              value={newCatName}
              onChange={(e) => setNewCatName(e.target.value)}
              placeholder="Category name (e.g. Country)..."
              style={{ flex: 1 }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newCatName.trim()) {
                  const opts = newCatType === 'list'
                    ? newListOpts.split(',').map((s) => s.trim()).filter(Boolean)
                    : undefined
                  const guid = createCategory(newCatName.trim(), newCatType, opts)
                  setExpanded((prev) => new Set(prev).add(guid))
                  setNewCatName('')
                  setNewListOpts('')
                  setNewCatType('text')
                }
              }}
            />
            <select
              value={newCatType}
              onChange={(e) => setNewCatType(e.target.value as TagCategoryType)}
              style={{ width: 90 }}
            >
              <option value="text">Text</option>
              <option value="date">Date</option>
              <option value="numeric">Numeric</option>
              <option value="list">List</option>
            </select>
            <button
              onClick={() => {
                if (newCatName.trim()) {
                  const opts = newCatType === 'list'
                    ? newListOpts.split(',').map((s) => s.trim()).filter(Boolean)
                    : undefined
                  const guid = createCategory(newCatName.trim(), newCatType, opts)
                  setExpanded((prev) => new Set(prev).add(guid))
                  setNewCatName('')
                  setNewListOpts('')
                  setNewCatType('text')
                }
              }}
            >
              Add
            </button>
          </div>
          {newCatType === 'list' && (
            <input
              type="text"
              value={newListOpts}
              onChange={(e) => setNewListOpts(e.target.value)}
              placeholder="Options (comma-separated, e.g. Australia, Netherlands)"
              style={{ width: '100%', fontSize: 11, marginBottom: 4 }}
            />
          )}
        </div>

        <div className="modal-actions">
          <button onClick={onClose}>Done</button>
        </div>

        {/* ── Edit list options sub-dialog ── */}
        {editingListCat && (
          <div
            className="modal-overlay"
            onClick={() => setEditingListCat(null)}
            style={{ position: 'fixed' }}
          >
            <div className="modal" onClick={(e) => e.stopPropagation()} style={{ minWidth: 350 }}>
              <h2>Edit List Options</h2>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                One option per line:
              </div>
              <textarea
                value={editListOpts}
                onChange={(e) => setEditListOpts(e.target.value)}
                rows={8}
                style={{
                  width: '100%',
                  fontFamily: 'var(--font-family)',
                  fontSize: 'var(--font-size-sm)',
                  background: 'var(--bg-tertiary)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-sm)',
                  padding: 8,
                  resize: 'vertical'
                }}
              />
              <div className="modal-actions">
                <button className="secondary" onClick={() => setEditingListCat(null)}>
                  Cancel
                </button>
                <button
                  onClick={() => {
                    const opts = editListOpts.split('\n').map((s) => s.trim()).filter(Boolean)
                    updateCategoryListOptions(editingListCat, opts)
                    setEditingListCat(null)
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export function DocumentBrowser({ onImport, onSurveyImport, showManageDocTags, onCloseManageDocTags, onClose, onPopOut, isPoppedOut }: Props) {
  // Enforced checkout lock: reading/browsing documents stays live no
  // matter who holds the lock. The mutating controls below (new folder,
  // drop-to-import, rename/delete/move via context menu) stay clickable —
  // clicking one while locked intercepts the action and opens the same
  // Take Over / Create a Copy / Cancel dialog CheckoutConflictDialog
  // already shows at open time, rather than performing the mutation or
  // silently doing nothing.
  const lockedBy = useCheckoutLockedBy()
  const promptCheckoutLocked = () => useProjectStore.getState().promptCheckoutConflict()
  const sources = useDocumentStore((s) => s.sources)
  const selectedGuids = useDocumentStore((s) => s.selectedDocumentGuids)
  const selectedSurveyEntities = useDocumentStore((s) => s.selectedSurveyEntities)
  const viewedGuid = useDocumentStore((s) => s.viewedDocumentGuid)
  const selectDocuments = useDocumentStore((s) => s.selectDocuments)
  const selectSurveyEntities = useDocumentStore((s) => s.selectSurveyEntities)
  const viewDocument = useDocumentStore((s) => s.viewDocument)
  const removeSource = useDocumentStore((s) => s.removeSource)
  const renameSource = useDocumentStore((s) => s.renameSource)
  const addSource = useDocumentStore((s) => s.addSource)
  const folders = useDocumentStore((s) => s.folders)
  const sourceFolder = useDocumentStore((s) => s.sourceFolder)
  const addFolder = useDocumentStore((s) => s.addFolder)
  const removeFolder = useDocumentStore((s) => s.removeFolder)
  const renameFolder = useDocumentStore((s) => s.renameFolder)
  const moveSourceToFolder = useDocumentStore((s) => s.moveSourceToFolder)
  const moveSourceNear = useDocumentStore((s) => s.moveSourceNear)
  const moveFolderToFolder = useDocumentStore((s) => s.moveFolderToFolder)
  const getTagsForDocument = useTagStore((s) => s.getTagsForDocument)
  const tags = useTagStore((s) => s.tags)
  const categories = useTagStore((s) => s.categories)
  const createTag = useTagStore((s) => s.createTag)
  const assignTagToDocument = useTagStore((s) => s.assignTagToDocument)
  const removeTagFromDocument = useTagStore((s) => s.removeTagFromDocument)
  const assignTagToSurveyRespondent = useTagStore((s) => s.assignTagToSurveyRespondent)
  const removeTagFromSurveyRespondent = useTagStore((s) => s.removeTagFromSurveyRespondent)
  const assignTagToSurveyQuestion = useTagStore((s) => s.assignTagToSurveyQuestion)
  const removeTagFromSurveyQuestion = useTagStore((s) => s.removeTagFromSurveyQuestion)
  const createCategory = useTagStore((s) => s.createCategory)
  const deleteTag = useTagStore((s) => s.deleteTag)
  const renameTag = useTagStore((s) => s.renameTag)
  const deleteCategory = useTagStore((s) => s.deleteCategory)
  const renameCategory = useTagStore((s) => s.renameCategory)
  const updateCategoryListOptions = useTagStore((s) => s.updateCategoryListOptions)

  // ── Document search / filter ────────────────────────────────────
  const [docSearchOpen, setDocSearchOpen] = useState(false)
  const [docSearchQuery, setDocSearchQuery] = useState('')
  const closeDocSearch = useCallback(() => {
    setDocSearchOpen(false)
    setDocSearchQuery('')
  }, [])
  const trimmedDocSearch = docSearchQuery.trim().toLowerCase()

  /** Sources whose own name matches — the leaves of the tree only ever
   *  show when they themselves match (no "context" leaves). */
  const matchingSourceGuids = useMemo(() => {
    if (!trimmedDocSearch) return null
    return new Set(sources.filter((s) => s.name.toLowerCase().includes(trimmedDocSearch)).map((s) => s.guid))
  }, [sources, trimmedDocSearch])

  /** Folders that should stay visible: their own name matches, or a
   *  descendant folder/source matches — mirrors the Code Browser's
   *  ancestor-context filtering (FolderItem dims the non-matching ones). */
  const visibleFolderGuids = useMemo(() => {
    if (!trimmedDocSearch || !matchingSourceGuids) return null
    const childrenOf = new Map<string | null, DocumentFolder[]>()
    for (const f of folders) {
      const arr = childrenOf.get(f.parentGuid) ?? []
      arr.push(f)
      childrenOf.set(f.parentGuid, arr)
    }
    const visible = new Set<string>()
    const visit = (folder: DocumentFolder): boolean => {
      const selfMatch = folder.name.toLowerCase().includes(trimmedDocSearch)
      let anyChildVisible = false
      for (const cf of childrenOf.get(folder.guid) ?? []) {
        if (visit(cf)) anyChildVisible = true
      }
      const hasMatchingSource = sources.some(
        (s) => sourceFolder[s.guid] === folder.guid && matchingSourceGuids.has(s.guid)
      )
      const isVisible = selfMatch || anyChildVisible || hasMatchingSource
      if (isVisible) visible.add(folder.guid)
      return isVisible
    }
    for (const f of folders) if (f.parentGuid === null) visit(f)
    return visible
  }, [folders, sources, sourceFolder, matchingSourceGuids, trimmedDocSearch])

  // The two arrays every tree level (root render + FolderItem's own
  // recursive filtering) actually reads from. Pre-filtering here means
  // FolderItem/DocItem/SurveyItem need no filtering logic of their own —
  // their existing guid-based `.filter()` calls just naturally see fewer
  // items when a search is active.
  const visibleSources = matchingSourceGuids ? sources.filter((s) => matchingSourceGuids.has(s.guid)) : sources
  const visibleFolders = visibleFolderGuids ? folders.filter((f) => visibleFolderGuids.has(f.guid)) : folders

  // Build a flat ordered list of all visible source guids (for shift-click range selection)
  const lastClickedRef = useRef<string | null>(null)
  const flatSourceOrder = useMemo(() => {
    const order: string[] = []
    const walkFolder = (parentGuid: string | null) => {
      const childFolders = visibleFolders.filter((f) => f.parentGuid === parentGuid)
      for (const cf of childFolders) {
        walkFolder(cf.guid)
      }
      const childSources = parentGuid === null
        ? visibleSources.filter((s) => !sourceFolder[s.guid])
        : visibleSources.filter((s) => sourceFolder[s.guid] === parentGuid)
      for (const s of childSources) order.push(s.guid)
    }
    walkFolder(null)
    return order
  }, [visibleSources, visibleFolders, sourceFolder])

  const handleSelectDocument = useCallback((guid: string, e: React.MouseEvent) => {
    if (e.shiftKey && lastClickedRef.current) {
      // Shift-click: range select from last clicked to this one
      const lastIdx = flatSourceOrder.indexOf(lastClickedRef.current)
      const curIdx = flatSourceOrder.indexOf(guid)
      if (lastIdx >= 0 && curIdx >= 0) {
        const lo = Math.min(lastIdx, curIdx)
        const hi = Math.max(lastIdx, curIdx)
        const range = new Set(flatSourceOrder.slice(lo, hi + 1))
        // Add to existing selection
        const next = new Set(selectedGuids)
        for (const g of range) next.add(g)
        selectDocuments(next)
      }
    } else if (e.metaKey || e.ctrlKey || e.altKey) {
      // Cmd/Ctrl/Alt-click: toggle this item
      const next = new Set(selectedGuids)
      if (next.has(guid)) next.delete(guid)
      else next.add(guid)
      selectDocuments(next)
      lastClickedRef.current = guid
    } else {
      // Plain click: select only this item (and clear any survey-entity
      // selection so the selection reads as a single thing).
      selectDocuments(new Set([guid]))
      selectSurveyEntities(new Set())
      lastClickedRef.current = guid
    }
  }, [selectedGuids, selectDocuments, selectSurveyEntities, flatSourceOrder])

  // Cmd/Ctrl-click a respondent/question row toggles it in the survey-
  // entity selection (plain click still navigates — handled in
  // SurveyItem). Lets the user select several respondents/questions to
  // tag at once, alongside any selected documents.
  const handleToggleSurveyEntity = useCallback(
    (sourceGuid: string, kind: 'respondent' | 'question', id: string) => {
      const key = surveyEntityKey(kind === 'respondent' ? 'resp' : 'quest', sourceGuid, id)
      const next = new Set(selectedSurveyEntities)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      selectSurveyEntities(next)
    },
    [selectedSurveyEntities, selectSurveyEntities]
  )

  const handleViewDocument = useCallback((guid: string) => {
    viewDocument(guid)
  }, [viewDocument])

  // Routes survey-tree clicks to (1) the SurveyViewer's mode/childId
  // store and (2) the document store's current-source so the viewer
  // pane focuses on this survey. Two writes because the survey lives
  // as one source/tab — the sub-view (summary / respondent /
  // question) lives outside the tab system.
  const setSurveyView = useSurveyViewStore((s) => s.setView)
  const handleViewSurveyChild = useCallback(
    (
      surveyGuid: string,
      kind: 'summary' | 'respondent' | 'question',
      childId?: string
    ) => {
      setSurveyView(surveyGuid, kind, childId)
      viewDocument(surveyGuid)
    },
    [viewDocument, setSurveyView]
  )

  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    sourceGuid?: string
    folderGuid?: string
    // Right-click on a survey respondent / question leaf row.
    surveyChild?: { sourceGuid: string; kind: 'respondent' | 'question'; id: string; label: string }
  } | null>(null)
  const menuPos = useClampedMenuPosition(contextMenu)
  // What the Apply-Tags dialog is targeting: a whole document/survey
  // (sourceGuid), or a survey respondent / question sub-entity.
  const [showTagDialog, setShowTagDialog] = useState<TagDialogTarget | null>(null)
  const [showManageLocal, setShowManageLocal] = useState(false)
  const [editingFolder, setEditingFolder] = useState<string | null>(null)
  const [editFolderName, setEditFolderName] = useState('')
  const [isNewFolder, setIsNewFolder] = useState(false)
  const [newFolderParentGuid, setNewFolderParentGuid] = useState<string | null>(null)
  const [editingDocGuid, setEditingDocGuid] = useState<string | null>(null)
  const [tagsExpanded, setTagsExpanded] = useState(true)
  const [selectedTagGuids, setSelectedTagGuids] = useState<Set<string>>(new Set())
  const [tagSearchOpen, setTagSearchOpen] = useState(false)
  const [tagSearchQuery, setTagSearchQuery] = useState('')
  const closeTagSearch = useCallback(() => {
    setTagSearchOpen(false)
    setTagSearchQuery('')
  }, [])
  const [tagContextMenu, setTagContextMenu] = useState<{ x: number; y: number; tagGuid: string } | null>(null)
  const [betweenFilter, setBetweenFilter] = useState<{ tagGuid: string; categoryGuid: string; value2: string; mode: 'between' | 'not-between' } | null>(null)

  const dragCounterRef = useRef(0)
  const [isDragOverRoot, setIsDragOverRoot] = useState(false)

  const handleTagDrop = useCallback((tagGuids: string[], sourceGuid: string) => {
    // If the dropped-on document is part of the current selection, the
    // tag applies to the whole selection (documents + survey
    // respondents/questions); otherwise just this document.
    applyTagDropToSelection(tagGuids, { kind: 'document', guid: sourceGuid })
  }, [])

  const lastClickedTagRef = useRef<string | null>(null)

  const trimmedTagSearch = tagSearchQuery.trim().toLowerCase()

  /** Per-category filter result. A category whose own name matches keeps
   *  every one of its tags (the name match IS the find — filtering the
   *  tags too would often leave a matched category empty); otherwise
   *  only its individually-matching tags survive, and the category
   *  header renders dimmed since it's shown purely for context. Category
   *  header itself is hidden entirely once it has zero visible tags. */
  const filteredCategoryTags = useMemo(() => {
    const map = new Map<string, { catNameMatch: boolean; visibleTags: typeof tags }>()
    for (const cat of categories) {
      const catTags = sortTagsForCategory(tags.filter((t) => t.categoryGuid === cat.guid), cat)
      if (!trimmedTagSearch) {
        map.set(cat.guid, { catNameMatch: true, visibleTags: catTags })
        continue
      }
      const catNameMatch = cat.name.toLowerCase().includes(trimmedTagSearch)
      const visibleTags = catNameMatch
        ? catTags
        : catTags.filter((t) => (t.value || t.name).toLowerCase().includes(trimmedTagSearch))
      map.set(cat.guid, { catNameMatch, visibleTags })
    }
    return map
  }, [categories, tags, trimmedTagSearch])

  const visibleUncategorisedTags = useMemo(() => {
    const uncategorised = tags.filter((t) => !t.categoryGuid)
    if (!trimmedTagSearch) return uncategorised
    return uncategorised.filter((t) => (t.value || t.name).toLowerCase().includes(trimmedTagSearch))
  }, [tags, trimmedTagSearch])

  // Flat ordered list of all tag GUIDs in display order (for shift-click
  // range) — built from the filtered view so a search doesn't let range-
  // select reach tags the user can't currently see.
  const flatTagGuids = useMemo(() => {
    const result: string[] = []
    for (const cat of categories) {
      for (const t of filteredCategoryTags.get(cat.guid)?.visibleTags ?? []) {
        result.push(t.guid)
      }
    }
    for (const t of visibleUncategorisedTags) result.push(t.guid)
    return result
  }, [categories, filteredCategoryTags, visibleUncategorisedTags])

  const handleTagClick = useCallback((tagGuid: string, e: React.MouseEvent) => {
    if (e.shiftKey && lastClickedTagRef.current) {
      // Range select from last clicked to this one
      const from = flatTagGuids.indexOf(lastClickedTagRef.current)
      const to = flatTagGuids.indexOf(tagGuid)
      if (from !== -1 && to !== -1) {
        const lo = Math.min(from, to)
        const hi = Math.max(from, to)
        const range = flatTagGuids.slice(lo, hi + 1)
        setSelectedTagGuids((prev) => {
          const next = new Set(prev)
          for (const g of range) next.add(g)
          return next
        })
      }
    } else if (e.metaKey || e.ctrlKey) {
      // Toggle tag in selection
      setSelectedTagGuids((prev) => {
        const next = new Set(prev)
        if (next.has(tagGuid)) next.delete(tagGuid)
        else next.add(tagGuid)
        return next
      })
      lastClickedTagRef.current = tagGuid
    } else {
      // Single select
      setSelectedTagGuids((prev) => {
        if (prev.size === 1 && prev.has(tagGuid)) return new Set()
        return new Set([tagGuid])
      })
      lastClickedTagRef.current = tagGuid
    }
  }, [])

  const handleTagSelectDocs = useCallback((tagGuid: string) => {
    const tag = tags.find((t) => t.guid === tagGuid)
    if (tag && tag.memberSourceGuids.length > 0) {
      selectDocuments(new Set(tag.memberSourceGuids))
    }
    setTagContextMenu(null)
  }, [tags, selectDocuments])

  const handleSelectAllActiveTags = useCallback(() => {
    const allMembers = new Set<string>()
    for (const tGuid of selectedTagGuids) {
      const tag = tags.find((t) => t.guid === tGuid)
      if (tag) {
        for (const g of tag.memberSourceGuids) allMembers.add(g)
      }
    }
    if (allMembers.size > 0) {
      selectDocuments(allMembers)
    }
    setTagContextMenu(null)
  }, [selectedTagGuids, tags, selectDocuments])

  const handleBetweenFilter = useCallback((tagGuid: string, value2: string, mode: 'between' | 'not-between') => {
    const tag = tags.find((t) => t.guid === tagGuid)
    if (!tag || !tag.categoryGuid) return
    const cat = categories.find((c) => c.guid === tag.categoryGuid)
    if (!cat) return

    const catTags = tags.filter((t) => t.categoryGuid === cat.guid && t.value)
    const val1 = tag.value || ''

    const isDate = cat.type === 'date'
    const parse = (v: string) => isDate ? new Date(v.split('/').reverse().join('-')).getTime() : parseFloat(v)

    const lo = Math.min(parse(val1), parse(value2))
    const hi = Math.max(parse(val1), parse(value2))

    const matchingMembers = new Set<string>()
    for (const t of catTags) {
      const v = parse(t.value!)
      if (isNaN(v)) continue
      const inRange = v >= lo && v <= hi
      if ((mode === 'between' && inRange) || (mode === 'not-between' && !inRange)) {
        for (const g of t.memberSourceGuids) matchingMembers.add(g)
      }
    }
    if (matchingMembers.size > 0) {
      selectDocuments(matchingMembers)
    }
    setTagContextMenu(null)
    setBetweenFilter(null)
  }, [tags, categories, selectDocuments])

  const handleReorderDoc = useCallback((draggedGuids: string[], siblingGuid: string, position: 'before' | 'after') => {
    // Move each dragged doc near the sibling, preserving their relative order
    const ordered = position === 'before' ? draggedGuids : [...draggedGuids].reverse()
    for (const guid of ordered) {
      if (guid !== siblingGuid) {
        moveSourceNear(guid, siblingGuid, position)
      }
    }
  }, [moveSourceNear])

  const handleContextMenuDoc = useCallback(
    (e: React.MouseEvent, guid: string) => {
      e.preventDefault()
      e.stopPropagation()
      setContextMenu({ x: e.clientX, y: e.clientY, sourceGuid: guid })
    },
    []
  )

  const handleContextMenuFolder = useCallback(
    (e: React.MouseEvent, guid: string) => {
      e.preventDefault()
      e.stopPropagation()
      setContextMenu({ x: e.clientX, y: e.clientY, folderGuid: guid })
    },
    []
  )

  const handleContextMenuSurveyChild = useCallback(
    (e: React.MouseEvent, sourceGuid: string, kind: 'respondent' | 'question', id: string, label: string) => {
      e.preventDefault()
      e.stopPropagation()
      setContextMenu({ x: e.clientX, y: e.clientY, surveyChild: { sourceGuid, kind, id, label } })
    },
    []
  )

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  // Dismiss either context menu on any outside click. The previous
  // panel-level onMouseDown only caught clicks inside the Documents
  // panel, so clicking another panel or the toolbar left a stale menu
  // floating on screen. A document-level listener (registered only
  // while a menu is open) closes it from anywhere outside the menu DOM.
  useEffect(() => {
    if (!contextMenu && !tagContextMenu) return
    const handleDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('.context-menu')) return
      setContextMenu(null)
      setTagContextMenu(null)
    }
    document.addEventListener('mousedown', handleDown)
    return () => document.removeEventListener('mousedown', handleDown)
  }, [contextMenu, tagContextMenu])

  const handleFileDrop = useCallback(async (filePaths: string[], folderGuid?: string) => {
    const files = await window.api.readTextFiles(filePaths)
    if (!files) return
    const errors: string[] = []
    for (const f of files) {
      if ((f as any).error) {
        errors.push(`${f.name}: ${(f as any).error}`)
        continue
      }
      const ext = (f as any).extension || f.name.split('.').pop()?.toLowerCase() || ''
      // CSV / XLSX → defer to the survey-import preview dialog
      // (handled in App.tsx). XLSX is converted to CSV text in the
      // main process so the same pipeline handles both. Without this
      // branch a dropped survey would silently become a plain-text
      // source and bypass type detection.
      if (ext === 'csv' || ext === 'xlsx') {
        if (onSurveyImport) {
          const suggestedName = f.name.replace(/\.(csv|xlsx)$/i, '')
          onSurveyImport(f.content, suggestedName, folderGuid)
        } else {
          errors.push(`${f.name}: survey import is unavailable in this view.`)
        }
        continue
      }
      const st = sourceTypeFromExtension(ext)
      const formatting = (f as any).formatting
      const guid = addSource(f.name, f.content, st !== 'text' ? st : undefined, formatting)
      if (folderGuid) {
        useDocumentStore.getState().moveSourceToFolder(guid, folderGuid)
      }
    }
    if (errors.length > 0) {
      window.alert(`Could not import ${errors.length} file${errors.length > 1 ? 's' : ''}:\n\n${errors.join('\n')}`)
    }
  }, [addSource, onSurveyImport])

  // Top-level (root) folders and documents
  const rootFolders = visibleFolders.filter((f) => f.parentGuid === null)
  const rootSources = visibleSources.filter((s) => !sourceFolder[s.guid])

  return (
    <div className="panel">
      <div className="panel-header">
        {docSearchOpen ? (
          <input
            type="text"
            value={docSearchQuery}
            onChange={(e) => setDocSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') closeDocSearch() }}
            placeholder="Filter documents..."
            aria-label="Filter documents"
            autoFocus
            style={{
              flex: 1,
              minWidth: 0,
              padding: '2px 6px',
              fontSize: 12,
              fontWeight: 400,
              letterSpacing: 'normal',
              textTransform: 'none',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-sm)',
              outline: 'none',
              background: 'var(--bg-input)',
              color: 'var(--text-primary)'
            }}
          />
        ) : (
          <span style={{ flex: 1 }}>Documents</span>
        )}
        {(sources.length > 0 || folders.length > 0) && (
          <button
            className="panel-header-search"
            onClick={() => (docSearchOpen ? closeDocSearch() : setDocSearchOpen(true))}
            title={docSearchOpen ? 'Close search' : 'Filter documents'}
            aria-label={docSearchOpen ? 'Close search' : 'Filter documents'}
          >
            <Icon icon={docSearchOpen ? faXmark : faMagnifyingGlass} />
          </button>
        )}
        <button
          className="panel-header-add"
          onClick={() => {
            if (lockedBy) { promptCheckoutLocked(); return }
            setIsNewFolder(true)
            setNewFolderParentGuid(null)
            setEditingFolder('__new__')
            setEditFolderName('New Folder')
          }}
          title={lockedBy ? checkoutLockedTitle(lockedBy) : 'Create new folder'}
          aria-label="Create new folder"
          style={lockedBy ? { opacity: 0.4 } : undefined}
        >
          <Icon icon={faFolderPlus} />
        </button>
        {onPopOut && <button className="panel-header-popout" onClick={onPopOut} title={isPoppedOut ? "Pop back in" : "Pop out"} aria-label={isPoppedOut ? "Pop pane back into main window" : "Pop pane out into its own window"}><Icon icon={isPoppedOut ? faDownLeftAndUpRightToCenter : faUpRightFromSquare} /></button>}
        {onClose && <button className="panel-header-close" onClick={onClose} title="Close panel" aria-label="Close panel"><Icon icon={faXmark} /></button>}
      </div>
      <PanelGroup direction="vertical" style={{ flex: 1, overflow: 'hidden' }}>
        <Panel defaultSize={60} minSize={20}>
      <div
        className="panel-content"
        style={{ height: '100%' }}
        onDragEnter={(e) => {
          if (lockedBy) return
          if (
            e.dataTransfer.types.includes('application/x-magnolia-doc-reorder') ||
            e.dataTransfer.types.includes('application/x-magnolia-folder') ||
            e.dataTransfer.types.includes('Files')
          ) {
            e.preventDefault()
            dragCounterRef.current++
            setIsDragOverRoot(true)
          }
        }}
        onDragOver={(e) => {
          if (lockedBy) return
          if (
            e.dataTransfer.types.includes('application/x-magnolia-doc-reorder') ||
            e.dataTransfer.types.includes('application/x-magnolia-folder') ||
            e.dataTransfer.types.includes('Files')
          ) {
            e.preventDefault()
            e.dataTransfer.dropEffect = e.dataTransfer.types.includes('Files') ? 'copy' : 'move'
          }
        }}
        onDragLeave={() => {
          dragCounterRef.current--
          if (dragCounterRef.current <= 0) {
            dragCounterRef.current = 0
            setIsDragOverRoot(false)
          }
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          dragCounterRef.current = 0
          setIsDragOverRoot(false)
          if (lockedBy) { promptCheckoutLocked(); return }

          // Handle file drops from OS
          if (e.dataTransfer.files.length > 0) {
            const paths = Array.from(e.dataTransfer.files).map((f) => f.path).filter(Boolean)
            if (paths.length > 0) {
              handleFileDrop(paths)
              return
            }
          }

          const docsData = e.dataTransfer.getData('application/x-magnolia-docs')
          const docGuid = e.dataTransfer.getData('application/x-magnolia-doc-reorder')
          const docGuids: string[] = docsData ? JSON.parse(docsData) : docGuid ? [docGuid] : []
          if (docGuids.length > 0) {
            for (const g of docGuids) moveSourceToFolder(g, null)
            return
          }
          const folderGuid = e.dataTransfer.getData('application/x-magnolia-folder')
          if (folderGuid) {
            moveFolderToFolder(folderGuid, null)
          }
        }}
      >
        {sources.length === 0 && folders.length === 0 && (
          <div
            className="empty-state"
            style={{
              padding: 20,
              textAlign: 'center',
              color: 'var(--text-muted)',
              fontSize: 'var(--font-size-sm)'
            }}
          >
            No documents yet.
            <br />
            Click Import or use File &gt; Import.
          </div>
        )}
        {(sources.length > 0 || folders.length > 0) && trimmedDocSearch && visibleSources.length === 0 && visibleFolders.length === 0 && (
          <div
            className="empty-state"
            style={{
              padding: 20,
              textAlign: 'center',
              color: 'var(--text-muted)',
              fontSize: 'var(--font-size-sm)'
            }}
          >
            No documents match "{docSearchQuery.trim()}".
          </div>
        )}
        {rootFolders.map((folder) => (
          <FolderItem
            key={folder.guid}
            folder={folder}
            allFolders={visibleFolders}
            sources={visibleSources}
            sourceFolder={sourceFolder}
            selectedGuids={selectedGuids}
            viewedGuid={viewedGuid}
            depth={0}
            onSelectDocument={handleSelectDocument}
            onViewDocument={handleViewDocument}
            onContextMenuDoc={handleContextMenuDoc}
            onContextMenuFolder={handleContextMenuFolder}
            onRenameDoc={renameSource}
            onFileDrop={handleFileDrop}
            editingDocGuid={editingDocGuid}
            onStartEditingDoc={setEditingDocGuid}
            onStopEditingDoc={() => setEditingDocGuid(null)}
            getTagsForDocument={getTagsForDocument}
            onTagDrop={handleTagDrop}
            onReorderDoc={handleReorderDoc}
            onViewSurveyChild={handleViewSurveyChild}
            onContextMenuSurveyChild={handleContextMenuSurveyChild}
            selectedSurveyEntities={selectedSurveyEntities}
            onToggleSurveyEntity={handleToggleSurveyEntity}
            searchQuery={trimmedDocSearch}
          />
        ))}
        {rootSources.map((source) =>
          source.sourceType === 'survey' ? (
            <SurveyItem
              key={source.guid}
              source={source}
              selectedGuids={selectedGuids}
              viewedGuid={viewedGuid}
              depth={0}
              editing={editingDocGuid === source.guid}
              onSelectDocument={handleSelectDocument}
              onContextMenu={handleContextMenuDoc}
              onRename={renameSource}
              onStopEditing={() => setEditingDocGuid(null)}
              onViewSurveyChild={handleViewSurveyChild}
              onContextMenuSurveyChild={handleContextMenuSurveyChild}
              selectedSurveyEntities={selectedSurveyEntities}
              onToggleSurveyEntity={handleToggleSurveyEntity}
            />
          ) : (
            <DocItem
              key={source.guid}
              source={source}
              selectedGuids={selectedGuids}
              viewedGuid={viewedGuid}
              depth={0}
              editing={editingDocGuid === source.guid}
              onSelectDocument={handleSelectDocument}
              onViewDocument={handleViewDocument}
              onContextMenu={handleContextMenuDoc}
              onRename={renameSource}
              onStopEditing={() => setEditingDocGuid(null)}
              getTagsForDocument={getTagsForDocument}
              onTagDrop={handleTagDrop}
              onReorder={handleReorderDoc}
            />
          )
        )}
      </div>
        </Panel>
        {/* Internal divider between the Documents tree and the Tags
            tree. Mirrors the queries-sidebar-divider pattern: a
            visible 1 px line that survives in every theme, including
            the floating-card themes (Granola, Zine) where the global
            "hide all resize handles" rule would otherwise blank it.
            The className opts the handle into the per-theme exception
            list further down in global.css. */}
        <PanelResizeHandle
          className="documents-tags-divider"
          style={{
            height: 1,
            background: 'var(--border-color)',
            cursor: 'row-resize'
          }}
        />
        <Panel defaultSize={40} minSize={15}>
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* Tags section header — uses the shared .panel-header
                className so it inherits the small-caps section-label
                typography along with the Documents/Codes/Memos panes. */}
            <div className="panel-header" style={{ flexShrink: 0 }}>
              {tagSearchOpen ? (
                <input
                  type="text"
                  value={tagSearchQuery}
                  onChange={(e) => setTagSearchQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') closeTagSearch() }}
                  placeholder="Filter tags..."
                  aria-label="Filter tags"
                  autoFocus
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: '2px 6px',
                    fontSize: 12,
                    fontWeight: 400,
                    letterSpacing: 'normal',
                    textTransform: 'none',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-sm)',
                    outline: 'none',
                    background: 'var(--bg-input)',
                    color: 'var(--text-primary)'
                  }}
                />
              ) : (
                <span style={{ flex: 1 }}>Tags</span>
              )}
              {(tags.length > 0 || categories.length > 0) && (
                <button
                  className="panel-header-search"
                  onClick={() => (tagSearchOpen ? closeTagSearch() : setTagSearchOpen(true))}
                  title={tagSearchOpen ? 'Close search' : 'Filter tags'}
                  aria-label={tagSearchOpen ? 'Close search' : 'Filter tags'}
                >
                  <Icon icon={tagSearchOpen ? faXmark : faMagnifyingGlass} />
                </button>
              )}
              <button
                className="panel-header-add"
                onClick={() => setShowManageLocal(true)}
                title="Manage tags"
                aria-label="Manage tags"
              >
                <Icon icon={faPlus} />
              </button>
            </div>
            <div className="panel-content" style={{ height: '100%' }}>
              {tags.length === 0 && categories.length === 0 && (
                <div
                  className="empty-state"
                  style={{
                    padding: 20,
                    textAlign: 'center',
                    color: 'var(--text-muted)',
                    fontSize: 'var(--font-size-sm)'
                  }}
                >
                  No tags yet.
                </div>
              )}
              {(tags.length > 0 || categories.length > 0) && trimmedTagSearch && flatTagGuids.length === 0 && (
                <div
                  className="empty-state"
                  style={{
                    padding: 20,
                    textAlign: 'center',
                    color: 'var(--text-muted)',
                    fontSize: 'var(--font-size-sm)'
                  }}
                >
                  No tags match "{tagSearchQuery.trim()}".
                </div>
              )}
              {(() => {
                return (
                  <>
                    {categories.map((cat) => {
                      const entry = filteredCategoryTags.get(cat.guid)
                      const catTags = entry?.visibleTags ?? []
                      // Empty categories are listed too when there's no
                      // active search — they're a real organisational unit
                      // the user has set up, not noise. During a search,
                      // a category with zero matching tags just disappears.
                      if (trimmedTagSearch && catTags.length === 0) return null
                      return (
                        <TagCategoryItem
                          key={cat.guid}
                          category={cat}
                          tags={catTags}
                          selectedTagGuids={selectedTagGuids}
                          onTagClick={handleTagClick}
                          onTagDoubleClick={(tagGuid) => handleTagSelectDocs(tagGuid)}
                          onContextMenu={(e, tagGuid) => {
                            e.preventDefault()
                            e.stopPropagation()
                            setBetweenFilter(null)
                            setTagContextMenu({ x: e.clientX, y: e.clientY, tagGuid })
                          }}
                          dimmed={!!trimmedTagSearch && !entry?.catNameMatch}
                          forceExpanded={!!trimmedTagSearch}
                        />
                      )
                    })}
                    {visibleUncategorisedTags.map((tag) => (
                      <TagItem
                        key={tag.guid}
                        tag={tag}
                        depth={1}
                        isSelected={selectedTagGuids.has(tag.guid)}
                        selectedTagGuids={selectedTagGuids}
                        onClick={(e) => handleTagClick(tag.guid, e)}
                        onDoubleClick={() => handleTagSelectDocs(tag.guid)}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          setBetweenFilter(null)
                          setTagContextMenu({ x: e.clientX, y: e.clientY, tagGuid: tag.guid })
                        }}
                      />
                    ))}
                  </>
                )
              })()}
            </div>
          </div>
        </Panel>
      </PanelGroup>

      {/* Tag context menu */}
      {tagContextMenu && (() => {
        const ctxTag = tags.find((t) => t.guid === tagContextMenu.tagGuid)
        const ctxCat = ctxTag?.categoryGuid ? categories.find((c) => c.guid === ctxTag.categoryGuid) : null
        const isDateOrNumber = ctxCat && (ctxCat.type === 'date' || ctxCat.type === 'numeric' || ctxCat.type === 'text') && ctxTag?.value && !isNaN(ctxCat.type === 'date' ? new Date(ctxTag.value.split('/').reverse().join('-')).getTime() : parseFloat(ctxTag.value))
        const catTags = ctxCat ? tags.filter((t) => t.categoryGuid === ctxCat.guid && t.guid !== tagContextMenu.tagGuid && t.value) : []
        return (
          <div
            className="context-menu"
            style={{ left: tagContextMenu.x, top: tagContextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="context-menu-item"
              onClick={() => handleTagSelectDocs(tagContextMenu.tagGuid)}
            >
              Select Documents with This Tag
            </div>
            {selectedTagGuids.size > 1 && (
              <div
                className="context-menu-item"
                onClick={handleSelectAllActiveTags}
              >
                Select Documents for All Active Tags ({selectedTagGuids.size})
              </div>
            )}
            {isDateOrNumber && catTags.length > 0 && (
              <>
                <div className="context-menu-separator" />
                <div style={{ padding: '6px 12px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>
                  Range Filter ({ctxCat!.type === 'date' ? 'dates' : 'values'})
                </div>
                <div style={{ padding: '4px 12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginBottom: 4 }}>
                    <span style={{ color: 'var(--text-secondary)', minWidth: 40 }}>From:</span>
                    <span style={{ fontWeight: 600 }}>{ctxTag!.value}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginBottom: 6 }}>
                    <span style={{ color: 'var(--text-secondary)', minWidth: 40 }}>To:</span>
                    <select
                      style={{
                        flex: 1,
                        fontSize: 11,
                        padding: '2px 4px',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border-color)',
                        background: 'var(--bg-input)',
                        color: 'var(--text-primary)'
                      }}
                      value={betweenFilter?.value2 || ''}
                      onChange={(e) => setBetweenFilter({
                        tagGuid: tagContextMenu.tagGuid,
                        categoryGuid: ctxCat!.guid,
                        value2: e.target.value,
                        mode: betweenFilter?.mode || 'between'
                      })}
                    >
                      <option value="">Select...</option>
                      {catTags.map((t) => (
                        <option key={t.guid} value={t.value!}>{t.value}</option>
                      ))}
                    </select>
                  </div>
                  {betweenFilter?.value2 && (
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button
                        style={{ fontSize: 10, padding: '2px 8px', flex: 1 }}
                        onClick={() => handleBetweenFilter(tagContextMenu.tagGuid, betweenFilter.value2, 'between')}
                      >
                        Between
                      </button>
                      <button
                        className="secondary"
                        style={{ fontSize: 10, padding: '2px 8px', flex: 1 }}
                        onClick={() => handleBetweenFilter(tagContextMenu.tagGuid, betweenFilter.value2, 'not-between')}
                      >
                        Not Between
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
            <div className="context-menu-separator" />
            <div
              className="context-menu-item"
              style={{ color: 'var(--menu-fg-danger)' }}
              onClick={() => {
                deleteTag(tagContextMenu.tagGuid)
                setSelectedTagGuids((prev) => {
                  const next = new Set(prev)
                  next.delete(tagContextMenu.tagGuid)
                  return next
                })
                setTagContextMenu(null)
              }}
            >
              Delete Tag
            </div>
          </div>
        )
      })()}

      {/* Context menu for documents */}
      {contextMenu && contextMenu.sourceGuid && (
        <div
          ref={menuPos.ref}
          className="context-menu"
          style={{ left: menuPos.x, top: menuPos.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="context-menu-item"
            onClick={() => {
              viewDocument(contextMenu.sourceGuid!)
              closeContextMenu()
            }}
          >
            View
          </div>
          <div
            className="context-menu-item"
            title={lockedBy ? checkoutLockedTitle(lockedBy) : undefined}
            onClick={() => {
              closeContextMenu()
              if (lockedBy) { promptCheckoutLocked(); return }
              setEditingDocGuid(contextMenu.sourceGuid!)
            }}
          >
            Rename
          </div>
          <div
            className="context-menu-item"
            title={lockedBy ? checkoutLockedTitle(lockedBy) : undefined}
            onClick={() => {
              closeContextMenu()
              if (lockedBy) { promptCheckoutLocked(); return }
              setShowTagDialog({ kind: 'document', sourceGuid: contextMenu.sourceGuid! })
            }}
          >
            Edit Tags...
          </div>
          {folders.length > 0 && (
            <>
              <div className="context-menu-separator" />
              <div
                style={{
                  padding: '4px 14px',
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  fontWeight: 600,
                  userSelect: 'none'
                }}
              >
                Move to Folder
              </div>
              {sourceFolder[contextMenu.sourceGuid!] && (
                <div
                  className="context-menu-item"
                  title={lockedBy ? checkoutLockedTitle(lockedBy) : undefined}
                  onClick={() => {
                    closeContextMenu()
                    if (lockedBy) { promptCheckoutLocked(); return }
                    moveSourceToFolder(contextMenu.sourceGuid!, null)
                  }}
                >
                  (Root)
                </div>
              )}
              {folders.map((f) => (
                <div
                  key={f.guid}
                  className="context-menu-item"
                  title={lockedBy ? checkoutLockedTitle(lockedBy) : undefined}
                  onClick={() => {
                    closeContextMenu()
                    if (lockedBy) { promptCheckoutLocked(); return }
                    moveSourceToFolder(contextMenu.sourceGuid!, f.guid)
                  }}
                >
                  <Icon icon={faFolder} style={{ fontSize: 10, opacity: 0.7, marginRight: 4 }} />{f.name}
                </div>
              ))}
            </>
          )}
          <div className="context-menu-separator" />
          {(() => {
            // If the right-clicked doc is part of a multi-selection,
            // the menu acts on every selected doc; otherwise just on
            // the one under the cursor. Label pluralises to match.
            const guidsToRemove = selectedGuids.has(contextMenu.sourceGuid!) && selectedGuids.size > 1
              ? Array.from(selectedGuids)
              : [contextMenu.sourceGuid!]
            return (
              <div
                className="context-menu-item"
                style={{ color: 'var(--menu-fg-danger)' }}
                title={lockedBy ? checkoutLockedTitle(lockedBy) : undefined}
                onClick={() => {
                  closeContextMenu()
                  if (lockedBy) { promptCheckoutLocked(); return }
                  for (const g of guidsToRemove) removeSource(g)
                }}
              >
                {guidsToRemove.length > 1 ? `Remove ${guidsToRemove.length} Documents` : 'Remove Document'}
              </div>
            )
          })()}
        </div>
      )}

      {/* Context menu for a survey respondent / question leaf */}
      {contextMenu && contextMenu.surveyChild && (
        <div
          ref={menuPos.ref}
          className="context-menu"
          style={{ left: menuPos.x, top: menuPos.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="context-menu-item"
            onClick={() => {
              const sc = contextMenu.surveyChild!
              setShowTagDialog({ kind: sc.kind, sourceGuid: sc.sourceGuid, id: sc.id, label: sc.label })
              closeContextMenu()
            }}
          >
            Edit Tags...
          </div>
        </div>
      )}

      {/* Context menu for folders */}
      {contextMenu && contextMenu.folderGuid && (
        <div
          ref={menuPos.ref}
          className="context-menu"
          style={{ left: menuPos.x, top: menuPos.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="context-menu-item"
            title={lockedBy ? checkoutLockedTitle(lockedBy) : undefined}
            onClick={() => {
              closeContextMenu()
              if (lockedBy) { promptCheckoutLocked(); return }
              const f = folders.find((f) => f.guid === contextMenu.folderGuid)
              if (f) {
                setEditingFolder(f.guid)
                setEditFolderName(f.name)
              }
            }}
          >
            Rename
          </div>
          <div
            className="context-menu-item"
            title={lockedBy ? checkoutLockedTitle(lockedBy) : undefined}
            onClick={() => {
              closeContextMenu()
              if (lockedBy) { promptCheckoutLocked(); return }
              setIsNewFolder(true)
              setNewFolderParentGuid(contextMenu.folderGuid!)
              setEditingFolder('__new__')
              setEditFolderName('New Folder')
            }}
          >
            New Subfolder
          </div>
          {folders.find((f) => f.guid === contextMenu.folderGuid)?.parentGuid && (
            <div
              className="context-menu-item"
              title={lockedBy ? checkoutLockedTitle(lockedBy) : undefined}
              onClick={() => {
                closeContextMenu()
                if (lockedBy) { promptCheckoutLocked(); return }
                moveFolderToFolder(contextMenu.folderGuid!, null)
              }}
            >
              Move to Root
            </div>
          )}
          <div className="context-menu-separator" />
          <div
            className="context-menu-item"
            style={{ color: 'var(--menu-fg-danger)' }}
            title={lockedBy ? checkoutLockedTitle(lockedBy) : undefined}
            onClick={() => {
              closeContextMenu()
              if (lockedBy) { promptCheckoutLocked(); return }
              removeFolder(contextMenu.folderGuid!)
            }}
          >
            Delete Folder
          </div>
        </div>
      )}

      {/* New / Rename folder dialog */}
      {editingFolder && (
        <div
          className="modal-overlay"
          onClick={() => { setEditingFolder(null); setIsNewFolder(false) }}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{isNewFolder ? 'New Folder' : 'Rename Folder'}</h2>
            <div style={{ marginBottom: 12 }}>
              <input
                type="text"
                value={editFolderName}
                onChange={(e) => setEditFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && editFolderName.trim()) {
                    if (isNewFolder) {
                      addFolder(editFolderName.trim(), newFolderParentGuid)
                    } else {
                      renameFolder(editingFolder, editFolderName.trim())
                    }
                    setEditingFolder(null)
                    setIsNewFolder(false)
                  } else if (e.key === 'Escape') {
                    setEditingFolder(null)
                    setIsNewFolder(false)
                  }
                }}
                onFocus={(e) => e.target.select()}
                autoFocus
                style={{ width: '100%' }}
              />
            </div>
            <div className="modal-actions">
              <button className="secondary" onClick={() => { setEditingFolder(null); setIsNewFolder(false) }}>
                Cancel
              </button>
              <button
                onClick={() => {
                  if (editFolderName.trim()) {
                    if (isNewFolder) {
                      addFolder(editFolderName.trim(), newFolderParentGuid)
                    } else {
                      renameFolder(editingFolder, editFolderName.trim())
                    }
                    setEditingFolder(null)
                    setIsNewFolder(false)
                  }
                }}
              >
                {isNewFolder ? 'Okay' : 'Rename'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Apply Tags dialog — targets a document/survey or a survey
          respondent/question, binding the matching tag-store actions. */}
      {showTagDialog && (
        <ApplyDocumentTagsDialog
          title="Edit Tags"
          tags={tags}
          categories={categories}
          isAssigned={(tag) => {
            if (showTagDialog.kind === 'respondent') {
              return (tag.memberSurveyRespondents ?? []).some(
                (m) => m.sourceGuid === showTagDialog.sourceGuid && m.id === showTagDialog.id
              )
            }
            if (showTagDialog.kind === 'question') {
              return (tag.memberSurveyQuestions ?? []).some(
                (m) => m.sourceGuid === showTagDialog.sourceGuid && m.id === showTagDialog.id
              )
            }
            return tag.memberSourceGuids.includes(showTagDialog.sourceGuid)
          }}
          onAssign={(tagGuid) => {
            if (showTagDialog.kind === 'respondent') assignTagToSurveyRespondent(tagGuid, showTagDialog.sourceGuid, showTagDialog.id)
            else if (showTagDialog.kind === 'question') assignTagToSurveyQuestion(tagGuid, showTagDialog.sourceGuid, showTagDialog.id)
            else assignTagToDocument(tagGuid, showTagDialog.sourceGuid)
          }}
          onRemove={(tagGuid) => {
            if (showTagDialog.kind === 'respondent') removeTagFromSurveyRespondent(tagGuid, showTagDialog.sourceGuid, showTagDialog.id)
            else if (showTagDialog.kind === 'question') removeTagFromSurveyQuestion(tagGuid, showTagDialog.sourceGuid, showTagDialog.id)
            else removeTagFromDocument(tagGuid, showTagDialog.sourceGuid)
          }}
          createTag={createTag}
          onOpenManage={() => setShowManageLocal(true)}
          onClose={() => setShowTagDialog(null)}
        />
      )}

      {/* Manage Document Tags dialog */}
      {(showManageDocTags || showManageLocal) && (
        <ManageDocumentTagsDialog
          categories={categories}
          tags={tags}
          createCategory={createCategory}
          deleteCategory={deleteCategory}
          renameCategory={renameCategory}
          createTag={createTag}
          deleteTag={deleteTag}
          renameTag={renameTag}
          updateCategoryListOptions={updateCategoryListOptions}
          onClose={() => {
            setShowManageLocal(false)
            onCloseManageDocTags?.()
          }}
        />
      )}

    </div>
  )
}
