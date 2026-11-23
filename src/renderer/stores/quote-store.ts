import { create } from 'zustand'
import { useProjectStore } from './project-store'
import { generateGuid } from '../utils/guid'
import type { Quote, PdfRegionSelection } from '../models/types'
import { makeHmrSafe } from './hmr-preserve'
import { adjustRange, type TextEdit } from '../utils/text-edit-offsets'
import { noteBulkReset } from './empty-save-guard'

interface QuoteState {
  quotes: Quote[]
  setQuotes: (quotes: Quote[]) => void
  addQuote: (
    sourceGuid: string,
    sourceName: string,
    startPosition: number,
    endPosition: number,
    text: string,
    pdfRegion?: PdfRegionSelection,
    /** Survey-cell context: when set, startPosition/endPosition are
     *  cell-relative offsets inside the named (respondent × question)
     *  cell. */
    surveyCell?: { respondentId: string; questionId: string }
  ) => string
  removeQuote: (guid: string) => void
  getQuotesForSource: (sourceGuid: string) => Quote[]
  /** Re-anchor a source's text quotes after an in-place transcript edit. */
  adjustQuotesForEdit: (sourceGuid: string, edit: TextEdit) => void
  clearAll: () => void
}

export const useQuoteStore = create<QuoteState>((set, get) => ({
  quotes: [],

  setQuotes: (quotes) => set({ quotes }),

  addQuote: (sourceGuid, sourceName, startPosition, endPosition, text, pdfRegion, surveyCell) => {
    const guid = generateGuid()
    const quote: Quote = {
      guid,
      sourceGuid,
      sourceName,
      startPosition,
      endPosition,
      text,
      pdfRegion,
      surveyCell,
      createdDateTime: new Date().toISOString()
    }
    set((s) => ({ quotes: [...s.quotes, quote] }))
    useProjectStore.getState().markDirty()
    return guid
  },

  removeQuote: (guid) => {
    set((s) => ({ quotes: s.quotes.filter((q) => q.guid !== guid) }))
    useProjectStore.getState().markDirty()
  },

  /** Shift this source's text quotes for an in-place transcript edit so they
   *  keep pointing at the same words. PDF-region and survey-cell quotes are
   *  anchored differently and left untouched; a quote whose text was wholly
   *  deleted is dropped. */
  adjustQuotesForEdit: (sourceGuid, edit) => {
    let changed = false
    const quotes = get().quotes.flatMap((q) => {
      if (q.sourceGuid !== sourceGuid || q.pdfRegion || q.surveyCell) return [q]
      const next = adjustRange(q.startPosition, q.endPosition, edit)
      if (!next) { changed = true; return [] }
      if (next.start === q.startPosition && next.end === q.endPosition) return [q]
      changed = true
      return [{ ...q, startPosition: next.start, endPosition: next.end }]
    })
    if (changed) {
      set({ quotes })
      useProjectStore.getState().markDirty()
    }
  },

  getQuotesForSource: (sourceGuid) => {
    return get().quotes.filter((q) => q.sourceGuid === sourceGuid)
  },

  clearAll: () => {
    noteBulkReset()
    set({ quotes: [] })
  }
}))

makeHmrSafe('quoteStore', useQuoteStore)
