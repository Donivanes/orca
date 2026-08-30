import { isTuiAgentEnabled, pickTuiAgent } from '../../../shared/tui-agent-selection'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { AppState } from '@/store'

type AgentSelectionStore = Pick<
  AppState,
  'ensureRemoteDetectedAgents' | 'ensureDetectedAgents' | 'settings'
>

export async function selectDirectWorkItemAgent(args: {
  store: AgentSelectionStore
  agentOverride: TuiAgent | undefined
  launchConnectionId: string | null
  repoConnectionId: string | null
  detectedAgentsPromise: ReturnType<AppState['ensureDetectedAgents']> | null
}): Promise<TuiAgent | null> {
  const { store, agentOverride, launchConnectionId, repoConnectionId, detectedAgentsPromise } = args
  if (agentOverride) {
    const detectedAgents =
      typeof launchConnectionId === 'string'
        ? await store.ensureRemoteDetectedAgents(launchConnectionId)
        : await store.ensureDetectedAgents()
    if (
      !detectedAgents.includes(agentOverride) ||
      !isTuiAgentEnabled(agentOverride, store.settings?.disabledTuiAgents)
    ) {
      return null
    }
    return agentOverride
  }
  const detectedAgents =
    launchConnectionId === repoConnectionId
      ? await detectedAgentsPromise!
      : typeof launchConnectionId === 'string'
        ? await store.ensureRemoteDetectedAgents(launchConnectionId)
        : await store.ensureDetectedAgents()
  return pickTuiAgent(
    store.settings?.defaultTuiAgent,
    new Set(detectedAgents),
    store.settings?.disabledTuiAgents
  )
}
