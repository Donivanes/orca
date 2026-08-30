import { useAppStore } from '@/store'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import {
  mutateStructuredAgentSessionOutboxEntry,
  structuredSessionOperationId
} from '@/lib/structured-agent-session-outbox-storage'
import type {
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../shared/agent-session-wire'
import {
  requeueStructuredAgentSessionSendRefusal,
  structuredAgentSessionSendRequest,
  type StructuredAgentSessionOutboxEntry
} from '../../../shared/structured-agent-session-outbox'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'

type LaunchReceipt = { sessionId: string; fence: number }

export type StructuredPromptDeliveryResult = {
  delivered: boolean
  failureNotified: boolean
}

export type StructuredLaunchPromptOptions = {
  prompt?: string
  promptDelivery?: 'auto-submit' | 'draft' | 'submit-after-ready'
  onPromptDelivered?: () => void
}

async function persistLaunchOutboxEntry(
  sessionId: string,
  entry: StructuredAgentSessionOutboxEntry,
  update: (entry: StructuredAgentSessionOutboxEntry) => StructuredAgentSessionOutboxEntry | null
): Promise<boolean> {
  const result = await mutateStructuredAgentSessionOutboxEntry(
    sessionId,
    entry.clientMessageId,
    update
  )
  return result.saved && result.matched
}

async function dispatchStructuredCodexLaunchPrompt(
  entry: StructuredAgentSessionOutboxEntry,
  receipt: LaunchReceipt
): Promise<boolean> {
  if (
    !(await persistLaunchOutboxEntry(entry.sessionId, entry, (current) => ({
      ...current,
      state: 'dispatching',
      lastAttemptAt: Date.now()
    })))
  ) {
    return false
  }
  try {
    const result = await callStructuredAgentSession<
      AgentSessionMutationResult<AgentSessionSendResult>
    >(
      { kind: 'local' },
      'agentSession.send',
      structuredAgentSessionSendRequest(entry, receipt.fence)
    )
    if (!result.ok) {
      await persistLaunchOutboxEntry(entry.sessionId, entry, (current) =>
        requeueStructuredAgentSessionSendRefusal(
          current,
          result.refusal.code,
          structuredSessionOperationId
        )
      )
      return false
    }
    const state = result.value.submission.dispatchState
    await persistLaunchOutboxEntry(entry.sessionId, entry, (current) =>
      state === 'accepted'
        ? null
        : { ...current, state: state === 'unknown' ? 'unconfirmed' : 'queued' }
    )
    return state === 'accepted'
  } catch {
    await persistLaunchOutboxEntry(entry.sessionId, entry, (current) => ({
      ...current,
      state: 'unconfirmed'
    }))
    return false
  }
}

export function settleStructuredCodexLaunchPrompt(args: {
  sessionId: string
  launchResult: () => Promise<LaunchReceipt>
  options: StructuredLaunchPromptOptions
  stagedEntry: Promise<StructuredAgentSessionOutboxEntry | null | undefined>
}): Promise<StructuredPromptDeliveryResult> | undefined {
  const text = args.options.prompt?.trim() ?? ''
  if (!text) {
    return undefined
  }
  if (args.options.promptDelivery === 'draft') {
    return Promise.resolve()
      .then(args.launchResult)
      .then(
        () => {
          useAppStore.getState().seedNativeChatLaunchDraft({
            tabId: structuredAgentSessionTabId(args.sessionId),
            agent: 'codex',
            text,
            createdAt: Date.now()
          })
          args.options.onPromptDelivered?.()
          return { delivered: true, failureNotified: false }
        },
        () => ({ delivered: false, failureNotified: true })
      )
  }
  return Promise.resolve()
    .then(args.launchResult)
    .then(
      async (receipt) => {
        const entry = await args.stagedEntry
        if (!entry) {
          return { delivered: false, failureNotified: true }
        }
        const delivered = await dispatchStructuredCodexLaunchPrompt(entry, receipt)
        if (delivered) {
          args.options.onPromptDelivered?.()
        }
        return { delivered, failureNotified: false }
      },
      () => ({ delivered: false, failureNotified: true })
    )
}
