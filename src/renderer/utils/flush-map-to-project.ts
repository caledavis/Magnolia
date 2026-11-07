/**
 * Persist a single relationship-map instance into project.savedAnalyses.
 * Used by the inline map's Save Analysis / Update Analysis click and by
 * the TabBar's unsaved-changes dialog when the user picks Save while
 * closing a dirty map tab.
 */
import { useProjectStore } from '../stores/project-store'
import type { MapInstance } from '../stores/relationship-map-store'
import { t } from '../i18n'

export function flushMapToProject(map: MapInstance): void {
  const ps = useProjectStore.getState()
  const existing = ps.savedAnalyses ?? []
  const idx = existing.findIndex((a) => a.guid === map.guid)
  const now = new Date().toISOString()
  const entry = {
    guid: map.guid,
    toolType: 'relationship-map' as any,
    name: map.name?.trim() || t('app.relationshipMap'),
    config: {
      elements: map.elements,
      freeTexts: map.freeTexts,
      connections: map.connections,
      pan: map.pan
    },
    createdDateTime: idx >= 0 ? existing[idx].createdDateTime : now,
    modifiedDateTime: now
  }
  if (idx >= 0) {
    const next = [...existing]
    next[idx] = entry
    ps.setSavedAnalyses(next)
  } else {
    ps.setSavedAnalyses([...existing, entry])
  }
}
