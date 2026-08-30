import type { StructuredAgentSessionOutboxEntry } from '../../../shared/structured-agent-session-outbox'
import {
  accountingForSerializedOutbox,
  EMPTY_OUTBOX_ACCOUNTING,
  OUTBOX_AGGREGATE_KEY,
  OUTBOX_METADATA_PREFIX,
  OUTBOX_MUTATION_KEY,
  OUTBOX_PREFIX,
  outboxByteLength,
  outboxMetadataKey,
  outboxSessionIdFromKey,
  outboxStorageKey,
  parseOutboxAccounting,
  parseStoredOutboxEntries,
  serializeOutboxEntries,
  storedOutboxKeys,
  type OutboxAccounting
} from '@/lib/structured-agent-session-outbox-codec'

type OutboxAccountingCache = { aggregate: OutboxAccounting; serialized: string }

let accountingCache: OutboxAccountingCache | null = null
let storageInvalidationListenerInstalled = false
let authoritativeRecoveryRequired = false
let externalAggregateBaseline: string | null | undefined

function writeAccounting(key: string, accounting: OutboxAccounting): string {
  const serialized = JSON.stringify(accounting)
  localStorage.setItem(key, serialized)
  return serialized
}

function installStorageAccountingInvalidationListener(): void {
  if (storageInvalidationListenerInstalled || typeof window === 'undefined') {
    return
  }
  window.addEventListener('storage', (event) => {
    if (event.key === null) {
      accountingCache = null
      authoritativeRecoveryRequired = true
      externalAggregateBaseline = undefined
      return
    }
    if (event.key === OUTBOX_AGGREGATE_KEY) {
      accountingCache = null
      externalAggregateBaseline = undefined
      return
    }
    if (event.key === OUTBOX_MUTATION_KEY) {
      return
    }
    if (event.key.startsWith(OUTBOX_PREFIX) || event.key.startsWith(OUTBOX_METADATA_PREFIX)) {
      externalAggregateBaseline ??=
        accountingCache?.serialized ?? localStorage.getItem(OUTBOX_AGGREGATE_KEY)
      accountingCache = null
    }
  })
  storageInvalidationListenerInstalled = true
}

export function invalidateOutboxAccounting(): void {
  accountingCache = null
}

export function removeStoredOutbox(sessionId: string): void {
  localStorage.removeItem(outboxStorageKey(sessionId))
  localStorage.removeItem(outboxMetadataKey(sessionId))
}

function persistAccountingAfterPayload(input: {
  sessionId: string
  aggregate: OutboxAccounting
  previous: OutboxAccounting
  next: OutboxAccounting
}): boolean {
  const aggregate = {
    bytes: input.aggregate.bytes - input.previous.bytes + input.next.bytes,
    count: input.aggregate.count - input.previous.count + input.next.count
  }
  try {
    if (input.next.count === 0) {
      localStorage.removeItem(outboxMetadataKey(input.sessionId))
    } else {
      writeAccounting(outboxMetadataKey(input.sessionId), input.next)
    }
    const serialized = writeAccounting(OUTBOX_AGGREGATE_KEY, aggregate)
    accountingCache = { aggregate, serialized }
    return true
  } catch {
    localStorage.removeItem(outboxMetadataKey(input.sessionId))
    localStorage.removeItem(OUTBOX_AGGREGATE_KEY)
    accountingCache = null
    return false
  }
}

export function persistCanonicalOutboxEntries(input: {
  sessionId: string
  entries: readonly StructuredAgentSessionOutboxEntry[]
  previous: OutboxAccounting
  aggregate: OutboxAccounting
}): { payloadSaved: boolean; accountingSaved: boolean } {
  const serialized = serializeOutboxEntries(input.entries)
  const next = accountingForSerializedOutbox(serialized, input.entries.length)
  try {
    if (serialized) {
      localStorage.setItem(outboxStorageKey(input.sessionId), serialized)
    } else {
      localStorage.removeItem(outboxStorageKey(input.sessionId))
    }
  } catch {
    return { payloadSaved: false, accountingSaved: false }
  }
  return {
    payloadSaved: true,
    accountingSaved: persistAccountingAfterPayload({ ...input, next })
  }
}

export type OutboxAccountingRebuildResult = {
  aggregate: OutboxAccounting
  persisted: boolean
}

export function rebuildOutboxAccountingResult(now: number): OutboxAccountingRebuildResult {
  accountingCache = null
  authoritativeRecoveryRequired = false
  externalAggregateBaseline = undefined
  let aggregate = { ...EMPTY_OUTBOX_ACCOUNTING }
  let persisted = true
  for (const key of storedOutboxKeys()) {
    const sessionId = outboxSessionIdFromKey(key)
    if (!sessionId) {
      try {
        localStorage.removeItem(key)
      } catch {
        persisted = false
      }
      continue
    }
    const stored = localStorage.getItem(key)
    const entries = parseStoredOutboxEntries(sessionId, stored, now)
    const serialized = serializeOutboxEntries(entries)
    try {
      if (serialized) {
        if (stored !== serialized) {
          localStorage.setItem(key, serialized)
        }
      } else {
        removeStoredOutbox(sessionId)
      }
    } catch {
      persisted = false
    }
    const retained = localStorage.getItem(key)
    const accounting = accountingForSerializedOutbox(retained, retained ? entries.length : 0)
    try {
      if (retained) {
        writeAccounting(outboxMetadataKey(sessionId), accounting)
      } else {
        localStorage.removeItem(outboxMetadataKey(sessionId))
      }
    } catch {
      persisted = false
    }
    aggregate = {
      bytes: aggregate.bytes + accounting.bytes,
      count: aggregate.count + accounting.count
    }
  }
  try {
    const serialized = writeAccounting(OUTBOX_AGGREGATE_KEY, aggregate)
    if (persisted) {
      accountingCache = { aggregate, serialized }
    }
  } catch {
    try {
      localStorage.removeItem(OUTBOX_AGGREGATE_KEY)
    } catch {
      // Keep the recovery fence when even aggregate cleanup is refused.
    }
    accountingCache = null
    persisted = false
  }
  if (!persisted) {
    authoritativeRecoveryRequired = true
  }
  return { aggregate, persisted }
}

export function rebuildOutboxAccounting(now: number): OutboxAccounting {
  return rebuildOutboxAccountingResult(now).aggregate
}

export function readOutboxAccounting(
  sessionId: string,
  now: number,
  expectedCurrent?: OutboxAccounting
): { aggregate: OutboxAccounting; current: OutboxAccounting; accountingPersisted: boolean } {
  installStorageAccountingInvalidationListener()
  const payload = localStorage.getItem(outboxStorageKey(sessionId))
  const aggregateSerialized = localStorage.getItem(OUTBOX_AGGREGATE_KEY)
  const aggregate = parseOutboxAccounting(aggregateSerialized)
  const current = parseOutboxAccounting(localStorage.getItem(outboxMetadataKey(sessionId)))
  const currentMatchesPayload = payload
    ? current?.bytes === outboxByteLength(payload) &&
      (!expectedCurrent || current.count === expectedCurrent.count)
    : current === null
  const aggregateChangedOutsideOwnership =
    accountingCache !== null && accountingCache.serialized !== aggregateSerialized
  const externalPayloadMissingFromAggregate =
    externalAggregateBaseline !== undefined && externalAggregateBaseline === aggregateSerialized
  if (
    externalAggregateBaseline !== undefined &&
    externalAggregateBaseline !== aggregateSerialized
  ) {
    externalAggregateBaseline = undefined
  }
  if (
    authoritativeRecoveryRequired ||
    aggregateChangedOutsideOwnership ||
    externalPayloadMissingFromAggregate ||
    !aggregate ||
    !currentMatchesPayload
  ) {
    const rebuilt = rebuildOutboxAccountingResult(now)
    const rebuiltPayload = localStorage.getItem(outboxStorageKey(sessionId))
    return {
      aggregate: rebuilt.aggregate,
      current: accountingForSerializedOutbox(
        rebuiltPayload,
        rebuiltPayload ? parseStoredOutboxEntries(sessionId, rebuiltPayload, now).length : 0
      ),
      accountingPersisted: rebuilt.persisted
    }
  }
  accountingCache = { aggregate, serialized: aggregateSerialized! }
  return {
    aggregate,
    current: current ?? EMPTY_OUTBOX_ACCOUNTING,
    accountingPersisted: true
  }
}
