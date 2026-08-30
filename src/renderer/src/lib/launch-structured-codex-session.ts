import type {
  AgentSessionAttachResult,
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../../shared/structured-agent-session-mutation'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { useAppStore } from '@/store'
import {
  clearWebSessionFocusIntentIfMatches,
  recordWebSessionFocusIntent,
  resolveWebSessionVisibleTabId
} from '@/runtime/web-session-focus-intent'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '@/runtime/local-structured-session-tabs-sync'
import type { AgentStartedTelemetry } from '@/lib/worktree-startup-payload'

export type StructuredCodexInitialOptions = {
  model: string
  effort?: string
}

type StructuredAgentSessionCreateParams = {
  envelope: AgentSessionMutationEnvelope
  worktree: string
  agent: 'codex'
  initialOptions?: StructuredCodexInitialOptions
  telemetry?: AgentStartedTelemetry
}

export type StructuredAgentSessionLaunchIntent = {
  sessionId: string
  worktreeId: string
  params: StructuredAgentSessionCreateParams
}

export class StructuredAgentSessionCreateRefusalError extends Error {}

export function createStructuredCodexSessionLaunchIntent(
  worktreeId: string,
  options: {
    initialOptions?: StructuredCodexInitialOptions
    telemetry?: AgentStartedTelemetry
  } = {}
): StructuredAgentSessionLaunchIntent {
  const sessionId = `codex_${crypto.randomUUID().replaceAll('-', '_')}`
  const fields = {
    worktree: toRuntimeWorktreeSelector(worktreeId),
    agent: 'codex' as const,
    ...(options.initialOptions ? { initialOptions: options.initialOptions } : {}),
    ...(options.telemetry ? { telemetry: options.telemetry } : {})
  }
  const state = useAppStore.getState()
  recordWebSessionFocusIntent(
    { environmentId: LOCAL_STRUCTURED_SESSION_OWNER },
    worktreeId,
    `agent-session:${sessionId}`,
    undefined,
    resolveWebSessionVisibleTabId(state, worktreeId)
  )
  return {
    sessionId,
    worktreeId,
    params: {
      envelope: {
        sessionId,
        clientOperationId: createStructuredAgentSessionOperationId(() => crypto.randomUUID()),
        expectedRuntimeFence: null,
        payloadFingerprint: structuredAgentSessionPayloadFingerprint({
          method: 'agentSession.create',
          sessionId,
          fields
        })
      },
      ...fields
    }
  }
}

export function abandonStructuredAgentSessionLaunchIntent(
  intent: StructuredAgentSessionLaunchIntent
): void {
  clearWebSessionFocusIntentIfMatches(
    { environmentId: LOCAL_STRUCTURED_SESSION_OWNER },
    intent.worktreeId,
    `agent-session:${intent.sessionId}`
  )
}

export async function launchStructuredCodexSession(
  intent: StructuredAgentSessionLaunchIntent
): Promise<AgentSessionAttachResult> {
  const result = await callStructuredAgentSession<
    AgentSessionMutationResult<AgentSessionAttachResult>
  >({ kind: 'local' }, 'agentSession.create', intent.params)
  if (!result.ok) {
    if (result.refusal.acquisitionState === 'not-acquired') {
      abandonStructuredAgentSessionLaunchIntent(intent)
      throw new StructuredAgentSessionCreateRefusalError(result.refusal.message)
    }
    throw new Error(result.refusal.message)
  }
  return result.value
}
