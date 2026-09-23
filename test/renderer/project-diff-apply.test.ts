import { describe, it, expect, beforeEach, vi } from 'vitest'
import { applyMerge, emptyApplyPlan, resolveBinarySources, dedupeIdenticalSources, type ApplyPlan } from '../../src/renderer/utils/project-diff-apply'
import { useCodeStore } from '../../src/renderer/stores/code-store'
import { useTagStore } from '../../src/renderer/stores/tag-store'
import { useMemoStore } from '../../src/renderer/stores/memo-store'
import { useQuoteStore } from '../../src/renderer/stores/quote-store'
import { useLogbookStore } from '../../src/renderer/stores/logbook-store'
import { useDocumentStore } from '../../src/renderer/stores/document-store'
import { useProjectStore } from '../../src/renderer/stores/project-store'
import type { Code, TextSource } from '../../src/renderer/models/types'
import type { CodeDiffItem, SourceDiffItem } from '../../src/renderer/utils/project-diff'

beforeEach(() => {
  useCodeStore.setState({ codes: [] })
  useTagStore.setState({ tags: [], categories: [] })
  useMemoStore.setState({ memos: [] })
  useQuoteStore.setState({ quotes: [] })
  useLogbookStore.setState({ entries: [] })
  useDocumentStore.setState({ sources: [], sourceContents: {}, folders: [], sourceFolder: {} })
  useProjectStore.setState({ users: [], savedAnalyses: [], isDirty: false })
})

describe('applyMerge — codes', () => {
  it('adds a code from theirs, preserving its original guid', () => {
    const plan: ApplyPlan = emptyApplyPlan()
    const theirsCode: Code = { guid: 'new-code', name: 'New', isCodable: true, children: [] }
    plan.codes = [{ guid: 'new-code', bucket: 'onlyTheirs', theirs: theirsCode }]
    applyMerge(plan)
    expect(useCodeStore.getState().codes).toEqual([theirsCode])
  })

  it('removes a code approved as onlyMine', () => {
    useCodeStore.setState({ codes: [{ guid: 'a', name: 'A', isCodable: true, children: [] }] })
    const plan: ApplyPlan = emptyApplyPlan()
    plan.codes = [{ guid: 'a', bucket: 'onlyMine', mine: { guid: 'a', name: 'A', isCodable: true, children: [] } }]
    applyMerge(plan)
    expect(useCodeStore.getState().codes).toEqual([])
  })

  it('patches only the changed fields for a bothDiffer code, leaving others intact', () => {
    useCodeStore.setState({ codes: [{ guid: 'a', name: 'Old', color: '#111', isCodable: true, children: [] }] })
    const theirsCode: Code = { guid: 'a', name: 'New', color: '#111', isCodable: true, children: [] }
    const plan: ApplyPlan = emptyApplyPlan()
    const item: CodeDiffItem = { guid: 'a', bucket: 'bothDiffer', theirs: theirsCode, changedFields: ['name'] }
    plan.codes = [item]
    applyMerge(plan)
    expect(useCodeStore.getState().codes).toEqual([{ guid: 'a', name: 'New', color: '#111', isCodable: true, children: [] }])
  })

  it('moves a code to its new parent', () => {
    useCodeStore.setState({
      codes: [
        { guid: 'p1', name: 'P1', isCodable: true, children: [{ guid: 'child', name: 'Child', isCodable: true, children: [] }] },
        { guid: 'p2', name: 'P2', isCodable: true, children: [] }
      ]
    })
    const plan: ApplyPlan = emptyApplyPlan()
    const item: CodeDiffItem = {
      guid: 'child',
      bucket: 'bothDiffer',
      theirs: { guid: 'child', name: 'Child', isCodable: true, children: [] },
      changedFields: [],
      moved: { fromParentGuid: 'p1', toParentGuid: 'p2' }
    }
    plan.codes = [item]
    applyMerge(plan)
    const tree = useCodeStore.getState().codes
    expect(tree.find((c) => c.guid === 'p1')?.children).toEqual([])
    expect(tree.find((c) => c.guid === 'p2')?.children).toEqual([{ guid: 'child', name: 'Child', isCodable: true, children: [] }])
  })
})

describe('applyMerge — flat guid-keyed categories', () => {
  it('adds, removes, and replaces tags in one batch via the bulk setter', () => {
    useTagStore.setState({
      tags: [
        { guid: 'keep', name: 'Keep', memberSourceGuids: [], memberCodeGuids: [] },
        { guid: 'remove-me', name: 'Remove', memberSourceGuids: [], memberCodeGuids: [] }
      ]
    })
    const plan: ApplyPlan = emptyApplyPlan()
    plan.tags = [
      { guid: 'remove-me', bucket: 'onlyMine' },
      { guid: 'add-me', bucket: 'onlyTheirs', theirs: { guid: 'add-me', name: 'Added', memberSourceGuids: [], memberCodeGuids: [] } }
    ]
    applyMerge(plan)
    const guids = useTagStore.getState().tags.map((t) => t.guid).sort()
    expect(guids).toEqual(['add-me', 'keep'])
  })

  it('adds a memo via addMemoFromDraft-equivalent bulk splice, preserving its guid', () => {
    const plan: ApplyPlan = emptyApplyPlan()
    plan.memos = [{
      guid: 'm1',
      bucket: 'onlyTheirs',
      theirs: { guid: 'm1', type: 'project', title: 'A memo', content: 'hello', createdDateTime: '2024-01-01' }
    }]
    applyMerge(plan)
    expect(useMemoStore.getState().memos).toHaveLength(1)
    expect(useMemoStore.getState().memos[0].guid).toBe('m1')
  })

  it('replaces a quote with theirs version for a bothDiffer item (no update API, so this is remove+add under the hood)', () => {
    useQuoteStore.setState({ quotes: [{ guid: 'q1', sourceGuid: 's1', sourceName: 'Doc', startPosition: 0, endPosition: 5, text: 'hello', createdDateTime: '2024-01-01' }] })
    const plan: ApplyPlan = emptyApplyPlan()
    plan.quotes = [{
      guid: 'q1',
      bucket: 'bothDiffer',
      theirs: { guid: 'q1', sourceGuid: 's1', sourceName: 'Doc', startPosition: 0, endPosition: 5, text: 'howdy', createdDateTime: '2024-01-01' },
      changedFields: ['text']
    }]
    applyMerge(plan)
    expect(useQuoteStore.getState().quotes).toEqual([{ guid: 'q1', sourceGuid: 's1', sourceName: 'Doc', startPosition: 0, endPosition: 5, text: 'howdy', createdDateTime: '2024-01-01' }])
  })

  it('marks the project dirty after applying any change', () => {
    const plan: ApplyPlan = emptyApplyPlan()
    plan.logbookEntries = [{ guid: 'l1', bucket: 'onlyTheirs', theirs: { guid: 'l1', title: 'T', content: 'C', createdDateTime: '2024-01-01' } }]
    applyMerge(plan)
    expect(useProjectStore.getState().isDirty).toBe(true)
  })

  it('does nothing and stays clean when the plan is empty', () => {
    applyMerge(emptyApplyPlan())
    expect(useProjectStore.getState().isDirty).toBe(false)
  })
})

describe('applyMerge — sources (whole documents)', () => {
  const baseSource = (guid: string, overrides: Partial<TextSource> = {}): TextSource => ({
    guid, name: `${guid}.txt`, sourceType: 'text', selections: [], ...overrides
  })

  it('adds a new document from theirs, including its content', () => {
    const plan: ApplyPlan = emptyApplyPlan()
    const theirsSource = baseSource('new-doc')
    plan.sources = [{ guid: 'new-doc', bucket: 'onlyTheirs', theirs: theirsSource, theirsContent: 'hello world' }]
    applyMerge(plan)
    expect(useDocumentStore.getState().sources).toEqual([theirsSource])
    expect(useDocumentStore.getState().sourceContents['new-doc']).toBe('hello world')
  })

  it('skips adding a still-unresolved binary onlyTheirs document (resolveBinarySources should have run first)', () => {
    const plan: ApplyPlan = emptyApplyPlan()
    const theirsPdf = baseSource('pdf1', { sourceType: 'pdf' })
    plan.sources = [{ guid: 'pdf1', bucket: 'onlyTheirs', theirs: theirsPdf, binary: true }]
    applyMerge(plan)
    expect(useDocumentStore.getState().sources).toEqual([])
  })

  it('adds a binary-backed document once its handle has been resolved (binary: false)', () => {
    const plan: ApplyPlan = emptyApplyPlan()
    const resolvedPdf = baseSource('pdf1', { sourceType: 'pdf', formatData: { pdfFilePath: 'magnolia-bin://overlay/tok1.pdf' } })
    plan.sources = [{ guid: 'pdf1', bucket: 'onlyTheirs', theirs: resolvedPdf, binary: false, theirsContent: 'extracted text' }]
    applyMerge(plan)
    expect(useDocumentStore.getState().sources).toEqual([resolvedPdf])
    expect(useDocumentStore.getState().sourceContents['pdf1']).toBe('extracted text')
  })

  it('removes a document approved as onlyMine, dropping its content too', () => {
    const mineSource = baseSource('mine-only')
    useDocumentStore.setState({ sources: [mineSource], sourceContents: { 'mine-only': 'text' } })
    const plan: ApplyPlan = emptyApplyPlan()
    plan.sources = [{ guid: 'mine-only', bucket: 'onlyMine', mine: mineSource }]
    applyMerge(plan)
    expect(useDocumentStore.getState().sources).toEqual([])
    expect(useDocumentStore.getState().sourceContents).toEqual({})
  })

  it('renames a document for an approved bothDiffer item', () => {
    const mineSource = baseSource('r1', { name: 'old.txt' })
    useDocumentStore.setState({ sources: [mineSource], sourceContents: { r1: 'text' } })
    const plan: ApplyPlan = emptyApplyPlan()
    plan.sources = [{ guid: 'r1', bucket: 'bothDiffer', mine: mineSource, theirs: baseSource('r1', { name: 'new.txt' }), changedFields: ['name'] }]
    applyMerge(plan)
    expect(useDocumentStore.getState().sources[0].name).toBe('new.txt')
  })
})

describe('resolveBinarySources', () => {
  const pdfItem = (): SourceDiffItem => ({
    guid: 'pdf1',
    bucket: 'onlyTheirs',
    binary: true,
    theirs: { guid: 'pdf1', name: 'pdf1.pdf', sourceType: 'pdf', selections: [], formatData: { pdfFilePath: 'magnolia-bin://archive/pdf1.pdf' } },
    theirsContent: 'extracted text'
  })

  it('replaces the handle with the one importBinary returns, and clears binary', async () => {
    const importBinary = vi.fn().mockResolvedValue('magnolia-bin://overlay/tok1.pdf')
    const [resolved] = await resolveBinarySources([pdfItem()], '/path/to/compare.qdpx', importBinary)
    expect(importBinary).toHaveBeenCalledWith('/path/to/compare.qdpx', 'magnolia-bin://archive/pdf1.pdf')
    expect(resolved.binary).toBe(false)
    expect((resolved.theirs!.formatData as any).pdfFilePath).toBe('magnolia-bin://overlay/tok1.pdf')
  })

  it('drops an item whose binary could not be recovered, rather than passing through a broken handle', async () => {
    const importBinary = vi.fn().mockResolvedValue(null)
    const resolved = await resolveBinarySources([pdfItem()], '/path/to/compare.qdpx', importBinary)
    expect(resolved).toEqual([])
  })

  it('passes non-binary and non-onlyTheirs items through untouched, without calling importBinary', async () => {
    const importBinary = vi.fn()
    const textAdd: SourceDiffItem = { guid: 't1', bucket: 'onlyTheirs', binary: false, theirs: { guid: 't1', name: 't1.txt', sourceType: 'text', selections: [] }, theirsContent: 'hi' }
    const removal: SourceDiffItem = { guid: 'r1', bucket: 'onlyMine', mine: { guid: 'r1', name: 'r1.txt', sourceType: 'text', selections: [] } }
    const resolved = await resolveBinarySources([textAdd, removal], '/path/to/compare.qdpx', importBinary)
    expect(resolved).toEqual([textAdd, removal])
    expect(importBinary).not.toHaveBeenCalled()
  })
})

describe('dedupeIdenticalSources', () => {
  // The reported scenario: the SAME image independently imported into
  // both projects (so each has its own guid), surfacing as a spurious
  // onlyMine + onlyTheirs pair even though it's one file, not two.
  const mineImage: SourceDiffItem = {
    guid: 'mine-guid',
    bucket: 'onlyMine',
    mine: { guid: 'mine-guid', name: 'SG200991.jpeg', sourceType: 'image', selections: [], formatData: { imageFilePath: 'magnolia-bin://archive/mine-guid.jpeg' } }
  }
  const theirsImage: SourceDiffItem = {
    guid: 'theirs-guid',
    bucket: 'onlyTheirs',
    binary: true,
    theirs: { guid: 'theirs-guid', name: 'SG200991.jpeg', sourceType: 'image', selections: [], formatData: { imageFilePath: 'magnolia-bin://archive/theirs-guid.jpeg' } }
  }
  const otherOnlyMine: SourceDiffItem = { guid: 'unrelated', bucket: 'onlyMine', mine: { guid: 'unrelated', name: 'file.txt', sourceType: 'text', selections: [] } }

  it('drops a same-name, same-type onlyMine/onlyTheirs pair once their actual bytes are confirmed identical', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const readMineBinary = vi.fn().mockResolvedValue(bytes)
    const readTheirsBinary = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4]))
    const result = await dedupeIdenticalSources([mineImage, theirsImage, otherOnlyMine], {}, {}, '/compare.qdpx', readMineBinary, readTheirsBinary)
    expect(result).toEqual([otherOnlyMine])
    expect(readMineBinary).toHaveBeenCalledWith('magnolia-bin://archive/mine-guid.jpeg', 'image')
    expect(readTheirsBinary).toHaveBeenCalledWith('/compare.qdpx', 'magnolia-bin://archive/theirs-guid.jpeg')
  })

  it('keeps a same-name, same-type pair whose bytes actually differ (different photos, same filename)', async () => {
    const readMineBinary = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]))
    const readTheirsBinary = vi.fn().mockResolvedValue(new Uint8Array([9, 9, 9]))
    const result = await dedupeIdenticalSources([mineImage, theirsImage], {}, {}, '/compare.qdpx', readMineBinary, readTheirsBinary)
    expect(result).toEqual([mineImage, theirsImage])
  })

  it('never collapses documents with different names, even with identical content, without fetching bytes', async () => {
    const differentName: SourceDiffItem = {
      guid: 'other-guid',
      bucket: 'onlyTheirs',
      binary: true,
      theirs: { guid: 'other-guid', name: 'different-name.jpeg', sourceType: 'image', selections: [], formatData: { imageFilePath: 'magnolia-bin://archive/other-guid.jpeg' } }
    }
    const readMineBinary = vi.fn()
    const readTheirsBinary = vi.fn()
    const result = await dedupeIdenticalSources([mineImage, differentName], {}, {}, '/compare.qdpx', readMineBinary, readTheirsBinary)
    expect(result).toEqual([mineImage, differentName])
    expect(readMineBinary).not.toHaveBeenCalled()
  })

  it('dedupes text documents by sourceContents alone, with no binary fetch at all', async () => {
    const mineText: SourceDiffItem = { guid: 'mt', bucket: 'onlyMine', mine: { guid: 'mt', name: 'notes.txt', sourceType: 'text', selections: [] } }
    const theirsText: SourceDiffItem = { guid: 'tt', bucket: 'onlyTheirs', binary: false, theirs: { guid: 'tt', name: 'notes.txt', sourceType: 'text', selections: [] } }
    const readMineBinary = vi.fn()
    const readTheirsBinary = vi.fn()
    const result = await dedupeIdenticalSources(
      [mineText, theirsText], { mt: 'identical content' }, { tt: 'identical content' }, '/compare.qdpx', readMineBinary, readTheirsBinary
    )
    expect(result).toEqual([])
    expect(readMineBinary).not.toHaveBeenCalled()
  })
})

describe('applyMerge — document text, coarse codings, and itemized codings', () => {
  const baseSource = (guid: string): TextSource => ({ guid, name: `${guid}.txt`, sourceType: 'text', selections: [] })

  it('replaces text and wholesale-replaces selections for an approved coarse item', () => {
    const mineSource: TextSource = { ...baseSource('s1'), selections: [{ guid: 'sel-mine', startPosition: 0, endPosition: 5, codings: [{ guid: 'c1', codeGuid: 'codeA' }] }] }
    const theirsSelections = [{ guid: 'sel-theirs', startPosition: 0, endPosition: 6, codings: [{ guid: 'c2', codeGuid: 'codeB' }] }]
    useDocumentStore.setState({ sources: [mineSource], sourceContents: { s1: 'old text' } })

    const plan: ApplyPlan = emptyApplyPlan()
    plan.documentText = [{ sourceGuid: 's1', sourceName: 's1.txt', mineText: 'old text', theirsText: 'new text', changes: [] }]
    plan.codingsCoarse = [{
      sourceGuid: 's1',
      sourceName: 's1.txt',
      coarse: true,
      theirsSource: { ...baseSource('s1'), selections: theirsSelections }
    }]
    applyMerge(plan)

    expect(useDocumentStore.getState().sourceContents.s1).toBe('new text')
    expect(useDocumentStore.getState().sources[0].selections).toEqual(theirsSelections)
  })

  it('carries over formatData.survey (not just selections/text) when taking a coarse item for a changed survey', () => {
    const mineSurvey = { name: 'S', columns: [], questions: [], metadataColumnIds: [], respondents: [{ id: 'r1', displayName: 'Respondent 1', metadata: {}, answers: {} }] }
    const theirsSurvey = { name: 'S', columns: [], questions: [], metadataColumnIds: [], respondents: [{ id: 'r1', displayName: 'Respondent 1', metadata: {}, answers: {} }, { id: 'r2', displayName: 'Respondent 2', metadata: {}, answers: {} }] }
    const mineSource: TextSource = { ...baseSource('sv1'), sourceType: 'survey', formatData: { survey: mineSurvey, rawCsv: 'old,csv' } }
    const theirsSource: TextSource = { ...baseSource('sv1'), sourceType: 'survey', formatData: { survey: theirsSurvey, rawCsv: 'new,csv' } }
    useDocumentStore.setState({ sources: [mineSource], sourceContents: { sv1: 'old,csv' } })

    const plan: ApplyPlan = emptyApplyPlan()
    plan.codingsCoarse = [{ sourceGuid: 'sv1', sourceName: 'sv1.txt', coarse: true, theirsSource }]
    applyMerge(plan)

    const merged = useDocumentStore.getState().sources[0]
    expect((merged.formatData as { survey: typeof theirsSurvey }).survey.respondents).toHaveLength(2)
    expect(useDocumentStore.getState().sourceContents.sv1).toBe('new,csv')
  })

  it('itemizes an add by reusing an existing selection at the same anchor, and an add creating a new selection', () => {
    const mineSource: TextSource = {
      ...baseSource('s1'),
      selections: [{ guid: 'sel-existing', startPosition: 0, endPosition: 5, codings: [{ guid: 'c1', codeGuid: 'codeA' }] }]
    }
    useDocumentStore.setState({ sources: [mineSource], sourceContents: { s1: 'identical text' } })

    const plan: ApplyPlan = emptyApplyPlan()
    plan.codingsAdd = [
      // Same anchor as the existing selection — should reuse sel-existing, just add a second coding to it.
      { sourceGuid: 's1', instance: { selection: { guid: 'sel-theirs-1', startPosition: 0, endPosition: 5, codings: [] }, coding: { guid: 'c-theirs-1', codeGuid: 'codeB' } } },
      // A brand new anchor — should create a new selection.
      { sourceGuid: 's1', instance: { selection: { guid: 'sel-theirs-2', startPosition: 10, endPosition: 15, codings: [] }, coding: { guid: 'c-theirs-2', codeGuid: 'codeC' } } }
    ]
    applyMerge(plan)

    const selections = useDocumentStore.getState().sources[0].selections
    expect(selections).toHaveLength(2)
    const reused = selections.find((s) => s.guid === 'sel-existing')!
    expect(reused.codings.map((c) => c.codeGuid).sort()).toEqual(['codeA', 'codeB'])
    const created = selections.find((s) => s.startPosition === 10)!
    expect(created.codings.map((c) => c.codeGuid)).toEqual(['codeC'])
  })

  it('removes an itemized coding approved as onlyMine', () => {
    const mineSource: TextSource = {
      ...baseSource('s1'),
      selections: [{ guid: 'sel1', startPosition: 0, endPosition: 5, codings: [{ guid: 'c1', codeGuid: 'codeA' }] }]
    }
    useDocumentStore.setState({ sources: [mineSource], sourceContents: { s1: 'identical text' } })

    const plan: ApplyPlan = emptyApplyPlan()
    plan.codingsRemove = [
      { sourceGuid: 's1', instance: { selection: mineSource.selections[0], coding: mineSource.selections[0].codings[0] } }
    ]
    applyMerge(plan)

    expect(useDocumentStore.getState().sources[0].selections[0].codings).toEqual([])
  })
})
