import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  STRUCTURED_AGENT_SESSION_INITIAL_OPTIONS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_CODEX_SESSION_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import {
  decideInitialAgentTabViewMode,
  type NativeChatLaunchPromptDelivery
} from '@/lib/native-chat-initial-view-mode'
import {
  getTuiAgentDefaultArgs,
  getTuiAgentDefaultEnv
} from '../../../shared/tui-agent-launch-defaults'
import type { StructuredCodexInitialOptions } from '@/lib/launch-structured-codex-session'

export type AgentLaunchRoute = 'structured-native-chat' | 'legacy-native-chat' | 'terminal-tui'

export type AgentLaunchRoutingInput = {
  agent: TuiAgent
  settings:
    | Pick<
        GlobalSettings,
        | 'experimentalNativeChat'
        | 'experimentalStructuredNativeChat'
        | 'openAgentTabsInChatByDefault'
      >
    | null
    | undefined
  executionHostId: string
  platform: NodeJS.Platform
  hostCapabilities: readonly string[]
  workspaceKind?: 'git-worktree' | 'folder' | 'floating'
  projectRuntime?: ProjectExecutionRuntimeResolution | null
  promptDelivery?: NativeChatLaunchPromptDelivery
  launchDraftText?: string
  nativeChatTranscriptIsLocalReadable?: boolean
  requiresTuiLaunchCustomization?: boolean
  initialSessionOptions?: Readonly<Record<string, unknown>>
}

export function hasExplicitTuiLaunchCustomization(
  settings:
    | Pick<GlobalSettings, 'agentCmdOverrides' | 'agentDefaultArgs' | 'agentDefaultEnv'>
    | null
    | undefined,
  agent: TuiAgent
): boolean {
  const configuredArgs = settings?.agentDefaultArgs?.[agent]
  const configuredEnv = settings?.agentDefaultEnv?.[agent]
  const defaultEnv = getTuiAgentDefaultEnv(agent)
  const envIsCustomized =
    configuredEnv !== undefined &&
    (Object.keys(configuredEnv).length !== Object.keys(defaultEnv).length ||
      Object.entries(configuredEnv).some(([key, value]) => defaultEnv[key] !== value))
  return (
    Boolean(settings?.agentCmdOverrides?.[agent]?.trim()) ||
    (configuredArgs !== undefined &&
      configuredArgs.trim().length > 0 &&
      configuredArgs.trim() !== getTuiAgentDefaultArgs(agent).trim()) ||
    envIsCustomized
  )
}

export function hasSemanticallyNonEmptyAgentArgs(value: string | null | undefined): boolean {
  return Boolean(value?.trim())
}

export function normalizeStructuredCodexInitialOptions(
  options: Readonly<Record<string, unknown>> | null | undefined
): StructuredCodexInitialOptions | undefined {
  const model = typeof options?.model === 'string' ? options.model.trim() : ''
  if (!model) {
    return undefined
  }
  const effort = typeof options?.effort === 'string' ? options.effort.trim() : ''
  return { model, ...(effort ? { effort } : {}) }
}

export function structuredAgentProviderCapability(agent: TuiAgent): string | null {
  if (agent === 'codex') {
    return STRUCTURED_CODEX_SESSION_RUNTIME_CAPABILITY
  }
  return null
}

/** One policy owns both the process runtime and the first rendered surface. */
export function resolveAgentLaunchRoute(input: AgentLaunchRoutingInput): AgentLaunchRoute {
  const initialViewMode = decideInitialAgentTabViewMode({
    experimentalNativeChat: input.settings?.experimentalNativeChat,
    openAgentTabsInChatByDefault: input.settings?.openAgentTabsInChatByDefault,
    agent: input.agent,
    promptDelivery: input.promptDelivery,
    launchDraftText: input.launchDraftText,
    nativeChatTranscriptIsLocalReadable: input.nativeChatTranscriptIsLocalReadable
  })
  if (initialViewMode !== 'chat') {
    return 'terminal-tui'
  }
  if (input.settings?.experimentalStructuredNativeChat !== true) {
    return 'legacy-native-chat'
  }

  const providerCapability = structuredAgentProviderCapability(input.agent)
  const projectRuntime = input.projectRuntime
  const runtimeRefused =
    projectRuntime?.status === 'repair-required' || projectRuntime?.runtime.kind === 'wsl'
  const structuredSupported =
    providerCapability !== null &&
    input.workspaceKind !== 'floating' &&
    input.requiresTuiLaunchCustomization !== true &&
    input.executionHostId === 'local' &&
    input.platform !== 'win32' &&
    !runtimeRefused &&
    input.hostCapabilities.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY) &&
    input.hostCapabilities.includes(providerCapability) &&
    (!input.initialSessionOptions || Object.keys(input.initialSessionOptions).length === 0
      ? true
      : input.hostCapabilities.includes(
          STRUCTURED_AGENT_SESSION_INITIAL_OPTIONS_RUNTIME_CAPABILITY
        ))

  return structuredSupported ? 'structured-native-chat' : 'legacy-native-chat'
}
