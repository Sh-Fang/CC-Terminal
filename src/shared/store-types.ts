// 分组 / 标签页 / 会话栈数据结构：主进程 store、preload、渲染进程共用一份定义

export type SessionSource = 'startup' | 'clear' | 'compact' | 'resume' | 'fork'

/** 会话元信息；对话内容在 cc 的 jsonl 里，这里只记标题与时间 */
export interface SessionRec {
  id: string
  source: SessionSource
  createdAt: string
  lastTs?: string
  // 用户在 app 里手动改的名字
  userTitle?: string
  // cc 里 /rename 写入的标题
  ccTitle?: string
  // 第一条用户消息（截断）
  firstPrompt?: string
}

/** 标签页；stack 为会话栈，栈顶在前；closedAt 有值即历史标签页 */
export interface TabRec {
  id: string
  groupId: string
  name: string
  autoLaunchCC: boolean
  memo?: string
  stack: string[]
  openedAt: string
  lastSeenAt: string
  closedAt?: string
}

/** 分组；tabIds 含已关闭的标签页，顺序即显示顺序 */
export interface GroupRec {
  id: string
  name: string
  cwd: string
  collapsed: boolean
  tabIds: string[]
}

export interface StoreData {
  version: 1
  groups: GroupRec[]
  tabs: TabRec[]
  sessions: SessionRec[]
  activeTabId: string | null
}

/** 推给渲染进程的快照：持久数据 + 各标签页此刻正在运行的会话（不落盘） */
export interface StoreSnapshot extends StoreData {
  running: Record<string, string>
}

export interface SessionStartEvent {
  tabId: string
  sessionId: string
  source: SessionSource
  ts?: string
}

export type StoreOp =
  | { op: 'createGroup'; id: string; name: string; cwd: string }
  | { op: 'renameGroup'; id: string; name: string }
  | { op: 'setCollapsed'; ids: string[]; collapsed: boolean }
  | { op: 'reorderGroups'; ids: string[] }
  | { op: 'createTab'; id: string; groupId: string; name: string; autoLaunchCC: boolean; stack?: string[] }
  | { op: 'renameTab'; id: string; name: string }
  | { op: 'setAutoLaunch'; id: string; autoLaunchCC: boolean }
  | { op: 'setMemo'; id: string; memo: string | null }
  | { op: 'reorderTabs'; groupId: string; ids: string[] }
  | { op: 'closeTabs'; ids: string[] }
  | { op: 'reopenTab'; id: string; top?: string }
  | { op: 'setActiveTab'; id: string | null }
  | { op: 'clearRunning'; tabId: string }
  | { op: 'setTop'; tabId: string; sessionId: string }
  | { op: 'removeSession'; tabId: string; sessionId: string }
  | { op: 'renameSession'; id: string; title: string | null }
  | { op: 'refreshMeta'; ids: string[] }
