/**
 * The AI Assistance coding being reviewed in its document (see
 * components/AI/AiReviewBar.tsx): which proposal, and its passage, which the
 * document keeps highlighted until it's decided. A store of its own, with
 * no imports, so the document viewers can read it without loading AI
 * Assistance's (which changed the order modules load in, and with it the
 * query engine's results).
 */
import { create } from 'zustand'

export interface Reviewing {
  proposalId: string
  sourceGuid: string
  start: number
  end: number
  surveyCell?: { respondentId: string; questionId: string }
}

interface ReviewState {
  reviewing: Reviewing | null
  setReviewing: (r: Reviewing | null) => void
}

export const useAiReviewStore = create<ReviewState>((set) => ({
  reviewing: null,
  setReviewing: (reviewing) => set({ reviewing })
}))
