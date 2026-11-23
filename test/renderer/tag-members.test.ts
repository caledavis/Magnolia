import { describe, it, expect, beforeEach } from 'vitest'
import { useDocumentStore } from '../../src/renderer/stores/document-store'
import { useTagStore, tagsWithMembersIn } from '../../src/renderer/stores/tag-store'
import type { QDASet, TextSource } from '../../src/renderer/models/types'

const tag = (guid: string, members: string[], extra: Partial<QDASet> = {}): QDASet => ({
  guid,
  name: guid,
  memberSourceGuids: members,
  memberCodeGuids: [],
  ...extra
})

const source = (guid: string): TextSource =>
  ({ guid, name: guid, sourceType: 'text', selections: [] }) as unknown as TextSource

describe('tagsWithMembersIn', () => {
  it('drops members whose document is gone, survey members included', () => {
    const tags = [
      tag('t1', ['a', 'gone'], {
        memberSurveyRespondents: [{ sourceGuid: 'gone', id: 'r1' }, { sourceGuid: 'a', id: 'r2' }],
        memberSurveyQuestions: [{ sourceGuid: 'gone', id: 'q1' }]
      }),
      tag('t2', ['a'])
    ]
    const out = tagsWithMembersIn(tags, (g) => g !== 'gone')
    expect(out[0].memberSourceGuids).toEqual(['a'])
    expect(out[0].memberSurveyRespondents).toEqual([{ sourceGuid: 'a', id: 'r2' }])
    expect(out[0].memberSurveyQuestions).toEqual([])
    expect(out[1]).toBe(tags[1])
  })

  it('returns the same list when nothing is dropped', () => {
    const tags = [tag('t1', ['a', 'b']), tag('t2', [])]
    expect(tagsWithMembersIn(tags, () => true)).toBe(tags)
  })
})

describe('removing a document', () => {
  beforeEach(() => {
    useDocumentStore.setState({ sources: [source('a'), source('b')], sourceContents: {}, openTabs: [], viewedDocumentGuid: null })
    useTagStore.setState({ tags: [tag('t1', ['a', 'b']), tag('t2', ['b'])] })
  })

  it('takes it off its tags', () => {
    useDocumentStore.getState().removeSource('b')
    const tags = useTagStore.getState().tags
    expect(tags.map((t) => t.memberSourceGuids)).toEqual([['a'], []])
    expect(tags.map((t) => t.guid)).toEqual(['t1', 't2'])
  })
})
