/**
 * Document Selector graph model + resolver.
 *
 * The Document Selector lets the user wire tags, folders, explicit document
 * picks, "all documents" and set-operations (∩ ∪ −) into a node graph that
 * resolves to a set of source guids. This module is the single source of
 * truth for both the graph's TYPES and its RESOLUTION, so the Document
 * Selector UI and the query engine resolve identically.
 *
 * Crucially the resolver is PURE — every input arrives as a parameter, so it
 * can run outside the component (e.g. when the query store re-resolves a
 * saved filter against the *current* project data, making document filters
 * live rather than frozen to the doc set that matched at save time).
 */
import { sourceTypeFromFilename } from './format-registry'
import type { SurveyEntityRef } from '../models/types'

export type DNodeKind = 'docs' | 'tag' | 'type' | 'folder' | 'allDocs' | 'setOp' | 'result'
export type SetOp = 'union' | 'intersect' | 'subtract'

export interface DNode {
  id: string
  kind: DNodeKind
  x: number
  y: number
  /** docs node: list of source guids */
  docGuids?: string[]
  /** tag node */
  tagCategoryGuid?: string
  tagGuid?: string
  tagName?: string
  /** tag filter mode and range */
  tagGuid2?: string
  betweenMode?: 'is' | 'between' | 'not-between'
  /** type node */
  typeExt?: string
  /** folder node: a single folder guid (descendants included automatically) */
  folderGuid?: string
  /** setOp node: operators between consecutive input slots */
  setOps?: (SetOp | undefined)[]
}

export interface DConn {
  id: string
  from: string
  to: string
  toPort: number
}

export type DocCategory = 'video' | 'audio' | 'document' | 'image'

export function categoryOfSource(name: string): DocCategory {
  const st = sourceTypeFromFilename(name)
  if (st === 'video') return 'video'
  if (st === 'audio') return 'audio'
  if (st === 'image') return 'image'
  return 'document'
}

/** Everything the resolver needs about the current project, passed in so the
 *  resolution stays pure (no module-level state, runnable from the engine). */
export interface DocGraphData {
  sources: { guid: string; name: string }[]
  tags: { guid: string; name: string; categoryGuid?: string; value?: string }[]
  /** tag guid → member source guids (documents/surveys tagged with it) */
  tagMembers: Record<string, string[]>
  folders: { guid: string; name: string; parentGuid: string | null }[]
  /** source guid → folder guid */
  sourceFolder: Record<string, string>
  /** tag guid → survey respondents tagged with it (so a tag node pulls in a
   *  survey tagged only via a respondent; cell scope narrows it downstream) */
  respondentTagMembers: Record<string, SurveyEntityRef[]>
  /** tag guid → survey questions tagged with it */
  questionTagMembers: Record<string, SurveyEntityRef[]>
}

/** Resolve a Document Selector graph to the set of source guids it selects. */
export function resolveDocGraph(nodes: DNode[], conns: DConn[], data: DocGraphData): string[] {
  const allSet = new Set(data.sources.map((s) => s.guid))
  const res = nodes.find((n) => n.kind === 'result')
  if (!res) return []
  const inp = conns.find((c) => c.to === res.id)
  if (!inp) return [] // nothing wired to Result = no documents selected
  return Array.from(walkNode(inp.from, nodes, conns, data, allSet, new Set()))
}

function walkNode(
  id: string,
  nodes: DNode[],
  conns: DConn[],
  data: DocGraphData,
  allSet: Set<string>,
  visited: Set<string>
): Set<string> {
  if (visited.has(id)) return new Set()
  visited.add(id)
  const n = nodes.find((nd) => nd.id === id)
  if (!n) return new Set()

  if (n.kind === 'docs') {
    return new Set((n.docGuids || []).filter((g) => allSet.has(g)))
  }

  if (n.kind === 'tag') {
    if (!n.tagGuid) return new Set()
    // Between / Not Between range filter
    if (n.tagGuid2 && n.betweenMode && n.tagCategoryGuid) {
      const tag1 = data.tags.find((t) => t.guid === n.tagGuid)
      const tag2 = data.tags.find((t) => t.guid === n.tagGuid2)
      if (tag1?.value && tag2?.value) {
        const catTags = data.tags.filter((t) => t.categoryGuid === n.tagCategoryGuid && t.value)
        const isDate = !isNaN(new Date(tag1.value.split('/').reverse().join('-')).getTime())
        const parse = (v: string) => (isDate ? new Date(v.split('/').reverse().join('-')).getTime() : parseFloat(v))
        const lo = Math.min(parse(tag1.value), parse(tag2.value))
        const hi = Math.max(parse(tag1.value), parse(tag2.value))
        const result = new Set<string>()
        for (const t of catTags) {
          const v = parse(t.value!)
          if (isNaN(v)) continue
          const inRange = v >= lo && v <= hi
          if ((n.betweenMode === 'between' && inRange) || (n.betweenMode === 'not-between' && !inRange)) {
            for (const g of data.tagMembers[t.guid] || []) {
              if (allSet.has(g)) result.add(g)
            }
          }
        }
        return result
      }
    }
    const result = new Set<string>((data.tagMembers[n.tagGuid] || []).filter((g) => allSet.has(g)))
    // Surveys tagged only via a respondent / question still belong in the
    // document set (their cells get narrowed downstream by cell scope).
    for (const r of data.respondentTagMembers[n.tagGuid] || []) {
      if (allSet.has(r.sourceGuid)) result.add(r.sourceGuid)
    }
    for (const q of data.questionTagMembers[n.tagGuid] || []) {
      if (allSet.has(q.sourceGuid)) result.add(q.sourceGuid)
    }
    return result
  }

  if (n.kind === 'type') {
    if (!n.typeExt) return new Set()
    const cat = n.typeExt as DocCategory
    return new Set(data.sources.filter((s) => categoryOfSource(s.name) === cat).map((s) => s.guid))
  }

  if (n.kind === 'folder') {
    if (!n.folderGuid) return new Set()
    // Include the chosen folder AND every descendant folder so dropping a
    // parent folder selects everything underneath.
    const folderSet = new Set<string>([n.folderGuid])
    let added = true
    while (added) {
      added = false
      for (const f of data.folders) {
        if (f.parentGuid && folderSet.has(f.parentGuid) && !folderSet.has(f.guid)) {
          folderSet.add(f.guid)
          added = true
        }
      }
    }
    const result = new Set<string>()
    for (const guid of allSet) {
      const fg = data.sourceFolder[guid]
      if (fg && folderSet.has(fg)) result.add(guid)
    }
    return result
  }

  if (n.kind === 'allDocs') {
    return new Set(allSet)
  }

  if (n.kind === 'setOp') {
    const ops = n.setOps ?? ['union']
    const ins = conns.filter((c) => c.to === id).sort((a, b) => a.toPort - b.toPort)
    const sets = ins.map((c) => walkNode(c.from, nodes, conns, data, allSet, visited))
    if (sets.length === 0) return new Set()

    let result = sets[0]
    for (let i = 0; i < ops.length && i + 1 < sets.length; i++) {
      const op = ops[i] ?? 'union'
      const next = sets[i + 1]
      if (op === 'union') {
        result = new Set([...result, ...next])
      } else if (op === 'intersect') {
        result = new Set([...result].filter((g) => next.has(g)))
      } else if (op === 'subtract') {
        result = new Set([...result].filter((g) => !next.has(g)))
      }
    }
    return result
  }

  return new Set()
}
