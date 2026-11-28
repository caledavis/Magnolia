import { describe, it, expect, beforeEach } from 'vitest'
import { queueSave, savesSettled } from '../../src/renderer/app/save-queue'
import { useProjectStore, editGeneration } from '../../src/renderer/stores/project-store'

// Edits made while a save is writing aren't in the file: the project must
// stay unsaved after it, and saves must finish in the order they began.

beforeEach(() => {
  useProjectStore.setState({ isDirty: false, checkoutMarker: null, newerFormat: null })
})

describe('marking a save done', () => {
  it('leaves the project unsaved when it was edited while saving', () => {
    useProjectStore.getState().markDirty()
    const generation = editGeneration()
    // The save is writing; another edit comes in.
    useProjectStore.getState().markDirty()
    expect(useProjectStore.getState().markSavedAt(generation)).toBe(false)
    expect(useProjectStore.getState().isDirty).toBe(true)
  })

  it('marks it saved when nothing changed meanwhile', () => {
    useProjectStore.getState().markDirty()
    const generation = editGeneration()
    expect(useProjectStore.getState().markSavedAt(generation)).toBe(true)
    expect(useProjectStore.getState().isDirty).toBe(false)
  })

  it('counts renames and saved analyses as edits too', () => {
    const generation = editGeneration()
    useProjectStore.getState().setName('Renamed')
    expect(useProjectStore.getState().markSavedAt(generation)).toBe(false)
  })
})

describe('queueSave', () => {
  it('runs one save at a time, in the order asked', async () => {
    const log: string[] = []
    let release: () => void = () => {}
    const slow = queueSave(() => new Promise<void>((r) => { log.push('slow start'); release = () => { log.push('slow end'); r() } }))
    const quick = queueSave(async () => { log.push('quick') })
    await Promise.resolve()
    await Promise.resolve()
    expect(log).toEqual(['slow start'])
    release()
    await Promise.all([slow, quick])
    expect(log).toEqual(['slow start', 'slow end', 'quick'])
  })

  it('goes on after a save that failed', async () => {
    const failed = queueSave(async () => { throw new Error('disk full') })
    const next = queueSave(async () => 'saved')
    await expect(failed).rejects.toThrow('disk full')
    await expect(next).resolves.toBe('saved')
    await savesSettled()
  })
})
