/**
 * FindDialog — the Cmd/Ctrl+F popup. A trimmed-down Text-node query
 * builder scoped to the currently-open document. Submitting builds a
 * `{ type: 'text', ... }` CodeCondition + a sourceGuids filter, runs
 * it via `useQueryStore.setComplexQuery`, and the existing Query
 * Results Viewer shows the matches.
 *
 * The Find tool is intentionally NOT a parallel feature — it's just a
 * quick keyboard-driven way to build a text query without opening the
 * full Query Builder. Options mirror the Text node box (search text,
 * case sensitive, whole word); "not" is omitted because Find is
 * always about matching, not excluding.
 */
import { useEffect, useRef, useState } from 'react'
import { useQueryStore } from '../../stores/query-store'
import { Icon, faMagnifyingGlass } from '../Icon'
import { toolColors } from '../../utils/tool-registry'
import type { Query } from '../../models/types'
import { useTranslation } from 'react-i18next'

interface Props {
  open: boolean
  sourceGuid: string
  sourceName: string
  onClose: () => void
}

export function FindDialog({ open, sourceGuid, sourceName, onClose }: Props) {
  const { t } = useTranslation()
  const [searchText, setSearchText] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus the text field each time the dialog opens so the user can
  // start typing immediately after Cmd/Ctrl+F.
  useEffect(() => {
    if (open) {
      setSearchText('')
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  if (!open) return null

  const runFind = (): void => {
    const trimmed = searchText.trim()
    if (!trimmed) return
    const query: Query = {
      documentFilter: { sourceGuids: [sourceGuid] },
      codeCondition: {
        type: 'text',
        searchText: trimmed,
        caseSensitive,
        wholeWord
      }
    }
    useQueryStore.getState().setComplexQuery(query)
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ minWidth: 360 }}>
        <h2 style={{ margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)' }}>
          <Icon icon={faMagnifyingGlass} className="analysis-header-icon" style={{ fontSize: 16 }} />
          {t('find.title')}
        </h2>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
          {t('find.in', { name: sourceName })}
        </div>
        <div style={{ marginBottom: 12 }}>
          <input
            ref={inputRef}
            type="text"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); runFind() }
              else if (e.key === 'Escape') { e.preventDefault(); onClose() }
            }}
            placeholder={t('find.placeholder')}
            style={{ width: '100%' }}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16, fontSize: 'var(--font-size-sm)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(e) => setCaseSensitive(e.target.checked)}
            />
            {t('find.caseSensitive')}
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
            <input
              type="checkbox"
              checked={wholeWord}
              onChange={(e) => setWholeWord(e.target.checked)}
            />
            {t('find.wholeWord')}
          </label>
        </div>
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button disabled={!searchText.trim()} onClick={runFind}>{t('find.title')}</button>
        </div>
      </div>
    </div>
  )
}
