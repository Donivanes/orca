import { TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/tui-agent'

export async function preflightFolderWorkspaceAgentTrust(args: {
  agent: TuiAgent | null
  workspacePath: string | null
  connectionId?: string | null
}): Promise<void> {
  if (!args.agent || !window.api.agentTrust?.markTrusted) {
    return
  }
  const preflight = TUI_AGENT_CONFIG[args.agent].preflightTrust
  if (!preflight || !args.workspacePath) {
    return
  }
  try {
    await window.api.agentTrust.markTrusted({
      preset: preflight,
      workspacePath: args.workspacePath,
      ...(args.connectionId ? { connectionId: args.connectionId } : {})
    })
  } catch {
    // Best-effort: the user can still accept the agent trust prompt manually.
  }
}
