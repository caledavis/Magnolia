import { create } from 'zustand'
import type { Code } from '../models/types'
import { generateGuid } from '../utils/guid'
import { useProjectStore } from './project-store'
import { useDocumentStore } from './document-store'
import { makeHmrSafe } from './hmr-preserve'

interface CodeState {
  codes: Code[]

  setCodes: (codes: Code[]) => void
  addCode: (name: string, color: string, parentGuid?: string) => string
  removeCode: (guid: string) => void
  renameCode: (guid: string, name: string) => void
  recolorCode: (guid: string, color: string) => void
  moveCode: (guid: string, newParentGuid: string | null) => void
  /** Insert code before or after a sibling (same parent level) */
  moveCodeNear: (guid: string, siblingGuid: string, position: 'before' | 'after') => void
  setCodeDescription: (guid: string, description: string) => void
  setCodeHotkey: (guid: string, hotkey: number | undefined) => void
  mergeCodes: (importedCodes: Code[]) => void
  /** Merge sourceCode into targetCode: recode its segments with the target,
   *  then remove it. Its subcodes either move under the target, keeping
   *  their own segments (`'move'`), or are merged into the target too
   *  (`'merge'`). Merging a code into itself or one of its own subcodes
   *  does nothing. */
  mergeIntoCode: (sourceGuid: string, targetGuid: string, subcodes?: 'move' | 'merge') => void
  findCode: (guid: string) => Code | undefined
  flatCodes: () => Code[]
  clearAll: () => void
}

function findInTree(codes: Code[], guid: string): Code | undefined {
  for (const code of codes) {
    if (code.guid === guid) return code
    const found = findInTree(code.children, guid)
    if (found) return found
  }
  return undefined
}

function flattenCodes(codes: Code[]): Code[] {
  const result: Code[] = []
  for (const code of codes) {
    result.push(code)
    result.push(...flattenCodes(code.children))
  }
  return result
}

function removeFromTree(codes: Code[], guid: string): Code[] {
  return codes
    .filter((c) => c.guid !== guid)
    .map((c) => ({ ...c, children: removeFromTree(c.children, guid) }))
}

function updateInTree(
  codes: Code[],
  guid: string,
  updater: (code: Code) => Code
): Code[] {
  return codes.map((c) => {
    if (c.guid === guid) return updater(c)
    return { ...c, children: updateInTree(c.children, guid, updater) }
  })
}

function addChildInTree(
  codes: Code[],
  parentGuid: string,
  child: Code
): Code[] {
  return codes.map((c) => {
    if (c.guid === parentGuid) {
      return { ...c, children: [...c.children, child] }
    }
    return { ...c, children: addChildInTree(c.children, parentGuid, child) }
  })
}

/** Insert `code` before or after `siblingGuid` at the same level */
function insertNearSibling(
  codes: Code[],
  siblingGuid: string,
  code: Code,
  position: 'before' | 'after'
): Code[] {
  const result: Code[] = []
  let found = false
  for (const c of codes) {
    if (c.guid === siblingGuid) {
      found = true
      if (position === 'before') {
        result.push(code, c)
      } else {
        result.push(c, code)
      }
    } else {
      result.push({ ...c, children: insertNearSibling(c.children, siblingGuid, code, position) })
    }
  }
  return result
}

/** Find the parent guid of a code, or null if it's at root */
function findParentGuid(codes: Code[], targetGuid: string): string | null | undefined {
  for (const c of codes) {
    if (c.children.some((ch) => ch.guid === targetGuid)) return c.guid
    const found = findParentGuid(c.children, targetGuid)
    if (found !== undefined) return found
  }
  return undefined // not found at all
}

export const useCodeStore = create<CodeState>((set, get) => ({
  codes: [],

  setCodes: (codes) => set({ codes }),

  addCode: (name, color, parentGuid) => {
    const guid = generateGuid()
    const newCode: Code = {
      guid,
      name,
      isCodable: true,
      color,
      children: []
    }
    set((state) => {
      if (parentGuid) {
        return { codes: addChildInTree(state.codes, parentGuid, newCode) }
      }
      return { codes: [...state.codes, newCode] }
    })
    useProjectStore.getState().markDirty()
    return guid
  },

  removeCode: (guid) => {
    set((state) => ({ codes: removeFromTree(state.codes, guid) }))
    useProjectStore.getState().markDirty()
  },

  renameCode: (guid, name) => {
    set((state) => ({
      codes: updateInTree(state.codes, guid, (c) => ({ ...c, name }))
    }))
    useProjectStore.getState().markDirty()
  },

  recolorCode: (guid, color) => {
    set((state) => ({
      codes: updateInTree(state.codes, guid, (c) => ({ ...c, color }))
    }))
    useProjectStore.getState().markDirty()
  },

  moveCode: (guid, newParentGuid) => {
    const code = get().findCode(guid)
    if (!code) return
    set((state) => {
      const withRemoved = removeFromTree(state.codes, guid)
      if (newParentGuid) {
        return { codes: addChildInTree(withRemoved, newParentGuid, code) }
      }
      return { codes: [...withRemoved, code] }
    })
    useProjectStore.getState().markDirty()
  },

  moveCodeNear: (guid, siblingGuid, position) => {
    const code = get().findCode(guid)
    if (!code) return
    set((state) => {
      const withRemoved = removeFromTree(state.codes, guid)
      return { codes: insertNearSibling(withRemoved, siblingGuid, code, position) }
    })
    useProjectStore.getState().markDirty()
  },

  setCodeDescription: (guid, description) => {
    set((state) => ({
      codes: updateInTree(state.codes, guid, (c) => ({ ...c, description }))
    }))
    useProjectStore.getState().markDirty()
  },

  setCodeHotkey: (guid, hotkey) => {
    set((state) => {
      // If assigning a hotkey, clear it from any other code first
      let codes = state.codes
      if (hotkey !== undefined) {
        const clearHotkey = (list: Code[]): Code[] =>
          list.map((c) => ({
            ...c,
            hotkey: c.hotkey === hotkey ? undefined : c.hotkey,
            children: clearHotkey(c.children)
          }))
        codes = clearHotkey(codes)
      }
      return { codes: updateInTree(codes, guid, (c) => ({ ...c, hotkey })) }
    })
    useProjectStore.getState().markDirty()
  },

  mergeCodes: (importedCodes) => {
    // Add imported codes that don't already exist (by guid).
    // Existing codes are left unchanged.
    const existingGuids = new Set(flattenCodes(get().codes).map((c) => c.guid))
    const newCodes = importedCodes.filter((c) => !existingGuids.has(c.guid))
    if (newCodes.length > 0) {
      set((state) => ({ codes: [...state.codes, ...newCodes] }))
      useProjectStore.getState().markDirty()
    }
  },

  mergeIntoCode: (sourceGuid, targetGuid, subcodes = 'move') => {
    const source = findInTree(get().codes, sourceGuid)
    if (!source || sourceGuid === targetGuid) return
    const descendants = flattenCodes(source.children)
    // The target would be removed along with the source's subtree.
    if (descendants.some((c) => c.guid === targetGuid)) return
    if (!findInTree(get().codes, targetGuid)) return

    const recoded = new Set([sourceGuid])
    if (subcodes === 'merge') for (const c of descendants) recoded.add(c.guid)

    // Recode the merged codes' segments with the target. A passage coded
    // with both would end up with the target twice; keep one.
    const ds = useDocumentStore.getState()
    const newSources = ds.sources.map((s: any) => ({
      ...s,
      selections: s.selections.map((sel: any) => {
        if (!sel.codings?.some((c: any) => recoded.has(c.codeGuid))) return sel
        let seenTarget = false
        const codings = []
        for (const coding of sel.codings) {
          const codeGuid = recoded.has(coding.codeGuid) ? targetGuid : coding.codeGuid
          if (codeGuid === targetGuid) {
            if (seenTarget) continue
            seenTarget = true
          }
          codings.push(codeGuid === coding.codeGuid ? coding : { ...coding, codeGuid })
        }
        return { ...sel, codings }
      })
    }))
    useDocumentStore.setState({ sources: newSources })

    set((state) => {
      const withoutSource = removeFromTree(state.codes, sourceGuid)
      if (subcodes === 'merge' || source.children.length === 0) return { codes: withoutSource }
      return {
        codes: updateInTree(withoutSource, targetGuid, (c) => ({
          ...c,
          children: [...c.children, ...source.children]
        }))
      }
    })
    useProjectStore.getState().markDirty()
  },

  findCode: (guid) => findInTree(get().codes, guid),

  flatCodes: () => flattenCodes(get().codes),

  clearAll: () => set({ codes: [] })
}))

makeHmrSafe('codeStore', useCodeStore)
