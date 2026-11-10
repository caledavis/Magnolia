import { useState, useCallback, useRef } from 'react'
import type { TextSource } from '../../models/types'
import { Icon, faXmark, faFile, faHeadphones, faVideo, faImage, faGear, faGitMerge, faNotebookPen, SURVEY_ICON, type IconComponent } from '../Icon'
import { isAnalysisTab, isMapTab, isPreferencesTab, isMergeTab, isQueryBuilderTab, isNotebookTab, mapGuidFromTabId, notebookGuidFromTabId } from '../../utils/tab-ids'
import { useDocumentStore } from '../../stores/document-store'
import { useRelationshipMapStore } from '../../stores/relationship-map-store'
import { useAnalysisTabsStore } from '../../stores/analysis-tabs-store'
import { useToolSaveRegistry } from '../../stores/tool-save-registry'
import { TOOL_REGISTRY } from '../../utils/tool-registry'
import { sourceTypeFromFilename } from '../../utils/format-registry'
import { useIconTint, iconTintKindForSourceType, PALETTE_ICON_CLASS } from '../../utils/icon-tint'
import { useTranslation } from 'react-i18next'

interface TabBarProps {
  openTabs: string[]
  activeTab: string | null
  sources: TextSource[]
  onSelectTab: (guid: string) => void
  onCloseTab: (guid: string) => void
  onReorderTabs: (guids: string[]) => void
}

export function TabBar({ openTabs, activeTab, sources, onSelectTab, onCloseTab, onReorderTabs }: TabBarProps) {
  const { t } = useTranslation()
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)
  const dragGuidRef = useRef<string | null>(null)
  const maps = useRelationshipMapStore((s) => s.maps)
  const setMapName = useRelationshipMapStore((s) => s.setName)
  // Inline-edit state: which map tab is being renamed, and the draft text.
  const [editingMapGuid, setEditingMapGuid] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  const sourceMap = new Map(sources.map((s) => [s.guid, s]))
  const folders = useDocumentStore((s) => s.folders)
  const analysisTabs = useAnalysisTabsStore((s) => s.instances)
  // Tab id of the dirty tab the user is trying to close, or null when
  // the confirm dialog is hidden. Storing the id (not just a boolean)
  // means the dialog's Save / Discard / Cancel buttons all act on the
  // same tab the user clicked X on, not the currently-active tab.
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null)

  const requestClose = useCallback((tabId: string) => {
    const dirty = (() => {
      if (isMapTab(tabId)) {
        const guid = mapGuidFromTabId(tabId)
        return !!(guid && useRelationshipMapStore.getState().maps[guid]?.dirty)
      }
      if (isAnalysisTab(tabId) || isQueryBuilderTab(tabId)) {
        return !!useAnalysisTabsStore.getState().instances[tabId]?.dirty
      }
      return false
    })()
    if (dirty) {
      setPendingCloseTabId(tabId)
    } else {
      onCloseTab(tabId)
    }
  }, [onCloseTab])

  const handleDialogDiscard = useCallback(() => {
    if (pendingCloseTabId) onCloseTab(pendingCloseTabId)
    setPendingCloseTabId(null)
  }, [pendingCloseTabId, onCloseTab])

  const handleDialogSave = useCallback(() => {
    if (!pendingCloseTabId) return
    const tabId = pendingCloseTabId
    // All seven analysis tools (the six in InlineAnalysisTab plus the
    // Relationship Map) register their save handler in the
    // tool-save-registry and follow the same contract: synchronous
    // saves return true (we proceed with close); a return of false
    // means the tool opened its own "Name this analysis" sub-dialog
    // and the close should defer until the user completes it manually.
    const saved = useToolSaveRegistry.getState().invokeSave(tabId)
    if (saved) {
      onCloseTab(tabId)
    }
    setPendingCloseTabId(null)
  }, [pendingCloseTabId, onCloseTab])

  const handleDialogCancel = useCallback(() => {
    setPendingCloseTabId(null)
  }, [])

  const labelFor = (tabId: string): string => {
    if (isMapTab(tabId)) {
      const guid = mapGuidFromTabId(tabId)
      const map = guid ? maps[guid] : undefined
      return map?.name?.trim() || t('tabs.untitledMap')
    }
    if (isAnalysisTab(tabId) || isQueryBuilderTab(tabId)) {
      const inst = analysisTabs[tabId]
      return inst?.title?.trim() || (isQueryBuilderTab(tabId) ? t('tabs.queryBuilder') : t('tabs.analysis'))
    }
    if (isPreferencesTab(tabId)) return t('tabs.preferences')
    if (isMergeTab(tabId)) return t('tabs.mergeProjects')
    if (isNotebookTab(tabId)) {
      const guid = notebookGuidFromTabId(tabId)
      return folders.find((f) => f.guid === guid)?.name || t('documents.notebook')
    }
    return sourceMap.get(tabId)?.name || t('common.document')
  }

  // Per-tab leading icon. Tool tabs reuse the glyph their toolbar
  // button uses (via TOOL_REGISTRY); document tabs pick an icon
  // based on the source's file kind, mirroring the DocumentBrowser's
  // iconForSource. Icons are coloured by tintFor below. Returns
  // null when no icon fits.
  const iconFor = (tabId: string): IconComponent | null => {
    if (isMapTab(tabId)) return TOOL_REGISTRY['relationship-map'].icon
    if (isQueryBuilderTab(tabId)) return TOOL_REGISTRY.queryBuilder.icon
    if (isAnalysisTab(tabId)) {
      const toolType = analysisTabs[tabId]?.toolType
      return toolType ? TOOL_REGISTRY[toolType]?.icon ?? null : null
    }
    if (isPreferencesTab(tabId)) return faGear
    if (isMergeTab(tabId)) return faGitMerge
    if (isNotebookTab(tabId)) return faNotebookPen
    const source = sourceMap.get(tabId)
    if (!source) return null
    if (source.sourceType === 'survey') return SURVEY_ICON
    // Prefer the declared sourceType; only sniff the name when it's unset.
    // Foreign QDPX imports name sources without extensions, so a name-only
    // sniff would mis-icon every media tab as a generic document.
    const st = ((source as { sourceType?: string }).sourceType || sourceTypeFromFilename(source.name)) as string
    if (st === 'audio') return faHeadphones
    if (st === 'video') return faVideo
    if (st === 'image') return faImage
    return faFile
  }

  // Per-tab icon style override, layered onto the shared muted-icon style
  // below. The merge toolbar button flips git-merge 180° (Magnolia merges
  // *into* the current project, the reverse of git's arrow) — the tab
  // icon matches it for the same reason.
  const iconStyleFor = (tabId: string): React.CSSProperties => {
    if (isMergeTab(tabId)) return { transform: 'scale(-1, -1)' }
    return {}
  }

  // Every tab icon is a palette icon (PALETTE_ICON_CLASS), coloured the
  // same as in the ribbon and the Document Browser. Document tabs also
  // pass their source type's colour. Empty (muted icon) on
  // High Contrast.
  const tint = useIconTint()
  const tintFor = (tabId: string): React.CSSProperties => {
    if (isMapTab(tabId) || isQueryBuilderTab(tabId) || isAnalysisTab(tabId)) return {}
    if (isPreferencesTab(tabId) || isMergeTab(tabId)) return {}
    if (isNotebookTab(tabId)) return tint('folder')
    const source = sourceMap.get(tabId)
    if (!source) return {}
    const st = ((source as { sourceType?: string }).sourceType || sourceTypeFromFilename(source.name)) as string
    return tint(iconTintKindForSourceType(st))
  }

  // Whether a tool tab has unsaved changes — drives the asterisk before
  // the tab title and feeds the close-tab confirm dialog. Document tabs
  // are never "dirty" in this sense; their content is autosaved as part
  // of the project file.
  const isDirty = (tabId: string): boolean => {
    if (isMapTab(tabId)) {
      const guid = mapGuidFromTabId(tabId)
      return !!(guid && maps[guid]?.dirty)
    }
    if (isAnalysisTab(tabId) || isQueryBuilderTab(tabId)) {
      return !!analysisTabs[tabId]?.dirty
    }
    return false
  }

  const handleDragStart = useCallback((e: React.DragEvent, guid: string) => {
    dragGuidRef.current = guid
    e.dataTransfer.setData('application/x-magnolia-tab', guid)
    e.dataTransfer.effectAllowed = 'move'
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, idx: number) => {
    if (!e.dataTransfer.types.includes('application/x-magnolia-tab')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverIdx(idx)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent, targetIdx: number) => {
    e.preventDefault()
    setDragOverIdx(null)
    const dragGuid = dragGuidRef.current
    if (!dragGuid) return
    const fromIdx = openTabs.indexOf(dragGuid)
    if (fromIdx === -1 || fromIdx === targetIdx) return
    const next = openTabs.filter((g) => g !== dragGuid)
    const insertIdx = targetIdx > fromIdx ? targetIdx - 1 : targetIdx
    next.splice(insertIdx, 0, dragGuid)
    onReorderTabs(next)
  }, [openTabs, onReorderTabs])

  const handleDragEnd = useCallback(() => {
    setDragOverIdx(null)
    dragGuidRef.current = null
  }, [])

  return (
    <div
      className="tab-bar"
      onDragLeave={(e) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
          setDragOverIdx(null)
        }
      }}
    >
      {openTabs.map((guid, i) => {
        const isActive = guid === activeTab
        const name = labelFor(guid)
        const dirty = isDirty(guid)
        const tabIcon = iconFor(guid)
        const mapGuid = isMapTab(guid) ? mapGuidFromTabId(guid) : null
        const isEditingThis = editingMapGuid !== null && editingMapGuid === mapGuid
        return (
          <div
            key={guid}
            className={`tab-item${isActive ? ' active' : ''}`}
            draggable={!isEditingThis}
            onDragStart={(e) => handleDragStart(e, guid)}
            onDragOver={(e) => handleDragOver(e, i)}
            onDrop={(e) => handleDrop(e, i)}
            onDragEnd={handleDragEnd}
            onClick={() => { if (!isEditingThis) onSelectTab(guid) }}
            onDoubleClick={() => {
              // Rename map tabs in place; document tabs stay read-only.
              if (mapGuid) {
                setEditingMapGuid(mapGuid)
                setEditName(maps[mapGuid]?.name ?? '')
              }
            }}
            onAuxClick={(e) => {
              if (e.button === 1) { e.preventDefault(); requestClose(guid) }
            }}
            style={{
              borderInlineStart: dragOverIdx === i ? '2px solid var(--accent)' : undefined,
            }}
          >
            {tabIcon && (
              <Icon
                icon={tabIcon}
                className={PALETTE_ICON_CLASS}
                style={{
                  fontSize: 13,
                  color: 'var(--text-muted)',
                  flexShrink: 0,
                  ...iconStyleFor(guid),
                  ...tintFor(guid)
                }}
              />
            )}
            {isEditingThis ? (
              <input
                autoFocus
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={() => {
                  if (mapGuid) setMapName(mapGuid, editName.trim() || t('tabs.untitledMap'))
                  setEditingMapGuid(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (mapGuid) setMapName(mapGuid, editName.trim() || t('tabs.untitledMap'))
                    setEditingMapGuid(null)
                  } else if (e.key === 'Escape') {
                    setEditingMapGuid(null)
                  }
                }}
                style={{
                  flex: 1, minWidth: 60, padding: '1px 4px',
                  font: 'inherit', color: 'var(--text-primary)',
                  background: 'var(--bg-primary)',
                  border: '1px solid var(--accent)', borderRadius: 3
                }}
              />
            ) : (
              <span className="tab-name">
                {dirty && (
                  <span
                    className="tab-dirty-marker"
                    title={t('tabs.unsavedChanges')}
                    aria-label={t('tabs.unsavedChanges')}
                  >
                    •&nbsp;
                  </span>
                )}
                {name}
              </span>
            )}
            <span
              className="tab-close"
              onClick={(e) => { e.stopPropagation(); requestClose(guid) }}
              title={t('tabs.closeTab')}
            >
              <Icon icon={faXmark} />
            </span>
          </div>
        )
      })}
      {pendingCloseTabId && (
        <div className="modal-overlay" onClick={handleDialogCancel}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ minWidth: 360 }}>
            <h2>{t('tabs.unsavedChanges')}</h2>
            <p style={{ margin: '8px 0 16px', color: 'var(--text-secondary)' }}>
              {t('tabs.unsavedQuestion', { name: labelFor(pendingCloseTabId) })}
            </p>
            <div className="modal-actions">
              <button className="secondary" onClick={handleDialogCancel}>
                {t('common.cancel')}
              </button>
              <button className="secondary" onClick={handleDialogDiscard}>
                {t('common.discard')}
              </button>
              <button onClick={handleDialogSave}>
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
