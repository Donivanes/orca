import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { CodexSession } from './codex-structured-session-state'

export function requireCodexSession(
  sessions: ReadonlyMap<string, CodexSession>,
  sessionId: string
): CodexSession {
  const session = sessions.get(sessionId)
  if (!session || session.ended) {
    throw new Error(`no live codex app-server for session ${sessionId}`)
  }
  return session
}

export function codexHistoryFilePath(
  sessions: ReadonlyMap<string, CodexSession>,
  identity: AgentSessionJournalIdentity
): string | null {
  return sessions.get(identity.sessionId)?.historyPath ?? null
}
