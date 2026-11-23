import { create } from 'zustand'
import type { QDASet, TagCategory, TagCategoryType } from '../models/types'
import { generateGuid } from '../utils/guid'
import { useProjectStore } from './project-store'
import { makeHmrSafe } from './hmr-preserve'
import { noteBulkReset } from './empty-save-guard'

interface TagState {
  tags: QDASet[]
  categories: TagCategory[]

  setTags: (tags: QDASet[]) => void
  setCategories: (categories: TagCategory[]) => void
  createTag: (name: string, categoryGuid?: string, value?: string) => string
  deleteTag: (guid: string) => void
  /** Take a removed document (or survey) off every tag it was applied to. */
  forgetSource: (sourceGuid: string) => void
  renameTag: (guid: string, name: string) => void
  assignTagToDocument: (tagGuid: string, sourceGuid: string) => void
  removeTagFromDocument: (tagGuid: string, sourceGuid: string) => void
  getTagsForDocument: (sourceGuid: string) => QDASet[]
  // Survey sub-entity tagging — respondents and questions aren't
  // sources, so they get their own membership arrays.
  assignTagToSurveyRespondent: (tagGuid: string, sourceGuid: string, respondentId: string) => void
  removeTagFromSurveyRespondent: (tagGuid: string, sourceGuid: string, respondentId: string) => void
  getTagsForSurveyRespondent: (sourceGuid: string, respondentId: string) => QDASet[]
  assignTagToSurveyQuestion: (tagGuid: string, sourceGuid: string, questionId: string) => void
  removeTagFromSurveyQuestion: (tagGuid: string, sourceGuid: string, questionId: string) => void
  getTagsForSurveyQuestion: (sourceGuid: string, questionId: string) => QDASet[]
  createCategory: (name: string, type: TagCategoryType, listOptions?: string[]) => string
  deleteCategory: (guid: string) => void
  renameCategory: (guid: string, name: string) => void
  updateCategoryListOptions: (guid: string, options: string[]) => void
  clearAll: () => void
}

/** The tags with only the members whose document (or survey) `keep`
 *  accepts: a tag can't list a document the project doesn't have. Returns
 *  `tags` itself when nothing is dropped. */
export function tagsWithMembersIn(tags: QDASet[], keep: (sourceGuid: string) => boolean): QDASet[] {
  let changed = false
  const out = tags.map((tag) => {
    const sources = tag.memberSourceGuids.filter(keep)
    const respondents = tag.memberSurveyRespondents?.filter((r) => keep(r.sourceGuid))
    const questions = tag.memberSurveyQuestions?.filter((q) => keep(q.sourceGuid))
    if (
      sources.length === tag.memberSourceGuids.length &&
      respondents?.length === tag.memberSurveyRespondents?.length &&
      questions?.length === tag.memberSurveyQuestions?.length
    ) return tag
    changed = true
    return {
      ...tag,
      memberSourceGuids: sources,
      ...(respondents ? { memberSurveyRespondents: respondents } : {}),
      ...(questions ? { memberSurveyQuestions: questions } : {})
    }
  })
  return changed ? out : tags
}

export const useTagStore = create<TagState>((set, get) => ({
  tags: [],
  categories: [],

  setTags: (tags) => set({ tags }),
  setCategories: (categories) => set({ categories }),

  createTag: (name, categoryGuid, value) => {
    const guid = generateGuid()
    const tag: QDASet = {
      guid,
      name,
      categoryGuid,
      value,
      memberSourceGuids: [],
      memberCodeGuids: []
    }
    set((state) => ({ tags: [...state.tags, tag] }))
    useProjectStore.getState().markDirty()
    return guid
  },

  deleteTag: (guid) => {
    set((state) => ({ tags: state.tags.filter((t) => t.guid !== guid) }))
    useProjectStore.getState().markDirty()
  },

  forgetSource: (sourceGuid) => {
    const tags = tagsWithMembersIn(get().tags, (guid) => guid !== sourceGuid)
    if (tags !== get().tags) set({ tags })
  },

  renameTag: (guid, name) => {
    set((state) => ({
      tags: state.tags.map((t) => (t.guid === guid ? { ...t, name } : t))
    }))
    useProjectStore.getState().markDirty()
  },

  assignTagToDocument: (tagGuid, sourceGuid) => {
    set((state) => ({
      tags: state.tags.map((t) =>
        t.guid === tagGuid && !t.memberSourceGuids.includes(sourceGuid)
          ? { ...t, memberSourceGuids: [...t.memberSourceGuids, sourceGuid] }
          : t
      )
    }))
    useProjectStore.getState().markDirty()
  },

  removeTagFromDocument: (tagGuid, sourceGuid) => {
    set((state) => ({
      tags: state.tags.map((t) =>
        t.guid === tagGuid
          ? {
              ...t,
              memberSourceGuids: t.memberSourceGuids.filter(
                (g) => g !== sourceGuid
              )
            }
          : t
      )
    }))
    useProjectStore.getState().markDirty()
  },

  getTagsForDocument: (sourceGuid) =>
    get().tags.filter((t) => t.memberSourceGuids.includes(sourceGuid)),

  assignTagToSurveyRespondent: (tagGuid, sourceGuid, respondentId) => {
    set((state) => ({
      tags: state.tags.map((t) => {
        if (t.guid !== tagGuid) return t
        const members = t.memberSurveyRespondents ?? []
        if (members.some((m) => m.sourceGuid === sourceGuid && m.id === respondentId)) return t
        return { ...t, memberSurveyRespondents: [...members, { sourceGuid, id: respondentId }] }
      })
    }))
    useProjectStore.getState().markDirty()
  },

  removeTagFromSurveyRespondent: (tagGuid, sourceGuid, respondentId) => {
    set((state) => ({
      tags: state.tags.map((t) =>
        t.guid === tagGuid
          ? {
              ...t,
              memberSurveyRespondents: (t.memberSurveyRespondents ?? []).filter(
                (m) => !(m.sourceGuid === sourceGuid && m.id === respondentId)
              )
            }
          : t
      )
    }))
    useProjectStore.getState().markDirty()
  },

  getTagsForSurveyRespondent: (sourceGuid, respondentId) =>
    get().tags.filter((t) =>
      (t.memberSurveyRespondents ?? []).some(
        (m) => m.sourceGuid === sourceGuid && m.id === respondentId
      )
    ),

  assignTagToSurveyQuestion: (tagGuid, sourceGuid, questionId) => {
    set((state) => ({
      tags: state.tags.map((t) => {
        if (t.guid !== tagGuid) return t
        const members = t.memberSurveyQuestions ?? []
        if (members.some((m) => m.sourceGuid === sourceGuid && m.id === questionId)) return t
        return { ...t, memberSurveyQuestions: [...members, { sourceGuid, id: questionId }] }
      })
    }))
    useProjectStore.getState().markDirty()
  },

  removeTagFromSurveyQuestion: (tagGuid, sourceGuid, questionId) => {
    set((state) => ({
      tags: state.tags.map((t) =>
        t.guid === tagGuid
          ? {
              ...t,
              memberSurveyQuestions: (t.memberSurveyQuestions ?? []).filter(
                (m) => !(m.sourceGuid === sourceGuid && m.id === questionId)
              )
            }
          : t
      )
    }))
    useProjectStore.getState().markDirty()
  },

  getTagsForSurveyQuestion: (sourceGuid, questionId) =>
    get().tags.filter((t) =>
      (t.memberSurveyQuestions ?? []).some(
        (m) => m.sourceGuid === sourceGuid && m.id === questionId
      )
    ),

  createCategory: (name, type, listOptions) => {
    const guid = generateGuid()
    const category: TagCategory = { guid, name, type }
    if (type === 'list' && listOptions) {
      category.listOptions = listOptions
    }
    set((state) => ({ categories: [...state.categories, category] }))
    useProjectStore.getState().markDirty()
    return guid
  },

  deleteCategory: (guid) => {
    set((state) => ({
      categories: state.categories.filter((c) => c.guid !== guid),
      // Also remove tags belonging to this category
      tags: state.tags.filter((t) => t.categoryGuid !== guid)
    }))
    useProjectStore.getState().markDirty()
  },

  renameCategory: (guid, name) => {
    set((state) => ({
      categories: state.categories.map((c) =>
        c.guid === guid ? { ...c, name } : c
      )
    }))
    useProjectStore.getState().markDirty()
  },

  updateCategoryListOptions: (guid, options) => {
    set((state) => ({
      categories: state.categories.map((c) =>
        c.guid === guid ? { ...c, listOptions: options } : c
      )
    }))
    useProjectStore.getState().markDirty()
  },

  clearAll: () => {
    noteBulkReset()
    set({ tags: [], categories: [] })
  }
}))

makeHmrSafe('tagStore', useTagStore)
