import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { FloatingTerminalWindowControls } from './FloatingTerminalWindowControls'

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

const storeBox = vi.hoisted(() => ({
  state: null as unknown
}))

const mocks = vi.hoisted(() => ({
  activateTab: vi.fn(),
  createTab: vi.fn(),
  setActiveTabForWorktree: vi.fn(),
  setTabBarOrder: vi.fn(),
  queueTabStartupCommand: vi.fn(),
  focusTerminalTabSurface: vi.fn(),
  buildAgentStartupPlan: vi.fn(),
  launchAgentInNewTab: vi.fn()
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof ReactModule>('react')
  return {
    ...actual,
    useCallback: <T,>(callback: T) => callback,
    useMemo: <T,>(factory: () => T) => factory()
  }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(storeBox.state), {
    getState: () => storeBox.state
  })
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))

vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: mocks.launchAgentInNewTab
}))

vi.mock('@/lib/tui-agent-startup', () => ({
  buildAgentStartupPlan: mocks.buildAgentStartupPlan
}))

vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => [{ id: 'claude', label: 'Claude' }],
  AgentIcon: function AgentIcon() {
    return null
  }
}))

vi.mock('@/lib/new-workspace', () => ({
  CLIENT_PLATFORM: 'darwin'
}))

vi.mock('@/lib/telemetry', () => ({
  tuiAgentToAgentKind: () => 'claude'
}))

vi.mock('../../../../shared/tui-agent-selection', () => ({
  isTuiAgentEnabled: () => true
}))

vi.mock('../../../../shared/tui-agent-launch-defaults', () => ({
  resolveTuiAgentLaunchArgs: () => [],
  resolveTuiAgentLaunchEnv: () => ({})
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, vars?: Record<string, string>) =>
    vars ? fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => vars[name] ?? '') : fallback
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useOptionalShortcutLabel: () => null
}))

vi.mock('@/components/ui/button', () => ({
  Button: function Button(props: { children?: unknown }) {
    return props.children ?? null
  }
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: function Tooltip(props: { children?: unknown }) {
    return props.children
  },
  TooltipContent: function TooltipContent(props: { children?: unknown }) {
    return props.children
  },
  TooltipTrigger: function TooltipTrigger(props: { children?: unknown }) {
    return props.children
  }
}))

vi.mock('lucide-react', () => ({
  Maximize2: function Maximize2() {
    return null
  },
  Minimize2: function Minimize2() {
    return null
  },
  Minus: function Minus() {
    return null
  }
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  if (!element.props) {
    return
  }
  cb(element)
  visit(element.props.children, cb)
}

function findOnClickByAriaLabel(node: unknown, ariaLabel: string): () => void {
  let found: (() => void) | null = null
  visit(node, (entry) => {
    if (entry.props['aria-label'] === ariaLabel && typeof entry.props.onClick === 'function') {
      found = entry.props.onClick as () => void
    }
  })
  if (!found) {
    throw new Error(`onClick for aria-label "${ariaLabel}" not found`)
  }
  return found
}

const NEW_AGENT_TAB_ID = 'floating-agent-tab'
const EXISTING_TAB_ID = 'floating-existing-tab'

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset()
  }
  mocks.createTab.mockImplementation(() => {
    const tab = { id: NEW_AGENT_TAB_ID }
    const state = storeBox.state as { tabsByWorktree: Record<string, { id: string }[]> }
    const existing = state.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []
    state.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] = [...existing, tab]
    return tab
  })
  mocks.buildAgentStartupPlan.mockReturnValue({
    launchCommand: 'claude',
    launchConfig: {},
    env: undefined,
    startupCommandDelivery: undefined
  })
  mocks.launchAgentInNewTab.mockReturnValue({ tabId: NEW_AGENT_TAB_ID })
  storeBox.state = {
    settings: {
      defaultTuiAgent: 'claude',
      disabledTuiAgents: [],
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {}
    },
    createTab: mocks.createTab,
    activateTab: mocks.activateTab,
    setActiveTabForWorktree: mocks.setActiveTabForWorktree,
    setTabBarOrder: mocks.setTabBarOrder,
    queueTabStartupCommand: mocks.queueTabStartupCommand,
    tabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [{ id: EXISTING_TAB_ID }] },
    tabBarOrderByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [EXISTING_TAB_ID] }
  }
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('FloatingTerminalWindowControls default-agent launch', () => {
  it('routes the floating default-agent action through the centralized launch policy', () => {
    ;(
      storeBox.state as {
        settings: Record<string, unknown>
      }
    ).settings.nativeChatSessionOptions = {
      claude: { model: 'opus', valuesByModel: { opus: { effort: 'high' } } }
    }
    const element = FloatingTerminalWindowControls({
      maximized: false,
      onToggleMaximized: vi.fn(),
      onMinimize: vi.fn()
    })

    const launch = findOnClickByAriaLabel(element, 'Open Claude in floating workspace')
    launch()

    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith({
      agent: 'claude',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      launchSource: 'shortcut'
    })
    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith(NEW_AGENT_TAB_ID)
  })
})
