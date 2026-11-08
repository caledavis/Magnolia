import { useState, useRef, createContext, useContext, useCallback, useMemo, useEffect } from 'react'
import type { AnalysisInitData } from '../../../models/types'
import { stripFormatting } from '../../../utils/strip-formatting'
import { sourceTypeFromFilename } from '../../../utils/format-registry'
import type { IconComponent } from '../../Icon'
import {
  Icon,
  faFile,
  faTag,
  faTags,
  QUOTE_ICON,
  faMagnifyingGlass,
  MEMO_RANGED_ICON,
  faCircleNodes,
  faChevronRight,
  SURVEY_RESPONDENT_ICON,
  SURVEY_QUESTION_ICON,
  SURVEY_ICON
} from '../../Icon'
import { buildCellText } from '../../../utils/survey/cell-text'
import { TOOL_REGISTRY } from '../../../utils/tool-registry'
import { useTranslation } from 'react-i18next'
import { t } from '../../../i18n'

interface Props {
  data: AnalysisInitData
  visible: boolean
}

/* ── Accordion section ─────────────────────────────────────── */

function Section({ title, defaultOpen = false, children }: {
  title: string; defaultOpen?: boolean; children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="analysis-section" style={{ marginBottom: 10, padding: 0 }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          padding: '10px 12px', fontSize: 11, fontWeight: 700,
          textTransform: 'uppercase', letterSpacing: '0.5px',
          color: 'var(--text-muted, #8e8e93)', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 6, userSelect: 'none'
        }}
      >
        <span style={{ fontSize: 8, transition: 'transform 0.15s', transform: open ? 'rotate(90deg)' : 'rotate(0)', display: 'inline-flex' }}><Icon icon={faChevronRight} /></span>
        {title}
      </div>
      {open && <div style={{ padding: '0 0 8px' }}>{children}</div>}
    </div>
  )
}

/* ── Tree expand/collapse node ─────────────────────────────── */

function TreeNode({ label, depth, defaultOpen = false, children }: {
  label: React.ReactNode; depth: number; defaultOpen?: boolean; children?: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const hasChildren = !!children
  return (
    <>
      <div
        onClick={() => hasChildren && setOpen(!open)}
        style={{
          paddingInlineStart: 8 + depth * 16, paddingInlineEnd: 8, paddingTop: 2, paddingBottom: 2,
          fontSize: 12, cursor: hasChildren ? 'pointer' : 'default',
          display: 'flex', alignItems: 'center', gap: 4, userSelect: 'none',
          color: 'var(--text-muted, #8e8e93)', fontWeight: 600, fontStyle: 'italic'
        }}
      >
        {hasChildren && (
          <span style={{ fontSize: 8, transition: 'transform 0.15s', transform: open ? 'rotate(90deg)' : 'rotate(0)', display: 'inline-flex' }}><Icon icon={faChevronRight} /></span>
        )}
        {label}
      </div>
      {open && children}
    </>
  )
}

/* ── Selection context ─────────────────────────────────────── */

interface SelectionPayload { kind: string; data: any; label: string }

interface SelectionContextValue {
  selected: Set<string>
  handleClick: (uid: string, payload: SelectionPayload, e: React.MouseEvent) => void
  /** Returns the JSON payload the DraggableItem should put on the
   *  dataTransfer. When the dragged item is part of a multi-item
   *  selection, this packs the whole selection into a `multi` envelope;
   *  otherwise it returns the item's existing single-item format. */
  getDragPayload: (uid: string, payload: SelectionPayload) => any
  clearSelection: () => void
  /** Each DraggableItem self-registers its uid + payload while mounted
   *  so shift-click range selection can look up every visible item in
   *  DOM order and include the ones between the anchor and the target. */
  registerItem: (uid: string, payload: SelectionPayload) => void
  unregisterItem: (uid: string) => void
}

const SelectionContext = createContext<SelectionContextValue | null>(null)

function useSelection(): SelectionContextValue {
  const ctx = useContext(SelectionContext)
  if (!ctx) throw new Error('DraggableItem must be rendered inside a MapSidebar selection provider')
  return ctx
}

/* ── Draggable leaf item ───────────────────────────────────── */

function DraggableItem({ kind, data, label, depth = 0, icon, iconColor, colorPip }: {
  kind: string; data: any; label: string
  depth?: number; icon?: IconComponent; iconColor?: string; colorPip?: string
}) {
  const { selected, handleClick, getDragPayload, registerItem, unregisterItem } = useSelection()
  const uid = `${kind}:${data.entityGuid}`
  const isSelected = selected.has(uid)
  // Keep the registry in sync with the current payload so shift-click
  // range selection can retrieve the right data for each item between
  // anchor and target. Re-register on every render — the registry is a
  // ref-held Map, so this is cheap and doesn't trigger re-renders.
  registerItem(uid, { kind, data, label })
  useEffect(() => () => unregisterItem(uid), [uid, unregisterItem])
  return (
    <div
      draggable
      data-uid={uid}
      onClick={(e) => handleClick(uid, { kind, data, label }, e)}
      onDragStart={(e) => {
        const payload = getDragPayload(uid, { kind, data, label })
        e.dataTransfer.setData('application/json', JSON.stringify(payload))
        e.dataTransfer.effectAllowed = 'copy'
      }}
      style={{
        paddingInlineStart: 8 + depth * 16, paddingInlineEnd: 8, paddingTop: 4, paddingBottom: 4,
        fontSize: 12, cursor: 'grab', borderRadius: 4,
        display: 'flex', alignItems: 'center', gap: 6,
        background: isSelected ? 'var(--selection-bg)' : 'transparent',
        userSelect: 'none'
      }}
      onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'var(--bg-hover, #f5f5f7)' }}
      onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}
    >
      {colorPip && (
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: colorPip, flexShrink: 0 }} />
      )}
      {icon && (
        <Icon icon={icon} style={{ fontSize: 11, color: iconColor || 'var(--text-muted, #8e8e93)', flexShrink: 0, width: 12 }} />
      )}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary, #1d1d1f)' }}>
        {label}
      </span>
    </div>
  )
}

const EMPTY = <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '4px 8px 4px 24px' }}>{t('map.none')}</div>

/* ── Code tree (recursive) ─────────────────────────────────── */

interface CodeNode { guid: string; name: string; color?: string; isCodable: boolean; parentGuid?: string }
interface CodeTreeNode extends CodeNode { children: CodeTreeNode[] }

function buildCodeTree(codes: CodeNode[]): CodeTreeNode[] {
  const map = new Map<string, CodeTreeNode>()
  const roots: CodeTreeNode[] = []
  for (const c of codes) map.set(c.guid, { ...c, children: [] })
  for (const c of codes) {
    const node = map.get(c.guid)!
    if (c.parentGuid && map.has(c.parentGuid)) {
      map.get(c.parentGuid)!.children.push(node)
    } else {
      roots.push(node)
    }
  }
  return roots
}

function CodeTreeItems({ nodes, depth, filter }: {
  nodes: CodeTreeNode[]; depth: number; filter: string
}) {
  return (
    <>
      {nodes.map((c) => {
        const matchesSelf = c.name.toLowerCase().includes(filter)
        const hasMatchingChildren = c.children.some((ch) => ch.name.toLowerCase().includes(filter))
        if (!matchesSelf && !hasMatchingChildren && filter) return null
        return (
          <div key={c.guid}>
            <DraggableItem
              kind="code"
              data={{ entityGuid: c.guid, label: c.name, codeColor: c.color }}
              label={c.name}
              colorPip={c.color || '#8e8e93'}
              depth={depth}
            />
            {c.children.length > 0 && (
              <CodeTreeItems nodes={c.children} depth={depth + 1} filter={filter} />
            )}
          </div>
        )
      })}
    </>
  )
}

/* ── Document tree (folders + docs) ────────────────────────── */

function DocumentTree({ sources, folders, sourceFolder, depth, filter }: {
  sources: { guid: string; name: string }[]
  folders: { guid: string; name: string; parentGuid: string | null }[]
  sourceFolder: Record<string, string>
  depth: number
  filter: string
}) {
  const childFolders = folders.filter((f) => f.parentGuid === null || !folders.some((p) => p.guid === f.parentGuid))
  const nestedFolders = (parentGuid: string | null) =>
    folders.filter((f) => f.parentGuid === parentGuid)
  const docsInFolder = (folderGuid: string) =>
    sources.filter((s) => sourceFolder[s.guid] === folderGuid)
  const rootDocs = sources.filter((s) => !sourceFolder[s.guid])

  return (
    <>
      <FolderItems
        folders={nestedFolders(null)}
        allFolders={folders}
        sources={sources}
        sourceFolder={sourceFolder}
        depth={depth}
        filter={filter}
        docsInFolder={docsInFolder}
        nestedFolders={nestedFolders}
      />
      {rootDocs
        .filter((s) => !filter || s.name.toLowerCase().includes(filter))
        .map((s) => (
          <DraggableItem
            key={s.guid}
            kind="document"
            data={{ entityGuid: s.guid, label: s.name }}
            label={s.name}
            icon={faFile}
            iconColor="#8e8e93"
            depth={depth}
          />
        ))}
    </>
  )
}

function FolderItems({ folders, allFolders, sources, sourceFolder, depth, filter, docsInFolder, nestedFolders }: {
  folders: { guid: string; name: string; parentGuid: string | null }[]
  allFolders: { guid: string; name: string; parentGuid: string | null }[]
  sources: { guid: string; name: string }[]
  sourceFolder: Record<string, string>
  depth: number
  filter: string
  docsInFolder: (guid: string) => { guid: string; name: string }[]
  nestedFolders: (parentGuid: string | null) => { guid: string; name: string; parentGuid: string | null }[]
}) {
  return (
    <>
      {folders.map((folder) => {
        const childDocs = docsInFolder(folder.guid).filter((s) => !filter || s.name.toLowerCase().includes(filter))
        const childFolders = nestedFolders(folder.guid)
        if (filter && childDocs.length === 0 && childFolders.length === 0) return null
        return (
          <TreeNode key={folder.guid} label={folder.name} depth={depth} defaultOpen={!filter}>
            <FolderItems
              folders={childFolders}
              allFolders={allFolders}
              sources={sources}
              sourceFolder={sourceFolder}
              depth={depth + 1}
              filter={filter}
              docsInFolder={docsInFolder}
              nestedFolders={nestedFolders}
            />
            {childDocs.map((s) => (
              <DraggableItem
                key={s.guid}
                kind="document"
                data={{ entityGuid: s.guid, label: s.name }}
                label={s.name}
                iconColor="#6366f1"
                depth={depth + 1}
              />
            ))}
          </TreeNode>
        )
      })}
    </>
  )
}

/* ── Main sidebar ──────────────────────────────────────────── */

export function MapSidebar({ data, visible }: Props) {
  const { t } = useTranslation()
  const [filter, setFilter] = useState('')
  const lower = filter.toLowerCase()

  // Multi-selection for the draggable leaf items:
  //   plain click    — select only this, set as anchor
  //   Cmd/Ctrl-click — toggle this in/out of selection, set as anchor
  //   shift-click    — select range from anchor to this (in DOM order)
  //   shift+Cmd      — add range to existing selection (don't clear)
  // Dragging a selected item drags the whole selection; dragging an
  // unselected item drags just that one.
  const [selectionMap, setSelectionMap] = useState<Map<string, SelectionPayload>>(new Map())
  const selectionMapRef = useRef(selectionMap)
  selectionMapRef.current = selectionMap

  // Anchor = last item clicked without shift. Shift-click ranges from
  // here to the target. Kept in a ref because it doesn't need to
  // trigger re-renders.
  const anchorRef = useRef<string | null>(null)

  // Registry of every currently-rendered DraggableItem, keyed by uid.
  // Populated from the DraggableItem component via the context.
  const registryRef = useRef<Map<string, SelectionPayload>>(new Map())

  const registerItem = useCallback((uid: string, payload: SelectionPayload) => {
    registryRef.current.set(uid, payload)
  }, [])
  const unregisterItem = useCallback((uid: string) => {
    registryRef.current.delete(uid)
  }, [])

  const handleClick = useCallback((uid: string, payload: SelectionPayload, e: React.MouseEvent) => {
    setSelectionMap((prev) => {
      const next = new Map(prev)
      if (e.shiftKey && anchorRef.current && anchorRef.current !== uid) {
        // Range select from anchor → this target. DOM order is the
        // rendered order, which matches visual order in the sidebar.
        const allEls = Array.from(document.querySelectorAll<HTMLElement>('[data-uid]'))
        const uidsInOrder = allEls
          .map((el) => el.dataset.uid!)
          .filter((u) => registryRef.current.has(u))
        const startIdx = uidsInOrder.indexOf(anchorRef.current)
        const endIdx = uidsInOrder.indexOf(uid)
        if (startIdx >= 0 && endIdx >= 0) {
          const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx]
          // Without Cmd/Ctrl, a shift-click replaces the selection with
          // just the range. Hold Cmd/Ctrl to add the range to whatever
          // is already selected.
          if (!(e.metaKey || e.ctrlKey)) next.clear()
          for (let i = lo; i <= hi; i++) {
            const k = uidsInOrder[i]
            const p = registryRef.current.get(k)
            if (p) next.set(k, p)
          }
        }
        // Intentionally don't move anchor on shift-click — the user can
        // keep extending the range from the original pivot.
      } else if (e.metaKey || e.ctrlKey) {
        if (next.has(uid)) next.delete(uid)
        else next.set(uid, payload)
        anchorRef.current = uid
      } else {
        next.clear()
        next.set(uid, payload)
        anchorRef.current = uid
      }
      return next
    })
  }, [])

  const getDragPayload = useCallback((uid: string, payload: SelectionPayload) => {
    const cur = selectionMapRef.current
    if (cur.has(uid) && cur.size > 1) {
      return {
        kind: 'multi',
        items: Array.from(cur.values()).map((p) => ({ kind: p.kind, ...p.data }))
      }
    }
    return { kind: payload.kind, ...payload.data }
  }, [])

  const clearSelection = useCallback(() => {
    setSelectionMap(new Map())
    anchorRef.current = null
  }, [])

  const selectionCtxValue = useMemo<SelectionContextValue>(() => ({
    selected: new Set(selectionMap.keys()),
    handleClick,
    getDragPayload,
    clearSelection,
    registerItem,
    unregisterItem
  }), [selectionMap, handleClick, getDragPayload, clearSelection, registerItem, unregisterItem])

  if (!visible) return null

  const codeTree = buildCodeTree(data.codes)
  const filteredQueries = (data.savedQueries || []).filter((q) => q.name.toLowerCase().includes(lower))
  const filteredAnalyses = (data.savedAnalyses || []).filter((a) => a.name.toLowerCase().includes(lower))
  const filteredTags = data.tags.filter((t) => !lower || t.name.toLowerCase().includes(lower))
  const tagCategories = data.categories.filter((c) => filteredTags.some((t) => t.categoryGuid === c.guid))
  const uncategorizedTags = filteredTags.filter((t) => !t.categoryGuid)

  // Group memos: project memos, then by source document
  const memos = (data.memos || []).filter((m) => !lower || m.title.toLowerCase().includes(lower))
  const projectMemos = memos.filter((m) => m.type === 'project')
  const analysisMemos = memos.filter((m) => m.type === 'analysis')
  // Document & selection memos grouped by their parent source
  const docMemos = memos.filter((m) => m.type === 'document' || m.type === 'content')
  const memosBySource = new Map<string, typeof docMemos>()
  for (const m of docMemos) {
    const srcGuid = m.sourceGuid || (m.sourceGuids && m.sourceGuids[0]) || '__unlinked'
    if (!memosBySource.has(srcGuid)) memosBySource.set(srcGuid, [])
    memosBySource.get(srcGuid)!.push(m)
  }

  const filteredQuotes = (data.quotes || []).filter((q) => !lower || q.text.toLowerCase().includes(lower))
  const sourceNameMap = new Map(data.sources.map((s) => [s.guid, s.name]))

  return (
    <SelectionContext.Provider value={selectionCtxValue}>
    <div style={{
      width: 240, borderInlineEnd: '1px solid var(--border-color, #e0e0e0)',
      display: 'flex', flexDirection: 'column',
      background: 'var(--bg-secondary, #fafafa)', flexShrink: 0, overflow: 'hidden'
    }}>
      <div style={{ padding: 8, borderBottom: '1px solid var(--border-color, #e0e0e0)' }}>
        <input
          value={filter} onChange={(e) => setFilter(e.target.value)}
          placeholder={t('map.filterPlaceholder')}
          style={{
            width: '100%', padding: '5px 8px', fontSize: 12,
            border: '1px solid var(--border-color, #d0d0d0)', borderRadius: 6,
            outline: 'none', background: 'var(--bg-primary, #fff)',
            color: 'var(--text-primary, #1d1d1f)'
          }}
        />
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {/* Documents with folder nesting, plus tags */}
        <Section title={t('map.sectionDocuments', { count: data.sources.length })} defaultOpen>
          <DocumentTree
            sources={data.sources}
            folders={data.folders}
            sourceFolder={data.sourceFolder || {}}
            depth={1}
            filter={lower}
          />
          {data.sources.length === 0 && EMPTY}
          {/* Tags nested under Documents */}
          {filteredTags.length > 0 && (
            <TreeNode label={<><Icon icon={faTags} style={{ fontSize: 10, marginInlineEnd: 4 }} />{t('tags.heading')}</>} depth={1} defaultOpen={false}>
              {tagCategories.map((cat) => {
                const catTags = filteredTags.filter((t) => t.categoryGuid === cat.guid)
                if (catTags.length === 0) return null
                return (
                  <div key={cat.guid}>
                    <DraggableItem kind="tag-category" data={{ entityGuid: cat.guid, label: cat.name }} label={cat.name} icon={faTags} iconColor="#636e7b" depth={2} />
                    {catTags.map((t) => (
                      <DraggableItem key={t.guid} kind="tag" data={{ entityGuid: t.guid, label: t.name }} label={t.name} icon={faTag} iconColor="#636e7b" depth={3} />
                    ))}
                  </div>
                )
              })}
              {uncategorizedTags.length > 0 && uncategorizedTags.map((t) => (
                <DraggableItem key={t.guid} kind="tag" data={{ entityGuid: t.guid, label: t.name }} label={t.name} icon={faTag} iconColor="#636e7b" depth={2} />
              ))}
            </TreeNode>
          )}
        </Section>

        {/* Surveys — each survey expands to a Respondents subtree, a
            Questions subtree, and a Cells subtree (cells grouped by
            question). Three element kinds end up draggable to the
            canvas: survey-respondent (User icon), survey-question
            (MessageCircleQuestionMark icon), and survey-cell (answer
            text snippet). Only shown when the project contains at
            least one survey source. */}
        {(() => {
          const surveys = Object.entries(data.surveysByGuid || {})
            .map(([guid, survey]) => ({
              guid,
              name: data.sources.find((s) => s.guid === guid)?.name || survey.name,
              survey
            }))
            .filter((s) => !lower || s.name.toLowerCase().includes(lower))
          if (surveys.length === 0) return null
          return (
            <Section title={t('map.sectionSurveys', { count: surveys.length })}>
              {surveys.map((s) => {
                const respondents = s.survey.respondents
                const questions = s.survey.questions
                return (
                  <TreeNode key={s.guid} label={s.name} depth={1} defaultOpen={!!lower}>
                    {respondents.length > 0 && (
                      <TreeNode label={t('map.sectionRespondents', { count: respondents.length })} depth={2} defaultOpen={!!lower}>
                        {respondents
                          .filter((r) => !lower || r.displayName.toLowerCase().includes(lower))
                          .map((r) => (
                            <DraggableItem
                              key={`${s.guid}:${r.id}`}
                              kind="survey-respondent"
                              data={{
                                entityGuid: r.id,
                                label: r.displayName,
                                surveyGuid: s.guid
                              }}
                              label={r.displayName}
                              icon={SURVEY_RESPONDENT_ICON}
                              iconColor="#0E8A8A"
                              depth={3}
                            />
                          ))}
                      </TreeNode>
                    )}
                    {questions.length > 0 && (
                      <TreeNode label={t('map.sectionQuestions', { count: questions.length })} depth={2} defaultOpen={!!lower}>
                        {questions
                          .filter((q) => !lower || q.text.toLowerCase().includes(lower))
                          .map((q) => (
                            <DraggableItem
                              key={`${s.guid}:${q.id}`}
                              kind="survey-question"
                              data={{
                                entityGuid: q.id,
                                label: q.text,
                                surveyGuid: s.guid
                              }}
                              label={q.text}
                              icon={SURVEY_QUESTION_ICON}
                              iconColor="#1E6FA0"
                              depth={3}
                            />
                          ))}
                      </TreeNode>
                    )}
                    {/* Cells: grouped under their parent question. Each
                        leaf is a draggable answer for one (respondent,
                        question) pair. */}
                    {questions.length > 0 && respondents.length > 0 && (
                      <TreeNode label={t('map.cells')} depth={2} defaultOpen={false}>
                        {questions.map((q) => {
                          const cells = respondents
                            .map((r) => {
                              const text = buildCellText(r.answers[q.id])
                              if (!text) return null
                              return { respondent: r, text }
                            })
                            .filter((c): c is { respondent: typeof respondents[0]; text: string } => c !== null)
                            .filter((c) => !lower
                              || c.text.toLowerCase().includes(lower)
                              || c.respondent.displayName.toLowerCase().includes(lower))
                          if (cells.length === 0) return null
                          return (
                            <TreeNode key={`${s.guid}:cells:${q.id}`} label={q.text} depth={3} defaultOpen={false}>
                              {cells.map(({ respondent, text }) => {
                                const truncated = text.length > 40 ? text.slice(0, 40) + '…' : text
                                const label = `${respondent.displayName} — ${truncated}`
                                return (
                                  <DraggableItem
                                    key={`${s.guid}:${respondent.id}:${q.id}`}
                                    kind="survey-cell"
                                    data={{
                                      entityGuid: respondent.id,
                                      questionId: q.id,
                                      questionLabel: q.text,
                                      label: respondent.displayName,
                                      snippet: text,
                                      surveyGuid: s.guid,
                                      sourceGuid: s.guid
                                    }}
                                    label={label}
                                    icon={QUOTE_ICON}
                                    iconColor="#0E8A8A"
                                    depth={4}
                                  />
                                )
                              })}
                            </TreeNode>
                          )
                        })}
                      </TreeNode>
                    )}
                  </TreeNode>
                )
              })}
            </Section>
          )
        })()}

        {/* Codes with hierarchy */}
        <Section title={t('map.sectionCodes', { count: data.codes.length })} defaultOpen>
          <CodeTreeItems nodes={codeTree} depth={1} filter={lower} />
          {data.codes.length === 0 && EMPTY}
        </Section>

        {/* Queries */}
        <Section title={t('map.sectionQueries', { count: filteredQueries.length })}>
          {filteredQueries.map((q) => (
            <DraggableItem key={q.guid} kind="query" data={{ entityGuid: q.guid, label: q.name }} label={q.name} icon={faMagnifyingGlass} iconColor="#D06828" depth={1} />
          ))}
          {filteredQueries.length === 0 && EMPTY}
        </Section>

        {/* Analyses */}
        <Section title={t('map.sectionAnalyses', { count: filteredAnalyses.length })}>
          {filteredAnalyses.map((a) => (
            <DraggableItem key={a.guid} kind="analysis" data={{ entityGuid: a.guid, label: a.name, toolType: a.toolType }} label={a.name} icon={TOOL_REGISTRY[a.toolType]?.icon || faCircleNodes} iconColor={TOOL_REGISTRY[a.toolType]?.color || '#8e8e93'} depth={1} />
          ))}
          {filteredAnalyses.length === 0 && EMPTY}
        </Section>

        {/* Memos nested under type/document */}
        <Section title={t('map.sectionMemos', { count: memos.length })}>
          {projectMemos.length > 0 && (
            <TreeNode label={t('map.project')} depth={1} defaultOpen>
              {projectMemos.map((m) => (
                <DraggableItem key={m.guid} kind="memo" data={{ entityGuid: m.guid, label: m.title, snippet: m.content }} label={m.title} icon={MEMO_RANGED_ICON} iconColor="#8e8e93" depth={2} />
              ))}
            </TreeNode>
          )}
          {[...memosBySource.entries()].map(([srcGuid, srcMemos]) => {
            const srcName = sourceNameMap.get(srcGuid) || t('map.unlinked')
            return (
              <TreeNode key={srcGuid} label={srcName} depth={1} defaultOpen>
                {srcMemos.map((m) => (
                  <DraggableItem key={m.guid} kind="memo" data={{ entityGuid: m.guid, label: m.title, snippet: m.content }} label={m.title} icon={MEMO_RANGED_ICON} iconColor="#8e8e93" depth={2} />
                ))}
              </TreeNode>
            )
          })}
          {analysisMemos.length > 0 && (
            <TreeNode label={t('map.analysis')} depth={1} defaultOpen>
              {analysisMemos.map((m) => (
                <DraggableItem key={m.guid} kind="memo" data={{ entityGuid: m.guid, label: m.title, snippet: m.content }} label={m.title} icon={MEMO_RANGED_ICON} iconColor="#8e8e93" depth={2} />
              ))}
            </TreeNode>
          )}
          {memos.length === 0 && EMPTY}
        </Section>

        {/* Quotes */}
        <Section title={t('map.sectionQuotes', { count: filteredQuotes.length })}>
          {filteredQuotes.map((q) => (
            <DraggableItem
              key={q.guid}
              kind="quote"
              data={{ entityGuid: q.guid, label: q.sourceName, snippet: stripFormatting(q.text, sourceTypeFromFilename(q.sourceName)), sourceGuid: q.sourceGuid, startPosition: q.startPosition, endPosition: q.endPosition }}
              label={(() => { const text = stripFormatting(q.text, sourceTypeFromFilename(q.sourceName)); return `"${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"` })()}
              icon={QUOTE_ICON}
              iconColor="var(--quote-icon-color)"
              depth={1}
            />
          ))}
          {filteredQuotes.length === 0 && EMPTY}
        </Section>
      </div>
    </div>
    </SelectionContext.Provider>
  )
}
