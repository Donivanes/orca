import { ensureAgentStartupInTerminal } from '@/lib/new-workspace'
import { seedNativeChatAppliedSessionOptions } from '@/components/native-chat/native-chat-session-option-cache'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { ActivateAndRevealResult } from '@/lib/worktree-activation'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { activateStructuredAgentSessionById } from '@/lib/structured-agent-session-tab-activation'

export function focusPublishedStructuredSession(worktreeId: string, sessionId: string): void {
  activateStructuredAgentSessionById({ worktreeId, sessionId })
}

export function continueFullCreationActivation(args: {
  worktreeId: string
  activation: ActivateAndRevealResult | false
  startupPlan: AgentStartupPlan | null
  structuredLaunch: boolean
  backendSpawnedStartup: boolean
  startupTerminalTabId?: string
  tuiAgent: TuiAgent
}): void {
  if (!args.structuredLaunch && args.startupPlan) {
    const optionScopeKey =
      (args.activation !== false ? args.activation.primaryTabId : null) ?? args.startupTerminalTabId
    if (optionScopeKey) {
      seedNativeChatAppliedSessionOptions(
        optionScopeKey,
        args.tuiAgent,
        args.startupPlan.sessionOptions
      )
    }
  }
  if (!args.structuredLaunch && args.startupPlan && !args.backendSpawnedStartup) {
    void ensureAgentStartupInTerminal({
      worktreeId: args.worktreeId,
      primaryTabId: args.activation === false ? null : args.activation.primaryTabId,
      startup: args.startupPlan
    })
  }
}
