/**
 * AI apps on this computer (Claude Desktop and others) using the open
 * project, through Magnolia's connector (src-tauri/src/mcp.rs).
 *
 * Each request is answered as the pane's own chat answers its AI's: with
 * the tools in utils/ai/tools.ts, only for a project the user has let AI
 * apps read (asked in the AI Assistance Viewer, which opens to ask), and
 * with every change only proposed, for the Viewer (which opens when the
 * first one arrives, and lists the rest as they come).
 */
import { useAiStore, type AiSession, type AiProposal } from '../../stores/ai-store'
import { useDocumentStore } from '../../stores/document-store'
import { AI_REVIEW_TAB_ID } from '../tab-ids'
import { useProjectStore } from '../../stores/project-store'
import { emptyRefs, runTool } from './tools'
import { generateGuid } from '../guid'

interface AppCall {
  callId: string
  session: string
  client: string
  name: string
  input: Record<string, unknown>
}

/** An app's name for people: Claude Desktop calls itself "claude-ai". */
export function appName(client: string): string {
  // Claude Desktop calls itself "claude-ai", or (in agent mode)
  // "local-agent-mode-…".
  if (/^claude(-ai)?$/i.test(client) || /^local-agent-mode/i.test(client)) return 'Claude Desktop'
  return client || 'An AI app'
}

/** The AI Assistance Viewer, in front. */
function showViewer() {
  useDocumentStore.getState().openToolTab(AI_REVIEW_TAB_ID)
}

function answer(callId: string, content: string, isError = false) {
  void window.api.mcpReply(callId, content, isError).catch(() => {})
}

/** Answer one request (exported for the tests). */
export function answerAppCall(call: AppCall): void {
  const project = useProjectStore.getState()
  if (!project.filePath) {
    return answer(call.callId, 'No project is open in Magnolia. Ask the user to open one.', true)
  }
  const ai = useAiStore.getState()
  const name = appName(call.client)
  if (!ai.appsAllowed) {
    ai.setAppRequest(name)
    showViewer()
    return answer(call.callId, `The user hasn't yet let AI apps use this project ("${project.name}"). Magnolia is asking them now, in its AI Assistance Viewer: ask them to allow it there, then try again.`, true)
  }
  // The session (one per connection): its references (D3, P12…).
  const sessionId = `app:${call.session}`
  let session = ai.sessions.find((x) => x.id === sessionId)
  if (!session) {
    session = { id: sessionId, app: name, createdAt: new Date().toISOString(), refs: emptyRefs() }
    useAiStore.setState((s) => ({ sessions: [session!, ...s.sessions] }))
  }
  const refs = structuredClone(session.refs)
  const hadPending = ai.proposals.some((p) => p.status === 'pending')
  const outcome = runTool(call.name, call.input ?? {}, refs)
  const now = new Date().toISOString()
  const proposals: AiProposal[] = (outcome.proposals ?? []).map((p) => ({
    id: generateGuid(), chatId: sessionId, change: p.change, reason: p.reason, status: 'pending', createdAt: now, model: name
  }))
  useAiStore.setState((s) => ({
    sessions: s.sessions.map((x: AiSession) => (x.id === sessionId ? { ...x, refs } : x)),
    proposals: proposals.length ? [...s.proposals, ...proposals] : s.proposals
  }))
  project.markDirty()
  // The first change to review: the Viewer opens (after that it lists the
  // rest as they come).
  if (proposals.length && !hadPending) showViewer()
  // The app can't open Magnolia's passages: it gets the reference's text.
  const tail = proposals.length ? '\n[Shown to the user in Magnolia\'s AI Assistance Viewer, to approve or deny.]' : ''
  answer(call.callId, outcome.content + tail, outcome.isError)
}

let installed = false
/** Listen for AI apps' requests (once, in the main window). */
export function installAppListener(): void {
  if (installed || typeof window === 'undefined' || !window.api?.onMcpCall) return
  installed = true
  window.api.onMcpCall((call) => {
    try {
      answerAppCall(call)
    } catch (err) {
      answer(call.callId, `Magnolia couldn't do that: ${err instanceof Error ? err.message : String(err)}`, true)
    }
  })
}
