// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type * as NewWorkspaceModule from '@/lib/new-workspace'
import { getDefaultSettings } from '../../../../shared/constants'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-codex-session'
import type {
  StructuredCodexLaunchReceipt,
  StructuredCodexLaunchResult
} from '@/lib/structured-agent-session-launch'

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn(),
  ensureAgentStartupInTerminal: vi.fn(),
  startStructuredCodexLaunch: vi.fn()
}))

// Why: importOriginal keeps the real resolveStartupLaunchDraftText, so the
// invariant test below exercises the shipped gate instead of a copy of it.
vi.mock('@/lib/worktree-activation', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace }
})

vi.mock('@/lib/new-workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof NewWorkspaceModule>()
  return {
    ...actual,
    ensureAgentStartupInTerminal: mocks.ensureAgentStartupInTerminal
  }
})

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

import { useAppStore } from '@/store'
import { submitFolderWorkspaceCreate } from './folder-workspace-composer-submit'

function makeProjectGroup(): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Platform',
    parentPath: '/repo/platform',
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-workspace-1',
    projectGroupId: 'group-1',
    name: 'hi',
    folderPath: '/repo/platform/hi',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
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

describe('submitFolderWorkspaceCreate', () => {
  beforeEach(() => {
    mocks.startStructuredCodexLaunch.mockClear()
    mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })
    mocks.startStructuredCodexLaunch.mockReturnValue(
      structuredLaunchResult('session-1', Promise.resolve({ sessionId: 'session-1', fence: 1 }))
    )
    Object.assign(window, {
      api: {
        agentTrust: {
          markTrusted: vi.fn().mockResolvedValue(undefined)
        }
      }
    })
  })
  afterEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReset()
    mocks.ensureAgentStartupInTerminal.mockReset()
    Reflect.deleteProperty(window, 'api')
    vi.restoreAllMocks()
  })

  it('closes the composer after creation even when reveal fails', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const onOpenChange = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.activateAndRevealFolderWorkspace.mockImplementation(() => {
      throw new Error('activation failed')
    })

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: 'hi',
      lastAutoName: '',
      linkedWorkItem: null,
      note: '',
      quickAgent: null,
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      createFolderWorkspace,
      onOpenChange
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'hi',
      connectionId: null,
      linkedTask: null
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith('folder-workspace-1', {
      runtimeEnvironmentId: null
    })
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to activate folder workspace after create:',
      expect.any(Error)
    )
  })

  it('marks a blank folder workspace for first-input rename when launching an agent with a note', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const onOpenChange = vi.fn()

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem: null,
      note: 'Fix the flaky checkout flow',
      quickAgent: 'codex',
      autoRenameBranchFromWork: true,
      agentCmdOverrides: {},
      agentArgs: '--model gpt-5.4',
      agentEnv: { ORCA_AGENT_PROFILE: 'review' },
      launchSource: 'new_workspace_composer',
      runtimeEnvironmentId: 'env-1',
      createFolderWorkspace,
      onOpenChange
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'Platform workspace',
      connectionId: null,
      linkedTask: null,
      createdWithAgent: 'codex',
      pendingFirstAgentMessageRename: true
    })
    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith(
      'folder-workspace-1',
      expect.objectContaining({
        runtimeEnvironmentId: 'env-1',
        startup: expect.objectContaining({
          command: expect.stringContaining('codex'),
          env: { ORCA_AGENT_PROFILE: 'review' },
          telemetry: expect.objectContaining({
            launch_source: 'new_workspace_composer'
          })
        })
      })
    )
    const startup = mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]?.startup
    expect(startup?.command).toContain('--model')
    expect(startup?.command).toContain('gpt-5.4')
    expect(mocks.ensureAgentStartupInTerminal).not.toHaveBeenCalled()
  })

  it('does not mark first-input rename when the folder workspace has an explicit name', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: 'Checkout polish',
      lastAutoName: '',
      linkedWorkItem: null,
      note: 'Fix the flaky checkout flow',
      quickAgent: 'codex',
      autoRenameBranchFromWork: true,
      agentCmdOverrides: {},
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'Checkout polish',
      connectionId: null,
      linkedTask: null,
      createdWithAgent: 'codex'
    })
  })

  it('does not mark first-input rename when a linked work item owns the folder workspace name', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const linkedWorkItem = {
      provider: 'github' as const,
      type: 'issue' as const,
      number: 42,
      title: 'Restore checkout polish',
      url: 'https://github.com/stablyai/orca/issues/42',
      repoId: 'repo-1'
    }

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem,
      note: 'Use the issue context',
      quickAgent: 'codex',
      autoRenameBranchFromWork: true,
      agentCmdOverrides: {},
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'Restore checkout polish',
      connectionId: null,
      linkedTask: linkedWorkItem,
      createdWithAgent: 'codex'
    })
  })

  it('creates a Jira folder workspace with its bound source context', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const linkedWorkItem = {
      provider: 'jira' as const,
      type: 'issue' as const,
      number: 0,
      title: 'ORCA-123 Link Jira',
      url: 'https://company.atlassian.net/browse/ORCA-123',
      jiraIdentifier: 'ORCA-123'
    }
    const linkedTaskSourceContext = {
      kind: 'task-source' as const,
      provider: 'jira' as const,
      projectId: 'group-1',
      hostId: 'runtime:folder-env' as const,
      providerIdentity: {
        provider: 'jira' as const,
        siteId: 'site-1',
        siteUrl: 'https://company.atlassian.net',
        projectKey: 'ORCA'
      }
    }

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem,
      linkedTaskSourceContext,
      note: '',
      quickAgent: null,
      autoRenameBranchFromWork: true,
      agentCmdOverrides: {},
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'ORCA-123 Link Jira',
      connectionId: null,
      linkedTask: linkedWorkItem,
      linkedTaskSourceContext
    })
  })

  it('keeps linked Codex context out of submitted startup and pastes it as a draft', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const linkedWorkItem = {
      provider: 'github' as const,
      type: 'pr' as const,
      number: 91,
      title: 'Restore linked quick-create',
      url: 'https://github.com/stablyai/orca/pull/91',
      repoId: 'repo-1'
    }

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem,
      note: 'Review this before starting',
      quickAgent: 'codex',
      autoRenameBranchFromWork: true,
      agentCmdOverrides: {},
      launchSource: 'new_workspace_composer',
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'Restore linked quick-create',
      connectionId: null,
      linkedTask: linkedWorkItem,
      createdWithAgent: 'codex'
    })
    const startup = mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]?.startup
    expect(startup?.command).toBe('codex')
    expect(startup?.command).not.toContain(linkedWorkItem.url)
    expect(startup?.command).not.toContain('Review this before starting')
    expect(window.api.agentTrust?.markTrusted).toHaveBeenCalledWith({
      preset: 'codex',
      workspacePath: '/repo/platform/hi'
    })
    expect(mocks.ensureAgentStartupInTerminal).toHaveBeenCalledWith({
      worktreeId: folderWorkspaceKey('folder-workspace-1'),
      primaryTabId: 'tab-1',
      startup: expect.objectContaining({
        agent: 'codex',
        launchCommand: 'codex',
        followupPrompt: null,
        draftPrompt: `Review this before starting\n\n${linkedWorkItem.url}`
      })
    })
  })

  it('opens supported local linked Codex creation as structured chat with the draft', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const linkedWorkItem = {
      provider: 'github' as const,
      type: 'issue' as const,
      number: 42,
      title: 'Route folder launch',
      url: 'https://github.com/stablyai/orca/issues/42',
      repoId: 'repo-1'
    }

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem,
      note: 'Review first',
      quickAgent: 'codex',
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      settings: {
        ...getDefaultSettings('/tmp/orca-workspaces'),
        experimentalNativeChat: true,
        experimentalStructuredNativeChat: true,
        openAgentTabsInChatByDefault: true
      },
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith('folder-workspace-1', {
      runtimeEnvironmentId: null,
      providesInitialSurface: true
    })
    expect(mocks.startStructuredCodexLaunch).toHaveBeenCalledWith(
      folderWorkspaceKey('folder-workspace-1'),
      {
        prompt: `Review first\n\n${linkedWorkItem.url}`,
        promptDelivery: 'draft',
        telemetry: {
          agent_kind: 'codex',
          launch_source: 'sidebar',
          request_kind: 'new'
        }
      }
    )
    expect(mocks.ensureAgentStartupInTerminal).not.toHaveBeenCalled()
  })

  it('restores the terminal rename marker and launch token after structured refusal', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const updateFolderWorkspace = vi
      .spyOn(useAppStore.getState(), 'updateFolderWorkspace')
      .mockResolvedValue(true)
    mocks.startStructuredCodexLaunch.mockReturnValueOnce(
      structuredLaunchResult(
        'session-1',
        Promise.reject(new StructuredAgentSessionCreateRefusalError('refused'))
      )
    )

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem: null,
      note: 'Name this from the first response',
      quickAgent: 'codex',
      autoRenameBranchFromWork: true,
      agentCmdOverrides: {},
      settings: {
        ...getDefaultSettings('/tmp/orca-workspaces'),
        experimentalNativeChat: true,
        experimentalStructuredNativeChat: true,
        openAgentTabsInChatByDefault: true
      },
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith(
      expect.not.objectContaining({ pendingFirstAgentMessageRename: true })
    )
    expect(updateFolderWorkspace).toHaveBeenCalledWith('folder-workspace-1', {
      pendingFirstAgentMessageRename: true
    })
    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenNthCalledWith(
      2,
      'folder-workspace-1',
      expect.objectContaining({
        startup: expect.objectContaining({ launchToken: expect.any(String) })
      })
    )
  })

  it('keeps the folder TUI startup when restructure is off', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: 'Legacy folder',
      lastAutoName: '',
      linkedWorkItem: null,
      note: '',
      quickAgent: 'codex',
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      settings: {
        ...getDefaultSettings('/tmp/orca-workspaces'),
        experimentalNativeChat: true,
        experimentalStructuredNativeChat: false,
        openAgentTabsInChatByDefault: true
      },
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith(
      'folder-workspace-1',
      expect.objectContaining({ startup: expect.objectContaining({ launchAgent: 'codex' }) })
    )
    expect(mocks.startStructuredCodexLaunch).not.toHaveBeenCalled()
  })

  it('pre-marks remote linked Codex folder workspaces trusted before draft paste', async () => {
    const createFolderWorkspace = vi.fn(async () =>
      makeFolderWorkspace({
        connectionId: 'ssh-1',
        folderPath: '/home/alice/platform/Trust remote folder draft'
      })
    )
    const linkedWorkItem = {
      provider: 'github' as const,
      type: 'pr' as const,
      number: 92,
      title: 'Trust remote folder draft',
      url: 'https://github.com/stablyai/orca/pull/92',
      repoId: 'repo-1'
    }
    const projectGroup = {
      ...makeProjectGroup(),
      connectionId: 'ssh-1',
      parentPath: '/home/alice/platform'
    }

    await submitFolderWorkspaceCreate({
      projectGroup,
      name: '',
      lastAutoName: '',
      linkedWorkItem,
      note: '',
      quickAgent: 'codex',
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      isRemote: true,
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(window.api.agentTrust?.markTrusted).toHaveBeenCalledWith({
      preset: 'codex',
      workspacePath: '/home/alice/platform/Trust remote folder draft',
      connectionId: 'ssh-1'
    })
    expect(mocks.ensureAgentStartupInTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: folderWorkspaceKey('folder-workspace-1'),
        startup: expect.objectContaining({
          agent: 'codex',
          draftPrompt: linkedWorkItem.url
        })
      })
    )
  })

  it('delivers non-linked follow-up prompts for agents that need stdin after launch', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: 'Aider followup',
      lastAutoName: '',
      linkedWorkItem: null,
      note: 'Fix the failing folder prompt flow',
      quickAgent: 'aider',
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    const startup = mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]?.startup
    expect(startup?.command).toBe('aider')
    expect(mocks.ensureAgentStartupInTerminal).toHaveBeenCalledWith({
      worktreeId: folderWorkspaceKey('folder-workspace-1'),
      primaryTabId: 'tab-1',
      startup: expect.objectContaining({
        agent: 'aider',
        launchCommand: 'aider',
        followupPrompt: 'Fix the failing folder prompt flow'
      })
    })
  })

  it('uses native draft launch for linked agents with prefill support', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const linkedWorkItem = {
      provider: 'gitlab' as const,
      type: 'mr' as const,
      number: 17,
      title: 'Review folder workspace draft',
      url: 'https://gitlab.example.com/group/project/-/merge_requests/17',
      repoId: 'repo-1'
    }

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem,
      note: 'Check the migration path',
      quickAgent: 'claude',
      autoRenameBranchFromWork: true,
      agentCmdOverrides: {},
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    const startup = mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]?.startup
    expect(startup?.command).toContain('claude --prefill')
    expect(startup?.command).toContain('Check the migration path')
    expect(startup?.command).toContain(linkedWorkItem.url)
    expect(mocks.ensureAgentStartupInTerminal).not.toHaveBeenCalled()
  })

  it('uses native prefill for link-only Linear folder workspace drafts', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const linkedWorkItem = {
      provider: 'linear' as const,
      type: 'issue' as const,
      number: 0,
      title: 'Ship Linear source drafts',
      url: 'https://linear.app/acme/issue/ENG-77/ship-linear-source-drafts',
      linearIdentifier: 'ENG-77',
      linkedContext: {
        provider: 'linear' as const,
        version: 1 as const,
        renderedText: [
          'Linear issue context snapshot',
          'Identifier: ENG-77',
          'Title: Ship Linear source drafts',
          'Description:',
          'Distinctive folder Linear body.'
        ].join('\n')
      }
    }

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem,
      note: 'User note stays above source',
      quickAgent: 'claude',
      autoRenameBranchFromWork: true,
      agentCmdOverrides: {},
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'ENG-77 Ship Linear source drafts',
      connectionId: null,
      linkedTask: {
        provider: 'linear',
        type: 'issue',
        number: 0,
        title: 'Ship Linear source drafts',
        url: 'https://linear.app/acme/issue/ENG-77/ship-linear-source-drafts',
        linearIdentifier: 'ENG-77'
      },
      createdWithAgent: 'claude'
    })
    const startup = mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]?.startup
    expect(startup?.command).toContain('claude --prefill')
    expect(startup?.command).toContain('User note stays above source')
    expect(startup?.command).toContain('Linked Linear issue: ENG-77')
    expect(startup?.command).toContain(
      'https://linear.app/acme/issue/ENG-77/ship-linear-source-drafts'
    )
    expect(startup?.command).not.toContain('Distinctive folder Linear body.')
    expect(startup?.command).not.toContain('--- BEGIN LINKED WORK ITEM CONTEXT ---')
    expect(startup?.command).not.toContain('orca linear')
    expect(mocks.ensureAgentStartupInTerminal).not.toHaveBeenCalled()
  })
})
