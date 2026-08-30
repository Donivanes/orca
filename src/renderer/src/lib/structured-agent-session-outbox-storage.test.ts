// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStructuredAgentSessionOutboxEntry } from '../../../shared/structured-agent-session-outbox'
import {
  enqueueStructuredAgentSessionLaunchPrompt,
  readStructuredAgentSessionOutbox,
  reconcileStructuredAgentSessionOutboxStorage,
  protectStructuredAgentSessionLaunchOutbox,
  releaseStructuredAgentSessionLaunchOutbox,
  STRUCTURED_AGENT_SESSION_OUTBOX_MAX_AGGREGATE_BYTES,
  STRUCTURED_AGENT_SESSION_OUTBOX_MAX_ENTRIES,
  STRUCTURED_AGENT_SESSION_OUTBOX_MAX_ENTRY_BYTES,
  STRUCTURED_AGENT_SESSION_OUTBOX_TTL_MS,
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

describe('structured agent-session outbox storage', () => {
  beforeEach(() => localStorage.clear())

  it('refuses per-session count and payload overflow without overwriting source entries', async () => {
    const sessionId = 'codex_bounded_session'
    const first = entry(sessionId, 1, 100)
    expect(await writeStructuredAgentSessionOutbox(sessionId, [first], 100)).toBe(true)
    expect(
      await writeStructuredAgentSessionOutbox(
        sessionId,
        Array.from({ length: STRUCTURED_AGENT_SESSION_OUTBOX_MAX_ENTRIES + 1 }, (_, index) =>
          entry(sessionId, index + 2, 100)
        ),
        100
      )
    ).toBe(false)
    expect(
      await enqueueStructuredAgentSessionLaunchPrompt(
        'codex_oversize_session',
        'x'.repeat(STRUCTURED_AGENT_SESSION_OUTBOX_MAX_ENTRY_BYTES),
        100
      )
    ).toBeNull()
    expect(readStructuredAgentSessionOutbox(sessionId, 100)).toEqual([first])
  })

  it('preserves the prior durable outbox when the payload write is refused', async () => {
    const sessionId = 'codex_quota_refusal'
    const first = entry(sessionId, 1, 100)
    expect(await writeStructuredAgentSessionOutbox(sessionId, [first], 100)).toBe(true)
    const originalSetItem = localStorage.setItem.bind(localStorage)
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === rawStorageKey(sessionId)) {
        throw new DOMException('quota exceeded', 'QuotaExceededError')
      }
      return originalSetItem(key, value)
    })

    expect(
      await writeStructuredAgentSessionOutbox(sessionId, [first, entry(sessionId, 2, 100)], 100)
    ).toBe(false)
    expect(readStructuredAgentSessionOutbox(sessionId, 100)).toEqual([first])
  })

  it('expires old entries and removes outboxes for sessions absent from host inventory', async () => {
    const active = 'codex_active_session'
    const orphan = 'codex_orphan_session'
    expect(await writeStructuredAgentSessionOutbox(active, [entry(active, 1, 100)], 100)).toBe(true)
    expect(await writeStructuredAgentSessionOutbox(orphan, [entry(orphan, 2, 100)], 100)).toBe(true)

    await reconcileStructuredAgentSessionOutboxStorage([active], 101)
    expect(readStructuredAgentSessionOutbox(active, 101)).toHaveLength(1)
    expect(readStructuredAgentSessionOutbox(orphan, 101)).toEqual([])
    expect(JSON.parse(localStorage.getItem(RAW_AGGREGATE_KEY) ?? 'null')).toMatchObject({
      count: 1
    })
    expect(
      readStructuredAgentSessionOutbox(active, 100 + STRUCTURED_AGENT_SESSION_OUTBOX_TTL_MS + 1)
    ).toEqual([])
    await vi.waitFor(() =>
      expect(JSON.parse(localStorage.getItem(RAW_AGGREGATE_KEY) ?? 'null')).toEqual({
        bytes: 0,
        count: 0
      })
    )
  })

  it('bounds aggregate storage and protects only an active unpublished launch', async () => {
    const prompt = 'x'.repeat(Math.floor(STRUCTURED_AGENT_SESSION_OUTBOX_MAX_AGGREGATE_BYTES / 14))
    for (let index = 0; index < 13; index += 1) {
      const sessionId = `codex_aggregate_${index}`
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
    const overflow = 'codex_aggregate_overflow'
    expect(
      await writeStructuredAgentSessionOutbox(
        overflow,
        [
          createStructuredAgentSessionOutboxEntry({
            clientMessageId: '1700000000000-ffffffffffffffffffffffffffffffff',
            sessionId: overflow,
            text: prompt,
            attachments: [],
            queuedAt: 100
          })
        ],
        100
      )
    ).toBe(false)

    const staged = 'codex_staged_launch'
    expect(await writeStructuredAgentSessionOutbox(staged, [entry(staged, 1, 100)], 100)).toBe(true)
    protectStructuredAgentSessionLaunchOutbox(staged)
    await reconcileStructuredAgentSessionOutboxStorage([], 101)
    expect(readStructuredAgentSessionOutbox(staged, 101)).toHaveLength(1)
    releaseStructuredAgentSessionLaunchOutbox(staged)
    await reconcileStructuredAgentSessionOutboxStorage([], 102)
    expect(readStructuredAgentSessionOutbox(staged, 102)).toEqual([])
  })

  it('persists pending launch protection across renderer realms until live publication', async () => {
    const sessionId = 'codex_cross_realm_pending_launch'
    protectStructuredAgentSessionLaunchOutbox(sessionId)
    expect(
      await enqueueStructuredAgentSessionLaunchPrompt(sessionId, 'review this', 100)
    ).not.toBeNull()

    vi.resetModules()
    const reloadedRealm = await import('./structured-agent-session-outbox-storage')
    await reloadedRealm.reconcileStructuredAgentSessionOutboxStorage([], 101)
    expect(reloadedRealm.readStructuredAgentSessionOutbox(sessionId, 101)).toHaveLength(1)

    await reloadedRealm.reconcileStructuredAgentSessionOutboxStorage([sessionId], 102)
    await reloadedRealm.reconcileStructuredAgentSessionOutboxStorage([], 103)
    expect(reloadedRealm.readStructuredAgentSessionOutbox(sessionId, 103)).toEqual([])
    releaseStructuredAgentSessionLaunchOutbox(sessionId)
  })

  it('preserves every valid pending v1 entry from an earlier unbounded writer', () => {
    const sessionId = 'codex_legacy_count'
    const legacy = Array.from(
      { length: STRUCTURED_AGENT_SESSION_OUTBOX_MAX_ENTRIES + 1 },
      (_, index) => entry(sessionId, index + 1, 100)
    )
    localStorage.setItem(rawStorageKey(sessionId), JSON.stringify(legacy))

    expect(readStructuredAgentSessionOutbox(sessionId, 100)).toEqual(legacy)
  })

  it('allows legacy aggregate overflow to shrink before it reaches the current cap', async () => {
    const prompt = 'x'.repeat(280 * 1024)
    for (let index = 0; index < 15; index += 1) {
      const sessionId = `codex_legacy_aggregate_${index}`
      localStorage.setItem(
        rawStorageKey(sessionId),
        JSON.stringify([
          createStructuredAgentSessionOutboxEntry({
            clientMessageId: `1700000000000-${String(index).padStart(32, '0')}`,
            sessionId,
            text: prompt,
            attachments: [],
            queuedAt: 100
          })
        ])
      )
    }
    const shrinking = 'codex_legacy_shrinking'
    const current = [
      createStructuredAgentSessionOutboxEntry({
        clientMessageId: '1700000000000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        sessionId: shrinking,
        text: 'a'.repeat(140 * 1024),
        attachments: [],
        queuedAt: 100
      }),
      createStructuredAgentSessionOutboxEntry({
        clientMessageId: '1700000000000-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        sessionId: shrinking,
        text: 'b'.repeat(140 * 1024),
        attachments: [],
        queuedAt: 100
      })
    ]
    localStorage.setItem(rawStorageKey(shrinking), JSON.stringify(current))

    expect(
      await writeStructuredAgentSessionOutbox(
        shrinking,
        [{ ...current[0], state: 'dispatching', lastAttemptAt: 100 }, current[1]],
        100
      )
    ).toBe(true)
    expect(await writeStructuredAgentSessionOutbox(shrinking, current.slice(1), 100)).toBe(true)
    expect(readStructuredAgentSessionOutbox(shrinking, 100)).toEqual(current.slice(1))
  })

  it('touches no unrelated payload while updating one indexed outbox', async () => {
    const first = 'codex_perf_first'
    const second = 'codex_perf_second'
    const third = 'codex_perf_third'
    expect(await writeStructuredAgentSessionOutbox(first, [entry(first, 1, 100)], 100)).toBe(true)
    expect(await writeStructuredAgentSessionOutbox(second, [entry(second, 2, 100)], 100)).toBe(true)
    expect(await writeStructuredAgentSessionOutbox(third, [entry(third, 3, 100)], 100)).toBe(true)
    const backingStorage = localStorage
    const readKeys: string[] = []
    const writtenKeys: string[] = []
    let enumeratedKeys = 0
    const countingStorage = {
      get length() {
        return backingStorage.length
      },
      clear: () => backingStorage.clear(),
      getItem: (key: string) => {
        readKeys.push(key)
        return backingStorage.getItem(key)
      },
      key: (index: number) => {
        enumeratedKeys += 1
        return backingStorage.key(index)
      },
      removeItem: (key: string) => backingStorage.removeItem(key),
      setItem: (key: string, value: string) => {
        writtenKeys.push(key)
        backingStorage.setItem(key, value)
      }
    } satisfies Storage
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: countingStorage
    })
    let result = false
    try {
      result = await writeStructuredAgentSessionOutbox(
        second,
        [{ ...entry(second, 2, 100), state: 'unconfirmed' }],
        101
      )
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: backingStorage
      })
    }

    expect(result).toBe(true)
    expect(enumeratedKeys).toBe(0)
    expect(readKeys).not.toContain(rawStorageKey(first))
    expect(readKeys).not.toContain(rawStorageKey(third))
    expect(writtenKeys).not.toContain(rawStorageKey(first))
    expect(writtenKeys).not.toContain(rawStorageKey(third))
  })

  it('keeps a cold renderer write bounded to the touched session metadata', async () => {
    const first = 'codex_cold_perf_first'
    const second = 'codex_cold_perf_second'
    expect(await writeStructuredAgentSessionOutbox(first, [entry(first, 1, 100)], 100)).toBe(true)
    expect(await writeStructuredAgentSessionOutbox(second, [entry(second, 2, 100)], 100)).toBe(true)
    vi.resetModules()
    const coldRealm = await import('./structured-agent-session-outbox-storage')
    const backingStorage = localStorage
    const readKeys: string[] = []
    const writtenKeys: string[] = []
    let enumeratedKeys = 0
    const countingStorage = {
      get length() {
        return backingStorage.length
      },
      clear: () => backingStorage.clear(),
      getItem: (key: string) => {
        readKeys.push(key)
        return backingStorage.getItem(key)
      },
      key: (index: number) => {
        enumeratedKeys += 1
        return backingStorage.key(index)
      },
      removeItem: (key: string) => backingStorage.removeItem(key),
      setItem: (key: string, value: string) => {
        writtenKeys.push(key)
        backingStorage.setItem(key, value)
      }
    } satisfies Storage
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: countingStorage
    })
    try {
      expect(
        await coldRealm.writeStructuredAgentSessionOutbox(
          second,
          [{ ...entry(second, 2, 100), state: 'unconfirmed' }],
          101
        )
      ).toBe(true)
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: backingStorage
      })
    }

    expect(enumeratedKeys).toBe(0)
    expect(readKeys).not.toContain(rawStorageKey(first))
    expect(writtenKeys).not.toContain(rawStorageKey(first))
    expect(readKeys.length).toBeLessThanOrEqual(8)
    expect(writtenKeys.length).toBeLessThanOrEqual(4)
  })

  it('keeps a fenced external renderer publication on the bounded index path', async () => {
    const first = 'codex_external_perf_first'
    const second = 'codex_external_perf_second'
    const third = 'codex_external_perf_third'
    expect(await writeStructuredAgentSessionOutbox(first, [entry(first, 1, 100)], 100)).toBe(true)
    vi.resetModules()
    const secondRealm = await import('./structured-agent-session-outbox-storage')
    expect(
      await secondRealm.writeStructuredAgentSessionOutbox(second, [entry(second, 2, 100)], 100)
    ).toBe(true)
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: rawStorageKey(second),
        newValue: localStorage.getItem(rawStorageKey(second))
      })
    )
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: RAW_AGGREGATE_KEY,
        newValue: localStorage.getItem(RAW_AGGREGATE_KEY)
      })
    )
    const key = vi.spyOn(localStorage, 'key')

    expect(await writeStructuredAgentSessionOutbox(third, [entry(third, 3, 100)], 100)).toBe(true)
    expect(key).not.toHaveBeenCalled()
  })

  it('serializes deterministic writes to different sessions before publishing accounting', async () => {
    const first = 'codex_concurrent_first'
    const second = 'codex_concurrent_second'
    const firstEntries = [entry(first, 1, 100)]
    const secondEntries = [entry(second, 2, 100), entry(second, 3, 100)]
    const backingStorage = localStorage
    let interleaved = false
    let secondResult: Promise<boolean> | undefined
    const interleavingStorage = {
      get length() {
        return backingStorage.length
      },
      clear: () => backingStorage.clear(),
      getItem: (key: string) => backingStorage.getItem(key),
      key: (index: number) => backingStorage.key(index),
      removeItem: (key: string) => backingStorage.removeItem(key),
      setItem: (key: string, value: string) => {
        if (key === rawStorageKey(first) && !interleaved) {
          interleaved = true
          secondResult = writeStructuredAgentSessionOutbox(second, secondEntries, 100)
        }
        backingStorage.setItem(key, value)
      }
    } satisfies Storage
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: interleavingStorage
    })

    let firstResult = false
    let retained: string[] = []
    let aggregate = { bytes: -1, count: -1 }
    let retainedBytes = -1
    let retainedCount = -1
    try {
      firstResult = await writeStructuredAgentSessionOutbox(first, firstEntries, 100)
      await secondResult
      retained = [first, second].filter(
        (sessionId) => localStorage.getItem(rawStorageKey(sessionId)) !== null
      )
      aggregate = JSON.parse(localStorage.getItem(RAW_AGGREGATE_KEY) ?? 'null') as {
        bytes: number
        count: number
      }
      retainedBytes = retained.reduce(
        (sum, sessionId) =>
          sum +
          new TextEncoder().encode(localStorage.getItem(rawStorageKey(sessionId))!).byteLength,
        0
      )
      retainedCount = retained.reduce(
        (sum, sessionId) =>
          sum +
          (JSON.parse(localStorage.getItem(rawStorageKey(sessionId)) ?? '[]') as unknown[]).length,
        0
      )
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: backingStorage
      })
    }

    expect(interleaved).toBe(true)
    expect([firstResult, await secondResult].filter(Boolean)).toHaveLength(retained.length)
    expect(aggregate).toEqual({ bytes: retainedBytes, count: retainedCount })
  })

  it('does not let concurrent admission bypass the aggregate byte cap', async () => {
    const prompt = 'x'.repeat(Math.floor(STRUCTURED_AGENT_SESSION_OUTBOX_MAX_AGGREGATE_BYTES / 14))
    for (let index = 0; index < 12; index += 1) {
      const sessionId = `codex_quota_base_${index}`
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
    const first = 'codex_quota_concurrent_first'
    const second = 'codex_quota_concurrent_second'
    const candidate = (sessionId: string, id: string) => [
      createStructuredAgentSessionOutboxEntry({
        clientMessageId: `1700000000000-${id.repeat(32)}`,
        sessionId,
        text: prompt,
        attachments: [],
        queuedAt: 100
      })
    ]
    const backingStorage = localStorage
    let secondResult: Promise<boolean> | undefined
    let interleaved = false
    const interleavingStorage = {
      get length() {
        return backingStorage.length
      },
      clear: () => backingStorage.clear(),
      getItem: (key: string) => backingStorage.getItem(key),
      key: (index: number) => backingStorage.key(index),
      removeItem: (key: string) => backingStorage.removeItem(key),
      setItem: (key: string, value: string) => {
        if (key === rawStorageKey(first) && !interleaved) {
          interleaved = true
          secondResult = writeStructuredAgentSessionOutbox(second, candidate(second, 'b'), 100)
        }
        backingStorage.setItem(key, value)
      }
    } satisfies Storage
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: interleavingStorage
    })
    let firstResult = false
    try {
      firstResult = await writeStructuredAgentSessionOutbox(first, candidate(first, 'a'), 100)
      await secondResult
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: backingStorage
      })
    }

    const aggregate = JSON.parse(localStorage.getItem(RAW_AGGREGATE_KEY) ?? 'null') as {
      bytes: number
      count: number
    }
    const retainedCandidates = [first, second].filter(
      (sessionId) => localStorage.getItem(rawStorageKey(sessionId)) !== null
    )
    expect(interleaved).toBe(true)
    expect([firstResult, await secondResult].filter(Boolean)).toHaveLength(
      retainedCandidates.length
    )
    expect(aggregate.bytes).toBeLessThanOrEqual(STRUCTURED_AGENT_SESSION_OUTBOX_MAX_AGGREGATE_BYTES)
  })

  it('repairs externally stale aggregate metadata before admitting another payload', async () => {
    const first = 'codex_stale_first'
    const second = 'codex_stale_second'
    const third = 'codex_stale_third'
    expect(await writeStructuredAgentSessionOutbox(first, [entry(first, 1, 100)], 100)).toBe(true)
    expect(await writeStructuredAgentSessionOutbox(second, [entry(second, 2, 100)], 100)).toBe(true)
    const firstBytes = new TextEncoder().encode(
      localStorage.getItem(rawStorageKey(first))!
    ).byteLength
    localStorage.setItem(RAW_AGGREGATE_KEY, JSON.stringify({ bytes: firstBytes, count: 1 }))

    expect(await writeStructuredAgentSessionOutbox(third, [entry(third, 3, 100)], 100)).toBe(true)

    const aggregate = JSON.parse(localStorage.getItem(RAW_AGGREGATE_KEY) ?? 'null') as {
      bytes: number
      count: number
    }
    const retainedBytes = [first, second, third].reduce(
      (sum, sessionId) =>
        sum + new TextEncoder().encode(localStorage.getItem(rawStorageKey(sessionId))!).byteLength,
      0
    )
    expect(aggregate).toEqual({ bytes: retainedBytes, count: 3 })
  })

  it('rebuilds missing accounting on a reload read without rewriting valid payloads', async () => {
    const first = 'codex_reload_first'
    const second = 'codex_reload_second'
    const firstPayload = JSON.stringify([entry(first, 1, 100)])
    const secondPayload = JSON.stringify([entry(second, 2, 100)])
    localStorage.setItem(rawStorageKey(first), firstPayload)
    localStorage.setItem(rawStorageKey(second), secondPayload)
    const setItem = vi.spyOn(localStorage, 'setItem')

    expect(readStructuredAgentSessionOutbox(first, 100)).toHaveLength(1)

    await vi.waitFor(() => expect(localStorage.getItem(RAW_AGGREGATE_KEY)).not.toBeNull())

    const aggregate = JSON.parse(localStorage.getItem(RAW_AGGREGATE_KEY) ?? 'null') as {
      bytes: number
      count: number
    }
    expect(aggregate).toEqual({
      bytes:
        new TextEncoder().encode(firstPayload).byteLength +
        new TextEncoder().encode(secondPayload).byteLength,
      count: 2
    })
    expect(setItem.mock.calls.filter(([key]) => key === rawStorageKey(first))).toHaveLength(0)
    expect(setItem.mock.calls.filter(([key]) => key === rawStorageKey(second))).toHaveLength(0)
  })

  it('invalidates cached ownership when another renderer publishes outbox storage', async () => {
    const first = 'codex_external_first'
    const external = 'codex_external_second'
    const third = 'codex_external_third'
    expect(await writeStructuredAgentSessionOutbox(first, [entry(first, 1, 100)], 100)).toBe(true)
    const externalPayload = JSON.stringify([entry(external, 2, 100)])
    localStorage.setItem(rawStorageKey(external), externalPayload)
    localStorage.setItem(
      rawMetadataKey(external),
      JSON.stringify({ bytes: new TextEncoder().encode(externalPayload).byteLength, count: 1 })
    )
    window.dispatchEvent(new StorageEvent('storage', { key: rawStorageKey(external) }))

    expect(await writeStructuredAgentSessionOutbox(third, [entry(third, 3, 100)], 100)).toBe(true)

    const aggregate = JSON.parse(localStorage.getItem(RAW_AGGREGATE_KEY) ?? 'null') as {
      bytes: number
      count: number
    }
    expect(aggregate.count).toBe(3)
  })

  it('rebuilds a crashed owner transaction before the next admission', async () => {
    const first = 'codex_crash_first'
    const crashed = 'codex_crash_external'
    const next = 'codex_crash_next'
    expect(await writeStructuredAgentSessionOutbox(first, [entry(first, 1, 100)], 100)).toBe(true)
    const crashedPayload = JSON.stringify([entry(crashed, 2, 100)])
    localStorage.setItem(rawStorageKey(crashed), crashedPayload)
    localStorage.setItem(RAW_MUTATION_KEY, 'dead-renderer:7')

    expect(await writeStructuredAgentSessionOutbox(next, [entry(next, 3, 100)], 100)).toBe(true)

    expect(localStorage.getItem(RAW_MUTATION_KEY)).toBeNull()
    const aggregate = JSON.parse(localStorage.getItem(RAW_AGGREGATE_KEY) ?? 'null') as {
      bytes: number
      count: number
    }
    expect(aggregate.count).toBe(3)
    expect(aggregate.bytes).toBe(
      [first, crashed, next].reduce(
        (sum, sessionId) =>
          sum +
          new TextEncoder().encode(localStorage.getItem(rawStorageKey(sessionId))!).byteLength,
        0
      )
    )
  })

  it('rebuilds accounting after a metadata quota error leaves the payload durable', async () => {
    const sessionId = 'codex_accounting_quota'
    const backingStorage = localStorage
    let refusedAggregate = false
    const quotaStorage = {
      get length() {
        return backingStorage.length
      },
      clear: () => backingStorage.clear(),
      getItem: (key: string) => backingStorage.getItem(key),
      key: (index: number) => backingStorage.key(index),
      removeItem: (key: string) => backingStorage.removeItem(key),
      setItem: (key: string, value: string) => {
        if (
          key === RAW_AGGREGATE_KEY &&
          backingStorage.getItem(rawStorageKey(sessionId)) !== null &&
          !refusedAggregate
        ) {
          refusedAggregate = true
          throw new DOMException('quota exceeded', 'QuotaExceededError')
        }
        backingStorage.setItem(key, value)
      }
    } satisfies Storage
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: quotaStorage
    })
    let result = false
    try {
      result = await writeStructuredAgentSessionOutbox(sessionId, [entry(sessionId, 1, 100)], 100)
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: backingStorage
      })
    }

    expect(result).toBe(true)
    expect(localStorage.getItem(rawStorageKey(sessionId))).not.toBeNull()
    expect(localStorage.getItem(RAW_AGGREGATE_KEY)).toBeNull()
    expect(readStructuredAgentSessionOutbox(sessionId, 100)).toHaveLength(1)
    await vi.waitFor(() => expect(localStorage.getItem(RAW_AGGREGATE_KEY)).not.toBeNull())
    expect(JSON.parse(localStorage.getItem(RAW_AGGREGATE_KEY) ?? 'null')).toMatchObject({
      count: 1
    })
  })

  it('retains the retry fence when interrupted accounting cannot persist', async () => {
    const sessionId = 'codex_accounting_repair_refusal'
    const first = entry(sessionId, 1, 100)
    const second = entry(sessionId, 2, 100)
    const serialized = JSON.stringify([first])
    localStorage.setItem(rawStorageKey(sessionId), serialized)
    localStorage.setItem(
      rawMetadataKey(sessionId),
      JSON.stringify({ bytes: new TextEncoder().encode(serialized).byteLength, count: 1 })
    )
    localStorage.setItem(RAW_AGGREGATE_KEY, JSON.stringify({ bytes: 0, count: 0 }))
    localStorage.setItem(RAW_MUTATION_KEY, 'dead-renderer:repair')

    const backingStorage = localStorage
    let refusedAggregate = true
    const failingStorage = {
      get length() {
        return backingStorage.length
      },
      clear: () => backingStorage.clear(),
      getItem: (key: string) => backingStorage.getItem(key),
      key: (index: number) => backingStorage.key(index),
      removeItem: (key: string) => backingStorage.removeItem(key),
      setItem: (key: string, value: string) => {
        if (key === RAW_AGGREGATE_KEY && refusedAggregate) {
          refusedAggregate = false
          throw new DOMException('quota exceeded', 'QuotaExceededError')
        }
        backingStorage.setItem(key, value)
      }
    } satisfies Storage
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: failingStorage
    })
    let refusedResult = true
    try {
      refusedResult = await writeStructuredAgentSessionOutbox(sessionId, [first, second], 100)
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: backingStorage
      })
    }

    expect(refusedResult).toBe(false)
    expect(localStorage.getItem(RAW_MUTATION_KEY)).not.toBeNull()
    expect(JSON.parse(localStorage.getItem(rawStorageKey(sessionId)) ?? 'null')).toEqual([first])

    expect(await writeStructuredAgentSessionOutbox(sessionId, [first, second], 100)).toBe(true)
    expect(localStorage.getItem(RAW_MUTATION_KEY)).toBeNull()
    expect(readStructuredAgentSessionOutbox(sessionId, 100)).toEqual([first, second])
  })

  it('leaves deferred maintenance fenced when canonical accounting cannot persist', async () => {
    const sessionId = 'codex_deferred_accounting_refusal'
    const dispatching = { ...entry(sessionId, 1, 100), state: 'dispatching' as const }
    const serialized = JSON.stringify([dispatching])
    localStorage.setItem(rawStorageKey(sessionId), serialized)
    localStorage.setItem(
      rawMetadataKey(sessionId),
      JSON.stringify({ bytes: new TextEncoder().encode(serialized).byteLength, count: 1 })
    )
    localStorage.setItem(
      RAW_AGGREGATE_KEY,
      JSON.stringify({ bytes: new TextEncoder().encode(serialized).byteLength, count: 1 })
    )

    const backingStorage = localStorage
    let refusedAggregate = true
    const failingStorage = {
      get length() {
        return backingStorage.length
      },
      clear: () => backingStorage.clear(),
      getItem: (key: string) => backingStorage.getItem(key),
      key: (index: number) => backingStorage.key(index),
      removeItem: (key: string) => backingStorage.removeItem(key),
      setItem: (key: string, value: string) => {
        if (key === RAW_AGGREGATE_KEY && refusedAggregate) {
          refusedAggregate = false
          throw new DOMException('quota exceeded', 'QuotaExceededError')
        }
        backingStorage.setItem(key, value)
      }
    } satisfies Storage
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: failingStorage
    })
    try {
      expect(readStructuredAgentSessionOutbox(sessionId, 100)).toEqual([
        { ...dispatching, state: 'unconfirmed' }
      ])
      await vi.waitFor(() => expect(localStorage.getItem(RAW_MUTATION_KEY)).not.toBeNull())
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: backingStorage
      })
    }

    expect(JSON.parse(localStorage.getItem(rawStorageKey(sessionId)) ?? 'null')).toEqual([
      { ...dispatching, state: 'unconfirmed' }
    ])
    readStructuredAgentSessionOutbox(sessionId, 100)
    await vi.waitFor(() => expect(localStorage.getItem(RAW_MUTATION_KEY)).toBeNull())
    expect(readStructuredAgentSessionOutbox(sessionId, 100)).toEqual([
      { ...dispatching, state: 'unconfirmed' }
    ])
  })
})
