import type { TuiAgent } from '../../../shared/tui-agent'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { resolveInitialNativeChatSessionOptions } from '@/components/native-chat/native-chat-launch-session-options'
import {
  hasExplicitTuiLaunchCustomization,
  hasSemanticallyNonEmptyAgentArgs,
  normalizeStructuredCodexInitialOptions,
  resolveAgentLaunchRoute
} from '@/lib/agent-launch-routing'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { readLocalRuntimeCapabilities } from '@/runtime/local-runtime-capabilities'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import type { AppState } from '@/store'

export function resolveDirectWorkItemRouting(args: {
  store: AppState
  effectiveAgent: TuiAgent | null
  agentArgs?: string | null
  draftContent: string
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  launchPlatform: NodeJS.Platform
  launchConnectionId: string | null
  worktreeId: string
  settings: GlobalSettings | null | undefined
}): {
  structuredInitialOptions: ReturnType<typeof normalizeStructuredCodexInitialOptions>
  structuredLaunch: boolean
} {
  const structuredInitialOptions = args.effectiveAgent
    ? normalizeStructuredCodexInitialOptions(
        resolveInitialNativeChatSessionOptions(args.settings, {
          agent: args.effectiveAgent,
          promptDelivery: args.promptDelivery,
          launchDraftText: args.draftContent,
          nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(
            args.launchConnectionId
          )
        })
      )
    : undefined
  const launchRoute = args.effectiveAgent
    ? resolveAgentLaunchRoute({
        agent: args.effectiveAgent,
        settings: args.settings,
        executionHostId: getExecutionHostIdForWorktree(args.store, args.worktreeId),
        platform: args.launchPlatform,
        hostCapabilities: readLocalRuntimeCapabilities(),
        workspaceKind: 'git-worktree',
        projectRuntime: getLocalProjectExecutionRuntimeContext(
          args.store,
          args.worktreeId,
          CLIENT_PLATFORM
        ),
        promptDelivery: args.promptDelivery,
        launchDraftText: args.draftContent,
        nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(
          args.launchConnectionId
        ),
        requiresTuiLaunchCustomization:
          hasSemanticallyNonEmptyAgentArgs(args.agentArgs) ||
          hasExplicitTuiLaunchCustomization(args.settings, args.effectiveAgent),
        initialSessionOptions: structuredInitialOptions
      })
    : 'terminal-tui'
  return {
    structuredInitialOptions,
    structuredLaunch: launchRoute === 'structured-native-chat'
  }
}
