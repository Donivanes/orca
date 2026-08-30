import {
  launchStructuredCodexSession,
  StructuredAgentSessionCreateRefusalError,
  type StructuredAgentSessionLaunchIntent
} from '@/lib/launch-structured-codex-session'
import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync'
import type { AgentSessionHistoryResult } from '../../../shared/agent-session-wire'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'

export type StructuredCodexLaunchReceipt = { sessionId: string; fence: number }

export type StructuredLaunchRecoveryState = {
  intent: StructuredAgentSessionLaunchIntent
  promise: Promise<StructuredCodexLaunchReceipt>
  visibilityUnknown: boolean
}

async function verifyPublishedSession(intent: StructuredAgentSessionLaunchIntent): Promise<void> {
  const snapshots = await refreshLocalStructuredSessionTabs()
  const published = snapshots.some(
    (snapshot) =>
      snapshot.worktree === intent.worktreeId &&
      snapshot.tabs.some(
        (tab) => tab.type === 'agent-session' && tab.sessionId === intent.sessionId
      )
  )
  if (!published) {
    throw new Error('structured session tab publication unavailable')
  }
}

async function recoverPublishedSessionReceipt(
  intent: StructuredAgentSessionLaunchIntent
): Promise<StructuredCodexLaunchReceipt> {
  await verifyPublishedSession(intent)
  const history = await callStructuredAgentSession<AgentSessionHistoryResult>(
    { kind: 'local' },
    'agentSession.history',
    { sessionId: intent.sessionId, direction: 'tail', limit: 1 }
  )
  const fence = history.page.fence ?? (!history.ok ? history.fence : undefined)
  if (!fence) {
    throw new Error('structured session fence publication unavailable')
  }
  return { sessionId: intent.sessionId, fence }
}

async function retrySameIntent(
  state: StructuredLaunchRecoveryState,
  priorError: unknown
): Promise<StructuredCodexLaunchReceipt> {
  try {
    const attached = await launchStructuredCodexSession(state.intent)
    await verifyPublishedSession(state.intent)
    return { sessionId: attached.sessionId, fence: attached.fence }
  } catch (error) {
    if (error instanceof StructuredAgentSessionCreateRefusalError) {
      throw error
    }
    try {
      return await recoverPublishedSessionReceipt(state.intent)
    } catch {
      state.visibilityUnknown = true
      throw error ?? priorError
    }
  }
}

export async function launchAndReconcile(
  state: StructuredLaunchRecoveryState
): Promise<StructuredCodexLaunchReceipt> {
  let attached: Awaited<ReturnType<typeof launchStructuredCodexSession>>
  try {
    attached = await launchStructuredCodexSession(state.intent)
  } catch (error) {
    if (error instanceof StructuredAgentSessionCreateRefusalError) {
      throw error
    }
    try {
      return await recoverPublishedSessionReceipt(state.intent)
    } catch {
      return retrySameIntent(state, error)
    }
  }
  try {
    await verifyPublishedSession(state.intent)
    return { sessionId: attached.sessionId, fence: attached.fence }
  } catch (error) {
    return retrySameIntent(state, error)
  }
}

export async function reconcileUnknownLaunch(
  state: StructuredLaunchRecoveryState
): Promise<StructuredCodexLaunchReceipt> {
  state.visibilityUnknown = false
  try {
    return await recoverPublishedSessionReceipt(state.intent)
  } catch (error) {
    return retrySameIntent(state, error)
  }
}
