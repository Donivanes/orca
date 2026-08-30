import {
  parseStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../shared/structured-agent-session-outbox'

export const OUTBOX_PREFIX = 'orca:desktopStructuredAgentSessionOutbox:v1:'
export const OUTBOX_METADATA_PREFIX = 'orca:desktopStructuredAgentSessionOutboxMetadata:v1:'
export const OUTBOX_AGGREGATE_KEY = 'orca:desktopStructuredAgentSessionOutboxAggregate:v1'
export const OUTBOX_MUTATION_KEY = 'orca:desktopStructuredAgentSessionOutboxMutation:v1'
export const OUTBOX_MUTATION_LOCK = 'orca:desktopStructuredAgentSessionOutboxMutation:v1'
export const STRUCTURED_AGENT_SESSION_OUTBOX_MAX_ENTRIES = 64
export const STRUCTURED_AGENT_SESSION_OUTBOX_MAX_ENTRY_BYTES = 300 * 1024
export const STRUCTURED_AGENT_SESSION_OUTBOX_MAX_AGGREGATE_BYTES = 4 * 1024 * 1024
export const STRUCTURED_AGENT_SESSION_OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type OutboxAccounting = { bytes: number; count: number }

export const EMPTY_OUTBOX_ACCOUNTING: OutboxAccounting = { bytes: 0, count: 0 }
const OUTBOX_LIFECYCLE_GROWTH_BYTES = 256

export function outboxStorageKey(sessionId: string): string {
  return `${OUTBOX_PREFIX}${encodeURIComponent(sessionId)}`
}

export function outboxMetadataKey(sessionId: string): string {
  return `${OUTBOX_METADATA_PREFIX}${encodeURIComponent(sessionId)}`
}

export function outboxByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function outboxSessionIdFromKey(key: string): string | null {
  if (!key.startsWith(OUTBOX_PREFIX)) {
    return null
  }
  try {
    return decodeURIComponent(key.slice(OUTBOX_PREFIX.length))
  } catch {
    return null
  }
}

export function storedOutboxKeys(): string[] {
  const keys: string[] = []
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (key?.startsWith(OUTBOX_PREFIX)) {
      keys.push(key)
    }
  }
  return keys
}

export function parseOutboxAccounting(value: string | null): OutboxAccounting | null {
  if (!value) {
    return null
  }
  try {
    const parsed = JSON.parse(value) as Partial<OutboxAccounting>
    return Number.isSafeInteger(parsed.bytes) &&
      parsed.bytes! >= 0 &&
      Number.isSafeInteger(parsed.count) &&
      parsed.count! >= 0
      ? { bytes: parsed.bytes!, count: parsed.count! }
      : null
  } catch {
    return null
  }
}

export function parseStoredOutboxEntries(
  sessionId: string,
  serialized: string | null,
  now: number,
  recoverDispatching = true
): StructuredAgentSessionOutboxEntry[] {
  if (!serialized) {
    return []
  }
  try {
    const value = JSON.parse(serialized)
    if (!Array.isArray(value)) {
      return []
    }
    return value
      .map((entry) => parseStructuredAgentSessionOutboxEntry(entry, sessionId))
      .filter((entry): entry is StructuredAgentSessionOutboxEntry => entry !== null)
      .filter(
        (entry) =>
          entry.queuedAt <= now && now - entry.queuedAt <= STRUCTURED_AGENT_SESSION_OUTBOX_TTL_MS
      )
      .filter(
        (entry) =>
          outboxByteLength(JSON.stringify(entry)) <= STRUCTURED_AGENT_SESSION_OUTBOX_MAX_ENTRY_BYTES
      )
      .map((entry) =>
        recoverDispatching && entry.state === 'dispatching'
          ? { ...entry, state: 'unconfirmed' as const }
          : entry
      )
      .sort((left, right) => left.queuedAt - right.queuedAt)
  } catch {
    return []
  }
}

export function serializeOutboxEntries(
  entries: readonly StructuredAgentSessionOutboxEntry[]
): string | null {
  return entries.length > 0 ? JSON.stringify(entries) : null
}

export function hasPendingLaunchOutboxEntry(
  entries: readonly StructuredAgentSessionOutboxEntry[]
): boolean {
  return entries.some((entry) => entry.launchPending === true)
}

export function clearPendingLaunchOutboxEntries(
  entries: readonly StructuredAgentSessionOutboxEntry[]
): StructuredAgentSessionOutboxEntry[] {
  return entries.map(({ launchPending: _launchPending, ...entry }) => entry)
}

export function accountingForSerializedOutbox(
  serialized: string | null,
  count: number
): OutboxAccounting {
  return { bytes: serialized ? outboxByteLength(serialized) : 0, count }
}

export function isOutboxLifecycleOnlyUpdate(
  previous: readonly StructuredAgentSessionOutboxEntry[],
  next: readonly StructuredAgentSessionOutboxEntry[],
  previousBytes: number,
  nextBytes: number
): boolean {
  if (previous.length !== next.length) {
    return false
  }
  let changed = 0
  for (let index = 0; index < previous.length; index += 1) {
    const prior = previous[index]
    const current = next[index]
    if (!prior || !current) {
      return false
    }
    if (JSON.stringify(prior) === JSON.stringify(current)) {
      continue
    }
    if (
      prior.sessionId !== current.sessionId ||
      prior.queuedAt !== current.queuedAt ||
      JSON.stringify(prior.body) !== JSON.stringify(current.body) ||
      JSON.stringify(prior.previewUris) !== JSON.stringify(current.previewUris)
    ) {
      return false
    }
    changed += 1
  }
  return changed > 0 && nextBytes <= previousBytes + changed * OUTBOX_LIFECYCLE_GROWTH_BYTES
}
