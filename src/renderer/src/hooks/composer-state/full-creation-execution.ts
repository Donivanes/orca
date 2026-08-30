import type { ComposerModel } from './composer-model'

export type FullCreationExecutionInput = Pick<
  ComposerModel,
  | 'applyWorktreeMeta'
  | 'clearNewWorkspaceDraft'
  | 'createWorktree'
  | 'effectivePresetId'
  | 'isSubmissionCancelled'
  | 'linkedGitLabIssue'
  | 'linkedGitLabMR'
  | 'normalizedSparseDirectories'
  | 'note'
  | 'onCreated'
  | 'parentWorktreeId'
  | 'persistDraft'
  | 'persistSetupAgentStartupPolicy'
  | 'prepareFullSubmit'
  | 'resolvedInitialWorkspaceStatus'
  | 'selectedRepoExecutionHostId'
  | 'selectedRepoIsGit'
  | 'selectedRepoIsRemote'
  | 'setSidebarOpen'
  | 'settings'
  | 'sparseEnabled'
  | 'taskSourceContext'
  | 'telemetrySource'
  | 'tuiAgent'
>

import { useCallback } from 'react'
import type { PendingSmartGitHubSubmitResolution } from './source-selection-decisions'
import { translate } from '@/i18n/i18n'
import { settleComposerSubmit } from '@/lib/composer-submit-cancellation'
import { toFolderWorkspaceLinkedTask } from '@/components/sidebar/folder-workspace-composer-helpers'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { queueWorkspaceActivationTerminalFocus } from '@/lib/workspace-activation-terminal-focus'
import {
  hasExplicitTuiLaunchCustomization,
  normalizeStructuredCodexInitialOptions,
  resolveAgentLaunchRoute
} from '@/lib/agent-launch-routing'
import { readLocalRuntimeCapabilities } from '@/runtime/local-runtime-capabilities'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { startStructuredCodexLaunch } from '@/lib/structured-agent-session-launch'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-codex-session'
import { buildFullCreationStartupPayload } from './full-creation-startup-payload'
import { continueFullCreationActivation } from './full-creation-post-activation'
import { focusPublishedStructuredSession } from './full-creation-post-activation'
import { claimFullCreationStructuredRefusalFallback } from './full-creation-structured-refusal'
import { buildFullCreationIssueCommand } from './full-creation-issue-command'

export function useFullCreationExecution(input: FullCreationExecutionInput) {
  const {
    applyWorktreeMeta,
    clearNewWorkspaceDraft,
    createWorktree,
    effectivePresetId,
    isSubmissionCancelled,
    linkedGitLabIssue,
    linkedGitLabMR,
    normalizedSparseDirectories,
    note,
    onCreated,
    parentWorktreeId,
    persistDraft,
    persistSetupAgentStartupPolicy,
    prepareFullSubmit,
    resolvedInitialWorkspaceStatus,
    selectedRepoExecutionHostId,
    selectedRepoIsGit,
    selectedRepoIsRemote,
    setSidebarOpen,
    settings,
    sparseEnabled,
    taskSourceContext,
    telemetrySource,
    tuiAgent
  } = input

  const executeFullCreation = useCallback(
    async (
      smartGitHubResolution: PendingSmartGitHubSubmitResolution,
      repoId: string
    ): Promise<void> => {
      const prepared = await prepareFullSubmit(smartGitHubResolution)

      if (!prepared) {
        return
      }

      const {
        submitLinkedWorkItem,
        submitLinkedIssueNumber,
        submitLinkedPR,
        workspaceName,
        nameWasGenerated,
        submitBaseBranch,
        submitCompareBaseRef,
        submitPushTarget,
        submitStartupPrompt,
        submitShouldRunIssueAutomation,
        effectiveSetupDecision,
        issueCommandTrustDecision,
        confirmedIssueCommandTemplate,
        linkedLinearIssue,
        linkedLinearIssueWorkspaceId,
        linkedLinearIssueOrganizationUrlKey,
        effectiveBranchNameOverride,
        createDisplayName,
        pendingFirstAgentMessageRename,
        startupPlan,
        shouldSeedInitialAgentStatus,
        composerTelemetry,
        backendStartup
      } = prepared

      const startupPolicySettlement = await settleComposerSubmit(
        persistSetupAgentStartupPolicy(),
        isSubmissionCancelled
      )

      if (startupPolicySettlement.status === 'cancelled') {
        return
      }

      if (!startupPolicySettlement.value) {
        throw new Error(
          translate(
            'auto.hooks.useComposerState.setupAgentStartupPolicySaveFailed',
            'Failed to save setup startup behavior.'
          )
        )
      }

      if (isSubmissionCancelled()) {
        return
      }

      const structuredInitialOptions = normalizeStructuredCodexInitialOptions(
        startupPlan?.sessionOptions
      )
      const agentLaunchRoute = resolveAgentLaunchRoute({
        agent: tuiAgent,
        settings,
        executionHostId: selectedRepoExecutionHostId ?? 'local',
        platform: CLIENT_PLATFORM,
        hostCapabilities: readLocalRuntimeCapabilities(),
        workspaceKind: selectedRepoIsGit ? 'git-worktree' : 'folder',
        promptDelivery: startupPlan?.draftPrompt ? 'draft' : 'auto-submit',
        launchDraftText: startupPlan?.draftPrompt ?? submitStartupPrompt,
        nativeChatTranscriptIsLocalReadable: !selectedRepoIsRemote,
        requiresTuiLaunchCustomization: hasExplicitTuiLaunchCustomization(settings, tuiAgent),
        initialSessionOptions: structuredInitialOptions
      })
      const structuredLaunch = agentLaunchRoute === 'structured-native-chat'
      const effectiveBackendStartup = structuredLaunch ? undefined : backendStartup

      const result = await createWorktree(
        repoId,
        workspaceName,
        selectedRepoIsGit ? submitBaseBranch : undefined,
        effectiveSetupDecision,
        selectedRepoIsGit && sparseEnabled
          ? {
              directories: normalizedSparseDirectories,
              ...(effectivePresetId ? { presetId: effectivePresetId } : {})
            }
          : undefined,
        telemetrySource,
        createDisplayName,
        submitLinkedIssueNumber ?? undefined,
        submitLinkedPR ?? undefined,
        submitPushTarget,
        tuiAgent,
        linkedLinearIssue,
        effectiveBranchNameOverride,
        resolvedInitialWorkspaceStatus,
        smartGitHubResolution.kind === 'none' ? (linkedGitLabMR ?? undefined) : undefined,
        smartGitHubResolution.kind === 'none' ? (linkedGitLabIssue ?? undefined) : undefined,
        effectiveBackendStartup,
        structuredLaunch ? false : pendingFirstAgentMessageRename,
        undefined,
        linkedLinearIssueWorkspaceId,
        linkedLinearIssueOrganizationUrlKey,
        undefined,
        undefined,
        undefined,
        submitCompareBaseRef,
        {
          linkedWorkItem: toFolderWorkspaceLinkedTask(submitLinkedWorkItem),
          linkedTaskSourceContext: taskSourceContext,
          nameWasGenerated,
          ...(!structuredLaunch && !effectiveBackendStartup && startupPlan?.draftPrompt
            ? { startupDraft: startupPlan.draftPrompt }
            : {}),
          ...(parentWorktreeId ? { parentWorktreeId } : {})
        }
      )

      const worktree = result.worktree

      await applyWorktreeMeta(worktree.id, note.trim() ? { comment: note.trim() } : {})

      const issueCommand = buildFullCreationIssueCommand({
        enabled: submitShouldRunIssueAutomation,
        trustDecision: issueCommandTrustDecision,
        template: confirmedIssueCommandTemplate,
        issueNumber: submitLinkedIssueNumber,
        artifactUrl: submitLinkedWorkItem?.url
      })

      const backendSpawnedStartup = result.startupTerminal?.spawned === true

      const activation = activateAndRevealWorktree(worktree.id, {
        sidebarRevealBehavior: 'auto',
        setup: result.setup,
        defaultTabs: result.defaultTabs,
        issueCommand,
        ...(backendSpawnedStartup ? { backendStartupTerminalSpawned: true } : {}),
        ...(structuredLaunch ? { providesInitialSurface: true } : {}),
        ...(!structuredLaunch
          ? {
              startup: buildFullCreationStartupPayload({
                startupPlan,
                backendSpawnedStartup,
                tuiAgent,
                shouldSeedInitialAgentStatus,
                submitStartupPrompt,
                composerTelemetry
              })
            }
          : {})
      })

      continueFullCreationActivation({
        worktreeId: worktree.id,
        activation,
        startupPlan,
        structuredLaunch,
        backendSpawnedStartup,
        startupTerminalTabId: result.startupTerminal?.tabId,
        tuiAgent
      })

      if (structuredLaunch && tuiAgent === 'codex') {
        const launch = startStructuredCodexLaunch(worktree.id, {
          prompt: startupPlan?.draftPrompt ?? submitStartupPrompt,
          promptDelivery: startupPlan?.draftPrompt ? 'draft' : 'auto-submit',
          ...(structuredInitialOptions ? { initialOptions: structuredInitialOptions } : {}),
          telemetry: composerTelemetry
        })
        const refusalFallback = claimFullCreationStructuredRefusalFallback(launch, {
          worktreeId: worktree.id,
          startupPlan,
          backendSpawnedStartup,
          tuiAgent,
          shouldSeedInitialAgentStatus,
          submitStartupPrompt,
          composerTelemetry,
          ...(pendingFirstAgentMessageRename
            ? {
                restorePendingRename: () =>
                  applyWorktreeMeta(worktree.id, { pendingFirstAgentMessageRename: true }).then(
                    () => undefined,
                    () => undefined
                  )
              }
            : {})
        })
        try {
          focusPublishedStructuredSession(worktree.id, (await launch.launchResult).sessionId)
        } catch (error) {
          if (!(error instanceof StructuredAgentSessionCreateRefusalError)) {
            setSidebarOpen(true)
            onCreated?.()
            return
          }
          await refusalFallback
        }
      }

      setSidebarOpen(true)

      if (persistDraft) {
        clearNewWorkspaceDraft()
      }

      onCreated?.()

      if (!structuredLaunch) {
        queueWorkspaceActivationTerminalFocus(worktree.id, activation)
      }
    },
    [
      applyWorktreeMeta,
      clearNewWorkspaceDraft,
      createWorktree,
      effectivePresetId,
      isSubmissionCancelled,
      linkedGitLabIssue,
      linkedGitLabMR,
      normalizedSparseDirectories,
      note,
      onCreated,
      parentWorktreeId,
      persistDraft,
      persistSetupAgentStartupPolicy,
      prepareFullSubmit,
      resolvedInitialWorkspaceStatus,
      selectedRepoExecutionHostId,
      selectedRepoIsGit,
      selectedRepoIsRemote,
      setSidebarOpen,
      settings,
      sparseEnabled,
      taskSourceContext,
      telemetrySource,
      tuiAgent
    ]
  )

  return { executeFullCreation }
}
