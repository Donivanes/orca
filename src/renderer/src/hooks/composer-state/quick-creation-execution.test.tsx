// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreparedQuickSubmit } from './composer-submit-model'

const mocks = vi.hoisted(() => ({
  runBackgroundWorktreeCreation: vi.fn(),
  resolveAgentLaunchRoute: vi.fn(() => 'structured-native-chat' as const)
}))

vi.mock('@/lib/worktree-creation-flow', () => ({
  runBackgroundWorktreeCreation: mocks.runBackgroundWorktreeCreation
}))

vi.mock('@/lib/agent-launch-routing', () => ({
  hasExplicitTuiLaunchCustomization: () => false,
  normalizeStructuredCodexInitialOptions: () => undefined,
  resolveAgentLaunchRoute: mocks.resolveAgentLaunchRoute
}))

vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilities: () => []
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: () => ({ kind: 'local' })
}))

vi.mock('@/lib/linked-work-item-context', () => ({
  resolveQuickCreateLinkedWorkItemPrompt: () => ({ prompt: 'Fix it', draftPrompt: null })
}))

vi.mock('./quick-startup-plan', () => ({
  buildQuickComposerStartup: () => ({
    startupPlan: {
      agent: 'codex',
      launchCommand: 'codex',
      expectedProcess: 'codex',
      followupPrompt: null,
      launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} }
    },
    backendStartup: { command: 'codex' },
    telemetry: null
  })
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({}) }
}))

import { useQuickCreationExecution } from './quick-creation-execution'

function blankNamePreparedQuickSubmit(): PreparedQuickSubmit {
  return {
    submitLinkedWorkItem: null,
    agent: 'codex',
    submitLinkedIssueNumber: null,
    submitLinkedPR: null,
    submitTitleName: null,
    nameIsAutoManaged: true,
    smartGitHubCreateNames: { workspaceName: 'generated-name', displayName: undefined },
    workspaceName: 'generated-name',
    nameWasGenerated: true,
    smartSubmitBaseBranch: undefined,
    submitCompareBaseRef: undefined,
    submitPushTarget: undefined,
    submitBranchNameOverride: undefined,
    effectiveSetupDecision: 'inherit',
    issueCommand: undefined,
    linkedLinearIssue: undefined,
    linkedLinearIssueWorkspaceId: undefined,
    linkedLinearIssueOrganizationUrlKey: undefined,
    effectiveBranchNameOverride: undefined,
    submitBaseBranch: 'main',
    createDisplayName: undefined,
    pendingFirstAgentMessageRename: true,
    trimmedNote: ''
  }
}

describe('quick creation execution', () => {
  beforeEach(() => vi.clearAllMocks())

  it('carries blank-name rename ownership through a structured refusal-capable request', async () => {
    const prepareQuickSubmit = vi.fn(async () => blankNamePreparedQuickSubmit())
    const input = {
      clearNewWorkspaceDraft: vi.fn(),
      createMultiple: false,
      effectivePresetId: null,
      ephemeralVmRecipes: [],
      ephemeralVmsEnabled: false,
      isSubmissionCancelled: () => false,
      linkedGitLabIssue: null,
      linkedGitLabMR: null,
      normalizedSparseDirectories: [],
      onCreated: vi.fn(),
      parentWorktreeId: null,
      persistDraft: false,
      persistSetupAgentStartupPolicy: () => Promise.resolve(true),
      prepareQuickSubmit,
      resetForNextCreate: vi.fn(),
      resolvedInitialWorkspaceStatus: undefined,
      selectedEphemeralVmRecipeId: null,
      selectedRepoAgentLaunchPlatform: 'darwin',
      selectedRepoExecutionHostId: 'local',
      selectedRepoIsGit: true,
      selectedRepoIsRemote: false,
      selectedRepoSettings: undefined,
      selectedRepoStartupShell: undefined,
      selectedWorkspaceTarget: { status: 'idle' },
      settings: { autoRenameBranchFromWork: true },
      sparseEnabled: false,
      taskSourceContext: null,
      telemetrySource: undefined
    } as unknown as Parameters<typeof useQuickCreationExecution>[0]
    const hook = renderHook(() => useQuickCreationExecution(input))

    await act(() =>
      hook.result.current.executeQuickCreation({ kind: 'none' }, 'codex', '', null, 'repo-1', {
        id: 'repo-1',
        path: '/repo',
        displayName: 'Repo',
        badgeColor: '#000000',
        addedAt: 1,
        connectionId: null
      })
    )

    expect(prepareQuickSubmit).toHaveBeenCalledWith({ kind: 'none' }, 'codex', '')
    expect(mocks.runBackgroundWorktreeCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        agentLaunchRoute: 'structured-native-chat',
        pendingFirstAgentMessageRename: true
      })
    )
  })
})
