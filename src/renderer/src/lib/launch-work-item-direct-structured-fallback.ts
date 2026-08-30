import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import type { LaunchSource } from '../../../shared/telemetry-events'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import { buildDirectWorkItemStartupOpts } from './launch-work-item-direct-agent'

export function runDirectWorkItemStructuredFallback(args: {
  worktreeId: string
  effectiveAgent: TuiAgent | null
  startupPlan: AgentStartupPlan | null
  launchSource: LaunchSource
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  draftContent: string
}): string | null {
  const activation = activateAndRevealWorktree(args.worktreeId, {
    sidebarRevealBehavior: 'auto',
    createNewTerminalForStartup: true,
    ...buildDirectWorkItemStartupOpts(
      args.effectiveAgent,
      args.startupPlan,
      args.launchSource,
      args.promptDelivery === 'draft' ? args.draftContent : undefined
    )
  })
  return activation === false ? null : activation.primaryTabId
}
