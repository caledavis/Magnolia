/**
 * Inter-coder Agreement — compares how two or more coders coded the same
 * documents. Three drop zones, worked left to right: the coders' project
 * files (the open project plus .qdpx files added with the picker or
 * dropped in), the documents to compare (dragged from the Document
 * Browser; clicking one shows which projects have it), and the codes
 * (dragged from the Code Browser). Results sit below: per code, with
 * each document a click away, for every pair of coders — by characters
 * (% agreement, Cohen's kappa, Krippendorff's alpha for 3+) or by
 * segments (overlap threshold). Clicking a pair's cell opens the
 * passages where the two coders differ, side by side.
 *
 * A saved analysis keeps the file paths and selections plus a snapshot of
 * the results, so a report (and a reopened analysis whose files have
 * moved) can still show them.
 */
import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import type { AnalysisInitData } from '../../../models/types'
import {
  Icon,
  faUsers,
  faXmark,
  faPlus,
  faExclamationTriangle
} from '../../Icon'
import { useIconTint, PALETTE_ICON_CLASS } from '../../../utils/icon-tint'
import { EditableTitleSuffix } from '../../EditableTitleSuffix'
import { renameSavedAnalysis } from '../../../utils/rename-saved-analysis'
import { generateGuid } from '../../../utils/guid'
import { useToolDirtyState } from '../../../hooks/use-tool-dirty-state'
import { useRegisterToolSave } from '../../../hooks/use-register-tool-save'
import { useAnalysisTabsStore } from '../../../stores/analysis-tabs-store'
import { useDocumentStore } from '../../../stores/document-store'
import { useCodeStore } from '../../../stores/code-store'
import { usePreferencesStore } from '../../../stores/preferences-store'
import { useProjectStore } from '../../../stores/project-store'
import {
  IntercoderResults,
  docIcon,
  btnStyle,
  smallBtn,
  rowStyle,
  ellipsis,
  xStyle,
  emptyPane,
  coderBadge,
  countBadge,
  type Drill,
  type DrillData,
  type IntercoderResultsData
} from './IntercoderResults'
import { toCsv } from '../analysis-helpers'
import { descendantFolderGuids } from '../group-by'
import { useTranslation } from 'react-i18next'
import { formatNumber } from '../../../i18n'
import {
  OPEN_PROJECT_ID,
  matchDocuments,
  matchCodes,
  computeAgreement,
  syncExtents,
  type CoderProject,
  type MatchedDoc,
  type MatchedCode,
  type Measure,
  type DocExtents
} from './intercoder-model'
import {
  openProjectCoder,
  fileCoder,
  isOpenProjectPath,
  loadRegionExtents,
  needsRegionExtents,
  mergeExtents,
  loadErrorMessage
} from './load-coders'
import {
  type ResultsView,
  exportRows,
  type IntercoderSnapshot
} from './intercoder-tables'

export interface IntercoderConfig {
  /** Coders' project files in order; OPEN_PROJECT_ID for the open one. */
  paths: string[]
  /** The documents and codes dropped in, in order, as the open
   *  project's guids (what the Browsers drag). */
  docGuids: string[]
  codeGuids: string[]
  measure: Measure
  /** Results by pair of coders, or by coder against the rest (3+ coders). */
  view?: ResultsView
  /** Segments: minimum overlap (intersection ÷ union), 0–1. */
  threshold: number
  /** The results as last computed — what reports show, and what the
   *  tool falls back on when a file can't be opened any more. */
  snapshot?: IntercoderSnapshot
}

interface Props {
  data: AnalysisInitData
  savedConfig?: Partial<IntercoderConfig> & { guid?: string; name?: string }
  inTab?: {
    onClose: () => void
    onSaved: (savedGuid: string, name: string) => void
    onDirtyChange?: (dirty: boolean) => void
    tabId?: string
  }
}

const DEFAULT_THRESHOLD = 0.9
const PANE_H = 230

function isDocDrag(e: React.DragEvent): boolean {
  const types = e.dataTransfer.types
  return types.includes('application/x-magnolia-docs') || types.includes('application/x-magnolia-folder')
}

function isCodeDrag(e: React.DragEvent): boolean {
  const types = e.dataTransfer.types
  return types.includes('application/x-magnolia-code') || types.includes('application/x-magnolia-codes')
}

/** Document guids from a Document Browser drag: the selected documents,
 *  or every document in a folder and its subfolders. */
function parseDocDrop(e: React.DragEvent): string[] {
  const folderGuid = e.dataTransfer.getData('application/x-magnolia-folder')
  if (folderGuid) {
    const { sources, folders, sourceFolder } = useDocumentStore.getState()
    const inside = descendantFolderGuids(folders, folderGuid)
    return sources.filter((s) => inside.has(sourceFolder[s.guid])).map((s) => s.guid)
  }
  try {
    const guids = JSON.parse(e.dataTransfer.getData('application/x-magnolia-docs') || '[]') as unknown
    return Array.isArray(guids) ? guids.filter((g): g is string => typeof g === 'string') : []
  } catch { return [] }
}

function parseCodeDrop(e: React.DragEvent): string[] {
  try {
    const multi = e.dataTransfer.getData('application/x-magnolia-codes')
    const single = e.dataTransfer.getData('application/x-magnolia-code')
    const codes = (multi ? JSON.parse(multi) : single ? [JSON.parse(single)] : []) as { guid?: string }[]
    return codes.map((c) => c.guid).filter((g): g is string => typeof g === 'string')
  } catch { return [] }
}

/** Drag-over / leave / drop handlers for a pane that accepts `accepts`
 *  drags, lighting it while one is over it. Drops are stopped here so a
 *  dropped file isn't also imported by the window. */
function dropHandlers(
  accepts: (e: React.DragEvent) => boolean,
  setOver: (over: boolean) => void,
  onDrop: (e: React.DragEvent) => void
) {
  return {
    onDragOver: (e: React.DragEvent) => {
      if (!accepts(e)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = e.dataTransfer.effectAllowed === 'move' ? 'move' : 'copy'
      setOver(true)
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false)
    },
    onDrop: (e: React.DragEvent) => {
      setOver(false)
      if (!accepts(e)) return
      e.preventDefault()
      e.stopPropagation()
      onDrop(e)
    }
  }
}

function uniqueResolved<T>(guids: string[], resolve: (g: string) => T | undefined): T[] {
  const out: T[] = []
  for (const g of guids) {
    const x = resolve(g)
    if (x && !out.includes(x)) out.push(x)
  }
  return out
}

const appendNew = (prev: string[], fresh: string[]): string[] => {
  const out = [...prev]
  for (const g of fresh) if (!out.includes(g)) out.push(g)
  return out
}

export function IntercoderAgreement({ savedConfig, inTab }: Props) {
  const { t } = useTranslation()
  const tint = useIconTint()

  // ── Configuration ─────────────────────────────────────────────────
  const [paths, setPaths] = useState<string[]>(savedConfig?.paths ?? [OPEN_PROJECT_ID])
  const [docGuids, setDocGuids] = useState<string[]>(savedConfig?.docGuids ?? [])
  const [codeGuids, setCodeGuids] = useState<string[]>(savedConfig?.codeGuids ?? [])
  const [measure, setMeasure] = useState<Measure>(savedConfig?.measure ?? 'characters')
  const [threshold, setThreshold] = useState<number>(savedConfig?.threshold ?? DEFAULT_THRESHOLD)
  const [view, setView] = useState<ResultsView>(savedConfig?.view ?? 'pairs')
  const savedSnapshot = savedConfig?.snapshot

  // ── Loaded projects ───────────────────────────────────────────────
  const [fileCoders, setFileCoders] = useState<Record<string, CoderProject>>({})
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState<string[]>([])
  const [dropOver, setDropOver] = useState<'docs' | 'codes' | null>(null)

  // The open project, live: rebuilt whenever its codes, documents or
  // text change, so coding while the tool is open shows straight away.
  const docSources = useDocumentStore((s) => s.sources)
  const docContents = useDocumentStore((s) => s.sourceContents)
  const storeCodes = useCodeStore((s) => s.codes)
  const userName = usePreferencesStore((s) => s.userName)
  const projectPath = useProjectStore((s) => s.filePath)
  const openCoder = useMemo(() => openProjectCoder(), [docSources, docContents, storeCodes, userName, projectPath])

  useEffect(() => {
    for (const p of paths) {
      if (p === OPEN_PROJECT_ID || fileCoders[p] || loadErrors[p] || loading.includes(p)) continue
      setLoading((prev) => [...prev, p])
      fileCoder(p)
        .then((c) => setFileCoders((prev) => ({ ...prev, [p]: c })))
        .catch((err) => setLoadErrors((prev) => ({ ...prev, [p]: loadErrorMessage(p.split(/[/\\]/).pop() ?? p, err) })))
        .finally(() => setLoading((prev) => prev.filter((x) => x !== p)))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paths])

  const coders = useMemo(
    () => paths.map((p) => (p === OPEN_PROJECT_ID ? openCoder : fileCoders[p])).filter((c): c is CoderProject => !!c),
    [paths, openCoder, fileCoders]
  )
  const allLoaded = coders.length === paths.length

  const addPaths = useCallback((fresh: string[]) => {
    setPaths((prev) => {
      const out = [...prev]
      for (const raw of fresh) {
        const p = isOpenProjectPath(raw) ? OPEN_PROJECT_ID : raw
        if (!out.includes(p)) out.push(p)
      }
      return out
    })
  }, [])

  const handlePick = useCallback(async () => {
    const picked = await window.api.pickProjectFiles()
    if (picked.length) addPaths(picked)
  }, [addPaths])

  // A project that couldn't be opened (moved, renamed, deleted): pick
  // the file again, and it takes the old one's place in the list.
  const relocate = useCallback(async (p: string) => {
    const picked = await window.api.pickProjectFile()
    if (!picked) return
    const np = isOpenProjectPath(picked) ? OPEN_PROJECT_ID : picked
    setPaths((prev) => (prev.includes(np) && np !== p ? prev.filter((x) => x !== p) : prev.map((x) => (x === p ? np : x))))
    setLoadErrors((prev) => { const n = { ...prev }; delete n[p]; return n })
  }, [])

  const removePath = useCallback((p: string) => {
    setPaths((prev) => prev.filter((x) => x !== p))
    setLoadErrors((prev) => { const n = { ...prev }; delete n[p]; return n })
  }, [])

  // ── Matching and selection ────────────────────────────────────────
  const docs = useMemo(() => matchDocuments(coders), [coders])
  const codes = useMemo(() => matchCodes(coders), [coders])

  // Dropped guids → matched documents / codes. A guid is found among the
  // matched members; if the open project isn't one of the coders, by the
  // open project's name (documents, with type) or path (codes).
  const resolveDoc = useCallback((g: string): MatchedDoc | undefined => {
    const d = docs.find((x) => Object.values(x.members).includes(g))
    if (d) return d
    const s = openCoder.sources.find((x) => x.guid === g)
    return s ? docs.find((x) => x.name === s.name && (x.sourceType ?? 'text') === (s.sourceType ?? 'text')) : undefined
  }, [docs, openCoder])
  const openCodePaths = useMemo(() => new Map(matchCodes([openCoder]).map((c) => [c.key, c.path])), [openCoder])
  const resolveCode = useCallback((g: string): MatchedCode | undefined => {
    const c = codes.find((x) => Object.values(x.members).includes(g))
    if (c) return c
    const path = openCodePaths.get(g)
    return path ? codes.find((x) => x.path === path) : undefined
  }, [codes, openCodePaths])

  const selDocs = useMemo(() => uniqueResolved(docGuids, resolveDoc), [docGuids, resolveDoc])
  const selCodes = useMemo(() => uniqueResolved(codeGuids, resolveCode), [codeGuids, resolveCode])
  // Removing drops every guid that resolves to the item.
  const removeDoc = (d: MatchedDoc) => setDocGuids((prev) => prev.filter((g) => resolveDoc(g) !== d))
  const removeCode = (c: MatchedCode) => setCodeGuids((prev) => prev.filter((g) => resolveCode(g) !== c))

  const docDrop = dropHandlers(isDocDrag, (o) => setDropOver(o ? 'docs' : null), (e) => {
    const fresh = parseDocDrop(e)
    if (fresh.length) setDocGuids((prev) => appendNew(prev, fresh))
  })
  const codeDrop = dropHandlers(isCodeDrag, (o) => setDropOver(o ? 'codes' : null), (e) => {
    const fresh = parseCodeDrop(e)
    if (fresh.length) setCodeGuids((prev) => appendNew(prev, fresh))
  })

  const [focusDoc, setFocusDoc] = useState<string | null>(null)
  const focusMembers = focusDoc ? docs.find((d) => d.key === focusDoc)?.members : undefined

  // ── Extents (page areas load from the files) ──────────────────────
  const [regionAreas, setRegionAreas] = useState<Record<string, Record<string, number> | null>>({})
  useEffect(() => {
    let cancelled = false
    for (const d of selDocs) {
      if (d.key in regionAreas || !needsRegionExtents(coders, d)) continue
      void loadRegionExtents(coders, d).then((areas) => {
        if (!cancelled) setRegionAreas((prev) => (d.key in prev ? prev : { ...prev, [d.key]: areas }))
      })
    }
    return () => { cancelled = true }
  }, [selDocs, coders, regionAreas])

  const extents = useMemo(() => {
    const out: Record<string, DocExtents> = {}
    for (const d of selDocs) {
      const first = coders.find((p) => d.members[p.id])
      if (first) out[d.key] = mergeExtents(syncExtents(first, d), regionAreas[d.key] ?? null)
    }
    return out
  }, [selDocs, coders, regionAreas])

  // ── Results ───────────────────────────────────────────────────────
  const liveSnapshot = useMemo<IntercoderSnapshot | null>(() => {
    if (coders.length < 2 || selCodes.length === 0 || selDocs.length === 0) return null
    const results = computeAgreement({ projects: coders, docs: selDocs, codes: selCodes, extents, threshold })
    return {
      computedAt: new Date().toISOString(),
      measure,
      coders: coders.map((c) => ({ label: c.label, fileName: c.fileName })),
      codes: selCodes.map((c) => ({ key: c.key, name: c.name, path: c.path, color: c.color })),
      docs: selDocs.map((d) => ({ key: d.key, name: d.name, sourceType: d.sourceType })),
      results
    }
  }, [coders, selDocs, selCodes, extents, threshold, measure])

  // While any file is missing, show the saved results rather than a
  // comparison of whoever did load.
  const showingSaved = !allLoaded && loading.length === 0 && !!savedSnapshot
  const snapshot = showingSaved ? savedSnapshot! : allLoaded ? liveSnapshot : null

  const [expanded, setExpanded] = useState<string[]>([])
  const toggleExpanded = useCallback((key: string) =>
    setExpanded((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key])), [])

  const [drill, setDrill] = useState<Drill | null>(null)
  useEffect(() => { setDrill(null) }, [paths, measure, view])
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)

  // ── Persistence ───────────────────────────────────────────────────
  const [analysisGuid] = useState(savedConfig?.guid ?? generateGuid())
  const [analysisName, setAnalysisName] = useState(savedConfig?.name ?? '')
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const isExisting = !!savedConfig?.guid
  const savedRef = useRef(isExisting)
  const nameRef = useRef(analysisName)

  const currentConfig = useMemo(() => ({ paths, docGuids, codeGuids, measure, view, threshold }), [paths, docGuids, codeGuids, measure, view, threshold])
  const initialBaseline = useMemo(() => ({
    paths: savedConfig?.paths ?? [OPEN_PROJECT_ID],
    docGuids: savedConfig?.docGuids ?? [],
    codeGuids: savedConfig?.codeGuids ?? [],
    measure: savedConfig?.measure ?? 'characters',
    view: savedConfig?.view ?? 'pairs',
    threshold: savedConfig?.threshold ?? DEFAULT_THRESHOLD
  }), [])
  const { dirty, baseline, setBaseline } = useToolDirtyState(currentConfig, initialBaseline, inTab)

  const persistMountRef = useRef(true)
  useEffect(() => {
    if (persistMountRef.current) { persistMountRef.current = false; return }
    const tabId = inTab?.tabId
    if (tabId) useAnalysisTabsStore.getState().setConfig(tabId, { ...currentConfig, snapshot: savedSnapshot })
  }, [currentConfig, inTab?.tabId])

  const handleSave = useCallback((name: string) => {
    setAnalysisName(name)
    nameRef.current = name
    savedRef.current = true
    setShowSaveDialog(false)
    window.api.sendAnalysisAction('save-analysis', {
      guid: analysisGuid,
      toolType: 'intercoder-agreement',
      name,
      config: { ...currentConfig, snapshot: snapshot ?? savedSnapshot }
    })
    setBaseline(currentConfig)
    if (inTab) inTab.onSaved(analysisGuid, name)
    else setTimeout(() => window.close(), 200)
  }, [analysisGuid, currentConfig, snapshot, savedSnapshot, inTab, setBaseline])

  const handleDiscard = useCallback(() => {
    setPaths(baseline.paths)
    setDocGuids(baseline.docGuids)
    setCodeGuids(baseline.codeGuids)
    setMeasure(baseline.measure)
    setView(baseline.view)
    setThreshold(baseline.threshold)
  }, [baseline])

  const handleRename = useCallback((newName: string) => {
    setAnalysisName(newName)
    nameRef.current = newName
    renameSavedAnalysis(analysisGuid, newName)
    if (inTab) inTab.onSaved('', newName)
  }, [analysisGuid, inTab])

  useRegisterToolSave(inTab?.tabId, () => {
    if (isExisting) {
      handleSave(analysisName)
      return true
    }
    setShowSaveDialog(true)
    return false
  })

  // ── Export ────────────────────────────────────────────────────────
  const handleExportCsv = useCallback(() => {
    if (!snapshot) return
    const rows = exportRows(snapshot, view)
    window.api.exportCsv(toCsv(rows), 'intercoder-agreement.csv')
  }, [snapshot, view])

  // ── Results, here or in their own window ──────────────────────────
  // By coder needs three or more coders; with two it's the one pair.
  const byCoderOffered = (snapshot?.coders.length ?? coders.length) >= 3
  const emptyMessage = loading.length > 0 ? t('intercoder.loading')
    : coders.length < 2 ? t('intercoder.needTwo')
      : selDocs.length === 0 ? t('intercoder.pickDocuments')
        : t('intercoder.pickCodes')
  const docNames = useMemo(() => Object.fromEntries(docs.map((d) => [d.key, d.name])), [docs])
  const drillData = useMemo<DrillData | null>(() => drill ? {
    coders,
    docs: drill.docKey ? selDocs.filter((d) => d.key === drill.docKey) : selDocs,
    code: selCodes.find((c) => c.key === drill.codeKey)
  } : null, [drill, coders, selDocs, selCodes])
  const resultsData: IntercoderResultsData = {
    snapshot, view, measure, threshold, showingSaved, byCoderOffered, emptyMessage, docNames, expanded, drill, drillData
  }

  // The results can pop out into a window of their own, as the Query
  // Results can: it's sent what it shows, and sends back what the user
  // does there. A clicked result's passages are read from the coders'
  // projects, so it gets those, cut down to the documents compared.
  const [poppedOut, setPoppedOut] = useState(false)
  const windowTitle = t('tools.intercoderAgreement.label') + (analysisName ? `: ${analysisName}` : '')
  const windowData = useMemo(() => ({
    ...resultsData,
    drillData: drillData && {
      ...drillData,
      coders: drillData.coders.map((c) => trimCoder(c, drillData.docs))
    },
    title: windowTitle,
    theme: document.documentElement.getAttribute('data-theme') || ''
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [snapshot, view, measure, threshold, showingSaved, byCoderOffered, emptyMessage, docNames, expanded, drill, drillData, windowTitle])
  const togglePopOut = () => {
    if (poppedOut) window.api.closeIntercoderResultsWindow()
    else {
      window.api.openIntercoderResultsWindow(windowData)
      setPoppedOut(true)
    }
  }
  useEffect(() => {
    if (poppedOut) window.api.updateIntercoderResultsWindow(windowData)
  }, [poppedOut, windowData])
  useEffect(() => {
    if (!poppedOut) return
    const stopActions = window.api.onIntercoderResultsAction((action, payload) => {
      if (action === 'view') setView(payload as ResultsView)
      else if (action === 'measure') setMeasure(payload as Measure)
      else if (action === 'threshold') setThreshold(payload as number)
      else if (action === 'toggle-expanded') toggleExpanded(payload as string)
      else if (action === 'drill') setDrill(payload as Drill | null)
    })
    // Closed (or popped back in) from the window itself.
    const stopClosed = window.api.onIntercoderResultsClosed(() => setPoppedOut(false))
    return () => { stopActions(); stopClosed() }
  }, [poppedOut, toggleExpanded])
  // Closing the tool closes its window.
  const poppedOutRef = useRef(poppedOut)
  poppedOutRef.current = poppedOut
  useEffect(() => () => { if (poppedOutRef.current) window.api.closeIntercoderResultsWindow() }, [])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '14px 20px 6px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)' }}>
          <Icon icon={faUsers} className="analysis-header-icon" style={{ fontSize: 16 }} />
          {t('tools.intercoderAgreement.label')}{isExisting || savedRef.current ? ':' : ''}
          {(isExisting || savedRef.current) && <EditableTitleSuffix name={analysisName} onRename={handleRename} />}
        </h2>
        <div style={{ flex: 1 }} />
        <button className="secondary" style={btnStyle} onClick={() => (inTab ? inTab.onClose() : window.close())}>{t('common.close')}</button>
        {isExisting && dirty && <button className="secondary" style={btnStyle} onClick={handleDiscard}>{t('common.discardChanges')}</button>}
        <button className="secondary" style={btnStyle} onClick={handleExportCsv} disabled={!snapshot}>{t('analysis.exportCsv')}</button>
        {savedRef.current ? (
          <button style={btnStyle} disabled={!dirty} onClick={() => handleSave(nameRef.current.trim() || t('common.untitled'))}>
            {dirty ? t('analysis.update') : t('analysis.saved')}
          </button>
        ) : (
          <button style={btnStyle} onClick={() => setShowSaveDialog(true)}>{t('analysis.save')}</button>
        )}
        {/* Clearance for the floating MemoFab. */}
        <div style={{ width: 36, flexShrink: 0 }} />
      </div>

      {showSaveDialog && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{t('analysis.save')}</h2>
            <input
              autoFocus
              type="text"
              defaultValue={analysisName}
              placeholder={t('analysis.namePlaceholder')}
              style={{ width: '100%' }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave((e.target as HTMLInputElement).value.trim() || t('common.untitled'))
                if (e.key === 'Escape') setShowSaveDialog(false)
              }}
            />
            <div className="modal-actions">
              <button className="secondary" onClick={() => setShowSaveDialog(false)}>{t('common.cancel')}</button>
              <button onClick={(e) => {
                const input = (e.target as HTMLElement).parentElement!.parentElement!.querySelector('input') as HTMLInputElement
                handleSave(input.value.trim() || t('common.untitled'))
              }}>{t('common.save')}</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ padding: '4px 20px 8px', fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>{t('intercoder.intro')}</div>
      {(() => {
        // Coders' projects that couldn't be opened, said at the top so
        // it isn't missed: the results are then the saved ones.
        const missing = paths.filter((p) => loadErrors[p])
        if (missing.length === 0) return null
        return (
          <div role="alert" style={{
            margin: '0 20px 8px', padding: '7px 10px', fontSize: 11, display: 'flex', alignItems: 'flex-start', gap: 8, flexShrink: 0,
            color: 'var(--text-primary)', borderRadius: 'var(--radius-md)',
            background: 'color-mix(in srgb, #d39b1a 14%, var(--bg-panel))', border: '1px solid color-mix(in srgb, #d39b1a 45%, transparent)'
          }}>
            <Icon icon={faExclamationTriangle} style={{ fontSize: 12, color: 'var(--warning, #c68a00)', marginTop: 1, flexShrink: 0 }} />
            <span>{t('intercoder.missingBanner', { names: missing.map((p) => p.split(/[/\\]/).pop()).join(', ') })}</span>
          </div>
        )
      })()}

      <div ref={setScroller} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 20px 14px' }}>
        {/* ── The three panes ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10, height: PANE_H }}>
          {/* 1. Projects */}
          <Pane
            title={t('intercoder.paneProjects')}
            step={1}
            actions={<button className="secondary" style={smallBtn} onClick={() => void handlePick()}><Icon icon={faPlus} style={{ fontSize: 10 }} /> {t('intercoder.addProjects')}</button>}
          >
            {/* Projects are added with Add projects only: a file dropped
                into the window arrives without its location on disk, so
                it could only be read from a temporary copy that a saved
                analysis could never find again. */}
            {paths.map((p, i) => {
              const c = p === OPEN_PROJECT_ID ? openCoder : fileCoders[p]
              const err = loadErrors[p]
              const has = focusMembers ? !!c && !!focusMembers[c.id] : null
              return (
                <div
                  key={p}
                  style={{
                    ...rowStyle,
                    alignItems: 'flex-start',
                    background: has ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : undefined,
                    opacity: has === false ? 0.45 : 1
                  }}
                >
                  <span style={coderBadge}>{formatNumber(i + 1)}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                      {err && (
                        <span title={err} style={{ display: 'inline-flex', flexShrink: 0, color: 'var(--warning, #c68a00)' }}>
                          <Icon icon={faExclamationTriangle} style={{ fontSize: 11 }} />
                        </span>
                      )}
                      <span style={ellipsis} title={c?.label}>
                        {c ? c.label : err ? p.split(/[/\\]/).pop() : t('intercoder.loading')}
                      </span>
                    </div>
                    <div style={{ ...ellipsis, fontSize: 10, color: err ? 'var(--danger, #c0392b)' : 'var(--text-muted)' }} title={err ?? p}>
                      {err ?? (p === OPEN_PROJECT_ID ? t('intercoder.openProject', { name: c?.fileName ?? '' }) : c?.fileName ?? '')}
                    </div>

                  </div>
                  {err && (
                    <button className="secondary" style={{ ...smallBtn, flexShrink: 0 }} title={t('intercoder.locateTitle')} onClick={() => void relocate(p)}>
                      {t('intercoder.locate')}
                    </button>
                  )}
                  <span onClick={() => removePath(p)} title={t('intercoder.removeProject')} style={xStyle}><Icon icon={faXmark} style={{ fontSize: 10 }} /></span>
                </div>
              )
            })}
            <div style={{ padding: '8px 10px', fontSize: 10, color: 'var(--text-muted)' }}>
              {paths.length < 2 ? t('intercoder.needTwo') : t('intercoder.dropHint')}
            </div>
          </Pane>

          {/* 2. Documents */}
          <Pane
            title={t('intercoder.paneDocuments')}
            step={2}
            actions={selDocs.length > 0 && <ClearButton onClear={() => { setDocGuids([]); setFocusDoc(null) }} />}
            dropOver={dropOver === 'docs'}
            {...docDrop}
          >
            {selDocs.length === 0 ? (
              <div style={emptyPane}>{t('intercoder.dropDocuments')}</div>
            ) : selDocs.map((d) => {
              const n = Object.keys(d.members).length
              const ic = docIcon(d.sourceType)
              const isFocus = focusDoc === d.key
              return (
                <div
                  key={d.key}
                  style={{ ...rowStyle, background: isFocus ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : undefined, cursor: 'pointer' }}
                  onClick={() => setFocusDoc(isFocus ? null : d.key)}
                  title={n < 2 ? t('intercoder.docNotShared') : t('intercoder.docInProjects', { count: n, total: coders.length })}
                >
                  <Icon className={PALETTE_ICON_CLASS} icon={ic.icon} style={{ fontSize: 12, width: 13, color: 'var(--text-muted)', flexShrink: 0, ...(ic.tint ? tint(ic.tint) : {}) }} />
                  <span style={{ ...ellipsis, flex: 1, color: n < 2 ? 'var(--text-muted)' : undefined }}>{d.name}</span>
                  {d.textDiffers && (
                    <span title={t('intercoder.textDiffersTitle')} style={{ color: 'var(--warning, #c68a00)', display: 'inline-flex' }}>
                      <Icon icon={faExclamationTriangle} style={{ fontSize: 11 }} />
                    </span>
                  )}
                  {n < coders.length && <span style={countBadge}>{formatNumber(n)}/{formatNumber(coders.length)}</span>}
                  <span
                    onClick={(e) => { e.stopPropagation(); removeDoc(d); if (isFocus) setFocusDoc(null) }}
                    title={t('intercoder.removeDocument')}
                    style={xStyle}
                  >
                    <Icon icon={faXmark} style={{ fontSize: 10 }} />
                  </span>
                </div>
              )
            })}
          </Pane>

          {/* 3. Codes */}
          <Pane
            title={t('intercoder.paneCodes')}
            step={3}
            actions={selCodes.length > 0 && <ClearButton onClear={() => setCodeGuids([])} />}
            dropOver={dropOver === 'codes'}
            {...codeDrop}
          >
            {selCodes.length === 0 ? (
              <div style={emptyPane}>{t('intercoder.dropCodes')}</div>
            ) : selCodes.map((c) => {
              const n = Object.keys(c.members).length
              return (
                <div key={c.key} style={rowStyle} title={c.path}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.color || '#888', flexShrink: 0 }} />
                  <span style={{ ...ellipsis, flex: 1 }}>{c.name}</span>
                  {n < coders.length && <span style={countBadge} title={t('intercoder.codeInProjects', { count: n, total: coders.length })}>{formatNumber(n)}/{formatNumber(coders.length)}</span>}
                  <span onClick={() => removeCode(c)} title={t('intercoder.removeCode')} style={xStyle}><Icon icon={faXmark} style={{ fontSize: 10 }} /></span>
                </div>
              )
            })}
          </Pane>
        </div>

        {poppedOut ? (
          <div style={{ ...emptyPane, marginTop: 14, padding: '30px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, background: 'var(--bg-panel)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
            {t('intercoder.resultsPoppedOut')}
            <button className="secondary" style={btnStyle} onClick={togglePopOut}>{t('panel.popIn')}</button>
          </div>
        ) : (
          <IntercoderResults
            {...resultsData}
            scroller={scroller}
            poppedOut={false}
            onPopOut={togglePopOut}
            onView={setView}
            onMeasure={setMeasure}
            onThreshold={setThreshold}
            onToggleExpanded={toggleExpanded}
            onDrill={setDrill}
          />
        )}
      </div>
    </div>
  )
}


/** A coder's project cut down to `docs`, for the pop-out window. */
function trimCoder(c: CoderProject, docs: MatchedDoc[]): CoderProject {
  const keep = new Set(docs.map((d) => d.members[c.id]).filter(Boolean))
  const sources = c.sources.filter((s) => keep.has(s.guid))
  const sourceContents: Record<string, string> = {}
  for (const s of sources) if (s.guid in c.sourceContents) sourceContents[s.guid] = c.sourceContents[s.guid]
  return { ...c, sources, sourceContents }
}

// ── Small pieces ───────────────────────────────────────────────────────

function Pane({ title, step, actions, children, dropOver, onDragOver, onDragLeave, onDrop }: {
  title: string
  step: number
  actions?: React.ReactNode
  children: React.ReactNode
  dropOver?: boolean
  /** Takes dropped files itself, so the window's "drop to import" cue
   *  stays hidden over it. */
  onDragOver?: (e: React.DragEvent) => void
  onDragLeave?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
}) {
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0,
        background: 'var(--bg-panel)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md) var(--radius-md) 0 0' }}>
        <span style={coderBadge}>{step}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', flex: 1 }}>{title}</span>
        {actions}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 0' }}>{children}</div>
      {dropOver && (
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none', borderRadius: 'var(--radius-md)',
          background: 'color-mix(in srgb, var(--accent) 8%, transparent)', border: '2px dashed var(--accent)'
        }} />
      )}
    </div>
  )
}

function ClearButton({ onClear }: { onClear: () => void }) {
  const { t } = useTranslation()
  return (
    <button className="secondary" style={smallBtn} onClick={onClear}>{t('intercoder.clear')}</button>
  )
}
