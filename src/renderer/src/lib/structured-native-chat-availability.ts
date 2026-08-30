import type { AppState } from '@/store/types'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { readLocalRuntimeCapabilities } from '@/runtime/local-runtime-capabilities'
import type { TuiAgent } from '../../../shared/tui-agent'
import { resolveAgentLaunchRoute } from '@/lib/agent-launch-routing'

export function canUseStructuredNativeChat(
  state: AppState,
  worktreeId: string,
  agent: TuiAgent = 'codex'
): boolean {
  return (
    resolveAgentLaunchRoute({
      agent,
      settings: state.settings,
      executionHostId: getExecutionHostIdForWorktree(state, worktreeId),
      platform: getRendererAppPlatform(),
      hostCapabilities: readLocalRuntimeCapabilities(),
      workspaceKind: worktreeId.startsWith('folder:') ? 'folder' : 'git-worktree',
      projectRuntime: getLocalProjectExecutionRuntimeContext(state, worktreeId),
      nativeChatTranscriptIsLocalReadable: true
    }) === 'structured-native-chat'
  )
}
