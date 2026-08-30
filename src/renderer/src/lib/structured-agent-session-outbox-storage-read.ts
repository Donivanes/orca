import type { StructuredAgentSessionOutboxEntry } from '../../../shared/structured-agent-session-outbox'
import {
  OUTBOX_AGGREGATE_KEY,
  outboxByteLength,
  outboxMetadataKey,
  outboxStorageKey,
  parseOutboxAccounting,
  parseStoredOutboxEntries,
  serializeOutboxEntries
} from '@/lib/structured-agent-session-outbox-codec'
import {
  persistCanonicalOutboxEntries,
  readOutboxAccounting
} from '@/lib/structured-agent-session-outbox-accounting'
import {
  beginDurableStorageMutation,
  finishDurableStorageMutation,
  repairInterruptedStorageMutation,
  withStorageMutation
} from './structured-agent-session-outbox-storage-lock'

export function readStructuredAgentSessionOutbox(
  sessionId: string,
  now = Date.now()
): StructuredAgentSessionOutboxEntry[] {
  try {
    const key = outboxStorageKey(sessionId)
    const serialized = localStorage.getItem(key)
    const entries = parseStoredOutboxEntries(sessionId, serialized, now)
    const canonical = serializeOutboxEntries(entries)
    const metadata = parseOutboxAccounting(localStorage.getItem(outboxMetadataKey(sessionId)))
    const accountingMissing =
      parseOutboxAccounting(localStorage.getItem(OUTBOX_AGGREGATE_KEY)) === null ||
      (serialized
        ? metadata?.bytes !== outboxByteLength(serialized) || metadata.count !== entries.length
        : metadata !== null)
    if (serialized !== canonical || accountingMissing) {
      void maintainStructuredAgentSessionOutboxStorage(sessionId, now)
    }
    return entries
  } catch {
    return []
  }
}

function maintainStructuredAgentSessionOutboxStorage(
  sessionId: string,
  now: number
): Promise<void> {
  return withStorageMutation(() => {
    if (!repairInterruptedStorageMutation(now)) {
      return
    }
    // Re-read deferred repairs under the authoritative lock to avoid stale snapshot writes.
    const key = outboxStorageKey(sessionId)
    const serialized = localStorage.getItem(key)
    const entries = parseStoredOutboxEntries(sessionId, serialized, now)
    const canonical = serializeOutboxEntries(entries)
    const token = beginDurableStorageMutation()
    if (!token) {
      return
    }
    const accounting = readOutboxAccounting(sessionId, now, {
      bytes: serialized ? outboxByteLength(serialized) : 0,
      count: entries.length
    })
    if (!accounting.accountingPersisted) {
      return
    }
    if (serialized !== canonical) {
      const persisted = persistCanonicalOutboxEntries({
        sessionId,
        entries,
        previous: accounting.current,
        aggregate: accounting.aggregate
      })
      if (!persisted.accountingSaved) {
        return
      }
    }
    finishDurableStorageMutation(token)
  })
}
