import type { AgentStartedTelemetry, WorktreeStartupPayload } from '@/lib/worktree-startup-payload'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { createBrowserUuid } from '@/lib/browser-uuid'

export function buildFullCreationStartupPayload(args: {
  startupPlan: AgentStartupPlan | null
  backendSpawnedStartup: boolean
  tuiAgent: TuiAgent
  shouldSeedInitialAgentStatus: boolean
  submitStartupPrompt: string
  composerTelemetry: AgentStartedTelemetry
}): WorktreeStartupPayload | undefined {
  const { startupPlan } = args
  if (!startupPlan || args.backendSpawnedStartup) {
    return undefined
  }
  if (!startupPlan.launchToken) {
    startupPlan.launchToken = createBrowserUuid()
  }
  return {
    command: startupPlan.launchCommand,
    ...(startupPlan.env ? { env: startupPlan.env } : {}),
    launchConfig: startupPlan.launchConfig,
    ...(startupPlan.launchToken ? { launchToken: startupPlan.launchToken } : {}),
    launchAgent: args.tuiAgent,
    ...(startupPlan.draftPrompt ? { draftPrompt: startupPlan.draftPrompt } : {}),
    ...(startupPlan.startupCommandDelivery
      ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
      : {}),
    ...(args.shouldSeedInitialAgentStatus
      ? {
          initialAgentStatus: {
            agent: args.tuiAgent,
            prompt: args.submitStartupPrompt.trim()
          }
        }
      : {}),
    telemetry: args.composerTelemetry
  }
}
