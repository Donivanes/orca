import type { StructuredCodexLaunchResult } from '@/lib/structured-agent-session-launch'
import type { AgentStartedTelemetry } from '@/lib/worktree-startup-payload'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { runStructuredWorktreeLaunchFallback } from './full-creation-structured-fallback'

export function claimFullCreationStructuredRefusalFallback(
  launch: StructuredCodexLaunchResult,
  args: {
    worktreeId: string
    startupPlan: AgentStartupPlan | null
    backendSpawnedStartup: boolean
    tuiAgent: TuiAgent
    shouldSeedInitialAgentStatus: boolean
    submitStartupPrompt: string
    composerTelemetry: AgentStartedTelemetry
    restorePendingRename?: () => Promise<void>
  }
): Promise<boolean> {
  return launch.claimDefinitiveRefusalFallback(() => runStructuredWorktreeLaunchFallback(args))
}
