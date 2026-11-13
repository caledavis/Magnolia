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
  /** Between / Not Between on dates: the two ends as typed (or picked),
   *  written like date tags (dd/mm/yyyy, mm/yyyy, yyyy). Either may be
   *  empty, leaving that end open. When neither is set, the ends are the
   *  values of tagGuid and tagGuid2. */
  rangeFrom?: string
  rangeTo?: string
  /** type node */
  typeExt?: string
  /** folder node: a single folder guid (descendants included automatically) */
  folderGuid?: string
  /** setOp node: operators between consecutive input slots */
  setOps?: (SetOp | undefined)[]
}

export interface DocumentFilterState {
  sourceGuids: string[]
  tagGuids: string[]
  tagExcludeGuids: string[]
  folderGuids: string[]
  typeInclude: string[]
  typeExclude: string[]
  /** Persisted graph layout for the node editor */
  graph?: { nodes: DNode[]; conns: DConn[] }
  /** Surveys limited to some of their questions or respondents (chosen
   *  on the survey in Selected Documents). A survey not listed keeps all
   *  of them. Only surveys in the selection are kept. */
  questionScope?: SurveyEntityRef[]
  respondentScope?: SurveyEntityRef[]
}

export function emptyDocumentFilter(): DocumentFilterState {
  return {
    sourceGuids: [],
    tagGuids: [],
    tagExcludeGuids: [],
    folderGuids: [],
    typeInclude: [],
    typeExclude: []
  }
}

export interface DConn {
  id: string
  from: string
  to: string
  toPort: number
}

export type DocCategory = 'video' | 'audio' | 'document' | 'image' | 'survey' | 'note'

export function categoryOfSource(source: { name: string; sourceType?: string }): DocCategory {
  // Surveys and notes carry no telltale file extension, so they're
  // identified by their sourceType rather than the name.
  if (source.sourceType === 'survey') return 'survey'
  if (source.sourceType === 'note') return 'note'
  const st = sourceTypeFromFilename(source.name)
  if (st === 'video') return 'video'
  if (st === 'audio') return 'audio'
  if (st === 'image') return 'image'
  return 'document'
}

/** Everything the resolver needs about the current project, passed in so the
 *  resolution stays pure (no module-level state, runnable from the engine). */
/** The stretch of time a date tag's value covers, as UTC milliseconds
 *  (first and last moment): "03/05/2019" is a day, "05/2019" a month,
 *  "2019" a year. Also reads yyyy-mm-dd. Null if it isn't a date. */
export function dateSpan(value: string): [number, number] | null {
  const v = value.trim()
  let y: number, m: number | undefined, d: number | undefined
  let match: RegExpMatchArray | null
  if ((match = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) [d, m, y] = [+match[1], +match[2], +match[3]]
  else if ((match = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) [y, m, d] = [+match[1], +match[2], +match[3]]
  else if ((match = v.match(/^(\d{1,2})[/.-](\d{4})$/))) [m, y] = [+match[1], +match[2]]
  else if ((match = v.match(/^(\d{4})$/))) y = +match[1]
  else return null
  if (m !== undefined && (m < 1 || m > 12)) return null
  if (d !== undefined) {
    const start = Date.UTC(y, m! - 1, d)
    if (new Date(start).getUTCDate() !== d) return null // 31/02/2019
    return [start, Date.UTC(y, m! - 1, d + 1) - 1]
  }
  if (m !== undefined) return [Date.UTC(y, m - 1, 1), Date.UTC(y, m, 1) - 1]
  return [Date.UTC(y, 0, 1), Date.UTC(y + 1, 0, 1) - 1]
}

/** Newest first, for lists of dates; values that aren't dates go last. */
export function newestFirst(a: string, b: string): number {
  const sa = dateSpan(a), sb = dateSpan(b)
  if (!sa || !sb) return sa ? -1 : sb ? 1 : a.localeCompare(b)
  return sb[0] - sa[0] || sb[1] - sa[1]
}

/** The documents a date range takes in (or, for not-between, leaves
 *  out): those tagged with a date in the category that lies wholly
 *  inside it. Null if an end isn't a date or neither end is given. */
function dateRangeMembers(
  n: DNode, from: string, to: string, data: DocGraphData, allSet: Set<string>
): Set<string> | null {
  const a = from.trim() ? dateSpan(from) : undefined
  const b = to.trim() ? dateSpan(to) : undefined
  if (a === null || b === null || (!a && !b)) return null
  // Only a "from": from then on. Only a "to": up to then. Both: whichever
  // way round they were given.
  const lo = a && b ? Math.min(a[0], b[0]) : a ? a[0] : -Infinity
  const hi = a && b ? Math.max(a[1], b[1]) : b ? b[1] : Infinity
  const result = new Set<string>()
  for (const t of data.tags) {
    if (t.categoryGuid !== n.tagCategoryGuid || !t.value) continue
    const span = dateSpan(t.value)
    if (!span) continue
    const inRange = span[0] >= lo && span[1] <= hi
    if ((n.betweenMode === 'between') === inRange) {
      for (const g of data.tagMembers[t.guid] || []) if (allSet.has(g)) result.add(g)
    }
  }
  return result
}

export interface DocGraphData {
  sources: { guid: string; name: string; sourceType?: string }[]
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
    // Between / Not Between on dates, typed or picked
    if ((n.betweenMode === 'between' || n.betweenMode === 'not-between') && n.tagCategoryGuid) {
      const value = (g?: string) => (g ? data.tags.find((t) => t.guid === g)?.value ?? '' : '')
      const from = n.rangeFrom ?? value(n.tagGuid)
      const to = n.rangeTo ?? value(n.tagGuid2)
      const typed = n.rangeFrom !== undefined || n.rangeTo !== undefined
      const datesOnly = (!from || dateSpan(from)) && (!to || dateSpan(to))
      if (typed || datesOnly) return dateRangeMembers(n, from, to, data, allSet) ?? new Set()
    }
    if (!n.tagGuid) return new Set()
    // Between / Not Between on numbers
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
    return new Set(data.sources.filter((s) => categoryOfSource(s) === cat).map((s) => s.guid))
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
