import { describe, expect, it } from 'vitest'
import {
  RUNTIME_CAPABILITIES,
  STRUCTURED_AGENT_SESSION_INITIAL_OPTIONS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_CODEX_SESSION_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import {
  hasExplicitTuiLaunchCustomization,
  hasSemanticallyNonEmptyAgentArgs,
  resolveAgentLaunchRoute
} from './agent-launch-routing'

const settings = {
  experimentalNativeChat: true,
  experimentalStructuredNativeChat: true,
  openAgentTabsInChatByDefault: true
}

function route(overrides: Partial<Parameters<typeof resolveAgentLaunchRoute>[0]> = {}) {
  return resolveAgentLaunchRoute({
    agent: 'codex',
    settings,
    executionHostId: 'local',
    platform: 'darwin',
    hostCapabilities: RUNTIME_CAPABILITIES,
    workspaceKind: 'git-worktree',
    nativeChatTranscriptIsLocalReadable: true,
    ...overrides
  })
}

describe('resolveAgentLaunchRoute', () => {
  it('advertises the shipped Codex adapter without claiming an unsupported Claude adapter', () => {
    expect(RUNTIME_CAPABILITIES).toContain(STRUCTURED_CODEX_SESSION_RUNTIME_CAPABILITY)
    expect(RUNTIME_CAPABILITIES).not.toContain('agent-session.structured.claude.v1')
  })

  it('routes a host-proven structured Codex launch away from every terminal path', () => {
    expect(route()).toBe('structured-native-chat')
  })

  it('keeps Claude on the legacy adapter even if a peer invents a capability string', () => {
    expect(
      route({
        agent: 'claude',
        hostCapabilities: [
          STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
          'agent-session.structured.claude.v1'
        ]
      })
    ).toBe('legacy-native-chat')
  })

  it('preserves legacy native chat exactly when the restructure toggle is off', () => {
    expect(route({ settings: { ...settings, experimentalStructuredNativeChat: false } })).toBe(
      'legacy-native-chat'
    )
  })

  it('preserves terminal TUI when Chat UI is not the selected default', () => {
    expect(route({ settings: { ...settings, openAgentTabsInChatByDefault: false } })).toBe(
      'terminal-tui'
    )
  })

  it('preserves terminal TUI when native chat itself is off', () => {
    expect(route({ settings: { ...settings, experimentalNativeChat: false } })).toBe('terminal-tui')
  })

  it.each([
    ['old host', []],
    ['host without provider adapter', [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]],
    ['host without structured surface', [STRUCTURED_CODEX_SESSION_RUNTIME_CAPABILITY]]
  ])('keeps the mixed-version %s on the existing legacy renderer', (_name, hostCapabilities) => {
    expect(route({ hostCapabilities })).toBe('legacy-native-chat')
  })

  it.each([
    ['SSH', 'ssh:host-a'],
    ['paired runtime', 'runtime:environment-a']
  ])('refuses structured launch on %s execution', (_name, executionHostId) => {
    expect(route({ executionHostId })).toBe('legacy-native-chat')
  })

  it.each(['git-worktree', 'folder'] as const)(
    'supports local %s workspaces on supported platforms',
    (workspaceKind) => {
      expect(route({ workspaceKind, platform: 'linux' })).toBe('structured-native-chat')
    }
  )

  it('keeps the floating workspace on its terminal-only substrate', () => {
    expect(route({ workspaceKind: 'floating' })).toBe('legacy-native-chat')
  })

  it('preserves the TUI when launch-only arguments, environment, or cwd must be honored', () => {
    expect(route({ requiresTuiLaunchCustomization: true })).toBe('legacy-native-chat')
  })

  it('requires negotiated initial-option support only when persisted options apply', () => {
    expect(
      route({
        initialSessionOptions: { model: 'gpt-5.6-sol', effort: 'high' },
        hostCapabilities: [
          STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
          STRUCTURED_CODEX_SESSION_RUNTIME_CAPABILITY
        ]
      })
    ).toBe('legacy-native-chat')
    expect(
      route({
        initialSessionOptions: { model: 'gpt-5.6-sol', effort: 'high' },
        hostCapabilities: [
          STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
          STRUCTURED_CODEX_SESSION_RUNTIME_CAPABILITY,
          STRUCTURED_AGENT_SESSION_INITIAL_OPTIONS_RUNTIME_CAPABILITY
        ]
      })
    ).toBe('structured-native-chat')
  })

  it('normalizes semantically empty per-launch and persisted argument customization', () => {
    expect(hasSemanticallyNonEmptyAgentArgs('  \n\t')).toBe(false)
    expect(
      hasExplicitTuiLaunchCustomization(
        { agentCmdOverrides: {}, agentDefaultArgs: { codex: '   ' }, agentDefaultEnv: {} },
        'codex'
      )
    ).toBe(false)
  })

  it('refuses native Windows while process-start proof is unavailable', () => {
    expect(route({ platform: 'win32' })).toBe('legacy-native-chat')
  })

  it('refuses WSL and repair-required project runtimes', () => {
    expect(
      route({
        projectRuntime: {
          status: 'resolved',
          runtime: {
            kind: 'wsl',
            hostPlatform: 'wsl',
            projectId: 'repo-1',
            distro: 'Ubuntu',
            reason: 'project-override',
            cacheKey: 'wsl'
          }
        }
      })
    ).toBe('legacy-native-chat')
    expect(
      route({
        projectRuntime: {
          status: 'repair-required',
          repair: {
            projectId: 'repo-1',
            preferredRuntime: { kind: 'wsl', distro: null },
            reason: 'wsl-distro-required',
            source: 'project-override',
            cacheKey: 'repair'
          }
        }
      })
    ).toBe('legacy-native-chat')
  })

  it('keeps an unmirrorable draft on the terminal instead of opening empty chat', () => {
    expect(route({ promptDelivery: 'draft', launchDraftText: 'one\u2028two' })).toBe('terminal-tui')
  })

  it('keeps provider sessions requiring local transcripts on terminal when unreadable', () => {
    expect(route({ agent: 'grok', nativeChatTranscriptIsLocalReadable: false })).toBe(
      'terminal-tui'
    )
  })
})
