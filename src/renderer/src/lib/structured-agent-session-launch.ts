import { toast } from 'sonner'
import {
  createStructuredCodexSessionLaunchIntent,
  StructuredAgentSessionCreateRefusalError,
  type StructuredCodexInitialOptions
} from '@/lib/launch-structured-codex-session'
import { translate } from '@/i18n/i18n'
import {
  enqueueStructuredAgentSessionLaunchPrompt,
  protectStructuredAgentSessionLaunchOutbox,
  releaseStructuredAgentSessionLaunchOutbox
} from '@/lib/structured-agent-session-outbox-storage'
import type { StructuredAgentSessionOutboxEntry } from '../../../shared/structured-agent-session-outbox'
import type { AgentStartedTelemetry } from '@/lib/worktree-startup-payload'
import {
  launchAndReconcile,
  reconcileUnknownLaunch,
  type StructuredCodexLaunchReceipt,
  type StructuredLaunchRecoveryState
} from '@/lib/structured-agent-session-launch-recovery'
import {
  settleStructuredCodexLaunchPrompt,
  type StructuredPromptDeliveryResult
} from '@/lib/structured-agent-session-launch-prompt'

export type { StructuredCodexLaunchReceipt }

type StructuredLaunchState = StructuredLaunchRecoveryState & {
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
  promptSettlement?: {
    options: Omit<
      StructuredCodexLaunchOptions,
      'initialOptions' | 'telemetry' | 'onPromptDelivered'
    >
    stagedEntry: Promise<StructuredAgentSessionOutboxEntry | null | undefined>
  }
  refusalFallback: {
    callback: (() => void | Promise<void>) | null
    promise: Promise<boolean>
    resolve: (ran: boolean) => void
    reject: (error: unknown) => void
    started: boolean
  }
}

const pendingStructuredLaunchesByIdentity = new Map<string, StructuredLaunchState>()

export type StructuredCodexLaunchOptions = {
  prompt?: string
  promptDelivery?: 'auto-submit' | 'draft' | 'submit-after-ready'
  onPromptDelivered?: () => void
  initialOptions?: StructuredCodexInitialOptions
  telemetry?: AgentStartedTelemetry
}

export type StructuredCodexLaunchResult = {
  sessionId: string
  launchResult: Promise<StructuredCodexLaunchReceipt>
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
  claimDefinitiveRefusalFallback: (fallback: () => void | Promise<void>) => Promise<boolean>
}

function structuredCodexLaunchIdentity(
  worktreeId: string,
  options: StructuredCodexLaunchOptions
): string {
  return JSON.stringify([
    worktreeId,
    options.prompt?.trim() ?? '',
    options.promptDelivery ?? 'auto-submit',
    options.initialOptions?.model ?? null,
    options.initialOptions?.effort ?? null,
    options.telemetry?.agent_kind ?? null,
    options.telemetry?.launch_source ?? null,
    options.telemetry?.request_kind ?? null
  ])
}

function cleanupLaunchState(identity: string, state: StructuredLaunchState): void {
  if (pendingStructuredLaunchesByIdentity.get(identity) === state) {
    pendingStructuredLaunchesByIdentity.delete(identity)
    releaseStructuredAgentSessionLaunchOutbox(state.intent.sessionId)
  }
}

function settleDefinitiveRefusalFallback(identity: string, state: StructuredLaunchState): void {
  if (state.refusalFallback.started) {
    return
  }
  state.refusalFallback.started = true
  const fallback = state.refusalFallback.callback
  if (!fallback) {
    state.refusalFallback.resolve(false)
    cleanupLaunchState(identity, state)
    return
  }
  void Promise.resolve()
    .then(fallback)
    .then(
      () => state.refusalFallback.resolve(true),
      (error) => state.refusalFallback.reject(error)
    )
    .finally(() => cleanupLaunchState(identity, state))
}

function trackLaunchSettlement(
  identity: string,
  state: StructuredLaunchState,
  promise: Promise<StructuredCodexLaunchReceipt>
): void {
  void promise.then(
    () => {
      if (
        state.promise === promise &&
        pendingStructuredLaunchesByIdentity.get(identity) === state
      ) {
        state.refusalFallback.resolve(false)
        if (state.promptDeliveryResult) {
          void state.promptDeliveryResult.finally(() => cleanupLaunchState(identity, state))
        } else {
          cleanupLaunchState(identity, state)
        }
      }
    },
    (error) => {
      if (
        state.promise === promise &&
        pendingStructuredLaunchesByIdentity.get(identity) === state
      ) {
        if (error instanceof StructuredAgentSessionCreateRefusalError) {
          settleDefinitiveRefusalFallback(identity, state)
        } else if (!state.visibilityUnknown) {
          state.refusalFallback.resolve(false)
          cleanupLaunchState(identity, state)
        }
      }
    }
  )
}

function settleLaunchPrompt(
  state: StructuredLaunchState
): Promise<StructuredPromptDeliveryResult> | undefined {
  if (!state.promptSettlement) {
    return undefined
  }
  return settleStructuredCodexLaunchPrompt({
    sessionId: state.intent.sessionId,
    launchResult: () => state.promise,
    options: state.promptSettlement.options,
    stagedEntry: state.promptSettlement.stagedEntry
  })
}

function structuredCodexLaunchState(
  worktreeId: string,
  options: StructuredCodexLaunchOptions
): StructuredLaunchState {
  const identity = structuredCodexLaunchIdentity(worktreeId, options)
  const existing = pendingStructuredLaunchesByIdentity.get(identity)
  if (existing) {
    if (existing.visibilityUnknown) {
      existing.promise = reconcileUnknownLaunch(existing)
      existing.promptDeliveryResult = settleLaunchPrompt(existing)
      trackLaunchSettlement(identity, existing, existing.promise)
      trackLaunchFailureToast(existing.promise)
    }
    return existing
  }
  const fallback = Promise.withResolvers<boolean>()
  const state: StructuredLaunchState = {
    intent: createStructuredCodexSessionLaunchIntent(worktreeId, {
      ...(options.initialOptions ? { initialOptions: options.initialOptions } : {}),
      ...(options.telemetry ? { telemetry: options.telemetry } : {})
    }),
    promise: Promise.resolve({ sessionId: '', fence: 0 }),
    refusalFallback: {
      callback: null,
      promise: fallback.promise,
      resolve: fallback.resolve,
      reject: fallback.reject,
      started: false
    },
    visibilityUnknown: false
  }
  protectStructuredAgentSessionLaunchOutbox(state.intent.sessionId)
  const text = options.prompt?.trim() ?? ''
  const requiresStaging = Boolean(text && options.promptDelivery !== 'draft')
  const stagedEntry = requiresStaging
    ? Promise.resolve(enqueueStructuredAgentSessionLaunchPrompt(state.intent.sessionId, text))
    : Promise.resolve(undefined)
  state.promise = requiresStaging
    ? stagedEntry.then((entry) => {
        if (!entry) {
          throw new StructuredAgentSessionCreateRefusalError(
            'Could not durably stage the Codex launch prompt.'
          )
        }
        return launchAndReconcile(state)
      })
    : launchAndReconcile(state)
  state.promptSettlement = {
    options: {
      ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
      ...(options.promptDelivery !== undefined ? { promptDelivery: options.promptDelivery } : {})
    },
    stagedEntry
  }
  state.promptDeliveryResult = settleLaunchPrompt(state)
  pendingStructuredLaunchesByIdentity.set(identity, state)
  trackLaunchSettlement(identity, state, state.promise)
  trackLaunchFailureToast(state.promise)
  return state
}

function trackLaunchFailureToast(promise: Promise<StructuredCodexLaunchReceipt>): void {
  void promise.catch((error) => {
    toast.error(
      translate(
        'components.native-chat.structuredSessionLaunchFailed',
        'Could not open Codex chat'
      ),
      { description: error instanceof Error ? error.message : String(error) }
    )
  })
}

function subscribeToPromptDelivery(
  state: StructuredLaunchState,
  onPromptDelivered: (() => void) | undefined
): Promise<StructuredPromptDeliveryResult> | undefined {
  return state.promptDeliveryResult?.then((result) => {
    if (result.delivered) {
      onPromptDelivered?.()
    }
    return result
  })
}
export function startStructuredCodexLaunch(
  worktreeId: string,
  options: StructuredCodexLaunchOptions = {}
): StructuredCodexLaunchResult {
  const state = structuredCodexLaunchState(worktreeId, options)
  return {
    sessionId: state.intent.sessionId,
    launchResult: state.promise,
    ...(state.promptDeliveryResult
      ? { promptDeliveryResult: subscribeToPromptDelivery(state, options.onPromptDelivered)! }
      : {}),
    claimDefinitiveRefusalFallback: (fallback) => {
      state.refusalFallback.callback ??= fallback
      return state.refusalFallback.promise
    }
  }
}
