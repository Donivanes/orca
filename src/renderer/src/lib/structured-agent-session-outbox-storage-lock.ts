import { createStructuredAgentSessionOperationId } from '../../../shared/structured-agent-session-mutation'
import {
  OUTBOX_AGGREGATE_KEY,
  OUTBOX_MUTATION_KEY,
  OUTBOX_MUTATION_LOCK
} from '@/lib/structured-agent-session-outbox-codec'
import {
  invalidateOutboxAccounting,
  rebuildOutboxAccountingResult
} from '@/lib/structured-agent-session-outbox-accounting'

let fallbackStorageMutation = Promise.resolve()
const storageMutationOwnerId = crypto.randomUUID()
let storageMutationSequence = 0

export function structuredSessionOperationId(): string {
  return createStructuredAgentSessionOperationId(() => crypto.randomUUID())
}

export function withStorageMutation<T>(mutation: () => T | Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(OUTBOX_MUTATION_LOCK, { mode: 'exclusive' }, mutation)
  }
  const pending = fallbackStorageMutation.then(mutation, mutation)
  fallbackStorageMutation = pending.then(
    () => undefined,
    () => undefined
  )
  return pending
}

export function repairInterruptedStorageMutation(now: number): boolean {
  if (localStorage.getItem(OUTBOX_MUTATION_KEY) === null) {
    return true
  }
  try {
    localStorage.removeItem(OUTBOX_AGGREGATE_KEY)
  } catch {
    return false
  }
  invalidateOutboxAccounting()
  const rebuilt = rebuildOutboxAccountingResult(now)
  if (!rebuilt.persisted) {
    return false
  }
  localStorage.removeItem(OUTBOX_MUTATION_KEY)
  return true
}

export function beginDurableStorageMutation(): string | null {
  const token = `${storageMutationOwnerId}:${(storageMutationSequence += 1)}`
  try {
    localStorage.setItem(OUTBOX_MUTATION_KEY, token)
    return token
  } catch {
    return null
  }
}

export function finishDurableStorageMutation(token: string): void {
  if (localStorage.getItem(OUTBOX_MUTATION_KEY) === token) {
    localStorage.removeItem(OUTBOX_MUTATION_KEY)
  }
}
