// 启动前预置 userData 里的 store.json / settings.json / session-state 文件。
// 结构跟 src/shared/store-types.ts 的 StoreData 走，主进程读盘时按 src/main/store.ts 的 normalize 校验
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GroupRec, SessionRec, StoreData, TabRec } from '../../../src/shared/store-types'

/** 预置标签页；kind 省略为终端标签页 */
export interface TabSpec {
  id: string
  name?: string
  kind?: 'terminal' | 'claude' | 'codex'
  // 会话栈，栈顶在前
  stack?: string[]
  // 有值即历史标签页（已关闭）
  closedAt?: string
  memo?: string
}

/** 预置分组 */
export interface GroupSpec {
  id: string
  name?: string
  cwd: string
  tabs: TabSpec[]
  closed?: boolean
}

/** 预置会话的元信息 */
export interface SessionSpec {
  id: string
  userTitle?: string
  firstPrompt?: string
}

/** 按分组 / 标签页 / 会话描述拼出 store.json 的内容 */
export function buildStore(spec: { groups: GroupSpec[]; sessions?: SessionSpec[]; activeTabId?: string | null }): StoreData {
  const now = new Date().toISOString()
  const groups: GroupRec[] = []
  const tabs: TabRec[] = []
  for (const g of spec.groups) {
    groups.push({
      id: g.id,
      name: g.name ?? g.id,
      cwd: g.cwd,
      collapsed: false,
      tabIds: g.tabs.map((x) => x.id),
      closed: g.closed === true
    })
    for (const t of g.tabs) {
      const agent = t.kind === 'claude' || t.kind === 'codex' ? t.kind : undefined
      tabs.push({
        id: t.id,
        groupId: g.id,
        name: t.name ?? t.id,
        autoLaunchCC: !!agent,
        agent,
        memo: t.memo,
        stack: t.stack ?? [],
        openedAt: now,
        lastSeenAt: now,
        closedAt: t.closedAt
      })
    }
  }
  const sessions: SessionRec[] = (spec.sessions ?? []).map((s) => ({
    id: s.id,
    source: 'startup',
    createdAt: now,
    userTitle: s.userTitle,
    firstPrompt: s.firstPrompt
  }))
  const firstOpen = tabs.find((x) => !x.closedAt)?.id ?? null
  return { version: 1, groups, tabs, sessions, activeTabId: spec.activeTabId ?? firstOpen }
}

/** 写 store.json */
export function writeStore(userData: string, data: StoreData): void {
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'store.json'), JSON.stringify(data, null, 2), 'utf8')
}

/** 读当前落盘的 store.json */
export function readStore(userData: string): StoreData {
  return JSON.parse(readFileSync(join(userData, 'store.json'), 'utf8')) as StoreData
}

/** 写 settings.json：只写要改的字段，其余由主进程按默认值补齐 */
export function writeSettings(userData: string, partial: Record<string, unknown>): void {
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'settings.json'), JSON.stringify(partial, null, 2), 'utf8')
}

/** 状态文件目录：hook 往 <userData>/session-state/<标签页 id>.json 写状态 */
export function stateDir(userData: string): string {
  return join(userData, 'session-state')
}

/** 写一个状态文件；和 hook 一样整写，内容带时间戳保证每次都不同 */
export function writeStateFile(userData: string, tabId: string, state: Record<string, unknown>): void {
  const dir = stateDir(userData)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${tabId}.json`), JSON.stringify({ ts: new Date().toISOString(), ...state }), 'utf8')
}

/** 几分钟前的 ISO 时间，用来造今天关闭的历史标签页 */
export function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString()
}
