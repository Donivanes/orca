import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'
import type { AppState } from '@/store'

type TabOrderState = Pick<
  AppState,
  | 'tabsByWorktree'
  | 'openFiles'
  | 'browserTabsByWorktree'
  | 'tabBarOrderByWorktree'
  | 'setTabBarOrder'
>

export function appendLaunchedTabToOrder(
  state: TabOrderState,
  worktreeId: string,
  tabId: string
): void {
  const terminalIds = (state.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
  const editorIds = state.openFiles
    .filter((file) => file.worktreeId === worktreeId)
    .map((file) => file.id)
  const browserIds = (state.browserTabsByWorktree?.[worktreeId] ?? []).map((tab) => tab.id)
  const order = reconcileTabOrder(
    state.tabBarOrderByWorktree[worktreeId],
    terminalIds,
    editorIds,
    browserIds
  ).filter((id) => id !== tabId)
  state.setTabBarOrder(worktreeId, [...order, tabId])
}
