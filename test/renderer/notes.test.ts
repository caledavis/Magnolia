import { describe, it, expect, beforeEach } from 'vitest'
import { useDocumentStore } from '../../src/renderer/stores/document-store'
import { useMemoStore } from '../../src/renderer/stores/memo-store'
import { useQuoteStore } from '../../src/renderer/stores/quote-store'
import { useProjectStore } from '../../src/renderer/stores/project-store'
import { formatNoteStamp, noteName, sortNotes, toDateTimeLocal, fromDateTimeLocal, continueListEdit } from '../../src/renderer/utils/notes'
import type { TextSource } from '../../src/renderer/models/types'
import { getFormat } from '../../src/renderer/utils/format-registry'
import { categoryOfSource } from '../../src/renderer/utils/document-graph'

beforeEach(() => {
  useMemoStore.setState({ memos: [] })
  useQuoteStore.setState({ quotes: [] })
  useDocumentStore.setState({ sources: [], sourceContents: {}, folders: [], sourceFolder: {} })
  useProjectStore.setState({ users: [], isDirty: false })
})

// Local-time ISO, so the stamp doesn't depend on the test machine's zone.
const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).toISOString()

describe('note names', () => {
  it('stamps YYMMDD HH:MM in local time', () => {
    expect(formatNoteStamp(local(2026, 10, 7, 9, 5))).toBe('261007 09:05')
  })

  it('is "stamp - title", or just the stamp while untitled', () => {
    const noteDateTime = local(2026, 10, 27, 14, 32)
    expect(noteName({ title: 'Market observation', noteDateTime })).toBe('261027 14:32 - Market observation')
    expect(noteName({ title: '  ', noteDateTime })).toBe('261027 14:32')
  })

  it('round-trips through a datetime-local value', () => {
    const iso = local(2026, 1, 2, 3, 4)
    expect(toDateTimeLocal(iso)).toBe('2026-01-02T03:04')
    expect(fromDateTimeLocal(toDateTimeLocal(iso))).toBe(iso)
    expect(fromDateTimeLocal('')).toBeNull()
  })

  it('sorts newest observation first', () => {
    const mk = (guid: string, noteDateTime: string): TextSource =>
      ({ guid, name: guid, sourceType: 'note', formatData: { title: '', noteDateTime }, selections: [] })
    const sorted = sortNotes([mk('old', local(2026, 1, 1, 0, 0)), mk('new', local(2026, 6, 1, 0, 0)), mk('mid', local(2026, 3, 1, 0, 0))])
    expect(sorted.map((s) => s.guid)).toEqual(['new', 'mid', 'old'])
  })
})

describe('notebooks in the document store', () => {
  it('creates an empty note inside the notebook', () => {
    const ds = useDocumentStore.getState()
    const nb = ds.addFolder('Field notes', null, 'notebook')
    const guid = useDocumentStore.getState().addNote(nb)
    const state = useDocumentStore.getState()
    const note = state.sources.find((s) => s.guid === guid)!
    expect(note.sourceType).toBe('note')
    expect(state.sourceContents[guid]).toBe('')
    expect(state.sourceFolder[guid]).toBe(nb)
    expect(note.name).toBe(formatNoteStamp(note.formatData.noteDateTime))
  })

  it('renames a note from its title and timestamp', () => {
    const nb = useDocumentStore.getState().addFolder('NB', null, 'notebook')
    const guid = useDocumentStore.getState().addNote(nb)
    useDocumentStore.getState().updateNote(guid, { title: 'Lunch queue', noteDateTime: local(2026, 10, 1, 12, 0) })
    expect(useDocumentStore.getState().sources.find((s) => s.guid === guid)!.name).toBe('261001 12:00 - Lunch queue')
  })

  it('keeps notes in notebooks and other documents out of them', () => {
    const ds = useDocumentStore.getState()
    const nb = ds.addFolder('NB', null, 'notebook')
    const nb2 = ds.addFolder('NB2', null, 'notebook')
    const folder = ds.addFolder('Folder')
    const note = useDocumentStore.getState().addNote(nb)
    const doc = useDocumentStore.getState().addSource('doc.txt', 'hello')

    const { moveSourceToFolder } = useDocumentStore.getState()
    moveSourceToFolder(note, null)
    moveSourceToFolder(note, folder)
    moveSourceToFolder(doc, nb)
    expect(useDocumentStore.getState().sourceFolder).toEqual({ [note]: nb })

    moveSourceToFolder(note, nb2)
    moveSourceToFolder(doc, folder)
    expect(useDocumentStore.getState().sourceFolder).toEqual({ [note]: nb2, [doc]: folder })
  })

  it('nests notebooks in folders but nothing in notebooks', () => {
    const ds = useDocumentStore.getState()
    const nb = ds.addFolder('NB', null, 'notebook')
    const folder = ds.addFolder('Folder')
    useDocumentStore.getState().moveFolderToFolder(folder, nb)
    useDocumentStore.getState().moveFolderToFolder(nb, folder)
    const sub = useDocumentStore.getState().addFolder('Sub', nb)
    const byGuid = new Map(useDocumentStore.getState().folders.map((f) => [f.guid, f]))
    expect(byGuid.get(folder)!.parentGuid).toBeNull()
    expect(byGuid.get(nb)!.parentGuid).toBe(folder)
    expect(byGuid.get(sub)!.parentGuid).toBeNull()
  })

  it('deleting a notebook deletes its notes; deleting its folder keeps it', () => {
    const ds = useDocumentStore.getState()
    const folder = ds.addFolder('Folder')
    const nb = ds.addFolder('NB', folder, 'notebook')
    const note = useDocumentStore.getState().addNote(nb)

    useDocumentStore.getState().removeFolder(folder)
    let state = useDocumentStore.getState()
    expect(state.folders.find((f) => f.guid === nb)?.parentGuid).toBeNull()
    expect(state.sourceFolder[note]).toBe(nb)

    useDocumentStore.getState().removeFolder(nb)
    state = useDocumentStore.getState()
    expect(state.folders).toEqual([])
    expect(state.sources).toEqual([])
    expect(state.sourceFolder).toEqual({})
  })

  it('shifts codings when a note is edited', () => {
    const nb = useDocumentStore.getState().addFolder('NB', null, 'notebook')
    const guid = useDocumentStore.getState().addNote(nb)
    useDocumentStore.getState().applyTranscriptEdit(guid, 'The queue was long.')
    const sel = useDocumentStore.getState().addSelection(guid, 4, 9, 'queue')
    useDocumentStore.getState().applyTranscriptEdit(guid, 'At noon the queue was long.')
    const moved = useDocumentStore.getState().sources.find((s) => s.guid === guid)!.selections.find((s) => s.guid === sel)!
    expect([moved.startPosition, moved.endPosition]).toEqual([12, 17])
  })
})

describe('note formatting', () => {
  const blocks = (sourceType: string, text: string) => getFormat(sourceType).parseDocument(text)!.map((l) => l.blockClass)

  it('does not turn a line into a heading when a list is started under it', () => {
    expect(blocks('note', 'Arrived at nine\n-')).toEqual(['', ''])
    expect(blocks('note', 'Arrived at nine\n- queue')).toEqual(['', 'md-list-item'])
    expect(blocks('note', 'Arrived at nine\n===')).toEqual(['', ''])
  })

  it('still reads setext headings in imported Markdown', () => {
    expect(blocks('markdown', 'Title\n-')[0]).toBe('md-heading-2')
  })
})

describe('lists in notes', () => {
  const enter = (text: string) => {
    const at = [...text].length
    const e = continueListEdit(text, at, at)
    if (!e) return null
    const cps = [...text]
    return cps.slice(0, e.start).join('') + e.insert + cps.slice(e.end).join('')
  }

  it('keeps list markers visible', () => {
    const line = getFormat('note').parseDocument('- queue')![0]
    expect(line.blockClass).toBe('md-list-item')
    expect(line.inline.some((r) => r.hidden)).toBe(false)
  })

  it('continues bullets, numbers and tasks on Enter', () => {
    expect(enter('- queue')).toBe('- queue\n- ')
    expect(enter('  * nested')).toBe('  * nested\n  * ')
    expect(enter('9. ninth')).toBe('9. ninth\n10. ')
    expect(enter('- [x] done')).toBe('- [x] done\n- [ ] ')
  })

  it('ends the list on Enter in an empty item', () => {
    expect(enter('- queue\n- ')).toBe('- queue\n')
  })

  it('leaves other lines and carets inside the marker alone', () => {
    expect(enter('plain line')).toBeNull()
    expect(continueListEdit('- queue', 1, 1)).toBeNull()
  })
})

describe('inline Markdown across a paragraph', () => {
  const styled = (text: string) => getFormat('note').parseDocument(text)!.map((l) => l.inline.filter((r) => !r.hidden).length)

  it('formats every line of a multi-line paragraph, not just the first', () => {
    expect(styled('A **bold** word\nAn *italic* word\nSome ~~struck~~ `code`')).toEqual([1, 1, 2])
  })

  it('formats a span that crosses a line break on both lines', () => {
    expect(styled('**starts here\nends here**')).toEqual([1, 1])
  })
})

describe('notes in the Document Selector', () => {
  it('are their own document type', () => {
    expect(categoryOfSource({ name: '261027 14:32 - Market.mp3', sourceType: 'note' })).toBe('note')
    expect(categoryOfSource({ name: 'interview.txt' })).toBe('document')
  })
})
