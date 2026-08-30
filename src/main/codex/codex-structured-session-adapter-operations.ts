import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import type {
  AgentSessionDispatchOutcome,
  StructuredAgentSessionSetOptionInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { answerCodexPrompt } from './codex-structured-prompt-replies'
import { dispatchCodexTurn, isCodexTurnOptionKey } from './codex-structured-turn-start'
import {
  applyCodexStructuredSessionOption,
  readLiveCodexSessionOptions
} from './codex-structured-session-options'
import type { CodexSession } from './codex-structured-session-state'
import {
  requireCodexSession,
  codexHistoryFilePath
} from './codex-structured-session-adapter-session'
import type { CodexStructuredTurnCancellation } from './codex-structured-turn-cancellation'

export function bindCodexPromptItemId(
  sessions: ReadonlyMap<string, CodexSession>,
  sessionId: string,
  journalItemId: string,
  promptKey: string
): void {
  sessions
    .get(sessionId)
    ?.prompts.bindJournalItemId(
      journalItemId,
      requireCodexSession(sessions, sessionId).threadId,
      promptKey
    )
}

export async function dispatchCodexSession(
  sessions: ReadonlyMap<string, CodexSession>,
  cancellation: CodexStructuredTurnCancellation,
  input: {
    sessionId: string
    clientMessageId: string
    body: AgentJournalMessageItem
    fence: number
  },
  requestTimeoutMs: number | undefined
): Promise<AgentSessionDispatchOutcome> {
  const session = requireCodexSession(sessions, input.sessionId)
  await cancellation.captureBaseline(session)
  return dispatchCodexTurn(session, input, requestTimeoutMs)
}

export function cancelCodexTurn(
  sessions: ReadonlyMap<string, CodexSession>,
  cancellation: CodexStructuredTurnCancellation,
  input: { sessionId: string; turnId: string; fence: number }
): Promise<{ cancelled: boolean }> {
  return cancellation.cancel(requireCodexSession(sessions, input.sessionId), input.turnId)
}

export function answerCodexSessionPrompt(
  sessions: ReadonlyMap<string, CodexSession>,
  input: {
    sessionId: string
    itemId: string
    kind: 'approval' | 'question'
    optionId: string
    fence: number
  }
): void {
  const session = requireCodexSession(sessions, input.sessionId)
  answerCodexPrompt(session.prompts, session.connection, input.itemId, input.optionId)
}

export function setCodexSessionOption(
  sessions: ReadonlyMap<string, CodexSession>,
  input: StructuredAgentSessionSetOptionInput,
  requestTimeoutMs: number | undefined
): Promise<Readonly<Record<string, string>>> {
  if (!isCodexTurnOptionKey(input.key)) {
    throw new Error(`codex app-server has no thread option named ${input.key}`)
  }
  return applyCodexStructuredSessionOption(
    requireCodexSession(sessions, input.sessionId),
    input.key,
    input.value,
    requestTimeoutMs
  )
}

export function readCodexSessionOptions(
  sessions: ReadonlyMap<string, CodexSession>,
  sessionId: string,
  requestTimeoutMs: number | undefined
) {
  return readLiveCodexSessionOptions(requireCodexSession(sessions, sessionId), requestTimeoutMs)
}

export function codexSessionHistoryFilePath(
  sessions: ReadonlyMap<string, CodexSession>,
  identity: AgentSessionJournalIdentity
): string | null {
  return codexHistoryFilePath(sessions, identity)
}
