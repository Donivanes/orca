// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'

const mocks = vi.hoisted(() => ({ reconcile: vi.fn() }))

vi.mock('@/lib/structured-agent-session-outbox-storage', () => ({
  reconcileStructuredAgentSessionOutboxStorage: mocks.reconcile
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(vi.fn(), { getState: vi.fn() })
}))

vi.mock('./web-session-tabs-sync', () => ({
  applyWebSessionTabsSnapshot: vi.fn(),
  applyWebSessionTabsStorePatch: vi.fn(() => () => undefined),
  decideWebSessionTabsSnapshot: vi.fn(() => ({ apply: false }))
}))

import {
  refreshLocalStructuredSessionTabs,
  reconcileLocalStructuredSessionOutboxEvent,
  resetLocalStructuredSessionOutboxInventoryForTests
} from './local-structured-session-tabs-sync'

function snapshot(worktree: string, sessionId: string): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [
      {
        type: 'agent-session',
        id: `tab-${sessionId}`,
        title: 'Codex',
        sessionId,
        agent: 'codex',
        isActive: false
      }
    ]
  }
}

describe('local structured-session outbox live cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetLocalStructuredSessionOutboxInventoryForTests()
  })

  it('reconciles quota on authoritative snapshots, updates, and removals', () => {
    reconcileLocalStructuredSessionOutboxEvent({
      type: 'snapshots',
      authoritative: true,
      snapshots: [snapshot('wt-a', 'session-a'), snapshot('wt-b', 'session-b')]
    })
    expect(mocks.reconcile).toHaveBeenLastCalledWith(['session-a', 'session-b'])

    reconcileLocalStructuredSessionOutboxEvent({
      type: 'updated',
      ...snapshot('wt-a', 'session-a-next')
    })
    expect(mocks.reconcile).toHaveBeenLastCalledWith(['session-a-next', 'session-b'])

    reconcileLocalStructuredSessionOutboxEvent({
      type: 'updated',
      ...snapshot('wt-a', 'session-a-next')
    })
    expect(mocks.reconcile).toHaveBeenCalledTimes(2)

    reconcileLocalStructuredSessionOutboxEvent({
      type: 'updated',
      ...snapshot('wt-b', 'session-b'),
      removed: true,
      tabs: []
    })
    expect(mocks.reconcile).toHaveBeenLastCalledWith(['session-a-next'])
  })

  it('does not treat an unlabeled reload census as authoritative', () => {
    reconcileLocalStructuredSessionOutboxEvent({
      type: 'snapshots',
      snapshots: [snapshot('wt-a', 'session-a')]
    })
    expect(mocks.reconcile).not.toHaveBeenCalled()

    reconcileLocalStructuredSessionOutboxEvent({
      type: 'updated',
      ...snapshot('wt-b', 'session-b')
    })
    reconcileLocalStructuredSessionOutboxEvent({
      type: 'updated',
      ...snapshot('wt-a', 'session-a'),
      removed: true,
      tabs: []
    })
    expect(mocks.reconcile).not.toHaveBeenCalled()

    reconcileLocalStructuredSessionOutboxEvent({
      type: 'snapshots',
      authoritative: true,
      snapshots: [snapshot('wt-b', 'session-b')]
    })
    expect(mocks.reconcile).toHaveBeenLastCalledWith(['session-b'])
  })

  it('preserves known live sessions across later incomplete inventories', () => {
    reconcileLocalStructuredSessionOutboxEvent({
      type: 'snapshots',
      authoritative: true,
      snapshots: [snapshot('wt-a', 'session-a'), snapshot('wt-b', 'session-b')]
    })
    mocks.reconcile.mockClear()

    reconcileLocalStructuredSessionOutboxEvent({
      type: 'snapshots',
      snapshots: [snapshot('wt-a', 'session-a')]
    })
    expect(mocks.reconcile).not.toHaveBeenCalled()

    reconcileLocalStructuredSessionOutboxEvent({
      type: 'updated',
      ...snapshot('wt-a', 'session-a-next')
    })
    expect(mocks.reconcile).toHaveBeenLastCalledWith(['session-a-next', 'session-b'])
  })

  it('preserves reload outboxes when listAll returns an unlabeled census', async () => {
    reconcileLocalStructuredSessionOutboxEvent({
      type: 'snapshots',
      authoritative: true,
      snapshots: [snapshot('wt-live', 'session-live')]
    })
    mocks.reconcile.mockClear()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        runtime: {
          call: vi.fn(async () => ({ ok: true, result: { snapshots: [] } }))
        }
      }
    })

    await expect(refreshLocalStructuredSessionTabs()).resolves.toEqual([])
    expect(mocks.reconcile).not.toHaveBeenCalled()
  })
})
