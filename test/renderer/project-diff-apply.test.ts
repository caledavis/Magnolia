import { describe, it, expect, beforeEach } from 'vitest'
import { applyMerge, emptyApplyPlan, type ApplyPlan } from '../../src/renderer/utils/project-diff-apply'
import { useCodeStore } from '../../src/renderer/stores/code-store'
import { useTagStore } from '../../src/renderer/stores/tag-store'
import { useMemoStore } from '../../src/renderer/stores/memo-store'
import { useQuoteStore } from '../../src/renderer/stores/quote-store'
import { useLogbookStore } from '../../src/renderer/stores/logbook-store'
import { useDocumentStore } from '../../src/renderer/stores/document-store'
import { useProjectStore } from '../../src/renderer/stores/project-store'
import type { Code, TextSource } from '../../src/renderer/models/types'
import type { CodeDiffItem } from '../../src/renderer/utils/project-diff'

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

  it('adds a user via the new setUsers action', () => {
    const plan: ApplyPlan = emptyApplyPlan()
    plan.users = [{ guid: 'u1', bucket: 'onlyTheirs', theirs: { guid: 'u1', name: 'Bob' } }]
    applyMerge(plan)
    expect(useProjectStore.getState().users).toEqual([{ guid: 'u1', name: 'Bob' }])
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
