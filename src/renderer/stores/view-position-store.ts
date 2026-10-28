import { useProjectStore } from './project-store'

/**
 * Where the reader was in each document, so reopening the project (or
 * coming back from a tool tab, which unmounts the viewers) returns to the
 * same place instead of page 1. Viewers use it through useRememberedScroll.
 *
 * A position is the top of the visible area as a fraction of the
 * document's scroll height, so it survives a PDF opening at a different
 * zoom and, roughly, text reflowing at a different window width. Keys are
 * source guids, or finer keys for documents with several views; a viewer
 * can also keep a small string setting, such as which survey respondent
 * was open.
 *
 * Positions are kept per project file in this computer's web storage, not
 * in the project: where someone is reading is personal, and writing it
 * into the .qdpx would stamp the file as edited by them (and check it out)
 * just because they scrolled.
 */

const KEY_PREFIX = 'magnolia.viewPositions:'
const WRITE_DELAY_MS = 500

/** project file path → (key → fraction or setting). '' holds an unsaved project's positions for the session only. */
const cache = new Map<string, Record<string, number | string>>()
const unwritten = new Set<string>()
let writeTimer: ReturnType<typeof setTimeout> | null = null

function currentProject(): string {
  return useProjectStore.getState().filePath ?? ''
}

function readStored(project: string): Record<string, number | string> {
  if (!project) return {}
  try {
    const stored = JSON.parse(localStorage.getItem(KEY_PREFIX + project) ?? '{}')
    return stored && typeof stored === 'object' ? stored : {}
  } catch {
    return {} // unavailable or corrupt storage: start fresh
  }
}

function positionsFor(project: string): Record<string, number | string> {
  const cached = cache.get(project)
  if (cached) return cached
  const positions = readStored(project)
  cache.set(project, positions)
  return positions
}

/** Write pending positions to web storage now rather than after the delay. */
export function flushViewPositions(): void {
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = null
  for (const project of unwritten) {
    try {
      localStorage.setItem(KEY_PREFIX + project, JSON.stringify(cache.get(project) ?? {}))
    } catch { /* storage full or unavailable: positions last for this session only */ }
  }
  unwritten.clear()
}

function put(key: string, value: number | string): void {
  const project = currentProject()
  const positions = positionsFor(project)
  if (positions[key] === value) return
  positions[key] = value
  if (!project) return
  unwritten.add(project)
  if (!writeTimer) writeTimer = setTimeout(flushViewPositions, WRITE_DELAY_MS)
}

/** The saved position under `key` in the open project, as a 0–1 fraction. */
export function getViewPosition(key: string): number | undefined {
  const fraction = positionsFor(currentProject())[key]
  return typeof fraction === 'number' && Number.isFinite(fraction) ? fraction : undefined
}

/** Remember `scrollTop` within `scrollHeight` under `key` in the open project. */
export function setViewPosition(key: string, scrollTop: number, scrollHeight: number): void {
  if (!(scrollHeight > 0)) return
  put(key, Math.round(Math.min(1, Math.max(0, scrollTop / scrollHeight)) * 10000) / 10000)
}

/** A viewer's saved string setting under `key` in the open project. */
export function getViewSetting(key: string): string | undefined {
  const value = positionsFor(currentProject())[key]
  return typeof value === 'string' ? value : undefined
}

export function setViewSetting(key: string, value: string): void {
  put(key, value)
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', flushViewPositions)
