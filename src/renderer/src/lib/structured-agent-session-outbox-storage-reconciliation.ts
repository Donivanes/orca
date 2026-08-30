import {
  clearPendingLaunchOutboxEntries,
  hasPendingLaunchOutboxEntry,
  OUTBOX_AGGREGATE_KEY,
  outboxSessionIdFromKey,
  outboxStorageKey,
  parseStoredOutboxEntries,
  serializeOutboxEntries,
  storedOutboxKeys
} from '@/lib/structured-agent-session-outbox-codec'
import {
  invalidateOutboxAccounting,
  rebuildOutboxAccountingResult,
  removeStoredOutbox
} from '@/lib/structured-agent-session-outbox-accounting'
import { writeStructuredAgentSessionOutboxOwned } from './structured-agent-session-outbox-storage-mutations'
import {
  beginDurableStorageMutation,
  finishDurableStorageMutation,
  repairInterruptedStorageMutation,
  withStorageMutation
} from './structured-agent-session-outbox-storage-lock'

const protectedLaunchSessionIds = new Set<string>()

export function reconcileStructuredAgentSessionOutboxStorage(
  authoritativeSessionIds: readonly string[],
  now = Date.now()
): Promise<void> {
  return withStorageMutation(() => {
    if (!repairInterruptedStorageMutation(now)) {
      return
    }
    const authoritative = new Set(authoritativeSessionIds)
    const token = beginDurableStorageMutation()
    if (!token) {
      return
    }
    let completed = false
    try {
      for (const key of storedOutboxKeys()) {
        const sessionId = outboxSessionIdFromKey(key)
        if (!sessionId) {
          localStorage.removeItem(key)
          continue
        }
        const entries = parseStoredOutboxEntries(sessionId, localStorage.getItem(key), now, false)
        const sessionIsAuthoritative = authoritative.has(sessionId)
        if (
          !sessionIsAuthoritative &&
          !protectedLaunchSessionIds.has(sessionId) &&
          !hasPendingLaunchOutboxEntry(entries)
        ) {
          removeStoredOutbox(sessionId)
          continue
        }
        const retainedEntries = sessionIsAuthoritative
          ? clearPendingLaunchOutboxEntries(entries)
          : entries
        const serialized = serializeOutboxEntries(retainedEntries)
        if (serialized) {
          localStorage.setItem(key, serialized)
        } else {
          removeStoredOutbox(sessionId)
        }
      }
      localStorage.removeItem(OUTBOX_AGGREGATE_KEY)
      invalidateOutboxAccounting()
      completed = rebuildOutboxAccountingResult(now).persisted
    } catch {
      // Reconciliation is best-effort; later writes still fail closed on every bound.
      invalidateOutboxAccounting()
    } finally {
      if (completed) {
        finishDurableStorageMutation(token)
      }
    }
  })
}

export function protectStructuredAgentSessionLaunchOutbox(sessionId: string): void {
  protectedLaunchSessionIds.add(sessionId)
}

export function releaseStructuredAgentSessionLaunchOutbox(sessionId: string): void {
  protectedLaunchSessionIds.delete(sessionId)
  void withStorageMutation(() => {
    const now = Date.now()
    if (!repairInterruptedStorageMutation(now)) {
      return
    }
    const stored = localStorage.getItem(outboxStorageKey(sessionId))
    const entries = parseStoredOutboxEntries(sessionId, stored, now, false)
    if (hasPendingLaunchOutboxEntry(entries)) {
      writeStructuredAgentSessionOutboxOwned(
        sessionId,
        clearPendingLaunchOutboxEntries(entries),
        now
      )
    }
  })
}
