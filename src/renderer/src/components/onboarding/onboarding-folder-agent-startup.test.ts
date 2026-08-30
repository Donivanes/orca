import { describe, expect, it, vi } from 'vitest'
import { getDefaultOnboardingState, getDefaultSettings } from '../../../../shared/constants'
import {
  buildDismissedOnboardingFolderAgentStartup,
  buildOnboardingFolderAgentStartup,
  resolveDismissedOnboardingFolderAgentLaunch,
  shouldSeedFolderAgentAfterDismissedOnboarding
} from '@/lib/onboarding-folder-agent-startup'

vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilities: () => [
    'agent-session.structured.v1',
    'agent-session.structured.codex.v1',
    'agent-session.structured.initial-options.v1'
  ]
}))

describe('buildOnboardingFolderAgentStartup', () => {
  it('queues the persisted default agent with onboarding telemetry', () => {
    const startup = buildOnboardingFolderAgentStartup({
      ...getDefaultSettings('/tmp/orca-workspaces'),
      defaultTuiAgent: 'codex'
    })

    expect(startup).toEqual({
      command: "codex '--dangerously-bypass-approvals-and-sandbox'",
      env: {},
      launchAgent: 'codex',
      launchConfig: {
        agentCommand: "codex '--dangerously-bypass-approvals-and-sandbox'",
        agentArgs: '--dangerously-bypass-approvals-and-sandbox',
        agentEnv: {}
      },
      sessionOptions: undefined,
      telemetry: {
        agent_kind: 'codex',
        launch_source: 'onboarding',
        request_kind: 'new'
      }
    })
  })

  it('respects the blank terminal preference', () => {
    const startup = buildOnboardingFolderAgentStartup({
      ...getDefaultSettings('/tmp/orca-workspaces'),
      defaultTuiAgent: 'blank'
    })

    expect(startup).toBeUndefined()
  })

  it('omits native-chat preferences from terminal-default folder launches', () => {
    const startup = buildOnboardingFolderAgentStartup({
      ...getDefaultSettings('/tmp/orca-workspaces'),
      defaultTuiAgent: 'codex',
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: false,
      nativeChatSessionOptions: {
        codex: {
          model: 'gpt-5.2-codex',
          valuesByModel: { 'gpt-5.2-codex': { effort: 'medium' } }
        }
      }
    })

    expect(startup?.command).not.toContain("'-m'")
    expect(startup?.sessionOptions).toBeUndefined()
  })

  it('applies native-chat preferences to chat-default folder launches', () => {
    const startup = buildOnboardingFolderAgentStartup({
      ...getDefaultSettings('/tmp/orca-workspaces'),
      defaultTuiAgent: 'codex',
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true,
      nativeChatSessionOptions: {
        codex: {
          model: 'gpt-5.2-codex',
          valuesByModel: { 'gpt-5.2-codex': { effort: 'medium' } }
        }
      }
    })

    expect(startup?.command).toContain("'-m' 'gpt-5.2-codex'")
    expect(startup?.sessionOptions).toEqual({
      model: 'gpt-5.2-codex',
      effort: 'medium'
    })
  })

  it('does not infer an agent from auto mode', () => {
    const startup = buildOnboardingFolderAgentStartup({
      ...getDefaultSettings('/tmp/orca-workspaces'),
      defaultTuiAgent: null
    })

    expect(startup).toBeUndefined()
  })

  it('seeds after a dismissed onboarding run before any project was added', () => {
    expect(
      shouldSeedFolderAgentAfterDismissedOnboarding(
        {
          ...getDefaultOnboardingState(),
          outcome: 'dismissed'
        },
        false
      )
    ).toBe(true)
  })

  it('does not seed after another project was already added outside onboarding', () => {
    expect(
      shouldSeedFolderAgentAfterDismissedOnboarding(
        {
          ...getDefaultOnboardingState(),
          outcome: 'dismissed'
        },
        true
      )
    ).toBe(false)
  })

  it('does not seed after onboarding already added a project', () => {
    expect(
      shouldSeedFolderAgentAfterDismissedOnboarding(
        {
          ...getDefaultOnboardingState(),
          outcome: 'dismissed',
          checklist: { ...getDefaultOnboardingState().checklist, addedFolder: true }
        },
        false
      )
    ).toBe(false)
  })

  it('builds the skipped-onboarding folder startup from the persisted default agent', () => {
    expect(
      buildDismissedOnboardingFolderAgentStartup(
        {
          ...getDefaultSettings('/tmp/orca-workspaces'),
          defaultTuiAgent: 'codex',
          agentCmdOverrides: { codex: 'echo onboarding-folder-agent' }
        },
        { ...getDefaultOnboardingState(), outcome: 'dismissed' },
        false
      )
    ).toEqual({
      command: "echo onboarding-folder-agent '--dangerously-bypass-approvals-and-sandbox'",
      env: {},
      launchAgent: 'codex',
      launchConfig: {
        agentCommand: "echo onboarding-folder-agent '--dangerously-bypass-approvals-and-sandbox'",
        agentArgs: '--dangerously-bypass-approvals-and-sandbox',
        agentEnv: {}
      },
      sessionOptions: undefined,
      telemetry: {
        agent_kind: 'codex',
        launch_source: 'onboarding',
        request_kind: 'new'
      }
    })
  })

  it('routes dismissed-onboarding local Codex startup to structured native chat', () => {
    const launch = resolveDismissedOnboardingFolderAgentLaunch({
      settings: {
        ...getDefaultSettings('/tmp/orca-workspaces'),
        defaultTuiAgent: 'codex',
        experimentalNativeChat: true,
        experimentalStructuredNativeChat: true,
        openAgentTabsInChatByDefault: true
      },
      onboarding: { ...getDefaultOnboardingState(), outcome: 'dismissed' },
      hasExistingProject: false,
      executionHostId: 'local'
    })

    expect(launch).toMatchObject({
      agent: 'codex',
      route: 'structured-native-chat',
      structuredTelemetry: {
        agent_kind: 'codex',
        launch_source: 'onboarding',
        request_kind: 'new'
      }
    })
  })

  it('preserves dismissed-onboarding terminal startup when restructure is off', () => {
    const launch = resolveDismissedOnboardingFolderAgentLaunch({
      settings: {
        ...getDefaultSettings('/tmp/orca-workspaces'),
        defaultTuiAgent: 'codex',
        experimentalNativeChat: true,
        experimentalStructuredNativeChat: false,
        openAgentTabsInChatByDefault: true
      },
      onboarding: { ...getDefaultOnboardingState(), outcome: 'dismissed' },
      hasExistingProject: false,
      executionHostId: 'local'
    })

    expect(launch.route).toBe('legacy-native-chat')
    expect(launch.startup?.launchAgent).toBe('codex')
  })
})
