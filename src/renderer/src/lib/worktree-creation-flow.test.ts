import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PendingWorktreeCreation,
  WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'

const { prepareEphemeralVmWorkspaceTargetMock } = vi.hoisted(() => ({
  prepareEphemeralVmWorkspaceTargetMock: vi.fn()
}))

const { activateStructuredAgentSessionByIdMock } = vi.hoisted(() => ({
  activateStructuredAgentSessionByIdMock: vi.fn()
}))

type TestActiveView = 'terminal' | 'tasks'

const store = {
  settings: {
    activeRuntimeEnvironmentId: null as string | null,
    experimentalNativeChat: undefined as boolean | undefined,
    openAgentTabsInChatByDefault: undefined as boolean | undefined
  },
  activeView: 'terminal' as TestActiveView,
  activePendingCreationId: 'creation-1' as string | null,
  repos: [{ id: 'repo-runtime', connectionId: null }],
  pendingWorktreeCreations: {} as Record<string, PendingWorktreeCreation>,
  beginPendingWorktreeCreation: vi.fn((entry: PendingWorktreeCreation) => {
    store.pendingWorktreeCreations[entry.creationId] = entry
    store.activePendingCreationId = entry.creationId
  }),
  updatePendingWorktreeCreation: vi.fn(
    (creationId: string, patch: Partial<PendingWorktreeCreation>) => {
      const entry = store.pendingWorktreeCreations[creationId]
      if (entry) {
        store.pendingWorktreeCreations[creationId] = { ...entry, ...patch }
      }
    }
  ),
  removePendingWorktreeCreation: vi.fn((creationId: string) => {
    delete store.pendingWorktreeCreations[creationId]
  }),
  updateWorktreeMeta: vi.fn(),
  setActivePendingWorktreeCreation: vi.fn(),
  setActiveView: vi.fn(),
  setSidebarOpen: vi.fn(),
  createWorktree: vi.fn((..._args: unknown[]) => new Promise<unknown>(() => {})),
  setupProjectExistingFolder: vi.fn(),
  refreshRuntimeEnvironmentStatus: vi.fn(),
  seedNativeChatLaunchDraft: vi.fn(),
  setTabViewMode: vi.fn(),
  tabsByWorktree: {} as Record<string, { id: string; launchAgent?: string }[]>,
  unifiedTabsByWorktree: {}
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store
  }
}))

vi.mock('@/lib/browser-uuid', () => ({
  createBrowserUuid: () => 'creation-1'
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn(() => false)
}))

vi.mock('@/lib/worktree-initial-terminal-seeding', () => ({
  ensureWorktreeHasInitialTerminal: vi.fn()
}))

vi.mock('@/lib/workspace-activation-terminal-focus', () => ({
  queueWorkspaceActivationTerminalFocus: vi.fn()
}))

vi.mock('@/lib/new-workspace', () => ({
  ensureAgentStartupInTerminal: vi.fn()
}))

vi.mock('@/lib/structured-agent-session-launch', () => ({
  startStructuredCodexLaunch: vi.fn()
}))

vi.mock('@/lib/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionById: activateStructuredAgentSessionByIdMock
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn()
  }
}))

vi.mock('@/lib/ephemeral-vm-workspace-target', () => ({
  prepareEphemeralVmWorkspaceTarget: prepareEphemeralVmWorkspaceTargetMock
}))

import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-initial-terminal-seeding'
import { queueWorkspaceActivationTerminalFocus } from '@/lib/workspace-activation-terminal-focus'
import { ensureAgentStartupInTerminal } from '@/lib/new-workspace'
import { startStructuredCodexLaunch } from '@/lib/structured-agent-session-launch'
import { activateStructuredAgentSessionById } from '@/lib/structured-agent-session-tab-activation'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-codex-session'
import type {
  StructuredCodexLaunchReceipt,
  StructuredCodexLaunchResult
} from '@/lib/structured-agent-session-launch'
import { runBackgroundWorktreeCreation } from './worktree-creation-flow'

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

beforeEach(() => {
  vi.clearAllMocks()
  store.settings.activeRuntimeEnvironmentId = null
  store.settings.experimentalNativeChat = undefined
  store.settings.openAgentTabsInChatByDefault = undefined
  store.activeView = 'terminal'
  store.activePendingCreationId = 'creation-1'
  store.repos = []
  store.pendingWorktreeCreations = { 'creation-1': makePendingCreation(makeRequest()) }
  store.createWorktree.mockImplementation(() => new Promise(() => {}))
  store.updateWorktreeMeta.mockResolvedValue({ ok: true })
  store.tabsByWorktree = {}
  store.unifiedTabsByWorktree = {}
  vi.mocked(ensureWorktreeHasInitialTerminal).mockReturnValue('tab-1')
  vi.mocked(startStructuredCodexLaunch).mockReturnValue(
    structuredLaunchResult('session-1', Promise.resolve({ sessionId: 'session-1', fence: 1 }))
  )
  activateStructuredAgentSessionByIdMock.mockReset()
})

function makeRequest(overrides: Partial<WorktreeCreationRequest> = {}): WorktreeCreationRequest {
  return {
    repoId: 'repo-1',
    name: 'feature',
    setupDecision: 'inherit',
    agent: null,
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null,
    ...overrides
  }
}

function makePendingCreation(request: WorktreeCreationRequest): PendingWorktreeCreation {
  return {
    creationId: 'creation-1',
    phase: 'preparing',
    status: 'creating',
    startedAt: 1,
    indeterminate: false,
    loaderVisible: true,
    request
  }
}

describe('runBackgroundWorktreeCreation', () => {
  beforeEach(() => {
    store.settings.activeRuntimeEnvironmentId = null
    store.repos = [{ id: 'repo-runtime', connectionId: null }]
    store.pendingWorktreeCreations = {}
    store.activePendingCreationId = null
    store.beginPendingWorktreeCreation.mockClear()
    store.updatePendingWorktreeCreation.mockClear()
    store.removePendingWorktreeCreation.mockClear()
    store.setActiveView.mockClear()
    store.setSidebarOpen.mockClear()
    store.createWorktree.mockReset().mockImplementation(() => new Promise(() => {}))
    store.setupProjectExistingFolder.mockReset()
    store.refreshRuntimeEnvironmentStatus.mockReset()
    prepareEphemeralVmWorkspaceTargetMock.mockReset()
    globalThis.window = {
      api: {
        ephemeralVm: {
          attachWorkspace: vi.fn(),
          cleanup: vi.fn(),
          onProvisionEvent: vi.fn(() => vi.fn())
        }
      }
    } as never
  })

  it('uses the captured repo-owner progress mode instead of focused runtime state', () => {
    store.settings.activeRuntimeEnvironmentId = null
    store.beginPendingWorktreeCreation.mockClear()

    runBackgroundWorktreeCreation(makeRequest({ worktreeCreateProgressMode: 'indeterminate' }))

    expect(store.beginPendingWorktreeCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        creationId: 'creation-1',
        indeterminate: true,
        request: expect.objectContaining({
          worktreeCreateProgressMode: 'indeterminate'
        })
      })
    )
  })

  it('uses the serialized structured route without spawning or focusing a TUI', async () => {
    const request = makeRequest({
      agent: 'codex',
      agentLaunchRoute: 'structured-native-chat',
      startup: { command: "codex 'Fix quick route'", launchAgent: 'codex' },
      startupPlan: {
        agent: 'codex',
        launchCommand: "codex 'Fix quick route'",
        expectedProcess: 'codex',
        followupPrompt: null,
        launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} }
      },
      quickPrompt: 'Fix quick route'
    })
    store.pendingWorktreeCreations = { 'creation-1': makePendingCreation(request) }
    store.createWorktree.mockResolvedValue({
      worktree: { id: 'wt-structured', repoId: 'repo-1', path: '/repo/wt-structured' }
    })

    runBackgroundWorktreeCreation(request)

    await vi.waitFor(() => expect(startStructuredCodexLaunch).toHaveBeenCalled())
    const createCall = store.createWorktree.mock.calls[0] as unknown[]
    expect(createCall[16]).toBeUndefined()
    expect(ensureAgentStartupInTerminal).not.toHaveBeenCalled()
    expect(startStructuredCodexLaunch).toHaveBeenCalledWith('wt-structured', {
      prompt: 'Fix quick route',
      promptDelivery: 'auto-submit'
    })
    expect(queueWorkspaceActivationTerminalFocus).not.toHaveBeenCalled()
  })

  it('focuses the published structured session after a git worktree surface activates', async () => {
    const events: string[] = []
    let activeSurface = 'incumbent-terminal'
    let resolvePublication!: (receipt: StructuredCodexLaunchReceipt) => void
    const request = makeRequest({
      agent: 'codex',
      agentLaunchRoute: 'structured-native-chat',
      baseBranch: 'main',
      startupPlan: {
        agent: 'codex',
        launchCommand: 'codex',
        expectedProcess: 'codex',
        followupPrompt: null,
        launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} }
      },
      quickPrompt: 'Say hello'
    })
    const worktreeId = 'repo-1::/repo/git-worktree'
    store.pendingWorktreeCreations = { 'creation-1': makePendingCreation(request) }
    store.createWorktree.mockResolvedValue({
      worktree: { id: worktreeId, repoId: 'repo-1', path: '/repo/git-worktree' }
    })
    vi.mocked(activateAndRevealWorktree).mockImplementationOnce((id, options) => {
      expect(id).toBe(worktreeId)
      expect(options).toEqual(expect.objectContaining({ providesInitialSurface: true }))
      events.push('initial-surface-activation')
      activeSurface = 'terminal-1'
      return { primaryTabId: 'terminal-1' }
    })
    vi.mocked(startStructuredCodexLaunch).mockReturnValueOnce(
      structuredLaunchResult(
        'session-git',
        new Promise((resolve) => {
          resolvePublication = (receipt) => {
            events.push('structured-session-publication')
            resolve(receipt)
          }
        })
      )
    )
    activateStructuredAgentSessionByIdMock.mockImplementation(() => {
      events.push('renderer-tab-focus')
      activeSurface = 'structured-session'
      return true
    })

    runBackgroundWorktreeCreation(request)
    await vi.waitFor(() => expect(startStructuredCodexLaunch).toHaveBeenCalled())
    expect(events).toEqual(['initial-surface-activation'])

    resolvePublication({ sessionId: 'session-git', fence: 1 })
    await vi.waitFor(() =>
      expect(activateStructuredAgentSessionById).toHaveBeenCalledWith({
        worktreeId,
        sessionId: 'session-git'
      })
    )

    expect(events).toEqual([
      'initial-surface-activation',
      'structured-session-publication',
      'renderer-tab-focus'
    ])
    expect(activeSurface).toBe('structured-session')
    expect(queueWorkspaceActivationTerminalFocus).not.toHaveBeenCalled()
  })

  it('keeps background pending UI without a hidden terminal until structured publication settles', async () => {
    let resolveLaunch!: (value: { sessionId: string; fence: number }) => void
    const request = makeRequest({
      agent: 'codex',
      agentLaunchRoute: 'structured-native-chat',
      startupPlan: {
        agent: 'codex',
        launchCommand: 'codex',
        expectedProcess: 'codex',
        followupPrompt: null,
        launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} }
      },
      quickPrompt: 'Fix it'
    })
    store.activeView = 'tasks'
    store.pendingWorktreeCreations = { 'creation-1': makePendingCreation(request) }
    store.createWorktree.mockResolvedValue({
      worktree: { id: 'wt-background-structured', repoId: 'repo-1' }
    })
    vi.mocked(startStructuredCodexLaunch).mockReturnValueOnce(
      structuredLaunchResult(
        'session-background',
        new Promise((resolve) => (resolveLaunch = resolve))
      )
    )

    runBackgroundWorktreeCreation(request)
    await vi.waitFor(() => expect(startStructuredCodexLaunch).toHaveBeenCalled())
    expect(ensureWorktreeHasInitialTerminal).not.toHaveBeenCalled()
    expect(store.removePendingWorktreeCreation).not.toHaveBeenCalled()

    resolveLaunch({ sessionId: 'session-background', fence: 1 })
    await vi.waitFor(() => expect(store.removePendingWorktreeCreation).toHaveBeenCalled())
    expect(activateStructuredAgentSessionById).not.toHaveBeenCalled()
  })

  it('installs the preserved background TUI fallback after structured refusal', async () => {
    const request = makeRequest({
      agent: 'codex',
      agentLaunchRoute: 'structured-native-chat',
      pendingFirstAgentMessageRename: true,
      startupPlan: {
        agent: 'codex',
        launchCommand: 'codex',
        expectedProcess: 'codex',
        followupPrompt: null,
        launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} }
      },
      quickPrompt: 'Fix it'
    })
    store.activeView = 'tasks'
    store.pendingWorktreeCreations = { 'creation-1': makePendingCreation(request) }
    store.createWorktree.mockResolvedValue({
      worktree: { id: 'wt-background-fallback', repoId: 'repo-1' }
    })
    vi.mocked(startStructuredCodexLaunch).mockReturnValueOnce(
      structuredLaunchResult(
        'session-failed',
        Promise.reject(new StructuredAgentSessionCreateRefusalError('refused'))
      )
    )
    vi.mocked(activateAndRevealWorktree)
      .mockReturnValueOnce({ primaryTabId: 'setup-tab' })
      .mockReturnValueOnce({ primaryTabId: 'fallback-tab' })

    runBackgroundWorktreeCreation(request)
    await vi.waitFor(() => expect(ensureAgentStartupInTerminal).toHaveBeenCalled())

    expect(store.createWorktree.mock.calls[0]?.[17]).toBe(false)
    expect(store.updateWorktreeMeta).toHaveBeenCalledWith('wt-background-fallback', {
      pendingFirstAgentMessageRename: true
    })
    expect(ensureWorktreeHasInitialTerminal).toHaveBeenCalledWith(
      expect.anything(),
      'wt-background-fallback',
      expect.objectContaining({ command: 'codex' }),
      undefined,
      undefined,
      undefined,
      { activateCreatedTabs: false, createNewTerminalForStartup: true }
    )
    expect(vi.mocked(ensureWorktreeHasInitialTerminal).mock.calls.at(-1)?.[2]).toMatchObject({
      launchToken: 'creation-1'
    })
    expect(store.removePendingWorktreeCreation).toHaveBeenCalled()
  })

  it('does not duplicate an uncertain background structured launch with a TUI', async () => {
    const request = makeRequest({
      agent: 'codex',
      agentLaunchRoute: 'structured-native-chat',
      pendingFirstAgentMessageRename: true,
      note: 'Keep this note',
      startupPlan: {
        agent: 'codex',
        launchCommand: 'codex',
        expectedProcess: 'codex',
        followupPrompt: null,
        launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} }
      },
      quickPrompt: 'Fix it'
    })
    store.activeView = 'tasks'
    store.pendingWorktreeCreations = { 'creation-1': makePendingCreation(request) }
    store.createWorktree.mockResolvedValue({
      worktree: { id: 'wt-background-uncertain', repoId: 'repo-1' }
    })
    vi.mocked(startStructuredCodexLaunch).mockReturnValueOnce(
      structuredLaunchResult(
        'session-uncertain',
        Promise.reject(new Error('publication unavailable'))
      )
    )

    runBackgroundWorktreeCreation(request)
    await vi.waitFor(() =>
      expect(store.updateWorktreeMeta).toHaveBeenCalledWith('wt-background-uncertain', {
        comment: 'Keep this note'
      })
    )

    expect(ensureWorktreeHasInitialTerminal).not.toHaveBeenCalled()
    expect(ensureAgentStartupInTerminal).not.toHaveBeenCalled()
    expect(store.updateWorktreeMeta).not.toHaveBeenCalledWith('wt-background-uncertain', {
      pendingFirstAgentMessageRename: true
    })
    expect(store.removePendingWorktreeCreation).toHaveBeenCalled()
  })

  it('does not queue setup and issue commands again when structured refusal installs a fallback', async () => {
    const request = makeRequest({
      agent: 'codex',
      agentLaunchRoute: 'structured-native-chat',
      issueCommand: { command: 'gh issue view 42' },
      startupPlan: {
        agent: 'codex',
        launchCommand: 'codex',
        expectedProcess: 'codex',
        followupPrompt: null,
        launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} }
      },
      quickPrompt: 'Fix it'
    })
    store.pendingWorktreeCreations = { 'creation-1': makePendingCreation(request) }
    store.createWorktree.mockResolvedValue({
      worktree: { id: 'wt-active-fallback', repoId: 'repo-1' },
      setup: { runnerScriptPath: '/repo/setup.sh', envVars: {} }
    })
    vi.mocked(startStructuredCodexLaunch).mockReturnValueOnce(
      structuredLaunchResult(
        'session-failed',
        Promise.reject(new StructuredAgentSessionCreateRefusalError('refused'))
      )
    )

    runBackgroundWorktreeCreation(request)
    await vi.waitFor(() => expect(activateAndRevealWorktree).toHaveBeenCalledTimes(2))

    expect(activateAndRevealWorktree).toHaveBeenNthCalledWith(
      1,
      'wt-active-fallback',
      expect.objectContaining({
        setup: { runnerScriptPath: '/repo/setup.sh', envVars: {} },
        issueCommand: { command: 'gh issue view 42' },
        providesInitialSurface: true
      })
    )
    expect(activateAndRevealWorktree).toHaveBeenNthCalledWith(
      2,
      'wt-active-fallback',
      expect.not.objectContaining({
        setup: expect.anything(),
        issueCommand: expect.anything()
      })
    )
  })

  it('preserves serialized legacy startup when restructure was off at submit time', async () => {
    const request = makeRequest({
      agent: 'codex',
      agentLaunchRoute: 'legacy-native-chat',
      startup: { command: 'codex', launchAgent: 'codex' },
      startupPlan: {
        agent: 'codex',
        launchCommand: 'codex',
        expectedProcess: 'codex',
        followupPrompt: null,
        launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} }
      }
    })
    store.pendingWorktreeCreations = { 'creation-1': makePendingCreation(request) }
    store.createWorktree.mockResolvedValue({
      worktree: { id: 'wt-legacy', repoId: 'repo-1', path: '/repo/wt-legacy' },
      startupTerminal: { spawned: true, tabId: 'tab-agent' }
    })

    runBackgroundWorktreeCreation(request)

    await vi.waitFor(() => expect(store.removePendingWorktreeCreation).toHaveBeenCalled())
    const createCall = store.createWorktree.mock.calls[0] as unknown[]
    expect(createCall[16]).toEqual({ command: 'codex', launchAgent: 'codex' })
    expect(startStructuredCodexLaunch).not.toHaveBeenCalled()
  })

  it('falls back to focused runtime state for legacy captured requests', () => {
    store.settings.activeRuntimeEnvironmentId = 'focused-runtime'
    store.beginPendingWorktreeCreation.mockClear()

    runBackgroundWorktreeCreation(makeRequest())

    expect(store.beginPendingWorktreeCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        indeterminate: true,
        request: expect.not.objectContaining({
          worktreeCreateProgressMode: expect.any(String)
        })
      })
    )
  })

  it('shows a VM provisioning phase and creates the worktree on the prepared runtime repo', async () => {
    store.repos = [
      {
        id: 'repo-1',
        connectionId: null,
        gitRemoteIdentity: {
          canonicalKey: 'github.com/stablyai/orca',
          remoteName: 'origin',
          remoteUrl: 'git@github.com:stablyai/orca.git'
        }
      } as never
    ]
    prepareEphemeralVmWorkspaceTargetMock.mockResolvedValue({
      ok: true,
      runtimeId: 'runtime-1',
      environmentId: 'env-1',
      stderr: '',
      warnings: [],
      setup: {
        project: { id: 'project-1' },
        setup: {
          id: 'setup-runtime',
          projectId: 'project-1',
          hostId: 'runtime:env-1'
        },
        repo: { id: 'repo-runtime', path: '/workspace/repo' }
      }
    })
    store.createWorktree.mockResolvedValue({
      worktree: { id: 'repo-runtime::/workspace/repo/worktree', repoId: 'repo-runtime' }
    })

    runBackgroundWorktreeCreation(
      makeRequest({
        ephemeralVmRecipe: {
          sourceRepoId: 'repo-1',
          recipeId: 'cloud-sandbox',
          projectId: 'project-1'
        },
        baseBranch: 'Jinwoo-H/setup-vercel-sandbox',
        worktreeCreateProgressMode: 'indeterminate'
      })
    )

    expect(store.beginPendingWorktreeCreation).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'provisioning-vm' })
    )
    await vi.waitFor(() => expect(store.createWorktree).toHaveBeenCalled())
    expect(prepareEphemeralVmWorkspaceTargetMock).toHaveBeenCalledWith({
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox',
      projectId: 'github:stablyai/orca',
      workspaceName: 'feature',
      provisionId: 'creation-1',
      setupExistingFolder: store.setupProjectExistingFolder
    })
    const createCall = store.createWorktree.mock.calls[0] as unknown[]
    expect(createCall[0]).toBe('repo-runtime')
    expect(createCall[1]).toBe('feature')
    expect(createCall[2]).toBeUndefined()
    expect(createCall).toContain('creation-1')
    expect(window.api.ephemeralVm.attachWorkspace).toHaveBeenCalledWith({
      runtimeId: 'runtime-1',
      workspaceId: 'repo-runtime::/workspace/repo/worktree'
    })
    expect(store.refreshRuntimeEnvironmentStatus).toHaveBeenCalledWith('env-1')
    expect(store.removePendingWorktreeCreation).toHaveBeenCalledWith('creation-1', {
      cleanupVm: false
    })
  })

  it('preserves provider-backed VM start points after provisioning', async () => {
    store.repos = [{ id: 'repo-1', connectionId: null }] as never
    prepareEphemeralVmWorkspaceTargetMock.mockResolvedValue({
      ok: true,
      runtimeId: 'runtime-1',
      environmentId: 'env-1',
      stderr: '',
      warnings: [],
      setup: {
        project: { id: 'project-1' },
        setup: {
          id: 'setup-runtime',
          projectId: 'project-1',
          hostId: 'runtime:env-1'
        },
        repo: { id: 'repo-runtime', path: '/workspace/repo' }
      }
    })
    store.createWorktree.mockResolvedValue({
      worktree: { id: 'repo-runtime::/workspace/repo/worktree', repoId: 'repo-runtime' }
    })

    runBackgroundWorktreeCreation(
      makeRequest({
        ephemeralVmRecipe: {
          sourceRepoId: 'repo-1',
          recipeId: 'cloud-sandbox',
          projectId: 'github:stablyai/orca'
        },
        baseBranch: 'abc123',
        compareBaseRef: 'refs/remotes/origin/main',
        linkedPR: 42
      })
    )

    await vi.waitFor(() => expect(store.createWorktree).toHaveBeenCalled())
    const createCall = store.createWorktree.mock.calls[0] as unknown[]
    expect(createCall[0]).toBe('repo-runtime')
    expect(createCall[2]).toBe('abc123')
    expect(createCall[24]).toBe('refs/remotes/origin/main')
  })

  it('appends stderr provisioning events for the active VM recipe create', async () => {
    let provisionEventCallback:
      | ((event: { provisionId: string; stream: 'stdout' | 'stderr'; chunk: string }) => void)
      | null = null
    const unsubscribe = vi.fn()
    window.api.ephemeralVm.onProvisionEvent = vi.fn((callback) => {
      provisionEventCallback = callback
      return unsubscribe
    })
    prepareEphemeralVmWorkspaceTargetMock.mockImplementation(async () => {
      provisionEventCallback?.({
        provisionId: 'creation-1',
        stream: 'stderr',
        chunk: 'creating sandbox\n'
      })
      provisionEventCallback?.({
        provisionId: 'other-create',
        stream: 'stderr',
        chunk: 'ignore me\n'
      })
      provisionEventCallback?.({
        provisionId: 'creation-1',
        stream: 'stdout',
        chunk: '{"pairingCode":"secret"}'
      })
      return {
        ok: true,
        runtimeId: 'runtime-1',
        environmentId: 'env-1',
        stderr: '',
        warnings: [
          {
            id: 'recipe.result.endpoint.public_ws',
            message: 'Recipe pairing endpoint uses insecure public ws:// transport.',
            remediation: 'Use wss://.'
          }
        ],
        setup: {
          project: { id: 'project-1' },
          setup: {
            id: 'setup-runtime',
            projectId: 'project-1',
            hostId: 'runtime:env-1'
          },
          repo: { id: 'repo-runtime', path: '/workspace/repo' }
        }
      }
    })
    store.createWorktree.mockResolvedValue({
      worktree: { id: 'repo-runtime::/workspace/repo/worktree', repoId: 'repo-runtime' }
    })

    runBackgroundWorktreeCreation(
      makeRequest({
        ephemeralVmRecipe: {
          sourceRepoId: 'repo-1',
          recipeId: 'cloud-sandbox',
          projectId: 'project-1'
        },
        worktreeCreateProgressMode: 'indeterminate'
      })
    )

    await vi.waitFor(() => expect(store.createWorktree).toHaveBeenCalled())
    expect(window.api.ephemeralVm.onProvisionEvent).toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalled()
    expect(store.updatePendingWorktreeCreation).toHaveBeenCalledWith(
      'creation-1',
      expect.objectContaining({ provisioningLog: 'creating sandbox\n' })
    )
    expect(store.updatePendingWorktreeCreation).toHaveBeenCalledWith(
      'creation-1',
      expect.objectContaining({
        provisioningLog: expect.stringContaining(
          'Warning: Recipe pairing endpoint uses insecure public ws:// transport.'
        )
      })
    )
    expect(JSON.stringify(store.updatePendingWorktreeCreation.mock.calls)).not.toContain(
      'pairingCode'
    )
    expect(JSON.stringify(store.updatePendingWorktreeCreation.mock.calls)).not.toContain(
      'ignore me'
    )
  })
})
