import { toast } from 'sonner'
import { seedNativeChatLaunchDraftForAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { pasteDirectWorkItemDraftWhenAgentReady } from './launch-work-item-direct-agent'
import { agentLaunchCommandErrorMessage } from './launch-work-item-direct-messages'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { TuiAgent } from '../../../shared/tui-agent'

export function finishDirectWorkItemLaunch(args: {
  startupPlanFailed: boolean
  primaryTabId: string | null
  effectiveAgent: TuiAgent | null
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  draftContent: string
  startupPlan: AgentStartupPlan | null
  draftLaunchedNatively: boolean
}): boolean {
  if (args.startupPlanFailed) {
    toast.error(agentLaunchCommandErrorMessage())
    return false
  }
  if (args.promptDelivery === 'draft' && args.primaryTabId && args.effectiveAgent) {
    seedNativeChatLaunchDraftForAgentTab({
      tabId: args.primaryTabId,
      agent: args.effectiveAgent,
      text: args.draftContent
    })
  }
  if (!args.primaryTabId || !args.startupPlan || args.draftLaunchedNatively) {
    return true
  }
  if (args.promptDelivery === 'draft' && args.startupPlan.draftPrompt) {
    return true
  }
  void pasteDirectWorkItemDraftWhenAgentReady({
    primaryTabId: args.primaryTabId,
    startupPlan: args.startupPlan,
    content: args.draftContent,
    submit: args.promptDelivery === 'submit-after-ready',
    forcePaste: args.promptDelivery === 'submit-after-ready'
  })
  return true
}
