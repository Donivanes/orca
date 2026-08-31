import { useEffect, useRef, useState } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import {
  reconcileStructuredAgentSessionOutbox,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  mutateStructuredAgentSessionOutbox,
  readStructuredAgentSessionOutbox
} from '@/lib/structured-agent-session-outbox-storage'
import { useStructuredAgentSessionOutboxDispatch } from './use-structured-agent-session-outbox-dispatch'

function outboxEntriesEqual(
  left: readonly StructuredAgentSessionOutboxEntry[],
  right: readonly StructuredAgentSessionOutboxEntry[]
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function useStructuredAgentSessionOutbox(args: {
  sessionId: string
  target: RuntimeClientTarget
  fence: number | null
  submissions: readonly AgentJournalSubmission[]
}) {
  const { fence, sessionId, submissions, target } = args
  const [outbox, setOutbox] = useState<StructuredAgentSessionOutboxEntry[]>(() =>
    readStructuredAgentSessionOutbox(sessionId)
  )
  const outboxRef = useRef(outbox)
  const outboxSessionRef = useRef(sessionId)

  useEffect(() => {
    outboxRef.current = outbox
  }, [outbox])

  useEffect(() => {
    const sessionChanged = outboxSessionRef.current !== sessionId
    outboxSessionRef.current = sessionId
    if (sessionChanged) {
      const current = readStructuredAgentSessionOutbox(sessionId)
      outboxRef.current = current
      setOutbox(current)
    }
    void mutateStructuredAgentSessionOutbox(sessionId, (current) =>
      current.map((entry) =>
        entry.state === 'dispatching' ? { ...entry, state: 'queued' as const } : entry
      )
    ).then((result) => {
      if (
        outboxSessionRef.current === sessionId &&
        result.saved &&
        !outboxEntriesEqual(outboxRef.current, result.entries)
      ) {
        outboxRef.current = result.entries
        setOutbox(result.entries)
      }
    })
  }, [fence, sessionId, target])

  useEffect(() => {
    void mutateStructuredAgentSessionOutbox(sessionId, (current) =>
      reconcileStructuredAgentSessionOutbox(current, submissions)
    ).then((result) => {
      if (
        outboxSessionRef.current === sessionId &&
        result.saved &&
        !outboxEntriesEqual(outboxRef.current, result.entries)
      ) {
        outboxRef.current = result.entries
        setOutbox(result.entries)
      }
    })
  }, [sessionId, submissions])

  const { blockedClientMessageId, error, retry, send } = useStructuredAgentSessionOutboxDispatch({
    sessionId,
    target,
    fence,
    submissions,
    outbox,
    setOutbox
  })

  return { outbox, error, blockedClientMessageId, send, retry }
}
