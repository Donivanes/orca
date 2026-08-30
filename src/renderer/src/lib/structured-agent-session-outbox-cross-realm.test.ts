// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStructuredAgentSessionOutboxEntry } from '../../../shared/structured-agent-session-outbox'
import {
  appendStructuredAgentSessionOutboxEntry,
  mutateStructuredAgentSessionOutboxEntry,
  readStructuredAgentSessionOutbox,
  reconcileStructuredAgentSessionOutboxStorage,
  STRUCTURED_AGENT_SESSION_OUTBOX_MAX_AGGREGATE_BYTES,
  writeStructuredAgentSessionOutbox
} from './structured-agent-session-outbox-storage'

function entry(sessionId: string, index: number, queuedAt = 1) {
  return createStructuredAgentSessionOutboxEntry({
    clientMessageId: `1700000000000-${String(index).padStart(32, '0')}`,
    sessionId,
    text: `prompt ${index}`,
    attachments: [],
    queuedAt
  })
}

function rawStorageKey(sessionId: string): string {
  return `orca:desktopStructuredAgentSessionOutbox:v1:${encodeURIComponent(sessionId)}`
}

function rawMetadataKey(sessionId: string): string {
  return `orca:desktopStructuredAgentSessionOutboxMetadata:v1:${encodeURIComponent(sessionId)}`
}

const RAW_AGGREGATE_KEY = 'orca:desktopStructuredAgentSessionOutboxAggregate:v1'
const RAW_MUTATION_KEY = 'orca:desktopStructuredAgentSessionOutboxMutation:v1'

function interruptStorage(sessionId: string, entries: readonly unknown[]): void {
  const serialized = JSON.stringify(entries)
  localStorage.setItem(rawStorageKey(sessionId), serialized)
  localStorage.setItem(
    rawMetadataKey(sessionId),
    JSON.stringify({
      bytes: new TextEncoder().encode(serialized).byteLength,
      count: entries.length
    })
  )
  localStorage.setItem(RAW_AGGREGATE_KEY, JSON.stringify({ bytes: 0, count: 0 }))
  localStorage.setItem(RAW_MUTATION_KEY, 'dead-renderer:7')
}

describe('structured agent-session outbox cross-realm ownership', () => {
  beforeEach(() => localStorage.clear())

  it('retains the recovery fence when authoritative cleanup is interrupted', async () => {
    const first = 'codex_cleanup_interrupted_first'
    const second = 'codex_cleanup_interrupted_second'
    const next = 'codex_cleanup_interrupted_next'
    expect(await writeStructuredAgentSessionOutbox(first, [entry(first, 1, 100)], 100)).toBe(true)
    expect(await writeStructuredAgentSessionOutbox(second, [entry(second, 2, 100)], 100)).toBe(true)
    const backingStorage = localStorage
    let refusedRemoval = false
    const quotaStorage = {
      get length() {
        return backingStorage.length
      },
      clear: () => backingStorage.clear(),
      getItem: (key: string) => backingStorage.getItem(key),
      key: (index: number) => backingStorage.key(index),
      removeItem: (key: string) => {
        if (key === rawStorageKey(first) && !refusedRemoval) {
          refusedRemoval = true
          throw new DOMException('quota exceeded', 'QuotaExceededError')
        }
        backingStorage.removeItem(key)
      },
      setItem: (key: string, value: string) => backingStorage.setItem(key, value)
    } satisfies Storage
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: quotaStorage
    })
    try {
      await reconcileStructuredAgentSessionOutboxStorage([], 101)
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: backingStorage
      })
    }

    expect(localStorage.getItem(RAW_MUTATION_KEY)).not.toBeNull()
    expect(await writeStructuredAgentSessionOutbox(next, [entry(next, 3, 101)], 101)).toBe(true)
    expect(localStorage.getItem(RAW_MUTATION_KEY)).toBeNull()
    const retained = [first, second, next].filter(
      (sessionId) => localStorage.getItem(rawStorageKey(sessionId)) !== null
    )
    expect(JSON.parse(localStorage.getItem(RAW_AGGREGATE_KEY) ?? 'null')).toEqual({
      bytes: retained.reduce(
        (sum, sessionId) =>
          sum +
          new TextEncoder().encode(localStorage.getItem(rawStorageKey(sessionId))!).byteLength,
        0
      ),
      count: retained.length
    })
  })

  it('fences independent renderer realms before aggregate quota admission', async () => {
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
    let activeLocks = 0
    let maximumActiveLocks = 0
    let tail = Promise.resolve()
    const OUTBOX_LOCK_NAME = 'orca:desktopStructuredAgentSessionOutboxMutation:v1'
    const lockManager = {
      request: async <T>(
        _name: string,
        _options: LockOptions,
        callback: (lock: Lock | null) => T | PromiseLike<T>
      ): Promise<T> => {
        const previous = tail
        const release = Promise.withResolvers<void>()
        tail = previous.then(() => release.promise)
        await previous
        activeLocks += 1
        maximumActiveLocks = Math.max(maximumActiveLocks, activeLocks)
        try {
          return await callback({ name: OUTBOX_LOCK_NAME, mode: 'exclusive' } as Lock)
        } finally {
          activeLocks -= 1
          release.resolve()
        }
      }
    }
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: lockManager as LockManager
    })
    try {
      vi.resetModules()
      const secondRealm = await import('./structured-agent-session-outbox-storage')
      expect(secondRealm.writeStructuredAgentSessionOutbox).not.toBe(
        writeStructuredAgentSessionOutbox
      )
      const prompt = 'x'.repeat(
        Math.floor(STRUCTURED_AGENT_SESSION_OUTBOX_MAX_AGGREGATE_BYTES / 14)
      )
      for (let index = 0; index < 12; index += 1) {
        const sessionId = `codex_cross_realm_base_${index}`
        expect(
          await writeStructuredAgentSessionOutbox(
            sessionId,
            [
              createStructuredAgentSessionOutboxEntry({
                clientMessageId: `1700000000000-${String(index).padStart(32, '0')}`,
                sessionId,
                text: prompt,
                attachments: [],
                queuedAt: 100
              })
            ],
            100
          )
        ).toBe(true)
      }
      const candidate = (sessionId: string, digit: string) => [
        createStructuredAgentSessionOutboxEntry({
          clientMessageId: `1700000000000-${digit.repeat(32)}`,
          sessionId,
          text: prompt,
          attachments: [],
          queuedAt: 100
        })
      ]
      const firstSession = 'codex_cross_realm_first'
      const secondSession = 'codex_cross_realm_second'

      const [firstResult, secondResult] = await Promise.all([
        writeStructuredAgentSessionOutbox(firstSession, candidate(firstSession, 'a'), 100),
        secondRealm.writeStructuredAgentSessionOutbox(
          secondSession,
          candidate(secondSession, 'b'),
          100
        )
      ])

      expect([firstResult, secondResult].filter(Boolean)).toHaveLength(1)
      expect(maximumActiveLocks).toBe(1)
      const aggregate = JSON.parse(localStorage.getItem(RAW_AGGREGATE_KEY) ?? 'null') as {
        bytes: number
        count: number
      }
      expect(aggregate.bytes).toBeLessThanOrEqual(
        STRUCTURED_AGENT_SESSION_OUTBOX_MAX_AGGREGATE_BYTES
      )
      expect(aggregate.count).toBe(13)
    } finally {
      if (originalLocks) {
        Object.defineProperty(navigator, 'locks', originalLocks)
      } else {
        Reflect.deleteProperty(navigator, 'locks')
      }
    }
  })

  it('merges same-session appends from independent renderer owners', async () => {
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
    let tail = Promise.resolve()
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async <T>(
          name: string,
          _options: LockOptions,
          callback: (lock: Lock | null) => T | PromiseLike<T>
        ): Promise<T> => {
          const previous = tail
          const release = Promise.withResolvers<void>()
          tail = previous.then(() => release.promise)
          await previous
          try {
            return await callback({ name, mode: 'exclusive' } as Lock)
          } finally {
            release.resolve()
          }
        }
      } as LockManager
    })
    try {
      vi.resetModules()
      const secondRealm = await import('./structured-agent-session-outbox-storage')
      const sessionId = 'codex_cross_realm_same_session'
      const firstEntry = entry(sessionId, 1, 100)
      const secondEntry = entry(sessionId, 2, 100)

      const [firstResult, secondResult] = await Promise.all([
        appendStructuredAgentSessionOutboxEntry(sessionId, firstEntry, 100),
        secondRealm.appendStructuredAgentSessionOutboxEntry(sessionId, secondEntry, 100)
      ])

      expect(firstResult.saved).toBe(true)
      expect(secondResult.saved).toBe(true)
      expect(
        readStructuredAgentSessionOutbox(sessionId, 100).map((item) => item.clientMessageId)
      ).toEqual([firstEntry.clientMessageId, secondEntry.clientMessageId])
    } finally {
      if (originalLocks) {
        Object.defineProperty(navigator, 'locks', originalLocks)
      } else {
        Reflect.deleteProperty(navigator, 'locks')
      }
    }
  })

  it('merges independent same-session settlement operations without resurrection', async () => {
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
    let tail = Promise.resolve()
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async <T>(
          name: string,
          _options: LockOptions,
          callback: (lock: Lock | null) => T | PromiseLike<T>
        ): Promise<T> => {
          const previous = tail
          const release = Promise.withResolvers<void>()
          tail = previous.then(() => release.promise)
          await previous
          try {
            return await callback({ name, mode: 'exclusive' } as Lock)
          } finally {
            release.resolve()
          }
        }
      } as LockManager
    })
    try {
      vi.resetModules()
      const secondRealm = await import('./structured-agent-session-outbox-storage')
      const sessionId = 'codex_cross_realm_same_session_settlement'
      const firstEntry = entry(sessionId, 1, 100)
      const secondEntry = entry(sessionId, 2, 100)
      expect(
        (await appendStructuredAgentSessionOutboxEntry(sessionId, firstEntry, 100)).saved
      ).toBe(true)
      expect(
        (await appendStructuredAgentSessionOutboxEntry(sessionId, secondEntry, 100)).saved
      ).toBe(true)

      const [updated, removed] = await Promise.all([
        mutateStructuredAgentSessionOutboxEntry(
          sessionId,
          firstEntry.clientMessageId,
          (current) => ({ ...current, state: 'unconfirmed' }),
          100
        ),
        secondRealm.mutateStructuredAgentSessionOutboxEntry(
          sessionId,
          secondEntry.clientMessageId,
          () => null,
          100
        )
      ])

      expect(updated.saved).toBe(true)
      expect(removed.saved).toBe(true)
      expect(secondRealm.readStructuredAgentSessionOutbox(sessionId, 100)).toEqual([
        { ...firstEntry, state: 'unconfirmed' }
      ])
      vi.resetModules()
      const reloadedRealm = await import('./structured-agent-session-outbox-storage')
      expect(reloadedRealm.readStructuredAgentSessionOutbox(sessionId, 100)).toEqual([
        { ...firstEntry, state: 'unconfirmed' }
      ])
    } finally {
      if (originalLocks) {
        Object.defineProperty(navigator, 'locks', originalLocks)
      } else {
        Reflect.deleteProperty(navigator, 'locks')
      }
    }
  })

  it('re-reads deferred maintenance after an independent renderer appends', async () => {
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
    const sessionId = 'codex_deferred_maintenance_append'
    const first = { ...entry(sessionId, 1, 100), state: 'dispatching' as const }
    const serialized = JSON.stringify([first])
    localStorage.setItem(rawStorageKey(sessionId), serialized)
    localStorage.setItem(
      rawMetadataKey(sessionId),
      JSON.stringify({ bytes: new TextEncoder().encode(serialized).byteLength, count: 1 })
    )
    localStorage.setItem(
      RAW_AGGREGATE_KEY,
      JSON.stringify({ bytes: new TextEncoder().encode(serialized).byteLength, count: 1 })
    )
    let releaseMaintenance!: () => void
    let lockCalls = 0
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: <T>(
          _name: string,
          _options: LockOptions,
          callback: (lock: Lock | null) => T | PromiseLike<T>
        ): Promise<T> => {
          lockCalls += 1
          if (lockCalls === 1) {
            return new Promise<T>((resolve) => {
              releaseMaintenance = () => resolve(callback({} as Lock))
            })
          }
          return Promise.resolve(callback({} as Lock))
        }
      } as LockManager
    })
    try {
      expect(readStructuredAgentSessionOutbox(sessionId, 100)).toEqual([
        { ...first, state: 'unconfirmed' }
      ])
      vi.resetModules()
      const secondRealm = await import('./structured-agent-session-outbox-storage')
      const second = entry(sessionId, 2, 100)
      await expect(
        secondRealm.appendStructuredAgentSessionOutboxEntry(sessionId, second, 100)
      ).resolves.toMatchObject({ saved: true })
      releaseMaintenance()
      await vi.waitFor(() =>
        expect(readStructuredAgentSessionOutbox(sessionId, 100)).toEqual([
          { ...first, state: 'unconfirmed' },
          second
        ])
      )
    } finally {
      if (originalLocks) {
        Object.defineProperty(navigator, 'locks', originalLocks)
      } else {
        Reflect.deleteProperty(navigator, 'locks')
      }
    }
  })

  it('does not resurrect a settled entry after deferred maintenance waits', async () => {
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
    const sessionId = 'codex_deferred_maintenance_settlement'
    const first = { ...entry(sessionId, 1, 100), state: 'dispatching' as const }
    const serialized = JSON.stringify([first])
    localStorage.setItem(rawStorageKey(sessionId), serialized)
    localStorage.setItem(
      rawMetadataKey(sessionId),
      JSON.stringify({ bytes: new TextEncoder().encode(serialized).byteLength, count: 1 })
    )
    localStorage.setItem(
      RAW_AGGREGATE_KEY,
      JSON.stringify({ bytes: new TextEncoder().encode(serialized).byteLength, count: 1 })
    )
    let releaseMaintenance!: () => void
    let lockCalls = 0
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: <T>(
          _name: string,
          _options: LockOptions,
          callback: (lock: Lock | null) => T | PromiseLike<T>
        ): Promise<T> => {
          lockCalls += 1
          if (lockCalls === 1) {
            return new Promise<T>((resolve) => {
              releaseMaintenance = () => resolve(callback({} as Lock))
            })
          }
          return Promise.resolve(callback({} as Lock))
        }
      } as LockManager
    })
    try {
      expect(readStructuredAgentSessionOutbox(sessionId, 100)).toHaveLength(1)
      vi.resetModules()
      const secondRealm = await import('./structured-agent-session-outbox-storage')
      await expect(
        secondRealm.mutateStructuredAgentSessionOutboxEntry(
          sessionId,
          first.clientMessageId,
          () => null,
          100
        )
      ).resolves.toMatchObject({ saved: true, matched: true })
      releaseMaintenance()
      await vi.waitFor(() => expect(readStructuredAgentSessionOutbox(sessionId, 100)).toEqual([]))
    } finally {
      if (originalLocks) {
        Object.defineProperty(navigator, 'locks', originalLocks)
      } else {
        Reflect.deleteProperty(navigator, 'locks')
      }
    }
  })

  it('preserves a concurrent retry marker during deferred recovery', async () => {
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
    const sessionId = 'codex_deferred_maintenance_retry'
    const first = {
      ...entry(sessionId, 1, 100),
      state: 'dispatching' as const,
      retryAfterUnknownSubmittedAt: 200
    }
    const serialized = JSON.stringify([first])
    localStorage.setItem(rawStorageKey(sessionId), serialized)
    localStorage.setItem(
      rawMetadataKey(sessionId),
      JSON.stringify({ bytes: new TextEncoder().encode(serialized).byteLength, count: 1 })
    )
    localStorage.setItem(
      RAW_AGGREGATE_KEY,
      JSON.stringify({ bytes: new TextEncoder().encode(serialized).byteLength, count: 1 })
    )
    let releaseMaintenance!: () => void
    let lockCalls = 0
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: <T>(
          _name: string,
          _options: LockOptions,
          callback: (lock: Lock | null) => T | PromiseLike<T>
        ): Promise<T> => {
          lockCalls += 1
          if (lockCalls === 1) {
            return new Promise<T>((resolve) => {
              releaseMaintenance = () => resolve(callback({} as Lock))
            })
          }
          return Promise.resolve(callback({} as Lock))
        }
      } as LockManager
    })
    try {
      expect(readStructuredAgentSessionOutbox(sessionId, 100)).toHaveLength(1)
      vi.resetModules()
      const secondRealm = await import('./structured-agent-session-outbox-storage')
      const retried = { ...first, state: 'queued' as const, retryAfterUnknownSubmittedAt: 300 }
      await expect(
        secondRealm.writeStructuredAgentSessionOutbox(sessionId, [retried], 100)
      ).resolves.toBe(true)
      releaseMaintenance()
      await vi.waitFor(() =>
        expect(readStructuredAgentSessionOutbox(sessionId, 100)).toEqual([retried])
      )
    } finally {
      if (originalLocks) {
        Object.defineProperty(navigator, 'locks', originalLocks)
      } else {
        Reflect.deleteProperty(navigator, 'locks')
      }
    }
  })

  it('repairs interrupted accounting before a same-session append reads', async () => {
    const sessionId = 'codex_interrupted_append'
    const first = { ...entry(sessionId, 1, 100), state: 'dispatching' as const }
    interruptStorage(sessionId, [first])
    vi.resetModules()
    const secondRealm = await import('./structured-agent-session-outbox-storage')
    const second = entry(sessionId, 2, 100)

    await expect(
      secondRealm.appendStructuredAgentSessionOutboxEntry(sessionId, second, 100)
    ).resolves.toMatchObject({ saved: true })
    expect(secondRealm.readStructuredAgentSessionOutbox(sessionId, 100)).toEqual([
      { ...first, state: 'unconfirmed' },
      second
    ])
  })

  it('repairs interrupted accounting before a settlement reads the session', async () => {
    const sessionId = 'codex_interrupted_settlement'
    const first = { ...entry(sessionId, 1, 100), state: 'dispatching' as const }
    const second = entry(sessionId, 2, 100)
    interruptStorage(sessionId, [first, second])
    vi.resetModules()
    const secondRealm = await import('./structured-agent-session-outbox-storage')

    await expect(
      secondRealm.mutateStructuredAgentSessionOutboxEntry(
        sessionId,
        second.clientMessageId,
        () => null,
        100
      )
    ).resolves.toMatchObject({ saved: true, matched: true })
    expect(secondRealm.readStructuredAgentSessionOutbox(sessionId, 100)).toEqual([
      { ...first, state: 'unconfirmed' }
    ])
  })

  it('repairs interrupted accounting before a retry-marker transition reads', async () => {
    const sessionId = 'codex_interrupted_retry'
    const first = {
      ...entry(sessionId, 1, 100),
      state: 'dispatching' as const,
      retryAfterUnknownSubmittedAt: 200
    }
    interruptStorage(sessionId, [first])
    vi.resetModules()
    const secondRealm = await import('./structured-agent-session-outbox-storage')
    const retried = { ...first, retryAfterUnknownSubmittedAt: 300 }

    await expect(
      secondRealm.mutateStructuredAgentSessionOutboxEntry(
        sessionId,
        first.clientMessageId,
        (current) => ({ ...current, retryAfterUnknownSubmittedAt: 300 }),
        100
      )
    ).resolves.toMatchObject({ saved: true, matched: true })
    expect(secondRealm.readStructuredAgentSessionOutbox(sessionId, 100)).toEqual([
      { ...retried, state: 'unconfirmed' }
    ])
  })
})
