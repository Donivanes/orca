import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../shared/structured-agent-session-outbox'
import {
  accountingForSerializedOutbox,
  isOutboxLifecycleOnlyUpdate,
  outboxByteLength,
  outboxStorageKey,
  parseStoredOutboxEntries,
  serializeOutboxEntries,
  STRUCTURED_AGENT_SESSION_OUTBOX_MAX_AGGREGATE_BYTES,
  STRUCTURED_AGENT_SESSION_OUTBOX_MAX_ENTRIES,
  STRUCTURED_AGENT_SESSION_OUTBOX_MAX_ENTRY_BYTES,
  STRUCTURED_AGENT_SESSION_OUTBOX_TTL_MS
} from '@/lib/structured-agent-session-outbox-codec'
import {
  persistCanonicalOutboxEntries,
  readOutboxAccounting
} from '@/lib/structured-agent-session-outbox-accounting'
import {
  beginDurableStorageMutation,
  finishDurableStorageMutation,
  repairInterruptedStorageMutation,
  structuredSessionOperationId,
  withStorageMutation
} from './structured-agent-session-outbox-storage-lock'

export { structuredSessionOperationId }

export function writeStructuredAgentSessionOutbox(
  sessionId: string,
  entries: readonly StructuredAgentSessionOutboxEntry[],
  now = Date.now()
): Promise<boolean> {
  return withStorageMutation(() => {
    if (!repairInterruptedStorageMutation(now)) {
      return false
    }
    return writeStructuredAgentSessionOutboxOwned(sessionId, entries, now)
  })
}

export type StructuredAgentSessionOutboxMutationResult = {
  saved: boolean
  entries: StructuredAgentSessionOutboxEntry[]
}

export function mutateStructuredAgentSessionOutbox(
  sessionId: string,
  mutate: (
    entries: readonly StructuredAgentSessionOutboxEntry[]
  ) => readonly StructuredAgentSessionOutboxEntry[],
  now = Date.now()
): Promise<StructuredAgentSessionOutboxMutationResult> {
  return withStorageMutation(() => {
    if (!repairInterruptedStorageMutation(now)) {
      return {
        saved: false,
        entries: parseStoredOutboxEntries(
          sessionId,
          localStorage.getItem(outboxStorageKey(sessionId)),
          now,
          false
        )
      }
    }
    const current = parseStoredOutboxEntries(
      sessionId,
      localStorage.getItem(outboxStorageKey(sessionId)),
      now,
      false
    )
    const proposed = mutate(current)
    const changed =
      proposed.length !== current.length ||
      proposed.some((entry, index) => entry !== current[index])
    if (!changed) {
      return { saved: true, entries: current }
    }
    const next = [...proposed]
    return {
      saved: writeStructuredAgentSessionOutboxOwned(sessionId, next, now, current),
      entries: next
    }
  })
}

export function appendStructuredAgentSessionOutboxEntry(
  sessionId: string,
  entry: StructuredAgentSessionOutboxEntry,
  now = Date.now()
): Promise<StructuredAgentSessionOutboxMutationResult> {
  return withStorageMutation(() => {
    if (!repairInterruptedStorageMutation(now)) {
      return {
        saved: false,
        entries: parseStoredOutboxEntries(
          sessionId,
          localStorage.getItem(outboxStorageKey(sessionId)),
          now,
          false
        )
      }
    }
    const current = parseStoredOutboxEntries(
      sessionId,
      localStorage.getItem(outboxStorageKey(sessionId)),
      now,
      false
    )
    const existing = current.find(
      (candidate) => candidate.clientMessageId === entry.clientMessageId
    )
    if (existing) {
      return { saved: JSON.stringify(existing) === JSON.stringify(entry), entries: current }
    }
    const next = [...current, entry]
    return {
      saved: writeStructuredAgentSessionOutboxOwned(sessionId, next, now, current),
      entries: next
    }
  })
}

export function mutateStructuredAgentSessionOutboxEntry(
  sessionId: string,
  clientMessageId: string,
  mutate: (entry: StructuredAgentSessionOutboxEntry) => StructuredAgentSessionOutboxEntry | null,
  now = Date.now()
): Promise<StructuredAgentSessionOutboxMutationResult & { matched: boolean }> {
  return withStorageMutation(() => {
    if (!repairInterruptedStorageMutation(now)) {
      return {
        saved: false,
        entries: parseStoredOutboxEntries(
          sessionId,
          localStorage.getItem(outboxStorageKey(sessionId)),
          now,
          false
        ),
        matched: false
      }
    }
    const current = parseStoredOutboxEntries(
      sessionId,
      localStorage.getItem(outboxStorageKey(sessionId)),
      now,
      false
    )
    const index = current.findIndex((entry) => entry.clientMessageId === clientMessageId)
    if (index === -1) {
      return { saved: true, entries: current, matched: false }
    }
    const replacement = mutate(current[index]!)
    const next = replacement
      ? current.map((entry, entryIndex) => (entryIndex === index ? replacement : entry))
      : current.filter((_entry, entryIndex) => entryIndex !== index)
    return {
      saved: writeStructuredAgentSessionOutboxOwned(sessionId, next, now, current),
      entries: next,
      matched: true
    }
  })
}

export function writeStructuredAgentSessionOutboxOwned(
  sessionId: string,
  entries: readonly StructuredAgentSessionOutboxEntry[],
  now: number,
  knownPreviousEntries?: readonly StructuredAgentSessionOutboxEntry[]
): boolean {
  try {
    const key = outboxStorageKey(sessionId)
    const previousEntries =
      knownPreviousEntries ??
      parseStoredOutboxEntries(sessionId, localStorage.getItem(key), now, false)
    if (
      (entries.length > STRUCTURED_AGENT_SESSION_OUTBOX_MAX_ENTRIES &&
        (previousEntries.length <= STRUCTURED_AGENT_SESSION_OUTBOX_MAX_ENTRIES ||
          entries.length > previousEntries.length)) ||
      entries.some(
        (entry) =>
          entry.sessionId !== sessionId ||
          entry.queuedAt > now ||
          now - entry.queuedAt > STRUCTURED_AGENT_SESSION_OUTBOX_TTL_MS ||
          outboxByteLength(JSON.stringify(entry)) > STRUCTURED_AGENT_SESSION_OUTBOX_MAX_ENTRY_BYTES
      )
    ) {
      return false
    }
    const serialized = serializeOutboxEntries(entries)
    const next = accountingForSerializedOutbox(serialized, entries.length)
    const accounting = readOutboxAccounting(sessionId, now, {
      bytes: outboxByteLength(localStorage.getItem(key) ?? ''),
      count: previousEntries.length
    })
    const nextAggregateBytes = accounting.aggregate.bytes - accounting.current.bytes + next.bytes
    if (
      nextAggregateBytes > STRUCTURED_AGENT_SESSION_OUTBOX_MAX_AGGREGATE_BYTES &&
      nextAggregateBytes > accounting.aggregate.bytes &&
      !isOutboxLifecycleOnlyUpdate(previousEntries, entries, accounting.current.bytes, next.bytes)
    ) {
      return false
    }
    const token = beginDurableStorageMutation()
    if (!token) {
      return false
    }
    const persisted = persistCanonicalOutboxEntries({
      sessionId,
      entries,
      previous: accounting.current,
      aggregate: accounting.aggregate
    })
    if (persisted.accountingSaved) {
      finishDurableStorageMutation(token)
    }
    return persisted.payloadSaved
  } catch {
    return false
  }
}

export function enqueueStructuredAgentSessionLaunchPrompt(
  sessionId: string,
  text: string,
  now = Date.now()
): Promise<StructuredAgentSessionOutboxEntry | null> {
  return withStorageMutation(() => {
    if (!repairInterruptedStorageMutation(now)) {
      return null
    }
    const current = parseStoredOutboxEntries(
      sessionId,
      localStorage.getItem(outboxStorageKey(sessionId)),
      now,
      false
    )
    const entry = createStructuredAgentSessionOutboxEntry({
      clientMessageId: structuredSessionOperationId(),
      sessionId,
      text,
      attachments: [],
      queuedAt: now
    })
    const launchEntry = { ...entry, launchPending: true as const }
    return writeStructuredAgentSessionOutboxOwned(
      sessionId,
      [...current, launchEntry],
      now,
      current
    )
      ? launchEntry
      : null
  })
}
