import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../shared/tui-agent'

export async function preflightDirectWorkItemAgentTrust(args: {
  agent: TuiAgent | null
  workspacePath: string
  connectionId?: string | null
}): Promise<void> {
  if (!args.agent || !window.api.agentTrust?.markTrusted) {
    return
  }
  const preflight = TUI_AGENT_CONFIG[args.agent].preflightTrust
  if (!preflight) {
    return
  }
  try {
    await window.api.agentTrust.markTrusted({
      preset: preflight,
      workspacePath: args.workspacePath,
      ...(args.connectionId ? { connectionId: args.connectionId } : {})
    })
  } catch {
    // Best-effort: continue with launch if the trust artifact write fails.
  }
}
