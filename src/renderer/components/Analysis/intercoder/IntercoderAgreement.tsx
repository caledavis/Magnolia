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
import { useState, useMemo, useCallback, useEffect, useRef, Fragment } from 'react'
import type { AnalysisInitData } from '../../../models/types'
import {
  Icon,
  faUsers,
  faXmark,
  faPlus,
  faFile,
  faHeadphones,
  faVideo,
  faImage,
  faChevronDown,
  faChevronRight,
  faExclamationTriangle,
  faCircleInfo,
  SURVEY_ICON,
  type IconComponent
} from '../../Icon'
import { useIconTint, iconTintKindForSourceType, PALETTE_ICON_CLASS, type IconTintKind } from '../../../utils/icon-tint'
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
import { SegmentedControl } from '../SegmentedControl'
import { toCsv } from '../analysis-helpers'
import { formatTimestamp } from '../../../utils/timestamp-parser'
import { renderPdfRegionThumbnail } from '../../../utils/pdf-thumbnail'
import { renderImageRegionThumbnail } from '../../../utils/image-thumbnail'
import { mediaPathField } from '../../../utils/binary-handles'
import { descendantFolderGuids } from '../group-by'
import { useTranslation, Trans } from 'react-i18next'
import { formatNumber, formatPercent } from '../../../i18n'
import {
  OPEN_PROJECT_ID,
  matchDocuments,
  matchCodes,
  computeAgreement,
  syncExtents,
  codeSegments,
  passagesFor,
  surveyCells,
  type CoderProject,
  type MatchedDoc,
  type MatchedCode,
  type Measure,
  type Passage,
  type Segment,
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
  metricColumns,
  metricValue,
  formatMetric,
  metricLabel,
  metricTitle,
  pairLabel,
  tableRows,
  brennanPredigerLine,
  exportRows,
  type IntercoderSnapshot,
  type MetricCol
} from './intercoder-tables'

export interface IntercoderConfig {
  /** Coders' project files in order; OPEN_PROJECT_ID for the open one. */
  paths: string[]
  /** The documents and codes dropped in, in order, as the open
   *  project's guids (what the Browsers drag). */
  docGuids: string[]
  codeGuids: string[]
  measure: Measure
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
const CONTEXT = 60

function docIcon(sourceType: string | undefined): { icon: IconComponent; tint?: IconTintKind } {
  if (sourceType === 'survey') return { icon: SURVEY_ICON, tint: 'survey' }
  const tint = iconTintKindForSourceType(sourceType ?? 'text')
  if (sourceType === 'audio') return { icon: faHeadphones, tint }
  if (sourceType === 'video') return { icon: faVideo, tint }
  if (sourceType === 'image') return { icon: faImage, tint }
  return { icon: faFile, tint }
}

function isQdpxDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes('Files')
}

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
  const savedSnapshot = savedConfig?.snapshot

  // ── Loaded projects ───────────────────────────────────────────────
  const [fileCoders, setFileCoders] = useState<Record<string, CoderProject>>({})
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState<string[]>([])
  const [dropOver, setDropOver] = useState<'projects' | 'docs' | 'codes' | null>(null)

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

  const handleFileDrop = useCallback(async (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer.files).filter((f) => /\.qdpx$/i.test(f.name))
    const staged: string[] = []
    for (const f of files) {
      try { staged.push(await window.api.stageDroppedProject(f)) } catch { /* unreadable drop */ }
    }
    if (staged.length) addPaths(staged)
  }, [addPaths])

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
  const projectDrop = dropHandlers(isQdpxDrag, (o) => setDropOver(o ? 'projects' : null), (e) => { void handleFileDrop(e) })

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
  const expandedSet = useMemo(() => new Set(expanded), [expanded])
  const toggleExpanded = (key: string) =>
    setExpanded((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))

  const [drill, setDrill] = useState<{ codeKey: string; docKey: string | null; pair: number } | null>(null)
  useEffect(() => { setDrill(null) }, [paths, measure])

  // ── Persistence ───────────────────────────────────────────────────
  const [analysisGuid] = useState(savedConfig?.guid ?? generateGuid())
  const [analysisName, setAnalysisName] = useState(savedConfig?.name ?? '')
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const isExisting = !!savedConfig?.guid
  const savedRef = useRef(isExisting)
  const nameRef = useRef(analysisName)

  const currentConfig = useMemo(() => ({ paths, docGuids, codeGuids, measure, threshold }), [paths, docGuids, codeGuids, measure, threshold])
  const initialBaseline = useMemo(() => ({
    paths: savedConfig?.paths ?? [OPEN_PROJECT_ID],
    docGuids: savedConfig?.docGuids ?? [],
    codeGuids: savedConfig?.codeGuids ?? [],
    measure: savedConfig?.measure ?? 'characters',
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
    const rows = exportRows(snapshot)
    window.api.exportCsv(toCsv(rows), 'intercoder-agreement.csv')
  }, [snapshot])

  // ── Render ────────────────────────────────────────────────────────
  const cols: MetricCol[] = snapshot ? metricColumns(snapshot.measure, snapshot.coders.length) : []
  const rows = snapshot ? tableRows(snapshot, expandedSet) : []
  const pairCount = snapshot ? snapshot.results.pairs.length : 0
  const colsPerPair = snapshot?.measure === 'segments' ? 3 : 2
  const bpLine = snapshot ? brennanPredigerLine(snapshot) : null
  const docNameOf = (key: string) => snapshot?.docs.find((d) => d.key === key)?.name ?? docs.find((d) => d.key === key)?.name ?? ''

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

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 20px 14px' }}>
        {/* ── The three panes ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10, height: PANE_H }}>
          {/* 1. Projects */}
          <Pane
            title={t('intercoder.paneProjects')}
            step={1}
            actions={<button className="secondary" style={smallBtn} onClick={() => void handlePick()}><Icon icon={faPlus} style={{ fontSize: 10 }} /> {t('intercoder.addProjects')}</button>}
            dropOver={dropOver === 'projects'}
            fileDropZone
            {...projectDrop}
          >
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
                    <div style={ellipsis} title={c?.label}>
                      {c ? c.label : err ? p.split(/[/\\]/).pop() : t('intercoder.loading')}
                    </div>
                    <div style={{ ...ellipsis, fontSize: 10, color: err ? 'var(--danger, #c0392b)' : 'var(--text-muted)' }} title={err ?? p}>
                      {err ?? (p === OPEN_PROJECT_ID ? t('intercoder.openProject', { name: c?.fileName ?? '' }) : c?.fileName ?? '')}
                    </div>
                  </div>
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
            actions={selDocs.length > 0 && <ClearLink onClear={() => { setDocGuids([]); setFocusDoc(null) }} />}
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
            actions={selCodes.length > 0 && <ClearLink onClear={() => setCodeGuids([])} />}
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

        {/* ── Results ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '14px 0 8px', flexWrap: 'wrap' }}>
          <SegmentedControl
            label={t('intercoder.measure')}
            value={measure}
            onChange={setMeasure}
            options={[
              { value: 'characters', label: t('intercoder.measureCharacters'), title: t('intercoder.measureCharactersTitle') },
              { value: 'segments', label: t('intercoder.measureSegments'), title: t('intercoder.measureSegmentsTitle') }
            ]}
          />
          {measure === 'segments' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-secondary)' }} title={t('intercoder.thresholdTitle')}>
              {t('intercoder.threshold')}
              <input type="range" min={10} max={100} step={5} value={Math.round(threshold * 100)} onChange={(e) => setThreshold(Number(e.target.value) / 100)} style={{ width: 140 }} />
              <span style={{ minWidth: 36 }}>{formatPercent(threshold * 100, 0)}</span>
            </label>
          )}
          <HowCalculated />
        </div>

        {showingSaved && (
          <div style={noteStyle}>{t('intercoder.showingSaved')}</div>
        )}
        {snapshot && snapshot.results.skippedDocs.length > 0 && (
          <div style={noteStyle}>
            {t('intercoder.skippedNote', { names: snapshot.results.skippedDocs.map((s) => docNameOf(s.key)).join(', ') })}
          </div>
        )}
        {snapshot && snapshot.results.approxDocs.length > 0 && (
          <div style={noteStyle}>
            {t('intercoder.approxNote', { names: snapshot.results.approxDocs.map(docNameOf).join(', ') })}
          </div>
        )}

        {!snapshot ? (
          <div style={{ ...emptyPane, padding: '30px 20px', background: 'var(--bg-panel)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
            {loading.length > 0 ? t('intercoder.loading')
              : coders.length < 2 ? t('intercoder.needTwo')
                : selDocs.length === 0 ? t('intercoder.pickDocuments')
                  : t('intercoder.pickCodes')}
          </div>
        ) : (
          <div style={{ overflow: 'auto', background: 'var(--bg-panel)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
            <table style={{ borderCollapse: 'separate', borderSpacing: 0, fontSize: 12, minWidth: '100%' }}>
              <thead>
                <tr>
                  <th rowSpan={2} style={{ ...headStyle, textAlign: 'start', minWidth: 220 }}>{t('intercoder.code')}</th>
                  {Array.from({ length: pairCount }, (_, p) => (
                    <th key={p} colSpan={colsPerPair} style={{ ...headStyle, textAlign: 'center' }}>{pairLabel(snapshot, p)}</th>
                  ))}
                  {cols.some((c) => c.pair === null) && <th style={{ ...headStyle, textAlign: 'center' }}>{pairLabel(snapshot, null)}</th>}
                </tr>
                <tr>
                  {cols.map((c, i) => (
                    <th key={i} style={{ ...headStyle, fontWeight: 500, textAlign: 'center' }} title={metricTitle(c.metric)}>{metricLabel(c.metric)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isCode = r.kind === 'code'
                  const code = r.codeKey ? snapshot.codes.find((c) => c.key === r.codeKey) : undefined
                  return (
                    <tr key={`${r.kind}|${r.codeKey ?? ''}|${r.docKey ?? ''}`} style={{ background: r.kind === 'overall' ? 'var(--bg-secondary)' : undefined }}>
                      <td style={{ ...cellStyle, textAlign: 'start', paddingInlineStart: r.kind === 'doc' ? 34 : 8, fontWeight: r.kind === 'overall' ? 600 : undefined }} title={r.title ?? r.label}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                          {isCode && (
                            <span onClick={() => toggleExpanded(r.codeKey!)} style={{ cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', width: 10 }} title={t('intercoder.showDocuments')}>
                              <Icon icon={expandedSet.has(r.codeKey!) ? faChevronDown : faChevronRight} style={{ fontSize: 10 }} />
                            </span>
                          )}
                          {isCode && <span style={{ width: 8, height: 8, borderRadius: '50%', background: code?.color || '#888', flexShrink: 0 }} />}
                          {r.kind === 'doc' && (() => {
                            const ic = docIcon(snapshot.docs.find((d) => d.key === r.docKey)?.sourceType)
                            return <Icon className={PALETTE_ICON_CLASS} icon={ic.icon} style={{ fontSize: 11, color: 'var(--text-muted)', ...(ic.tint ? tint(ic.tint) : {}) }} />
                          })()}
                          <span style={ellipsis}>{r.label}</span>
                        </div>
                      </td>
                      {cols.map((c, i) => {
                        const v = metricValue(r.cell, c, snapshot.measure)
                        const clickable = !showingSaved && r.kind !== 'overall' && c.pair !== null && r.codeKey
                        const isSel = !!drill && c.pair === drill.pair && r.codeKey === drill.codeKey && (r.docKey ?? null) === drill.docKey
                        return (
                          <td
                            key={i}
                            onClick={clickable ? () => setDrill({ codeKey: r.codeKey!, docKey: r.docKey ?? null, pair: c.pair! }) : undefined}
                            title={clickable ? t('intercoder.showPassages') : undefined}
                            style={{
                              ...cellStyle,
                              textAlign: 'center',
                              cursor: clickable ? 'pointer' : undefined,
                              color: v === null ? 'var(--text-muted)' : undefined,
                              fontWeight: isCode || r.kind === 'overall' ? 600 : undefined,
                              borderInlineStart: c.pair !== null && i % colsPerPair === 0 ? '1px solid var(--border-color)' : undefined,
                              boxShadow: isSel ? 'inset 0 0 0 2px var(--accent)' : undefined,
                              background: v !== null && (c.metric === 'kappa' || c.metric === 'alpha' || c.metric === 'agreement') ? strengthTint(v, c.metric) : undefined
                            }}
                          >
                            {formatMetric(v, c.metric)}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {bpLine && <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-secondary)', borderTop: '1px solid var(--border-color)' }}>{bpLine}</div>}
          </div>
        )}

        {snapshot && drill && !showingSaved && (
          <DrillDown
            coders={coders}
            docs={drill.docKey ? selDocs.filter((d) => d.key === drill.docKey) : selDocs}
            code={selCodes.find((c) => c.key === drill.codeKey)}
            pair={snapshot.results.pairs[drill.pair]}
            measure={measure}
            threshold={threshold}
            onClose={() => setDrill(null)}
          />
        )}
      </div>
    </div>
  )
}

/** A soft green / amber / red wash for an agreement or kappa value, so
 *  weak agreement stands out. Kappa bands follow Landis & Koch loosely:
 *  ≥ 0.8 strong, ≥ 0.6 moderate, below that weak. */
function strengthTint(raw: number, metric: 'agreement' | 'kappa' | 'alpha' | string): string | undefined {
  // Judge the value as shown (0.1% / two decimals), so a 0.7996 shown as
  // 0.80 is shaded as 0.80.
  const v = metric === 'agreement' ? Math.round(raw * 1000) / 1000 : Math.round(raw * 100) / 100
  const strong = metric === 'agreement' ? 0.9 : 0.8
  const moderate = metric === 'agreement' ? 0.8 : 0.6
  const colour = v >= strong ? '#2e9d5b' : v >= moderate ? '#d39b1a' : '#d0473a'
  return `color-mix(in srgb, ${colour} 13%, transparent)`
}

// ── Drill-down ─────────────────────────────────────────────────────────

function DrillDown({ coders, docs, code, pair, measure, threshold, onClose }: {
  coders: CoderProject[]
  docs: MatchedDoc[]
  code: MatchedCode | undefined
  pair: [number, number]
  measure: Measure
  threshold: number
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [showAgreed, setShowAgreed] = useState(false)
  const first = coders[pair[0]]
  const second = coders[pair[1]]

  const groups = useMemo(() => {
    if (!code || !first || !second) return []
    return docs
      .filter((d) => d.members[first.id] && d.members[second.id])
      .map((d) => {
        // All coders' segments, so a recording is compared the same way
        // (transcript or time) as in the table.
        const per = codeSegments(coders, d, code)
        return { doc: d, passages: passagesFor(per[pair[0]], per[pair[1]], measure, threshold) }
      })
      .filter((g) => g.passages.length > 0)
  }, [docs, code, coders, pair, first, second, measure, threshold])

  const shown = groups
    .map((g) => ({ ...g, passages: showAgreed ? g.passages : g.passages.filter((p) => !p.agreed) }))
    .filter((g) => g.passages.length > 0)
  const total = groups.reduce((n, g) => n + g.passages.length, 0)
  const disagreements = groups.reduce((n, g) => n + g.passages.filter((p) => !p.agreed).length, 0)

  if (!code || !first || !second) return null
  return (
    <div style={{ marginTop: 14, background: 'var(--bg-panel)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderBottom: '1px solid var(--border-color)' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: code.color || '#888' }} />
        <strong style={{ fontSize: 12 }}>{code.name}</strong>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {t('intercoder.passageCount', { count: total, disagreements })}
        </span>
        <div style={{ flex: 1 }} />
        <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={showAgreed} onChange={(e) => setShowAgreed(e.target.checked)} />
          {t('intercoder.showAgreed')}
        </label>
        <span onClick={onClose} title={t('common.close')} style={xStyle}><Icon icon={faXmark} style={{ fontSize: 11 }} /></span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)' }}>
        <div style={{ padding: '6px 10px' }}>{first.label}</div>
        <div style={{ padding: '6px 10px', borderInlineStart: '1px solid var(--border-color)' }}>{second.label}</div>
      </div>
      {shown.length === 0 ? (
        <div style={{ ...emptyPane, padding: 20 }}>{total === 0 ? t('intercoder.noPassages') : t('intercoder.noDisagreements')}</div>
      ) : shown.map((g) => (
        <Fragment key={g.doc.key}>
          <div style={{ padding: '6px 10px', fontSize: 11, fontWeight: 600, background: 'color-mix(in srgb, var(--text-secondary) 6%, var(--bg-panel))', borderBottom: '1px solid var(--border-color)' }}>
            {g.doc.name}
          </div>
          {g.passages.map((p, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: '1px solid var(--border-color)' }}>
              {[first, second].map((c, side) => (
                <div key={side} style={{ padding: '8px 10px', borderInlineStart: side ? '1px solid var(--border-color)' : undefined, minWidth: 0 }}>
                  <PassageView coder={c} doc={g.doc} passage={p} segs={side ? p.second : p.first} colour={code.color || '#888'} />
                </div>
              ))}
            </div>
          ))}
        </Fragment>
      ))}
    </div>
  )
}

const pageNumber = (line: string): number => Number(line.slice(1)) || 1

function PassageView({ coder, doc, passage, segs, colour }: {
  coder: CoderProject
  doc: MatchedDoc
  passage: Passage
  segs: Segment[]
  colour: string
}) {
  const { t } = useTranslation()
  const source = coder.sources.find((s) => s.guid === doc.members[coder.id])
  const notCoded = <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', marginBottom: 4 }}>{t('intercoder.notCoded')}</div>

  if (passage.ch === 'text') {
    const text = !source ? '' : passage.line ? surveyCells(source)[passage.line] ?? '' : coder.sourceContents[source.guid] ?? ''
    return (
      <>
        {segs.length === 0 && notCoded}
        <TextSnippet text={text} passage={passage} segs={segs} colour={colour} />
      </>
    )
  }

  if (passage.ch === 'time') {
    // A timeline coding's transcript text: the lines whose start time
    // falls in the passage (as Query Results shows it), with the lines in
    // this coder's ranges highlighted.
    const transcript = source ? coder.sourceContents[source.guid] ?? '' : ''
    const lineTimes = (source?.formatData as { lineTimes?: Record<string, number> } | undefined)?.lineTimes
    if (transcript && lineTimes) {
      const inRange = (secs: number, from: number, to: number) => secs * 1000 >= from - 0.5 && secs * 1000 < to - 0.1
      const lines = transcript.split('\n')
        .map((text, i) => ({ text, at: lineTimes[String(i)] }))
        .filter((l) => typeof l.at === 'number' && inRange(l.at, passage.start, passage.end))
      if (lines.length > 0) {
        return (
          <div dir="auto" style={{ fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--text-secondary)' }}>
            {segs.length === 0 && notCoded}
            {lines.map((l, i) => {
              const on = segs.some((s) => s.ch === 'time' && inRange(l.at!, s.start, s.end))
              return (
                <div key={i}>
                  <span style={on ? { background: `color-mix(in srgb, ${colour} 30%, transparent)`, color: 'var(--text-primary)', borderRadius: 2 } : undefined}>{l.text}</span>
                </div>
              )
            })}
          </div>
        )
      }
    }
    const span = Math.max(1, passage.end - passage.start)
    return (
      <div>
        {segs.length === 0 ? notCoded : segs.map((s, i) => s.ch === 'time' && (
          <div key={i} style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
            {formatTimestamp(s.start / 1000)} – {formatTimestamp(s.end / 1000)}
          </div>
        ))}
        <div style={{ position: 'relative', height: 8, marginTop: 6, background: 'var(--bg-tertiary)', borderRadius: 4 }}>
          {segs.map((s, i) => s.ch === 'time' && (
            <div key={i} style={{
              position: 'absolute', top: 0, bottom: 0, borderRadius: 4, background: colour,
              insetInlineStart: `${((s.start - passage.start) / span) * 100}%`,
              width: `${((s.end - s.start) / span) * 100}%`
            }} />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>
        {doc.sourceType === 'pdf' ? t('intercoder.page', { n: pageNumber(passage.line) }) : null}
      </div>
      {segs.length === 0 && notCoded}
      <RegionPreview coder={coder} sourceType={doc.sourceType} formatData={source?.formatData} passage={passage} segs={segs} colour={colour} />
    </div>
  )
}

/** The passage with some context, this coder's coded parts highlighted. */
function TextSnippet({ text, passage, segs, colour }: { text: string; passage: Passage; segs: Segment[]; colour: string }) {
  const chars = useMemo(() => Array.from(text), [text])
  const from = Math.max(0, passage.start - CONTEXT)
  const to = Math.min(chars.length, passage.end + CONTEXT)
  const pieces: { s: string; on: boolean }[] = []
  for (let i = from; i < to; ) {
    const on = segs.some((s) => s.ch === 'text' && i >= s.start && i < s.end)
    let j = i + 1
    while (j < to && segs.some((s) => s.ch === 'text' && j >= s.start && j < s.end) === on) j++
    pieces.push({ s: chars.slice(i, j).join(''), on })
    i = j
  }
  return (
    <div dir="auto" style={{ fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--text-secondary)' }}>
      {from > 0 && '…'}
      {pieces.map((p, i) => p.on
        ? <mark key={i} style={{ background: `color-mix(in srgb, ${colour} 30%, transparent)`, color: 'var(--text-primary)', borderRadius: 2 }}>{p.s}</mark>
        : <span key={i}>{p.s}</span>)}
      {to < chars.length && '…'}
    </div>
  )
}

/** The passage's bounding box (padded), with this coder's regions drawn
 *  on it. Shows the picture underneath when the file is the open
 *  project's; other projects' files show the outlines alone. */
function RegionPreview({ coder, sourceType, formatData, passage, segs, colour }: {
  coder: CoderProject
  sourceType?: string
  formatData: unknown
  passage: Passage
  segs: Segment[]
  colour: string
}) {
  const box = passage.box!
  const pad = Math.max(box.w, box.h) * 0.08
  const view = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), w: box.w + pad * 2, h: box.h + pad * 2 }
  const [img, setImg] = useState<string | null>(null)
  useEffect(() => {
    setImg(null)
    if (coder.filePath) return
    const field = mediaPathField(sourceType)
    const handle = field ? (formatData as Record<string, unknown> | undefined)?.[field] : undefined
    if (typeof handle !== 'string') return
    let cancelled = false
    const opts = { filePath: handle, x: view.x, y: view.y, width: view.w, height: view.h }
    const p = sourceType === 'pdf'
      ? renderPdfRegionThumbnail({ ...opts, page: pageNumber(passage.line) })
      : renderImageRegionThumbnail(opts)
    p.then((url) => { if (!cancelled) setImg(url) }).catch(() => {})
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coder.filePath, sourceType, formatData, passage.line, view.x, view.y, view.w, view.h])
  const maxW = 320
  const scale = Math.min(maxW / view.w, 200 / view.h)
  return (
    <div style={{ position: 'relative', width: view.w * scale, height: view.h * scale, background: 'var(--bg-tertiary)', borderRadius: 4, overflow: 'hidden' }}>
      {img && <img src={img} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />}
      <svg viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} preserveAspectRatio="none">
        {segs.map((s, i) => s.ch === 'region' && (
          <rect key={i} x={s.x} y={s.y} width={s.w} height={s.h} fill={colour} fillOpacity={0.25} stroke={colour} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
    </div>
  )
}

// ── Small pieces ───────────────────────────────────────────────────────

function Pane({ title, step, actions, children, dropOver, fileDropZone, onDragOver, onDragLeave, onDrop }: {
  title: string
  step: number
  actions?: React.ReactNode
  children: React.ReactNode
  dropOver?: boolean
  /** Takes dropped files itself, so the window's "drop to import" cue
   *  stays hidden over it. */
  fileDropZone?: boolean
  onDragOver?: (e: React.DragEvent) => void
  onDragLeave?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
}) {
  return (
    <div
      data-file-drop-zone={fileDropZone ? '' : undefined}
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

/** The (i) button beside the measure switch: how every figure in the
 *  results is worked out, both measures, with the formulas. */
function HowCalculated() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  // Placed against the window, not the tool (whose scrolling area would
  // clip it), and kept inside it.
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null)
  useEffect(() => {
    if (!open || !buttonRef.current) return
    const update = () => {
      const r = buttonRef.current!.getBoundingClientRect()
      const width = Math.min(440, window.innerWidth - 32)
      const rtl = getComputedStyle(buttonRef.current!).direction === 'rtl'
      const left = rtl ? Math.max(16, r.right - width) : Math.min(r.left, window.innerWidth - width - 16)
      const top = r.bottom + 6
      setPlace({ left, top, width, maxHeight: Math.max(160, window.innerHeight - top - 16) })
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [open])
  const item = (k: string) => (
    <li style={{ marginBottom: 6 }}><Trans i18nKey={k} components={{ b: <strong /> }} /></li>
  )
  const section = (headingKey: string, keys: string[]) => (
    <>
      <div style={{ fontWeight: 600, fontSize: 11, margin: '8px 0 4px' }}>{t(headingKey)}</div>
      <ul style={{ margin: 0, paddingInlineStart: 16, color: 'var(--text-secondary)' }}>{keys.map((k) => <Fragment key={k}>{item(k)}</Fragment>)}</ul>
    </>
  )
  return (
    <div style={{ position: 'relative', display: 'flex' }}>
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        title={t('intercoder.howCalculated')}
        aria-label={t('intercoder.howCalculated')}
        style={{
          background: 'none', border: 'none', padding: 2,
          color: open ? 'var(--accent)' : 'var(--text-muted)',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}
      >
        <Icon icon={faCircleInfo} style={{ fontSize: 14 }} />
      </button>
      {open && place && (
        <>
          {/* Click-outside dismiss */}
          <div style={{ position: 'fixed', inset: 0, zIndex: 99 }} onClick={() => setOpen(false)} />
          <div
            style={{
              position: 'fixed', left: place.left, top: place.top,
              width: place.width, maxHeight: Math.min(520, place.maxHeight), overflow: 'auto', padding: '12px 14px',
              background: 'var(--bg-panel)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)',
              boxShadow: '0 4px 16px rgba(0,0,0,0.12)', fontSize: 11, lineHeight: 1.5, color: 'var(--text-primary)', zIndex: 100
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 2 }}>{t('intercoder.infoHeading')}</div>
            {section('intercoder.infoCharsHeading', ['intercoder.infoUnits', 'intercoder.infoPercent', 'intercoder.infoKappa', 'intercoder.infoAlpha', 'intercoder.infoTotals', 'intercoder.infoAllCodes'])}
            {section('intercoder.infoSegmentsHeading', ['intercoder.infoSegments', 'intercoder.infoBp'])}
            {section('intercoder.infoNotesHeading', ['intercoder.infoNotes'])}
          </div>
        </>
      )}
    </div>
  )
}

function ClearLink({ onClear }: { onClear: () => void }) {
  const { t } = useTranslation()
  return (
    <a href="#" style={{ fontSize: 10 }} onClick={(e) => { e.preventDefault(); onClear() }}>{t('intercoder.clear')}</a>
  )
}

const btnStyle: React.CSSProperties = { fontSize: 11, padding: '4px 14px' }
const smallBtn: React.CSSProperties = { fontSize: 10, padding: '2px 8px', display: 'inline-flex', alignItems: 'center', gap: 4 }
const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', fontSize: 12, minWidth: 0 }
const ellipsis: React.CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const xStyle: React.CSSProperties = { cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', flexShrink: 0, padding: 2 }
const emptyPane: React.CSSProperties = { padding: '16px 10px', fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }
const noteStyle: React.CSSProperties = { fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }
const coderBadge: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, minWidth: 16, height: 16, lineHeight: '16px', textAlign: 'center',
  borderRadius: 8, background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', flexShrink: 0
}
const countBadge: React.CSSProperties = {
  fontSize: 9, fontWeight: 600, padding: '0 5px', lineHeight: '14px', borderRadius: 7,
  background: 'var(--bg-tertiary)', color: 'var(--text-muted)', flexShrink: 0
}
const headStyle: React.CSSProperties = {
  background: 'var(--bg-secondary)',
  borderBottom: '1px solid var(--border-color)', padding: '6px 8px', fontSize: 11, fontWeight: 600,
  color: 'var(--text-secondary)', whiteSpace: 'nowrap'
}
const cellStyle: React.CSSProperties = {
  borderBottom: '1px solid var(--border-color)', padding: '5px 8px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums'
}
