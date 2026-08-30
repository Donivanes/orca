import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TuiAgentSelectionModule from '../../../shared/tui-agent-selection'
import type * as TuiAgentStartupModule from '@/lib/tui-agent-startup'

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  createWorktree: vi.fn(),
  ensureDetectedAgents: vi.fn(),
  ensureRemoteDetectedAgents: vi.fn(),
  updateWorktreeMeta: vi.fn(),
  setSidebarOpen: vi.fn(),
  seedNativeChatLaunchPrompt: vi.fn(),
  seedNativeChatLaunchDraft: vi.fn(),
  markNativeChatLaunchPromptFailed: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  pasteDraftWhenAgentReady: vi.fn(),
  openModalFallback: vi.fn(),
  resolvePrBase: vi.fn(),
  getConnectionId: vi.fn(),
  startStructuredCodexLaunch: vi.fn(),
  store: {} as Record<string, unknown> & {
    ensureDetectedAgents: ReturnType<typeof vi.fn>
    ensureRemoteDetectedAgents: ReturnType<typeof vi.fn>
    createWorktree: ReturnType<typeof vi.fn>
    updateWorktreeMeta: ReturnType<typeof vi.fn>
    setSidebarOpen: ReturnType<typeof vi.fn>
    seedNativeChatLaunchPrompt: ReturnType<typeof vi.fn>
    seedNativeChatLaunchDraft: ReturnType<typeof vi.fn>
    markNativeChatLaunchPromptFailed: ReturnType<typeof vi.fn>
  }
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.store
  }
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    message: vi.fn()
  }
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mocks.pasteDraftWhenAgentReady
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('@/lib/ensure-hooks-confirmed', () => ({
  ensureHooksConfirmed: vi.fn().mockResolvedValue('run')
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: mocks.getConnectionId
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

vi.mock('@/runtime/runtime-hooks-client', () => ({
  checkRuntimeHooks: vi
    .fn()
    .mockResolvedValue({ hasHooks: false, hooks: null, mayNeedUpdate: false })
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: vi.fn().mockReturnValue({ kind: 'local' }),
  callRuntimeRpc: vi.fn()
}))

vi.mock('@/lib/new-workspace', () => ({
  CLIENT_PLATFORM: 'win32',
  getWorkspaceIntentName: (args: {
    workItem?: { type: 'issue' | 'pr' | 'mr'; number: number; title: string } | null
  }) =>
    args.workItem
      ? {
          displayName:
            args.workItem.type === 'pr'
              ? `Review PR ${args.workItem.number}`
              : `Issue ${args.workItem.number}`,
          seedName:
            args.workItem.type === 'pr'
              ? `review-pr-${args.workItem.number}`
              : `issue-${args.workItem.number}`
        }
      : null,
  getSetupConfig: vi.fn(() => null),
  getWorkspaceSeedName: ({ explicitName }: { explicitName?: string }) => explicitName ?? '',
  isGitLabIssueUrl: vi.fn(() => false)
}))

vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))

vi.mock('@/lib/tui-agent-startup', async () => {
  const actual = await vi.importActual<typeof TuiAgentStartupModule>('@/lib/tui-agent-startup')
  return {
    ...actual,
    buildAgentDraftLaunchPlan: vi.fn(actual.buildAgentDraftLaunchPlan),
    buildAgentStartupPlan: vi.fn(actual.buildAgentStartupPlan)
  }
})

vi.mock('../../../shared/tui-agent-selection', async () => {
  const actual = await vi.importActual<typeof TuiAgentSelectionModule>(
    '../../../shared/tui-agent-selection'
  )
  return {
    ...actual,
    pickTuiAgent: vi.fn(actual.pickTuiAgent)
  }
})

import { launchWorkItemDirect } from './launch-work-item-direct'
import { buildAgentDraftLaunchPlan, buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-codex-session'
import type {
  StructuredCodexLaunchReceipt,
  StructuredCodexLaunchResult
} from '@/lib/structured-agent-session-launch'

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

const mockApi = {
  worktrees: {
    resolvePrBase: mocks.resolvePrBase
  },
  agentTrust: {
    markTrusted: vi.fn()
  }
}

describe('launchWorkItemDirect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', {
      api: {
        worktrees: {
          resolvePrBase: mocks.resolvePrBase
        },
        agentTrust: {
          markTrusted: mockApi.agentTrust.markTrusted
        }
      }
    })
    mocks.resolvePrBase.mockResolvedValue({
      baseBranch: 'abc123',
      compareBaseRef: 'refs/remotes/origin/main',
      headSha: 'abc123',
      branchNameOverride: 'feature/fix',
      pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
    })
    mocks.ensureDetectedAgents.mockResolvedValue(['codex'])
    mocks.ensureRemoteDetectedAgents.mockResolvedValue(['codex'])
    mocks.getConnectionId.mockReturnValue(null)
    mocks.createWorktree.mockResolvedValue({
      worktree: { id: 'repo-1::/repo/worktree', path: '/repo/worktree' },
      setup: undefined
    })
    mocks.updateWorktreeMeta.mockResolvedValue(undefined)
    mocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: 'tab-1' })
    mocks.pasteDraftWhenAgentReady.mockResolvedValue(true)
    mocks.startStructuredCodexLaunch.mockReturnValue(
      structuredLaunchResult('session-1', Promise.resolve({ sessionId: 'session-1', fence: 1 }))
    )
    mocks.store = {
      repos: [
        {
          id: 'repo-1',
          path: '/repo',
          displayName: 'Repo',
          addedAt: 1
        }
      ],
      activeRepoId: 'repo-1',
      activeWorktreeId: null,
      projects: [
        {
          id: 'repo-1',
          displayName: 'Repo',
          badgeColor: '#000000',
          sourceRepoIds: ['repo-1'],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      worktreesByRepo: {},
      settings: {
        defaultTuiAgent: 'codex',
        disabledTuiAgents: [],
        agentCmdOverrides: {}
      },
      ensureDetectedAgents: mocks.ensureDetectedAgents,
      ensureRemoteDetectedAgents: mocks.ensureRemoteDetectedAgents,
      createWorktree: mocks.createWorktree,
      updateWorktreeMeta: mocks.updateWorktreeMeta,
      setSidebarOpen: mocks.setSidebarOpen,
      seedNativeChatLaunchPrompt: mocks.seedNativeChatLaunchPrompt,
      seedNativeChatLaunchDraft: mocks.seedNativeChatLaunchDraft,
      markNativeChatLaunchPromptFailed: mocks.markNativeChatLaunchPromptFailed
    } as typeof mocks.store
    // @ts-expect-error -- test shim
    globalThis.window = { api: mockApi }
    mockApi.agentTrust.markTrusted.mockResolvedValue(undefined)
  })

  it('plans direct local Windows-path launches with POSIX startup for WSL project runtime', async () => {
    mocks.store.repos = [
      {
        id: 'repo-1',
        path: 'C:\\Users\\alice\\repo',
        displayName: 'Repo',
        addedAt: 1
      }
    ]
    mocks.store.projects = [
      {
        id: 'repo-1',
        displayName: 'Repo',
        badgeColor: '#000000',
        sourceRepoIds: ['repo-1'],
        createdAt: 1,
        updatedAt: 1,
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
      }
    ]
    mocks.store.createWorktree.mockResolvedValue({
      worktree: {
        id: 'repo-1::C:\\Users\\alice\\repo-worktree',
        path: 'C:\\Users\\alice\\repo-worktree'
      }
    })
    const { launchWorkItemDirect } = await import('./launch-work-item-direct')

    await expect(
      launchWorkItemDirect({
        item: {
          title: 'Fix failing checks',
          url: 'https://github.com/acme/repo/pull/1',
          type: 'issue',
          number: 1,
          pasteContent: 'Fix the failing checks.'
        },
        repoId: 'repo-1',
        openModalFallback: mocks.openModalFallback,
        launchSource: 'task_page',
        agentOverride: 'codex',
        promptDelivery: 'submit-after-ready'
      })
    ).resolves.toBe(true)

    expect(buildAgentStartupPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        platform: 'linux'
      })
    )
  })

  it('routes a supported direct Codex work-item launch to structured chat', async () => {
    mocks.store.settings = {
      defaultTuiAgent: 'codex',
      disabledTuiAgents: [],
      agentCmdOverrides: {},
      experimentalNativeChat: true,
      experimentalStructuredNativeChat: true,
      openAgentTabsInChatByDefault: true
    }

    await expect(
      launchWorkItemDirect({
        item: {
          title: 'Route direct launch',
          url: 'https://github.com/acme/repo/issues/123',
          type: 'issue',
          number: 123
        },
        repoId: 'repo-1',
        openModalFallback: mocks.openModalFallback,
        launchSource: 'task_page',
        agentOverride: 'codex',
        launchPlatform: 'darwin'
      })
    ).resolves.toBe(true)

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(
      'repo-1::/repo/worktree',
      expect.not.objectContaining({ startup: expect.anything() })
    )
    expect(mocks.startStructuredCodexLaunch).toHaveBeenCalledWith('repo-1::/repo/worktree', {
      prompt: 'https://github.com/acme/repo/issues/123',
      promptDelivery: 'draft',
      telemetry: {
        agent_kind: 'codex',
        launch_source: 'task_page',
        request_kind: 'new'
      }
    })
    expect(buildAgentDraftLaunchPlan).toHaveBeenCalledOnce()
  })

  it('creates a dedicated agent terminal after a structured direct launch is refused', async () => {
    mocks.store.settings = {
      defaultTuiAgent: 'codex',
      disabledTuiAgents: [],
      agentCmdOverrides: {},
      experimentalNativeChat: true,
      experimentalStructuredNativeChat: true,
      openAgentTabsInChatByDefault: true
    }
    mocks.createWorktree.mockResolvedValueOnce({
      worktree: { id: 'repo-1::/repo/worktree', path: '/repo/worktree' },
      setup: { runnerScriptPath: '/repo/setup.sh', envVars: {} }
    })
    mocks.startStructuredCodexLaunch.mockReturnValueOnce(
      structuredLaunchResult(
        'session-1',
        Promise.reject(new StructuredAgentSessionCreateRefusalError('refused'))
      )
    )

    await launchWorkItemDirect({
      item: {
        title: 'Route direct fallback',
        url: 'https://github.com/acme/repo/issues/123',
        type: 'issue',
        number: 123
      },
      repoId: 'repo-1',
      openModalFallback: mocks.openModalFallback,
      launchSource: 'task_page',
      agentOverride: 'codex',
      launchPlatform: 'darwin'
    })

    expect(mocks.activateAndRevealWorktree).toHaveBeenNthCalledWith(
      2,
      'repo-1::/repo/worktree',
      expect.objectContaining({
        createNewTerminalForStartup: true,
        startup: expect.objectContaining({ launchAgent: 'codex' })
      })
    )
  })

  it('preserves direct Codex TUI startup when restructure is off', async () => {
    mocks.store.settings = {
      defaultTuiAgent: 'codex',
      disabledTuiAgents: [],
      agentCmdOverrides: {},
      experimentalNativeChat: true,
      experimentalStructuredNativeChat: false,
      openAgentTabsInChatByDefault: true
    }

    await launchWorkItemDirect({
      item: {
        title: 'Keep direct legacy launch',
        url: 'https://github.com/acme/repo/issues/124',
        type: 'issue',
        number: 124
      },
      repoId: 'repo-1',
      openModalFallback: mocks.openModalFallback,
      launchSource: 'task_page',
      agentOverride: 'codex',
      launchPlatform: 'darwin'
    })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(
      'repo-1::/repo/worktree',
      expect.objectContaining({ startup: expect.objectContaining({ launchAgent: 'codex' }) })
    )
    expect(mocks.startStructuredCodexLaunch).not.toHaveBeenCalled()
  })
})
