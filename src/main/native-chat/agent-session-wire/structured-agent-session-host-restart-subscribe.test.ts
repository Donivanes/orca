import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type {
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }

function envelope(
  method: string,
  fields: Record<string, unknown>,
  overrides: Partial<AgentSessionMutationEnvelope> = {}
): AgentSessionMutationEnvelope {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    }),
    ...overrides
  }
}

const attachParams = (
  overrides: Partial<AgentSessionAttachParams> = {}
): AgentSessionAttachParams => hostTestAttachParams(null, overrides)

const ensureParams = (fence: number): AgentSessionAttachParams => hostTestAttachParams(fence)

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let releaseAcquisition: Mock<NonNullable<StructuredAgentSessionAdapter['releaseAcquisition']>>
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let cancelTurn: Mock<StructuredAgentSessionAdapter['cancelTurn']>
let answerPrompt: Mock<StructuredAgentSessionAdapter['answerPrompt']>
let setOption: Mock<StructuredAgentSessionAdapter['setOption']>
let ordinal = 0

function accepted(): AgentSessionDispatchOutcome {
  ordinal += 1
  return {
    state: 'accepted',
    providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal }
  }
}

function adapter(): StructuredAgentSessionAdapter {
  return {
    acquire,
    releaseAcquisition,
    dispatch,
    cancelTurn,
    answerPrompt,
    setOption
  }
}

async function attach(): Promise<AgentSessionRecord | null> {
  const result = await host.attach(CALLER, attachParams())
  expect(result.ok).toBe(true)
  return store.getRecord(SESSION)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-wire-host-'))
  resetHostTestOperationIds()
  ordinal = 0
  acquire = vi.fn(async ({ fence }) => ({
    process: {
      hostId: 'local',
      pid: 4242,
      processStartTimeMs: 1_700_000_000_000,
      spawnToken: store.getRecord(SESSION)?.lease.reservedSpawnToken ?? 'spawn-a'
    },
    link: {
      linkId: `link-${fence}`,
      handle: { provider: 'codex', threadId: THREAD },
      origin: store.getRecord(SESSION)?.providerHandleChain.length ? 'resumed' : 'created',
      mintedAtFence: fence,
      observedAt: NOW
    }
  }))
  releaseAcquisition = vi.fn(async () => true)
  dispatch = vi.fn(async () => accepted())
  cancelTurn = vi.fn(async () => ({ cancelled: true }))
  answerPrompt = vi.fn(async () => undefined)
  setOption = vi.fn(async () => undefined)
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
    store,
    adapter: adapter(),
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW
  })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('restart', () => {
  /** A restarted process: the same directories, a new store and a new host over
   *  them. Every lease loads unreconciled, so this is the state that decides
   *  whether a persisted session is reachable at all. */
  async function reboot(
    probeOwner: (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>
  ) {
    store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
    host = new StructuredAgentSessionHost({
      store,
      adapter: adapter(),
      journalRoot: root,
      claimKeyId: 'key-1',
      mintSpawnToken: () => 'spawn-b',
      probeOwner,
      now: () => NOW
    })
  }

  /** The refusal a restarted host owes a client holding the dead generation's
   *  fence: stale, with the live fence attached so the retry can succeed. */
  async function staleFenceFrom(held: number): Promise<number> {
    const refused = await host.attach(CALLER, ensureParams(held))
    if (refused.ok) {
      throw new Error('a fence from the previous host generation was accepted')
    }
    expect(refused.refusal.code).toBe('agent_session_checkpoint_stale')
    const current = refused.refusal.currentFence
    expect(current).toBeGreaterThan(held)
    return current ?? 0
  }

  it('adjudicates the leases it loaded before deciding who may write', async () => {
    const before = await attach()
    const held = before?.lease.runtimeFence ?? 0
    await reboot(async () => ({ outcome: 'pid-absent' }))

    const reattached = await host.attach(CALLER, ensureParams(await staleFenceFrom(held)))
    expect(reattached).toMatchObject({ ok: true })
    expect(store.getRecord(SESSION)?.lease.unreconciled).toBe(false)
    expect(store.getRecord(SESSION)?.lease.ownerProcess?.pid).toBe(4242)
  })

  it('restores durable journals for read-only history without acquiring a provider', async () => {
    await attach()
    const body = hostTestMessage('persisted conversation')
    await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
    await reboot(async () => ({ outcome: 'indeterminate', reason: 'read does not need ownership' }))
    acquire.mockClear()
    const listRecords = vi.spyOn(store, 'listRecords')

    await host.restoreReadableSessions()
    const restoreReads = listRecords.mock.calls.length
    await host.restoreReadableSessions()

    expect(host.listSessionTabs()).toEqual([
      { sessionId: SESSION, workspaceId: 'workspace-1', agent: 'codex' }
    ])
    const history = host.history({ sessionId: SESSION, direction: 'tail' })
    expect(history.ok && history.page.items).not.toHaveLength(0)
    expect(acquire).not.toHaveBeenCalled()
    expect(listRecords).toHaveBeenCalledTimes(restoreReads)
  })

  it('clears stale TUI recovery at restart, and reacquires the native owner when a surface holds it', async () => {
    await attach()
    await store.transitionHandoff(SESSION, (record) => ({
      ...record,
      lease: {
        ...record.lease,
        runtimeKind: 'tui',
        handoffStage: 'manual-recovery'
      }
    }))
    await reboot(async () => ({ outcome: 'pid-absent' }))
    acquire.mockClear()

    await host.restoreReadableSessions()
    // The recovery stage clears on evidence at startup; the child comes back only once a surface
    // holds the session (see structured-agent-session-surface-lifetime.test.ts).
    await host.hold(SESSION, 'surface-1')

    expect(acquire).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeKind: 'native',
      claimStatus: 'live',
      handoffStage: null,
      handoffOperationId: null
    })
    await expect(host.handoffStatus(SESSION)).resolves.toMatchObject({
      owner: 'native',
      phase: 'idle',
      stage: null
    })
  })

  it("keeps a session whose owner cannot be probed out of a live writer's hands", async () => {
    await attach()
    const held = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    await reboot(async () => ({ outcome: 'indeterminate', reason: 'no probe on this host' }))

    expect(await host.attach(CALLER, ensureParams(held))).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_ownership_unknown' }
    })
  })

  it('does not remember a failed adjudication as done', async () => {
    const before = await attach()
    const held = before?.lease.runtimeFence ?? 0
    const probe = vi
      .fn<(record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>>()
      .mockRejectedValueOnce(new Error('probe exploded'))
      .mockResolvedValue({ outcome: 'pid-absent' })
    await reboot(probe)

    await expect(host.attach(CALLER, ensureParams(held))).rejects.toThrow('probe exploded')
    const reattached = await host.attach(CALLER, ensureParams(await staleFenceFrom(held)))
    expect(reattached).toMatchObject({ ok: true })
    expect(probe).toHaveBeenCalledTimes(2)
  })
})

describe('subscribe', () => {
  it('opens with a snapshot and then streams cursor-qualified batches', async () => {
    await attach()
    const events: AgentSessionSubscribeEvent[] = []
    const dispose = host.subscribe({
      id: 'sub-1',
      sessionId: SESSION,
      emit: (event) => events.push(event)
    })
    const body = hostTestMessage('add a retry')
    await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })

    expect(events[0]?.type).toBe('snapshot')
    const batches = events.filter((event) => event.type === 'batch')
    expect(batches.length).toBeGreaterThan(0)
    const last = batches.at(-1)
    expect(last?.type === 'batch' && last.batch.cursor.sequence).toBeGreaterThan(0)

    dispose()
    expect(events.at(-1)?.type).toBe('end')
  })

  it('resumes from a client cursor with only the rows it missed', async () => {
    await attach()
    const body = hostTestMessage('add a retry')
    const first = await host.send(CALLER, {
      envelope: envelope('agentSession.send', { body }),
      body
    })
    if (!first.ok) {
      throw new Error(`expected a send, got ${first.refusal.code}`)
    }

    const events: AgentSessionSubscribeEvent[] = []
    host.subscribe({
      id: 'sub-2',
      sessionId: SESSION,
      emit: (event) => events.push(event),
      cursor: first.cursor
    })
    expect(events[0]).toMatchObject({ type: 'batch', handoff: { owner: 'native', phase: 'idle' } })

    const second = hostTestMessage('and a timeout')
    await host.send(CALLER, {
      envelope: envelope('agentSession.send', { body: second }),
      body: second
    })
    expect(events.some((event) => event.type === 'batch')).toBe(true)
    expect(events.some((event) => event.type === 'snapshot')).toBe(false)
  })

  it('drops a failed transport without aborting the mutation or other subscribers', async () => {
    await attach()
    const events: AgentSessionSubscribeEvent[] = []
    host.subscribe({
      id: 'dead-sub',
      sessionId: SESSION,
      emit: () => {
        throw new Error('socket closed')
      }
    })
    host.subscribe({
      id: 'live-sub',
      sessionId: SESSION,
      emit: (event) => events.push(event)
    })
    const body = hostTestMessage('survive subscriber failure')

    const result = await host.send(CALLER, {
      envelope: envelope('agentSession.send', { body }),
      body
    })

    expect(result).toMatchObject({ ok: true, value: { submission: { dispatchState: 'accepted' } } })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(events.some((event) => event.type === 'batch')).toBe(true)
  })

  it('resets a subscriber whose epoch is gone', async () => {
    await attach()
    const events: AgentSessionSubscribeEvent[] = []
    host.subscribe({
      id: 'sub-3',
      sessionId: SESSION,
      emit: (event) => events.push(event),
      cursor: { epoch: 'epoch-from-a-previous-life', sequence: 3 }
    })
    expect(events[0]).toMatchObject({ type: 'reset', reset: 'epoch_changed', fence: 1 })
  })

  it('publishes the replacement fence when the owner generation changes', async () => {
    const record = await attach()
    const events: AgentSessionSubscribeEvent[] = []
    host.subscribe({
      id: 'sub-4',
      sessionId: SESSION,
      emit: (event) => events.push(event)
    })
    const released = await store.evictProvenDeadOwner({
      sessionId: SESSION,
      expectedFence: record?.lease.runtimeFence ?? 1,
      probe: { outcome: 'pid-absent' },
      now: NOW
    })

    const replacement = await host.attach(CALLER, ensureParams(released.lease.runtimeFence))
    if (!replacement.ok) {
      throw new Error(`expected replacement owner, got ${replacement.refusal.code}`)
    }
    expect(events.at(-1)).toMatchObject({ type: 'snapshot', fence: replacement.fence })
  })
})
