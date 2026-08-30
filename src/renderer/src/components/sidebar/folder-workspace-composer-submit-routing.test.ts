// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type * as NewWorkspaceModule from '@/lib/new-workspace'
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
import { decideInitialAgentTabViewMode } from '@/lib/native-chat-initial-view-mode'
import { resolveStartupLaunchDraftText } from '@/lib/worktree-startup-payload'
import {
  getFolderWorkspaceAgentLaunchPlatform,
  submitFolderWorkspaceCreate
} from './folder-workspace-composer-submit'

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
    useAppStore.setState({ nativeChatLaunchDraftByTabId: {} })
    Reflect.deleteProperty(window, 'api')
    vi.restoreAllMocks()
  })

  it('keeps explicit blank linked folder creates free of agent startup and draft paste', async () => {
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
      note: 'Keep this as metadata only',
      quickAgent: null,
      autoRenameBranchFromWork: true,
      agentCmdOverrides: {},
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'Restore checkout polish',
      connectionId: null,
      linkedTask: linkedWorkItem
    })
    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith('folder-workspace-1', {
      runtimeEnvironmentId: null
    })
    expect(mocks.ensureAgentStartupInTerminal).not.toHaveBeenCalled()
  })

  it('does not mark first-input rename without submitted first input', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem: null,
      note: '   ',
      quickAgent: 'codex',
      autoRenameBranchFromWork: true,
      agentCmdOverrides: {},
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'Platform workspace',
      connectionId: null,
      linkedTask: null,
      createdWithAgent: 'codex'
    })
  })

  it('quotes quick-agent startup for POSIX when the folder group is a local WSL UNC path', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const projectGroup = {
      ...makeProjectGroup(),
      parentPath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\platform'
    }

    expect(getFolderWorkspaceAgentLaunchPlatform(projectGroup)).toBe('linux')

    await submitFolderWorkspaceCreate({
      projectGroup,
      name: 'WSL folder',
      lastAutoName: '',
      linkedWorkItem: null,
      note: "Use Bob's POSIX startup",
      quickAgent: 'claude',
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith(
      'folder-workspace-1',
      expect.objectContaining({
        startup: expect.objectContaining({
          command: `claude 'Use Bob'"'"'s POSIX startup'`
        })
      })
    )
  })

  it('quotes quick-agent startup for Windows when the remote folder group uses a Windows path', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const projectGroup = {
      ...makeProjectGroup(),
      connectionId: 'ssh-windows',
      parentPath: 'C:\\Users\\alice\\platform'
    }

    expect(getFolderWorkspaceAgentLaunchPlatform(projectGroup)).toBe('win32')

    await submitFolderWorkspaceCreate({
      projectGroup,
      name: 'Remote Windows folder',
      lastAutoName: '',
      linkedWorkItem: null,
      note: "Use Bob's Windows startup",
      quickAgent: 'claude',
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith(
      'folder-workspace-1',
      expect.objectContaining({
        startup: expect.objectContaining({
          command: "claude 'Use Bob''s Windows startup'"
        })
      })
    )
  })

  it('preserves SSH group ownership when creating and activating a folder workspace', async () => {
    const projectGroup = {
      ...makeProjectGroup(),
      connectionId: 'ssh-1',
      executionHostId: 'ssh:ssh-1'
    }
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace({ connectionId: 'ssh-1' }))
    const onOpenChange = vi.fn()

    await submitFolderWorkspaceCreate({
      projectGroup,
      name: 'SSH workspace',
      lastAutoName: '',
      linkedWorkItem: null,
      note: '',
      quickAgent: null,
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      isRemote: true,
      runtimeEnvironmentId: null,
      createFolderWorkspace,
      onOpenChange
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'SSH workspace',
      connectionId: 'ssh-1',
      linkedTask: null
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith('folder-workspace-1', {
      runtimeEnvironmentId: null
    })
  })

  it('returns false when folder workspace creation fails without returning a workspace', async () => {
    const createFolderWorkspace = vi.fn(async () => null)
    const onOpenChange = vi.fn()

    await expect(
      submitFolderWorkspaceCreate({
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
    ).resolves.toBe(false)

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealFolderWorkspace).not.toHaveBeenCalled()
  })
})

describe('submitFolderWorkspaceCreate native-chat launch draft', () => {
  const ISSUE_URL = 'https://github.com/stablyai/orca/issues/42'
  const linkedIssue = {
    provider: 'github' as const,
    type: 'issue' as const,
    number: 42,
    title: 'Restore linked quick-create',
    url: ISSUE_URL,
    repoId: 'repo-1'
  }

  function seededDraftFor(tabId: string): { text: string } | undefined {
    return useAppStore.getState().nativeChatLaunchDraftByTabId[tabId]
  }

  beforeEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })
    useAppStore.setState({ nativeChatLaunchDraftByTabId: {} })
    Object.assign(window, {
      api: { agentTrust: { markTrusted: vi.fn().mockResolvedValue(undefined) } }
    })
  })

  afterEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReset()
    mocks.ensureAgentStartupInTerminal.mockReset()
    useAppStore.setState({ nativeChatLaunchDraftByTabId: {} })
    Reflect.deleteProperty(window, 'api')
    vi.restoreAllMocks()
  })

  it('mirrors a startup-paste draft into the chat composer', async () => {
    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem: linkedIssue,
      note: '',
      quickAgent: 'codex',
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      createFolderWorkspace: vi.fn(async () => makeFolderWorkspace()),
      onOpenChange: vi.fn()
    })

    expect(seededDraftFor('tab-1')?.text).toBe(ISSUE_URL)
  })

  it('mirrors an argv-prefill draft, which never lands in startupPlan.draftPrompt', async () => {
    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem: linkedIssue,
      note: '',
      quickAgent: 'claude',
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      createFolderWorkspace: vi.fn(async () => makeFolderWorkspace()),
      onOpenChange: vi.fn()
    })

    // The draft rides in on `--prefill`, so the plan carries no draftPrompt at
    // all — keying the mirror off it would silently drop this whole branch.
    const startup = mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]?.startup
    expect(startup?.draftPrompt).toBeUndefined()
    expect(startup?.command).toContain(ISSUE_URL)
    expect(seededDraftFor('tab-1')?.text).toBe(ISSUE_URL)
  })

  it('mirrors a multi-line draft into chat', async () => {
    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem: linkedIssue,
      note: 'Reproduce on Windows first',
      quickAgent: 'codex',
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      createFolderWorkspace: vi.fn(async () => makeFolderWorkspace()),
      onOpenChange: vi.fn()
    })

    expect(mocks.ensureAgentStartupInTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        startup: expect.objectContaining({
          draftPrompt: `Reproduce on Windows first\n\n${ISSUE_URL}`
        })
      })
    )
    expect(seededDraftFor('tab-1')?.text).toBe(`Reproduce on Windows first\n\n${ISSUE_URL}`)
  })

  it('does not mirror an unlinked note, which is submitted rather than drafted', async () => {
    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem: null,
      note: 'Fix the flaky checkout flow',
      quickAgent: 'codex',
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      createFolderWorkspace: vi.fn(async () => makeFolderWorkspace()),
      onOpenChange: vi.fn()
    })

    expect(seededDraftFor('tab-1')).toBeUndefined()
  })
})

describe('folder-workspace draft: seeded set == chat-opening set', () => {
  const ISSUE_URL = 'https://github.com/stablyai/orca/issues/42'
  const linkedIssue = {
    provider: 'github' as const,
    type: 'issue' as const,
    number: 42,
    title: 'Restore linked quick-create',
    url: ISSUE_URL,
    repoId: 'repo-1'
  }

  beforeEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })
    useAppStore.setState({ nativeChatLaunchDraftByTabId: {} })
    Object.assign(window, {
      api: { agentTrust: { markTrusted: vi.fn().mockResolvedValue(undefined) } }
    })
  })

  afterEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReset()
    mocks.ensureAgentStartupInTerminal.mockReset()
    useAppStore.setState({ nativeChatLaunchDraftByTabId: {} })
    Reflect.deleteProperty(window, 'api')
    vi.restoreAllMocks()
  })

  // Why: `claude` takes its draft on argv, so `startupPlan.draftPrompt` stays
  // undefined; `codex` gets a startup paste and sets it. Both must reach the
  // view-mode gate, and both must agree with what the composer actually holds.
  it.each([
    ['argv-prefill', 'claude' as const, '', true],
    ['argv-prefill multi-line', 'claude' as const, 'Reproduce on Windows first', true],
    ['startup-paste', 'codex' as const, '', true],
    ['startup-paste multi-line', 'codex' as const, 'Reproduce on Windows first', true]
  ])('%s', async (_label, quickAgent, note, expectMirrored) => {
    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem: linkedIssue,
      note,
      quickAgent,
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      createFolderWorkspace: vi.fn(async () => makeFolderWorkspace()),
      onOpenChange: vi.fn()
    })

    const startup = mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]?.startup
    const seeded = useAppStore.getState().nativeChatLaunchDraftByTabId['tab-1'] != null
    const draftText = resolveStartupLaunchDraftText(startup)
    const opensInChat =
      decideInitialAgentTabViewMode({
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: true,
        agent: quickAgent,
        ...(draftText != null
          ? { promptDelivery: 'draft' as const, launchDraftText: draftText }
          : {})
      }) === 'chat'

    // The draft always reaches the TUI, whichever way it is delivered.
    expect(`${startup?.command ?? ''}${startup?.draftPrompt ?? ''}`).toContain(ISSUE_URL)
    expect(seeded).toBe(expectMirrored)
    expect(opensInChat).toBe(expectMirrored)
  })
})
