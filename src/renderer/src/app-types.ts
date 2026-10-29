// 跨模块共享的视图类型，controller 与各组件统一从此导入

import type { TerminalTab, SessionRecord } from './terminal-tab'

// 侧边栏视图
export interface GroupView {
  id: string
  name: string
  cwd: string
  collapsed: boolean
  tabs: TerminalTab[]
}

// 历史标签页条目
export interface HistoryEntry {
  tabId: string
  tabName: string
  groupName: string
  cwd: string
  autoLaunchCC: boolean
  sessions: SessionRecord[]
  activeSessionId?: string
  memo?: string
  openedAt: string
  lastSeenAt: string
}
