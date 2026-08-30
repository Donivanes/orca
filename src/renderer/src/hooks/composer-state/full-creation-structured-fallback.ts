import { ensureAgentStartupInTerminal } from '@/lib/new-workspace'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import type { AgentStartedTelemetry } from '@/lib/worktree-startup-payload'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { buildFullCreationStartupPayload } from './full-creation-startup-payload'

export async function runStructuredWorktreeLaunchFallback(args: {
  worktreeId: string
  startupPlan: AgentStartupPlan | null
  backendSpawnedStartup: boolean
  tuiAgent: TuiAgent
  shouldSeedInitialAgentStatus: boolean
  submitStartupPrompt: string
  composerTelemetry: AgentStartedTelemetry
  restorePendingRename?: () => Promise<void>
}): Promise<void> {
  const { startupPlan } = args
  await args.restorePendingRename?.()
  if (startupPlan && !startupPlan.launchToken) {
    startupPlan.launchToken = createBrowserUuid()
  }
  const fallbackActivation = activateAndRevealWorktree(args.worktreeId, {
    sidebarRevealBehavior: 'auto',
    createNewTerminalForStartup: true,
    startup: buildFullCreationStartupPayload(args)
  })
  if (startupPlan && !args.backendSpawnedStartup) {
    void ensureAgentStartupInTerminal({
      worktreeId: args.worktreeId,
      primaryTabId: fallbackActivation === false ? null : fallbackActivation.primaryTabId,
      startup: startupPlan
    })
  }
}
