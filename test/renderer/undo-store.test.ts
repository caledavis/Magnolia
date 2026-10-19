import { describe, it, expect, beforeEach } from 'vitest'
import { useUndoStore } from '../../src/renderer/stores/undo-store'
import { useCodeStore } from '../../src/renderer/stores/code-store'
import { useQueryStore } from '../../src/renderer/stores/query-store'
import type { Code } from '../../src/renderer/models/types'

// Undo capture compares slice references (stores update immutably) rather
// than serialising the whole project on every change.

const DEBOUNCE = 600
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const code = (name: string): Code => ({ guid: 'a', name, isCodable: true, children: [] }) as Code

beforeEach(async () => {
  useCodeStore.setState({ codes: [code('Start')] })
  await wait(DEBOUNCE)
  useUndoStore.getState().clearHistory()
})

describe('undo capture', () => {
  it('records a change as one undo step and restores it', async () => {
    useCodeStore.setState({ codes: [code('One')] })
    useCodeStore.setState({ codes: [code('Two')] })
    await wait(DEBOUNCE)
    expect(useUndoStore.getState().undoStack).toHaveLength(1)

    useUndoStore.getState().undo()
    expect(useCodeStore.getState().codes[0].name).toBe('Start')
    useUndoStore.getState().redo()
    expect(useCodeStore.getState().codes[0].name).toBe('Two')
  })

  it('ignores updates that leave every captured slice untouched', async () => {
    useQueryStore.setState({ isLoading: true })
    useQueryStore.setState({ isLoading: false })
    const codes = useCodeStore.getState().codes
    useCodeStore.setState({ codes })
    await wait(DEBOUNCE)
    expect(useUndoStore.getState().undoStack).toHaveLength(0)
  })

  it('keeps the held snapshot unaffected by later edits', async () => {
    useCodeStore.setState({ codes: [code('Edited')] })
    await wait(DEBOUNCE)
    useCodeStore.setState({ codes: [code('Later')] })
    await wait(DEBOUNCE)
    useUndoStore.getState().undo()
    expect(useCodeStore.getState().codes[0].name).toBe('Edited')
    useUndoStore.getState().undo()
    expect(useCodeStore.getState().codes[0].name).toBe('Start')
  })
})
