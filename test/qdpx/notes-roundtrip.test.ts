import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const userDataDir = mkdtempSync(join(tmpdir(), 'magnolia-userdata-'))
vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test', getPath: () => userDataDir } }))

import { writeQdpx } from '../../src/main/qdpx/writer'
import { readQdpx } from '../../src/main/qdpx/reader'
import type { Project } from '../../src/renderer/models/types'

const NOTE = '11111111-1111-4111-8111-111111111111'
const NOTEBOOK = '22222222-2222-4222-8222-222222222222'
const CODE = '33333333-3333-4333-8333-333333333333'

const dir = mkdtempSync(join(tmpdir(), 'magnolia-notes-'))

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('notes and notebooks survive a save and reopen', () => {
  it('keeps the note type, title, timestamp, text, coding and notebook', async () => {
    const noteDateTime = '2026-10-27T03:32:00.000Z'
    const project: Project = {
      name: 'Notes', origin: 'test', users: [], sets: [], notes: [],
      codes: [{ guid: CODE, name: 'Queue', isCodable: true, children: [] }],
      sources: [{
        guid: NOTE,
        name: '261027 14:32 - Market',
        sourceType: 'note',
        formatData: { title: 'Market', noteDateTime },
        selections: [{ guid: '44444444-4444-4444-8444-444444444444', name: 'queue', startPosition: 4, endPosition: 9, codings: [{ guid: '55555555-5555-4555-8555-555555555555', codeGuid: CODE }] }]
      }],
      folders: [{ guid: NOTEBOOK, name: 'Field notes', parentGuid: null, kind: 'notebook' }],
      sourceFolder: { [NOTE]: NOTEBOOK }
    }
    const path = join(dir, 'notes.qdpx')
    await writeQdpx(path, project, { [NOTE]: 'The **queue** was long.' })

    const back = await readQdpx(path)
    const note = back.sources.find((s) => s.guid === NOTE)!
    expect(note.sourceType).toBe('note')
    expect(note.name).toBe('261027 14:32 - Market')
    expect(note.formatData).toEqual({ title: 'Market', noteDateTime })
    expect(back.sourceContents[NOTE]).toBe('The **queue** was long.')
    expect(note.selections.map((s) => [s.startPosition, s.endPosition, s.codings[0].codeGuid])).toEqual([[4, 9, CODE]])
    expect(back.folders).toEqual([{ guid: NOTEBOOK, name: 'Field notes', parentGuid: null, kind: 'notebook' }])
    expect(back.sourceFolder).toEqual({ [NOTE]: NOTEBOOK })
  })
})
