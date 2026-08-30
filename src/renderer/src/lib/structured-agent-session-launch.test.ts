import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'

const mocks = vi.hoisted(() => ({
  createIntent: vi.fn(),
  launch: vi.fn(),
  enqueueLaunchPrompt: vi.fn(),
  seedNativeChatLaunchDraft: vi.fn(),
  clearNativeChatLaunchDraft: vi.fn(),
  writeOutbox: vi.fn(),
  readOutbox: vi.fn(),
  mutateOutboxEntry: vi.fn(),
  protectOutbox: vi.fn(),
  releaseOutbox: vi.fn(),
  callStructured: vi.fn(),
  storedOutbox: [] as Record<string, unknown>[]
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    message: vi.fn()
  }
}))

vi.mock('@/lib/launch-structured-codex-session', () => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  return {
    createStructuredCodexSessionLaunchIntent: mocks.createIntent,
    launchStructuredCodexSession: mocks.launch,
    StructuredAgentSessionCreateRefusalError
  }
})

vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  refreshLocalStructuredSessionTabs: vi.fn()
}))

vi.mock('@/lib/structured-agent-session-outbox-storage', () => ({
  enqueueStructuredAgentSessionLaunchPrompt: mocks.enqueueLaunchPrompt,
  writeStructuredAgentSessionOutbox: mocks.writeOutbox,
  readStructuredAgentSessionOutbox: mocks.readOutbox,
  mutateStructuredAgentSessionOutboxEntry: mocks.mutateOutboxEntry,
  structuredSessionOperationId: () => 'replacement-operation',
  protectStructuredAgentSessionLaunchOutbox: mocks.protectOutbox,
  releaseStructuredAgentSessionLaunchOutbox: mocks.releaseOutbox
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.callStructured
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      seedNativeChatLaunchDraft: mocks.seedNativeChatLaunchDraft,
      clearNativeChatLaunchDraft: mocks.clearNativeChatLaunchDraft
    })
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import {
  StructuredAgentSessionCreateRefusalError,
  type StructuredAgentSessionLaunchIntent
} from '@/lib/launch-structured-codex-session'
import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync'
import { startStructuredCodexLaunch } from './structured-agent-session-launch'

function launchIntent(
  worktreeId: string,
  sessionId = `session-${worktreeId}`
): StructuredAgentSessionLaunchIntent {
  return {
    worktreeId,
    sessionId,
    params: {
      envelope: {
        sessionId,
        clientOperationId: `operation-${sessionId}`,
        expectedRuntimeFence: null,
        payloadFingerprint: `fingerprint-${sessionId}`
      },
      worktree: `id:${worktreeId}`,
      agent: 'codex'
    }
  }
}

function publishedSnapshot(worktreeId: string, sessionId: string): RuntimeMobileSessionTabsResult {
  return {
    worktree: worktreeId,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [
      {
        type: 'agent-session',
        id: 'tab-1',
        title: 'Codex',
        sessionId,
        agent: 'codex',
        isActive: true
      }
    ]
  }
}

async function flushLaunchSettlement(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

describe('startStructuredCodexLaunch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.storedOutbox = []
    mocks.createIntent.mockImplementation((worktreeId: string) => launchIntent(worktreeId))
    mocks.enqueueLaunchPrompt.mockImplementation((sessionId: string, text: string) => {
      const entry = {
        clientMessageId: 'launch-operation',
        sessionId,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
        previewUris: [],
        state: 'queued',
        queuedAt: Date.now(),
        lastAttemptAt: null,
        retryAfterUnknownSubmittedAt: null
      }
      mocks.storedOutbox = [entry]
      return entry
    })
    mocks.readOutbox.mockImplementation(() => mocks.storedOutbox)
    mocks.writeOutbox.mockImplementation((_sessionId: string, entries: unknown[]) => {
      mocks.storedOutbox = entries as Record<string, unknown>[]
      return true
    })
    mocks.mutateOutboxEntry.mockImplementation(
      (
        _sessionId: string,
        clientMessageId: string,
        update: (entry: Record<string, unknown>) => Record<string, unknown> | null
      ) => {
        const index = mocks.storedOutbox.findIndex(
          (entry) => entry.clientMessageId === clientMessageId
        )
        if (index === -1) {
          return { saved: true, matched: false, entries: mocks.storedOutbox }
        }
        const replacement = update(mocks.storedOutbox[index]!)
        mocks.storedOutbox = replacement
          ? mocks.storedOutbox.map((entry, entryIndex) =>
              entryIndex === index ? replacement : entry
            )
          : mocks.storedOutbox.filter((_entry, entryIndex) => entryIndex !== index)
        return { saved: true, matched: true, entries: mocks.storedOutbox }
      }
    )
    mocks.callStructured.mockImplementation(async (_target: unknown, method: string) =>
      method === 'agentSession.history'
        ? { ok: true, page: { fence: 1 } }
        : {
            ok: true,
            replayed: false,
            fence: 1,
            cursor: { epoch: 'epoch-1', sequence: 1 },
            value: {
              clientMessageId: 'launch-operation',
              submission: {
                clientMessageId: 'launch-operation',
                submittedAt: 1,
                dispatchState: 'accepted'
              }
            }
          }
    )
  })

  it('opens the chat without an informational progress toast', async () => {
    const worktreeId = 'wt-open-quiet'
    const intent = launchIntent(worktreeId, 'session-1')
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockResolvedValue({ sessionId: intent.sessionId, fence: 1 })
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])

    startStructuredCodexLaunch(worktreeId)
    await flushLaunchSettlement()

    expect(mocks.launch).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledWith(intent)
    expect(toast.message).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('persists an auto-submit prompt before creating the structured session', async () => {
    const intent = launchIntent('wt-prompt', 'session-prompt')
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockResolvedValue({ sessionId: intent.sessionId, fence: 1 })
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(intent.worktreeId, intent.sessionId)
    ])

    const result = startStructuredCodexLaunch(intent.worktreeId, {
      prompt: 'Fix the prompt route',
      promptDelivery: 'auto-submit'
    })

    await expect(result.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    expect(mocks.enqueueLaunchPrompt).toHaveBeenCalledWith(intent.sessionId, 'Fix the prompt route')
    expect(mocks.enqueueLaunchPrompt.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.launch.mock.invocationCallOrder[0]
    )
  })

  it('settles delivery only after an accepted send and preserves the caller on rejection', async () => {
    const intent = launchIntent('wt-rejected-send', 'session-rejected-send')
    const onPromptDelivered = vi.fn()
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockResolvedValue({ sessionId: intent.sessionId, fence: 4 })
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(intent.worktreeId, intent.sessionId)
    ])
    mocks.callStructured.mockResolvedValueOnce({
      ok: true,
      value: {
        submission: {
          clientMessageId: 'launch-operation',
          submittedAt: 1,
          dispatchState: 'rejected',
          reason: 'not accepted'
        }
      }
    })

    const result = startStructuredCodexLaunch(intent.worktreeId, {
      prompt: 'Do not discard this source',
      promptDelivery: 'submit-after-ready',
      onPromptDelivered
    })

    await expect(result.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: false
    })
    expect(onPromptDelivered).not.toHaveBeenCalled()
    expect(mocks.storedOutbox).toEqual([
      expect.objectContaining({ clientMessageId: 'launch-operation', state: 'queued' })
    ])
    expect(mocks.callStructured.mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(refreshLocalStructuredSessionTabs).mock.invocationCallOrder[0]
    )
  })

  it('does not consume caller source when create is refused', async () => {
    const intent = launchIntent('wt-refused-source', 'session-refused-source')
    const onPromptDelivered = vi.fn()
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('unsupported'))

    const result = startStructuredCodexLaunch(intent.worktreeId, {
      prompt: 'Keep source',
      promptDelivery: 'submit-after-ready',
      onPromptDelivered
    })

    await expect(result.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: true
    })
    expect(onPromptDelivered).not.toHaveBeenCalled()
    expect(mocks.callStructured).not.toHaveBeenCalled()
  })

  it('seeds an editable draft only after the structured tab is published', async () => {
    const intent = launchIntent('wt-draft', 'session-draft')
    mocks.createIntent.mockReturnValueOnce(intent)
    let resolveLaunch!: (value: { sessionId: string; fence: number }) => void
    mocks.launch.mockImplementation(() => new Promise((resolve) => (resolveLaunch = resolve)))
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(intent.worktreeId, intent.sessionId)
    ])

    startStructuredCodexLaunch(intent.worktreeId, {
      prompt: 'Review this first',
      promptDelivery: 'draft'
    })

    expect(mocks.seedNativeChatLaunchDraft).not.toHaveBeenCalled()
    resolveLaunch({ sessionId: intent.sessionId, fence: 1 })
    await flushLaunchSettlement()
    expect(mocks.seedNativeChatLaunchDraft).toHaveBeenCalledWith({
      tabId: 'structured-agent-session-session-draft',
      agent: 'codex',
      text: 'Review this first',
      createdAt: expect.any(Number)
    })
    expect(mocks.enqueueLaunchPrompt).not.toHaveBeenCalled()
  })

  it('coalesces a duplicate click silently while the launch is in flight', async () => {
    const worktreeId = 'wt-duplicate-click'
    const intent = launchIntent(worktreeId)
    let resolveLaunch: (value: { sessionId: string; fence: number }) => void = () => {}
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockImplementation(() => new Promise((resolve) => (resolveLaunch = resolve)))
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])

    startStructuredCodexLaunch(worktreeId)
    startStructuredCodexLaunch(worktreeId)

    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledOnce()
    resolveLaunch({ sessionId: intent.sessionId, fence: 1 })
    await flushLaunchSettlement()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('single-flights prompt staging, dispatch, and delivery callbacks', async () => {
    const worktreeId = 'wt-duplicate-prompt'
    const intent = launchIntent(worktreeId)
    const firstDelivered = vi.fn()
    const secondDelivered = vi.fn()
    let resolveLaunch: (value: { sessionId: string; fence: number }) => void = () => {}
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockImplementation(() => new Promise((resolve) => (resolveLaunch = resolve)))
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])

    const first = startStructuredCodexLaunch(worktreeId, {
      prompt: 'Send once',
      promptDelivery: 'submit-after-ready',
      onPromptDelivered: firstDelivered
    })
    const second = startStructuredCodexLaunch(worktreeId, {
      prompt: 'Send once',
      promptDelivery: 'submit-after-ready',
      onPromptDelivered: secondDelivered
    })

    expect(mocks.enqueueLaunchPrompt).toHaveBeenCalledOnce()
    expect(first.promptDeliveryResult).not.toBe(second.promptDeliveryResult)
    await Promise.resolve()
    resolveLaunch({ sessionId: intent.sessionId, fence: 1 })
    await expect(first.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    expect(mocks.callStructured).toHaveBeenCalledOnce()
    expect(firstDelivered).toHaveBeenCalledOnce()
    expect(secondDelivered).toHaveBeenCalledOnce()
  })

  it('isolates coalesced delivery subscribers when one callback throws', async () => {
    const worktreeId = 'wt-duplicate-prompt-callback-error'
    const intent = launchIntent(worktreeId)
    const callbackError = new Error('caller cleanup failed')
    const firstDelivered = vi.fn(() => {
      throw callbackError
    })
    const secondDelivered = vi.fn()
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockResolvedValue({ sessionId: intent.sessionId, fence: 1 })
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])

    const first = startStructuredCodexLaunch(worktreeId, {
      prompt: 'Send once',
      promptDelivery: 'submit-after-ready',
      onPromptDelivered: firstDelivered
    })
    const second = startStructuredCodexLaunch(worktreeId, {
      prompt: 'Send once',
      promptDelivery: 'submit-after-ready',
      onPromptDelivered: secondDelivered
    })

    await expect(first.promptDeliveryResult).rejects.toBe(callbackError)
    await expect(second.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
    expect(firstDelivered).toHaveBeenCalledOnce()
    expect(secondDelivered).toHaveBeenCalledOnce()
    expect(mocks.callStructured).toHaveBeenCalledOnce()
  })

  it('keeps the launch identity single-flight until prompt delivery settles', async () => {
    const worktreeId = 'wt-delivery-still-pending'
    const intent = launchIntent(worktreeId)
    const firstDelivered = vi.fn()
    const secondDelivered = vi.fn()
    const send = Promise.withResolvers<{
      ok: true
      value: { submission: { dispatchState: 'accepted' } }
    }>()
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockResolvedValue({ sessionId: intent.sessionId, fence: 1 })
    mocks.callStructured.mockReturnValue(send.promise)
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])

    const first = startStructuredCodexLaunch(worktreeId, {
      prompt: 'Send once after create',
      promptDelivery: 'submit-after-ready',
      onPromptDelivered: firstDelivered
    })
    await flushLaunchSettlement()
    expect(mocks.callStructured).toHaveBeenCalledOnce()
    const second = startStructuredCodexLaunch(worktreeId, {
      prompt: 'Send once after create',
      promptDelivery: 'submit-after-ready',
      onPromptDelivered: secondDelivered
    })

    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.enqueueLaunchPrompt).toHaveBeenCalledOnce()
    send.resolve({ ok: true, value: { submission: { dispatchState: 'accepted' } } })
    await expect(first.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
    await expect(second.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
    expect(firstDelivered).toHaveBeenCalledOnce()
    expect(secondDelivered).toHaveBeenCalledOnce()
  })

  it('keeps distinct concurrent launch semantics independent on one worktree', async () => {
    const worktreeId = 'wt-distinct-prompts'
    const firstIntent = launchIntent(worktreeId, 'session-first-prompt')
    const secondIntent = launchIntent(worktreeId, 'session-second-prompt')
    const firstDelivered = vi.fn()
    const secondDelivered = vi.fn()
    const launches = [
      Promise.withResolvers<{ sessionId: string; fence: number }>(),
      Promise.withResolvers<{ sessionId: string; fence: number }>()
    ]
    mocks.createIntent.mockReturnValueOnce(firstIntent).mockReturnValueOnce(secondIntent)
    mocks.launch
      .mockImplementationOnce(() => launches[0].promise)
      .mockImplementationOnce(() => launches[1].promise)
    vi.mocked(refreshLocalStructuredSessionTabs).mockImplementation(async () => [
      publishedSnapshot(worktreeId, firstIntent.sessionId),
      publishedSnapshot(worktreeId, secondIntent.sessionId)
    ])

    const first = startStructuredCodexLaunch(worktreeId, {
      prompt: 'Fix the first issue',
      promptDelivery: 'submit-after-ready',
      onPromptDelivered: firstDelivered,
      initialOptions: { model: 'gpt-first', effort: 'high' },
      telemetry: {
        agent_kind: 'codex',
        launch_source: 'source_control_recovery',
        request_kind: 'new'
      }
    })
    const second = startStructuredCodexLaunch(worktreeId, {
      prompt: 'Fix the second issue',
      promptDelivery: 'submit-after-ready',
      onPromptDelivered: secondDelivered,
      initialOptions: { model: 'gpt-second', effort: 'medium' },
      telemetry: {
        agent_kind: 'codex',
        launch_source: 'quick_command',
        request_kind: 'new'
      }
    })

    expect(mocks.createIntent).toHaveBeenCalledTimes(2)
    expect(mocks.enqueueLaunchPrompt).toHaveBeenNthCalledWith(
      1,
      firstIntent.sessionId,
      'Fix the first issue'
    )
    expect(mocks.enqueueLaunchPrompt).toHaveBeenNthCalledWith(
      2,
      secondIntent.sessionId,
      'Fix the second issue'
    )
    expect(first.launchResult).not.toBe(second.launchResult)
    await Promise.resolve()
    launches[0].resolve({ sessionId: firstIntent.sessionId, fence: 1 })
    launches[1].resolve({ sessionId: secondIntent.sessionId, fence: 2 })
    await expect(first.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
    await expect(second.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
    expect(firstDelivered).toHaveBeenCalledOnce()
    expect(secondDelivered).toHaveBeenCalledOnce()
  })

  it('gives distinct refused launches independent fallback authority', async () => {
    const worktreeId = 'wt-distinct-refusals'
    const firstIntent = launchIntent(worktreeId, 'session-first-refusal')
    const secondIntent = launchIntent(worktreeId, 'session-second-refusal')
    const firstFallback = vi.fn()
    const secondFallback = vi.fn()
    mocks.createIntent.mockReturnValueOnce(firstIntent).mockReturnValueOnce(secondIntent)
    mocks.launch.mockRejectedValue(new StructuredAgentSessionCreateRefusalError('unsupported'))

    const first = startStructuredCodexLaunch(worktreeId, { prompt: 'first refused prompt' })
    const second = startStructuredCodexLaunch(worktreeId, { prompt: 'second refused prompt' })
    const fallbackResults = Promise.all([
      first.claimDefinitiveRefusalFallback(firstFallback),
      second.claimDefinitiveRefusalFallback(secondFallback)
    ])

    await expect(fallbackResults).resolves.toEqual([true, true])
    expect(firstFallback).toHaveBeenCalledOnce()
    expect(secondFallback).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledTimes(2)
  })

  it('gives identical retries only one definitive-refusal fallback', async () => {
    const worktreeId = 'wt-identical-refusals'
    const intent = launchIntent(worktreeId, 'session-identical-refusal')
    const firstFallback = vi.fn()
    const secondFallback = vi.fn()
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('unsupported'))

    const first = startStructuredCodexLaunch(worktreeId, { prompt: 'same refused prompt' })
    const second = startStructuredCodexLaunch(worktreeId, { prompt: 'same refused prompt' })
    const fallbackResults = Promise.all([
      first.claimDefinitiveRefusalFallback(firstFallback),
      second.claimDefinitiveRefusalFallback(secondFallback)
    ])

    await expect(fallbackResults).resolves.toEqual([true, true])
    expect(firstFallback).toHaveBeenCalledOnce()
    expect(secondFallback).not.toHaveBeenCalled()
    expect(mocks.launch).toHaveBeenCalledOnce()
  })

  it('refuses creation when durable prompt staging fails', async () => {
    const worktreeId = 'wt-staging-refused'
    const intent = launchIntent(worktreeId)
    const onPromptDelivered = vi.fn()
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.enqueueLaunchPrompt.mockReturnValueOnce(null)

    const result = startStructuredCodexLaunch(worktreeId, {
      prompt: 'Preserve this source',
      promptDelivery: 'submit-after-ready',
      onPromptDelivered
    })

    await expect(result.launchResult).rejects.toBeInstanceOf(
      StructuredAgentSessionCreateRefusalError
    )
    await expect(result.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: true
    })
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(onPromptDelivered).not.toHaveBeenCalled()
  })

  it('reconciles a host commit when the create reply is lost', async () => {
    const worktreeId = 'wt-response-loss'
    const intent = launchIntent(worktreeId)
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockRejectedValueOnce(new Error('response lost'))
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])

    startStructuredCodexLaunch(worktreeId)
    await flushLaunchSettlement()

    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledOnce()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('retries an absent unknown outcome with the exact same intent', async () => {
    const worktreeId = 'wt-same-envelope-retry'
    const intent = launchIntent(worktreeId)
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ sessionId: intent.sessionId, fence: 1 })
    vi.mocked(refreshLocalStructuredSessionTabs)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([publishedSnapshot(worktreeId, intent.sessionId)])

    startStructuredCodexLaunch(worktreeId)
    await flushLaunchSettlement()

    expect(mocks.launch).toHaveBeenCalledTimes(2)
    expect(mocks.launch.mock.calls[0]?.[0]).toBe(intent)
    expect(mocks.launch.mock.calls[1]?.[0]).toBe(intent)
    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('keeps an unresolved identity reserved until inventory reconciles it', async () => {
    const worktreeId = 'wt-still-unknown'
    const intent = launchIntent(worktreeId)
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockRejectedValue(new Error('offline'))
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([])

    startStructuredCodexLaunch(worktreeId)
    await flushLaunchSettlement()
    expect(toast.error).toHaveBeenCalledOnce()

    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])
    startStructuredCodexLaunch(worktreeId)
    await flushLaunchSettlement()

    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledTimes(2)
    expect(toast.error).toHaveBeenCalledOnce()
  })

  it('reattaches prompt delivery subscribers after an unknown launch becomes visible', async () => {
    const worktreeId = 'wt-unknown-prompt-recovery'
    const intent = launchIntent(worktreeId)
    const firstDelivered = vi.fn()
    const retryDelivered = vi.fn()
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockRejectedValue(new Error('offline'))
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([])

    const first = startStructuredCodexLaunch(worktreeId, {
      prompt: 'Deliver after recovery',
      promptDelivery: 'submit-after-ready',
      onPromptDelivered: firstDelivered
    })
    await expect(first.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: true
    })
    expect(firstDelivered).not.toHaveBeenCalled()

    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, intent.sessionId)
    ])
    const retry = startStructuredCodexLaunch(worktreeId, {
      prompt: 'Deliver after recovery',
      promptDelivery: 'submit-after-ready',
      onPromptDelivered: retryDelivered
    })

    await expect(retry.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.enqueueLaunchPrompt).toHaveBeenCalledOnce()
    expect(mocks.callStructured).toHaveBeenCalledTimes(2)
    expect(firstDelivered).not.toHaveBeenCalled()
    expect(retryDelivered).toHaveBeenCalledOnce()
  })

  it('releases a definitively refused intent so a new click can create a new identity', async () => {
    const worktreeId = 'wt-refused'
    const first = launchIntent(worktreeId, 'session-first')
    const second = launchIntent(worktreeId, 'session-second')
    mocks.createIntent.mockReturnValueOnce(first).mockReturnValueOnce(second)
    mocks.launch
      .mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('unsupported'))
      .mockResolvedValueOnce({ sessionId: second.sessionId, fence: 1 })
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, second.sessionId)
    ])

    startStructuredCodexLaunch(worktreeId)
    await flushLaunchSettlement()
    startStructuredCodexLaunch(worktreeId)
    await flushLaunchSettlement()

    expect(mocks.createIntent).toHaveBeenCalledTimes(2)
    expect(mocks.launch.mock.calls[0]?.[0]).toBe(first)
    expect(mocks.launch.mock.calls[1]?.[0]).toBe(second)
    expect(toast.error).toHaveBeenCalledOnce()
    expect(mocks.clearNativeChatLaunchDraft).not.toHaveBeenCalled()
    expect(mocks.writeOutbox).not.toHaveBeenCalledWith('session-first', [])
  })
})
