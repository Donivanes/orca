// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useFullCreationExecution,
  type FullCreationExecutionInput
} from './full-creation-execution'
import type { PreparedFullSubmit } from './composer-submit-model'
import { getDefaultSettings } from '../../../../shared/constants'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-codex-session'
import type {
  StructuredCodexLaunchReceipt,
  StructuredCodexLaunchResult
} from '@/lib/structured-agent-session-launch'
import { makeWorktree } from '@/store/slices/store-test-helpers'

const mocks = vi.hoisted(() => ({
  activateAndRevealWorktree: vi.fn(),
  activateStructuredAgentSessionById: vi.fn(),
  ensureAgentStartupInTerminal: vi.fn(),
  queueWorkspaceActivationTerminalFocus: vi.fn(),
  startStructuredCodexLaunch: vi.fn()
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('@/lib/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionById: mocks.activateStructuredAgentSessionById
}))

vi.mock('@/lib/new-workspace', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, ensureAgentStartupInTerminal: mocks.ensureAgentStartupInTerminal }
})

vi.mock('@/lib/workspace-activation-terminal-focus', () => ({
  queueWorkspaceActivationTerminalFocus: mocks.queueWorkspaceActivationTerminalFocus
}))

vi.mock('@/lib/structured-agent-session-launch', () => ({
  startStructuredCodexLaunch: mocks.startStructuredCodexLaunch
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilities: () => [
    'agent-session.structured.v1',
    'agent-session.structured.codex.v1',
    'agent-session.structured.initial-options.v1'
  ]
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function structuredLaunchResult(
  sessionId: string,
  launchResult: Promise<StructuredCodexLaunchReceipt>
): StructuredCodexLaunchResult {
  let fallbackResult: Promise<boolean> | null = null
  return {
    sessionId,
    launchResult,
    claimDefinitiveRefusalFallback: (fallback) => {
      fallbackResult ??= launchResult.then(
        () => false,
        async (error) => {
          if (!(error instanceof StructuredAgentSessionCreateRefusalError)) {
            return false
          }
          await fallback()
          return true
        }
      )
      return fallbackResult
    }
  }
}

describe('useFullCreationExecution cancellation', () => {
  it('does not create after dismissal while the late startup-policy preflight is pending', async () => {
    const startupPolicy = deferred<boolean>()
    let cancelled = false
    const createWorktree = vi.fn<FullCreationExecutionInput['createWorktree']>()
    const prepared = {
      submitLinkedWorkItem: null,
      submitLinkedIssueNumber: null,
      submitLinkedPR: null,
      submitTitleName: null,
      nameIsAutoManaged: false,
      smartGitHubCreateNames: {
        workspaceName: 'workspace',
        displayName: undefined
      },
      workspaceName: 'workspace',
      nameWasGenerated: false,
      submitBaseBranch: 'main',
      submitCompareBaseRef: undefined,
      submitPushTarget: undefined,
      submitBranchNameOverride: undefined,
      submitLinkedWorkItemProvider: null,
      submitStartupPrompt: '',
      submitShouldRunIssueAutomation: false,
      effectiveSetupDecision: 'skip',
      issueCommandTrustDecision: 'skip',
      confirmedIssueCommandTemplate: '',
      linkedLinearIssue: undefined,
      linkedLinearIssueWorkspaceId: undefined,
      linkedLinearIssueOrganizationUrlKey: undefined,
      effectiveBranchNameOverride: undefined,
      createDisplayName: undefined,
      pendingFirstAgentMessageRename: false,
      startupPlan: null,
      shouldSeedInitialAgentStatus: false,
      composerTelemetry: {
        agent_kind: 'claude-code',
        launch_source: 'new_workspace_composer',
        request_kind: 'new'
      },
      backendStartup: undefined
    } satisfies PreparedFullSubmit
    const persistSetupAgentStartupPolicy = vi.fn(() => startupPolicy.promise)
    const state = {
      applyWorktreeMeta: vi
        .fn<FullCreationExecutionInput['applyWorktreeMeta']>()
        .mockResolvedValue(),
      clearNewWorkspaceDraft: vi.fn<FullCreationExecutionInput['clearNewWorkspaceDraft']>(),
      createWorktree,
      effectivePresetId: null,
      isSubmissionCancelled: () => cancelled,
      linkedGitLabIssue: null,
      linkedGitLabMR: null,
      normalizedSparseDirectories: [],
      note: '',
      onCreated: vi.fn<NonNullable<FullCreationExecutionInput['onCreated']>>(),
      parentWorktreeId: null,
      persistDraft: false,
      persistSetupAgentStartupPolicy,
      prepareFullSubmit: vi
        .fn<FullCreationExecutionInput['prepareFullSubmit']>()
        .mockResolvedValue(prepared),
      resolvedInitialWorkspaceStatus: undefined,
      selectedRepoExecutionHostId: 'local',
      selectedRepoIsGit: true,
      selectedRepoIsRemote: false,
      setSidebarOpen: vi.fn<FullCreationExecutionInput['setSidebarOpen']>(),
      settings: null,
      sparseEnabled: false,
      taskSourceContext: null,
      telemetrySource: undefined,
      tuiAgent: 'claude'
    } satisfies FullCreationExecutionInput
    const hook = renderHook(() => useFullCreationExecution(state))

    let creation!: Promise<void>
    act(() => {
      creation = hook.result.current.executeFullCreation({ kind: 'none' }, 'repo-1')
    })
    await act(() => Promise.resolve())
    expect(persistSetupAgentStartupPolicy).toHaveBeenCalledTimes(1)

    cancelled = true
    startupPolicy.resolve(true)
    await act(async () => creation)

    expect(createWorktree).not.toHaveBeenCalled()
  })
})

describe('useFullCreationExecution launch routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.activateStructuredAgentSessionById.mockReturnValue(true)
    mocks.startStructuredCodexLaunch.mockReturnValue(
      structuredLaunchResult('session-1', Promise.resolve({ sessionId: 'session-1', fence: 1 }))
    )
  })

  function inputFor(
    structured: boolean,
    pendingFirstAgentMessageRename = false
  ): FullCreationExecutionInput {
    const startupPlan = {
      agent: 'codex' as const,
      launchCommand: "codex 'Fix the route'",
      expectedProcess: 'codex',
      followupPrompt: null,
      launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} }
    }
    const prepared = {
      submitLinkedWorkItem: null,
      submitLinkedIssueNumber: null,
      submitLinkedPR: null,
      submitTitleName: null,
      nameIsAutoManaged: false,
      smartGitHubCreateNames: { workspaceName: 'route-workspace', displayName: undefined },
      workspaceName: 'route-workspace',
      nameWasGenerated: false,
      submitBaseBranch: 'main',
      submitCompareBaseRef: undefined,
      submitPushTarget: undefined,
      submitBranchNameOverride: undefined,
      submitLinkedWorkItemProvider: null,
      submitStartupPrompt: 'Fix the route',
      submitShouldRunIssueAutomation: false,
      effectiveSetupDecision: 'skip' as const,
      issueCommandTrustDecision: 'skip' as const,
      confirmedIssueCommandTemplate: '',
      linkedLinearIssue: undefined,
      linkedLinearIssueWorkspaceId: undefined,
      linkedLinearIssueOrganizationUrlKey: undefined,
      effectiveBranchNameOverride: undefined,
      createDisplayName: undefined,
      pendingFirstAgentMessageRename,
      startupPlan,
      shouldSeedInitialAgentStatus: false,
      composerTelemetry: {
        agent_kind: 'codex' as const,
        launch_source: 'new_workspace_composer' as const,
        request_kind: 'new' as const
      },
      backendStartup: { command: startupPlan.launchCommand, launchAgent: 'codex' as const }
    } satisfies PreparedFullSubmit
    return {
      applyWorktreeMeta: vi.fn().mockResolvedValue(undefined),
      clearNewWorkspaceDraft: vi.fn(),
      createWorktree: vi.fn().mockResolvedValue({
        worktree: makeWorktree({
          id: 'wt-created',
          repoId: 'repo-1',
          path: '/repo/wt-created'
        }),
        setup: null,
        defaultTabs: undefined
      }),
      effectivePresetId: null,
      isSubmissionCancelled: () => false,
      linkedGitLabIssue: null,
      linkedGitLabMR: null,
      normalizedSparseDirectories: [],
      note: '',
      onCreated: vi.fn(),
      parentWorktreeId: null,
      persistDraft: false,
      persistSetupAgentStartupPolicy: vi.fn().mockResolvedValue(true),
      prepareFullSubmit: vi.fn().mockResolvedValue(prepared),
      resolvedInitialWorkspaceStatus: undefined,
      selectedRepoExecutionHostId: 'local',
      selectedRepoIsGit: true,
      selectedRepoIsRemote: false,
      setSidebarOpen: vi.fn(),
      settings: {
        ...getDefaultSettings('/tmp/orca-workspaces'),
        experimentalNativeChat: true,
        experimentalStructuredNativeChat: structured,
        openAgentTabsInChatByDefault: true
      },
      sparseEnabled: false,
      taskSourceContext: null,
      telemetrySource: undefined,
      tuiAgent: 'codex'
    }
  }

  it('omits every TUI startup and opens structured Codex after full creation', async () => {
    const input = inputFor(true)
    mocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: 'tab-1' })
    const { result } = renderHook(() => useFullCreationExecution(input))

    await act(() => result.current.executeFullCreation({ kind: 'none' }, 'repo-1'))

    expect(vi.mocked(input.createWorktree).mock.calls[0]?.[16]).toBeUndefined()
    expect(vi.mocked(input.createWorktree).mock.calls[0]?.[17]).toBe(false)
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(
      'wt-created',
      expect.not.objectContaining({ startup: expect.anything() })
    )
    expect(mocks.ensureAgentStartupInTerminal).not.toHaveBeenCalled()
    expect(mocks.startStructuredCodexLaunch).toHaveBeenCalledWith('wt-created', {
      prompt: 'Fix the route',
      promptDelivery: 'auto-submit',
      telemetry: {
        agent_kind: 'codex',
        launch_source: 'new_workspace_composer',
        request_kind: 'new'
      }
    })
    expect(mocks.queueWorkspaceActivationTerminalFocus).not.toHaveBeenCalled()
  })

  it('focuses the structured tab after publication wins the initial terminal activation', async () => {
    const events: string[] = []
    const publication = deferred<StructuredCodexLaunchReceipt>()
    mocks.activateAndRevealWorktree.mockImplementation(() => {
      events.push('initial-surface-activation')
      return { primaryTabId: 'terminal-1' }
    })
    mocks.startStructuredCodexLaunch.mockReturnValueOnce(
      structuredLaunchResult(
        'session-published',
        publication.promise.then((receipt) => {
          events.push('structured-session-publication')
          return receipt
        })
      )
    )
    mocks.activateStructuredAgentSessionById.mockImplementation(() => {
      events.push('renderer-tab-focus')
      return true
    })
    const input = inputFor(true)
    const { result } = renderHook(() => useFullCreationExecution(input))

    let execution!: Promise<void>
    await act(async () => {
      execution = result.current.executeFullCreation({ kind: 'none' }, 'repo-1')
      await Promise.resolve()
    })
    expect(events).toEqual(['initial-surface-activation'])

    publication.resolve({ sessionId: 'session-published', fence: 1 })
    await act(async () => execution)

    expect(events).toEqual([
      'initial-surface-activation',
      'structured-session-publication',
      'renderer-tab-focus'
    ])
    expect(mocks.activateStructuredAgentSessionById).toHaveBeenCalledWith({
      worktreeId: 'wt-created',
      sessionId: 'session-published'
    })
  })

  it('installs the preserved TUI in a dedicated terminal after structured refusal', async () => {
    const input = inputFor(true, true)
    vi.mocked(input.createWorktree).mockResolvedValue({
      worktree: makeWorktree({
        id: 'wt-created',
        repoId: 'repo-1',
        path: '/repo/wt-created'
      }),
      setup: { runnerScriptPath: '/repo/setup.sh', envVars: {} },
      defaultTabs: undefined
    })
    mocks.activateAndRevealWorktree
      .mockReturnValueOnce({ primaryTabId: 'setup-tab' })
      .mockReturnValueOnce({ primaryTabId: 'fallback-tab' })
    mocks.startStructuredCodexLaunch.mockReturnValueOnce(
      structuredLaunchResult(
        'session-1',
        Promise.reject(new StructuredAgentSessionCreateRefusalError('refused'))
      )
    )
    const { result } = renderHook(() => useFullCreationExecution(input))

    await act(() => result.current.executeFullCreation({ kind: 'none' }, 'repo-1'))

    expect(mocks.activateAndRevealWorktree).toHaveBeenNthCalledWith(
      2,
      'wt-created',
      expect.objectContaining({
        createNewTerminalForStartup: true,
        startup: expect.objectContaining({
          command: "codex 'Fix the route'",
          launchToken: expect.any(String)
        })
      })
    )
    expect(mocks.ensureAgentStartupInTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryTabId: 'fallback-tab',
        startup: expect.objectContaining({ launchToken: expect.any(String) })
      })
    )
    expect(input.applyWorktreeMeta).toHaveBeenCalledWith('wt-created', {
      pendingFirstAgentMessageRename: true
    })
  })

  it('preserves full-creation TUI startup when restructure is off', async () => {
    const input = inputFor(false)
    const legacyActivation = { primaryTabId: 'legacy-chat-terminal' }
    mocks.activateAndRevealWorktree.mockReturnValue(legacyActivation)
    const { result } = renderHook(() => useFullCreationExecution(input))

    await act(() => result.current.executeFullCreation({ kind: 'none' }, 'repo-1'))

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(
      'wt-created',
      expect.objectContaining({ startup: expect.objectContaining({ launchAgent: 'codex' }) })
    )
    expect(mocks.startStructuredCodexLaunch).not.toHaveBeenCalled()
    expect(mocks.activateStructuredAgentSessionById).not.toHaveBeenCalled()
    expect(mocks.queueWorkspaceActivationTerminalFocus).toHaveBeenCalledWith(
      'wt-created',
      legacyActivation
    )
  })
})
