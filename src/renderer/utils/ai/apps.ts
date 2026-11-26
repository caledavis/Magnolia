/**
 * AI apps on this computer (Claude Desktop and others) using the open
 * project, through Magnolia's connector (src-tauri/src/mcp.rs).
 *
 * Each request is answered as the pane's own chat answers its AI's: with
 * the same tools (utils/ai/tools.ts), only for a project the user has let
 * AI apps read (asked in the AI Assistance pane, as for a service), with
 * each request listed in the pane under the app's session, and with every
 * change only proposed, for the AI Assistance Viewer.
 */
import { useAiStore, type AiSession, type AiProposal, type SessionItem } from '../../stores/ai-store'
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
  if (/^claude(-ai)?$/i.test(client)) return 'Claude Desktop'
  return client || 'An AI app'
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
    return answer(call.callId, `The user hasn't yet let AI apps use this project ("${project.name}"). Magnolia is asking them now, in its AI Assistance pane: ask them to allow it there, then try again.`, true)
  }
  // The session's record in the pane: one per connection.
  const sessionId = `app:${call.session}`
  let session = ai.sessions.find((x) => x.id === sessionId)
  if (!session) {
    session = { id: sessionId, app: name, createdAt: new Date().toISOString(), items: [], refs: emptyRefs() }
    useAiStore.setState((s) => ({ sessions: [session!, ...s.sessions], activeSessionId: sessionId }))
  }
  const refs = structuredClone(session.refs)
  const outcome = runTool(call.name, call.input ?? {}, refs)
  const now = new Date().toISOString()
  const proposals: AiProposal[] = (outcome.proposals ?? []).map((p) => ({
    id: generateGuid(), chatId: sessionId, change: p.change, reason: p.reason, status: 'pending', createdAt: now, model: name
  }))
  const item: SessionItem = {
    id: generateGuid(), content: outcome.content, isError: outcome.isError, activity: outcome.activity,
    proposalIds: proposals.length ? proposals.map((p) => p.id) : undefined, at: now
  }
  useAiStore.setState((s) => ({
    sessions: s.sessions.map((x: AiSession) => (x.id === sessionId ? { ...x, refs, items: [...x.items, item] } : x)),
    proposals: proposals.length ? [...s.proposals, ...proposals] : s.proposals
  }))
  project.markDirty()
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
