// 跨模块共享的视图类型，controller 与各组件统一从此导入

import type { TerminalTab, SessionRecord } from './terminal-tab'
import type { Range } from './lib/format'

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

// Ctrl+P 全局搜索的一条结果；titleHl 是 title 上的命中区间
export interface QuickItem {
  key: string
  kind: 'tab' | 'session' | 'path'
  title: string
  titleHl?: Range[]
  sub: string
  // 有值表示属于已关闭的标签页
  closedAt?: string
  act: () => void
}

// 按时间段（无关键字）或搜索类别（有关键字）分组
export interface QuickGroup {
  label: string
  items: QuickItem[]
}
