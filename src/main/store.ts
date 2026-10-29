// 分组 / 标签页 / 会话栈的唯一数据源：主进程持有，每次变更立即原子写 userData/store.json。
// 渲染进程只读快照、经 IPC 发操作；会话开始事件在这里直接按来历维护会话栈。
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isSessionSource } from './session-constants'
import type {
  GroupRec,
  SessionSource,
  SessionRec,
  SessionStartEvent,
  StoreData,
  StoreOp,
  StoreSnapshot,
  TabRec
} from '../shared/store-types'
import { migrateLegacy } from './store-migrate'

export type { StoreOp, StoreSnapshot } from '../shared/store-types'

const FILE = (): string => join(app.getPath('userData'), 'store.json')

let data: StoreData | null = null
const running = new Map<string, string>()
let onChange: ((snap: StoreSnapshot) => void) | null = null

export function setStoreChangeListener(fn: (snap: StoreSnapshot) => void): void {
  onChange = fn
}

function nowIso(): string {
  return new Date().toISOString()
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

// 读盘时逐字段校验，坏条目直接丢弃
function normalize(raw: unknown): StoreData {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const groups: GroupRec[] = []
  for (const g of Array.isArray(r.groups) ? r.groups : []) {
    const o = g as Record<string, unknown>
    if (!str(o?.id) || typeof o.cwd !== 'string') {
      continue
    }
    groups.push({
      id: o.id as string,
      name: str(o.name) ?? (o.cwd as string),
      cwd: o.cwd as string,
      collapsed: o.collapsed === true,
      tabIds: Array.isArray(o.tabIds) ? o.tabIds.filter((x): x is string => typeof x === 'string') : []
    })
  }
  const tabs: TabRec[] = []
  for (const t of Array.isArray(r.tabs) ? r.tabs : []) {
    const o = t as Record<string, unknown>
    if (!str(o?.id) || !str(o.groupId)) {
      continue
    }
    tabs.push({
      id: o.id as string,
      groupId: o.groupId as string,
      name: str(o.name) ?? 'A',
      autoLaunchCC: o.autoLaunchCC === true,
      memo: str(o.memo),
      stack: Array.isArray(o.stack) ? o.stack.filter((x): x is string => typeof x === 'string') : [],
      openedAt: str(o.openedAt) ?? nowIso(),
      lastSeenAt: str(o.lastSeenAt) ?? nowIso(),
      closedAt: str(o.closedAt)
    })
  }
  const sessions: SessionRec[] = []
  for (const s of Array.isArray(r.sessions) ? r.sessions : []) {
    const o = s as Record<string, unknown>
    if (!str(o?.id)) {
      continue
    }
    sessions.push({
      id: o.id as string,
      source: isSessionSource(o.source) ? o.source : 'startup',
      createdAt: str(o.createdAt) ?? nowIso(),
      lastTs: str(o.lastTs),
      userTitle: str(o.userTitle)
    })
  }
  return { version: 1, groups, tabs, sessions, activeTabId: str(r.activeTabId) ?? null }
}

function load(): StoreData {
  if (data) {
    return data
  }
  const path = FILE()
  if (existsSync(path)) {
    data = normalize(JSON.parse(readFileSync(path, 'utf8')))
  } else {
    // 首次启动新版：从旧 workspace.json / tab-history.json 离线转换，旧文件先整体备份
    data = normalize(migrateLegacy(app.getPath('userData')))
    persist()
  }
  return data
}

function persist(): void {
  const path = FILE()
  const dir = dirname(path)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, path)
}

export function snapshot(): StoreSnapshot {
  return { ...load(), running: Object.fromEntries(running) }
}

// 每个写操作的统一收尾：落盘 + 推送快照
function commit(): StoreSnapshot {
  persist()
  const snap = snapshot()
  onChange?.(snap)
  return snap
}

function tabOf(id: string): TabRec | undefined {
  return load().tabs.find((t) => t.id === id)
}

function groupOf(id: string): GroupRec | undefined {
  return load().groups.find((g) => g.id === id)
}

function sessionOf(id: string): SessionRec | undefined {
  return load().sessions.find((s) => s.id === id)
}

function ensureSession(id: string, source: SessionSource, ts?: string): SessionRec {
  let s = sessionOf(id)
  if (!s) {
    s = { id, source, createdAt: ts ?? nowIso() }
    load().sessions.push(s)
  }
  return s
}

function moveToTop(tab: TabRec, sessionId: string): void {
  tab.stack = [sessionId, ...tab.stack.filter((x) => x !== sessionId)]
}

/** 会话开始：按来历维护会话栈（见 GLOSSARY「主会话」「临时会话」） */
export function applySessionStart(ev: SessionStartEvent): StoreSnapshot | null {
  const tab = tabOf(ev.tabId)
  if (!tab) {
    return null
  }
  const prevRunning = running.get(tab.id)
  // 之前没在跑（刚启动）或跑的就是栈顶 → 视为主会话里的操作
  const fromTop = prevRunning === undefined || prevRunning === tab.stack[0]
  const inStack = tab.stack.includes(ev.sessionId)
  const sess = ensureSession(ev.sessionId, ev.source, ev.ts)
  if (ev.ts && (!sess.lastTs || ev.ts > sess.lastTs)) {
    sess.lastTs = ev.ts
  }
  if (ev.source === 'compact') {
    if (!inStack && tab.stack.length === 0) {
      tab.stack.push(ev.sessionId)
    }
  } else if (ev.source === 'resume') {
    // 栈内会话移到栈顶；栈外会话作为临时会话运行，不入栈
    if (inStack) {
      moveToTop(tab, ev.sessionId)
    }
  } else if (ev.source === 'startup') {
    moveToTop(tab, ev.sessionId)
  } else if (inStack) {
    // clear / fork 拿到已在栈里的 id：不变
  } else if (fromTop || tab.stack.length === 0) {
    tab.stack.unshift(ev.sessionId)
  } else {
    // 临时会话里开的新会话只入栈，不成为栈顶
    tab.stack.splice(1, 0, ev.sessionId)
  }
  running.set(tab.id, ev.sessionId)
  tab.lastSeenAt = nowIso()
  return commit()
}

/** 渲染进程发来的写操作 */
export function applyOp(o: StoreOp): StoreSnapshot {
  const d = load()
  switch (o.op) {
    case 'createGroup': {
      if (!groupOf(o.id)) {
        d.groups.push({ id: o.id, name: o.name, cwd: o.cwd, collapsed: false, tabIds: [] })
      }
      break
    }
    case 'renameGroup': {
      const g = groupOf(o.id)
      if (g) {
        g.name = o.name
      }
      break
    }
    case 'setCollapsed': {
      for (const id of o.ids) {
        const g = groupOf(id)
        if (g) {
          g.collapsed = o.collapsed
        }
      }
      break
    }
    case 'reorderGroups': {
      const picked = o.ids.map((id) => groupOf(id)).filter((g): g is GroupRec => !!g)
      d.groups = [...picked, ...d.groups.filter((g) => !o.ids.includes(g.id))]
      break
    }
    case 'createTab': {
      const g = groupOf(o.groupId)
      if (g && !tabOf(o.id)) {
        const ts = nowIso()
        d.tabs.push({
          id: o.id,
          groupId: o.groupId,
          name: o.name,
          autoLaunchCC: o.autoLaunchCC,
          stack: o.stack ?? [],
          openedAt: ts,
          lastSeenAt: ts
        })
        g.tabIds.push(o.id)
        g.collapsed = false
      }
      break
    }
    case 'renameTab': {
      const t = tabOf(o.id)
      if (t) {
        t.name = o.name
      }
      break
    }
    case 'setMemo': {
      const t = tabOf(o.id)
      if (t) {
        t.memo = o.memo ?? undefined
      }
      break
    }
    case 'reorderTabs': {
      const g = groupOf(o.groupId)
      if (g) {
        g.tabIds = [...o.ids.filter((id) => g.tabIds.includes(id)), ...g.tabIds.filter((id) => !o.ids.includes(id))]
      }
      break
    }
    case 'closeTabs': {
      const ts = nowIso()
      for (const id of o.ids) {
        const t = tabOf(id)
        if (t && !t.closedAt) {
          t.closedAt = ts
          t.lastSeenAt = ts
        }
        running.delete(id)
      }
      if (d.activeTabId && o.ids.includes(d.activeTabId)) {
        d.activeTabId = null
      }
      break
    }
    case 'deleteTabs': {
      // 只删历史标签页记录；仍打开的标签页不受影响
      const gone = new Set(o.ids.filter((id) => tabOf(id)?.closedAt))
      d.tabs = d.tabs.filter((t) => !gone.has(t.id))
      for (const g of d.groups) {
        g.tabIds = g.tabIds.filter((id) => !gone.has(id))
      }
      d.groups = d.groups.filter((g) => g.tabIds.length > 0)
      break
    }
    case 'reopenTab': {
      const t = tabOf(o.id)
      if (t) {
        const g = groupOf(t.groupId)
        // 分组此前已没有打开的标签页 → 重新出现时排到最后
        if (g && !d.tabs.some((x) => x.groupId === g.id && !x.closedAt)) {
          d.groups = [...d.groups.filter((x) => x.id !== g.id), g]
        }
        if (g) {
          g.collapsed = false
        }
        t.closedAt = undefined
        t.lastSeenAt = nowIso()
        if (o.top) {
          moveToTop(t, o.top)
        }
      }
      break
    }
    case 'setActiveTab': {
      d.activeTabId = o.id
      const t = o.id ? tabOf(o.id) : undefined
      if (t) {
        t.lastSeenAt = nowIso()
      }
      break
    }
    case 'setTop': {
      const t = tabOf(o.tabId)
      if (t && t.stack.includes(o.sessionId)) {
        moveToTop(t, o.sessionId)
      }
      break
    }
    case 'removeSession': {
      const t = tabOf(o.tabId)
      if (t) {
        t.stack = t.stack.filter((x) => x !== o.sessionId)
      }
      break
    }
    case 'renameSession': {
      const s = sessionOf(o.id)
      if (s) {
        s.userTitle = o.title?.trim() || undefined
      }
      break
    }
    case 'touchSession': {
      const s = sessionOf(o.id)
      if (s && (!s.lastTs || o.lastTs > s.lastTs)) {
        s.lastTs = o.lastTs
      }
      break
    }
    default: {
      break
    }
  }
  return commit()
}
