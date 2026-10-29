// 旧版数据离线迁移：workspace.json（已保存分组/工作区）+ tab-history.json（标签历史）→ store.json 结构。
// 只转换映射关系，不拉起 cc；旧文件先整体复制到 migrate-backup-<时间戳>/，原文件保留不动。
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

interface LegacySession {
  sessionId: string
  source?: string
  createdAt?: string
  lastTs?: string
  userTitle?: string
}

interface LegacyTab {
  id: string
  name: string
  sessions: LegacySession[]
  activeSessionId?: string
  autoLaunchCC: boolean
  memo?: string
  // 用于同 id 冲突时取较新的一份
  seenAt: string
}

const HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const LEGACY_FILES = ['workspace.json', 'tab-history.json']

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function asArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]) : []
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function legacySessions(v: unknown): LegacySession[] {
  return asArray(v)
    .filter((s) => typeof s.sessionId === 'string')
    .map((s) => ({
      sessionId: s.sessionId as string,
      source: str(s.source),
      createdAt: str(s.createdAt),
      lastTs: str(s.lastTs),
      userTitle: str(s.userTitle)
    }))
}

// 旧会话栈末尾是最近的；activeSessionId 是恢复目标 → 新栈：激活的在栈顶，其余按最近在前
function toStack(t: LegacyTab): string[] {
  const ids = t.sessions.map((s) => s.sessionId).reverse()
  const uniq = [...new Set(ids)]
  const active = t.activeSessionId && uniq.includes(t.activeSessionId) ? t.activeSessionId : uniq[0]
  return active ? [active, ...uniq.filter((x) => x !== active)] : []
}

function backup(userData: string): void {
  const present = LEGACY_FILES.filter((f) => existsSync(join(userData, f)))
  if (present.length === 0) {
    return
  }
  const dir = join(userData, `migrate-backup-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  for (const f of present) {
    copyFileSync(join(userData, f), join(dir, f))
  }
}

/** 返回 store.json 的原始结构（交给 store.normalize 校验）；没有旧数据时返回空树 */
export function migrateLegacy(userData: string): unknown {
  backup(userData)
  const groups: { id: string; name: string; cwd: string; collapsed: boolean; tabIds: string[] }[] = []
  const tabs = new Map<string, LegacyTab & { groupId: string; closedAt: string }>()
  const sessions = new Map<string, LegacySession>()

  const addTab = (groupId: string, t: LegacyTab, closedAt: string): void => {
    const prev = tabs.get(t.id)
    if (prev && prev.seenAt >= t.seenAt) {
      return
    }
    if (prev) {
      const g = groups.find((x) => x.id === prev.groupId)
      if (g) {
        g.tabIds = g.tabIds.filter((x) => x !== t.id)
      }
    }
    tabs.set(t.id, { ...t, groupId, closedAt })
    groups.find((x) => x.id === groupId)?.tabIds.push(t.id)
    for (const s of t.sessions) {
      const ex = sessions.get(s.sessionId)
      if (!ex || (s.userTitle && !ex.userTitle)) {
        sessions.set(s.sessionId, s)
      }
    }
  }

  // 已保存分组 → 分组 + 已关闭的标签页；已保存工作区丢弃
  const ws = readJson(join(userData, 'workspace.json'))
  for (const sg of asArray(ws?.savedGroups)) {
    const snap = (sg.snapshot ?? {}) as Record<string, unknown>
    const id = str(sg.id)
    const cwd = str(sg.cwd) ?? str(snap.cwd)
    if (!id || cwd === undefined) {
      continue
    }
    const savedAt = str(sg.lastRestoredAt) ?? str(sg.savedAt) ?? new Date().toISOString()
    groups.push({ id, name: str(sg.name) ?? cwd, cwd, collapsed: false, tabIds: [] })
    for (const t of asArray(snap.tabs)) {
      if (!str(t.id) || !str(t.name)) {
        continue
      }
      addTab(id, {
        id: t.id as string,
        name: t.name as string,
        sessions: legacySessions(t.sessions),
        activeSessionId: str(t.activeSessionId),
        autoLaunchCC: t.autoLaunchCC !== false,
        memo: str(t.memo),
        seenAt: savedAt
      }, savedAt)
    }
  }

  // 近 7 天的标签历史 → 已关闭的标签页；按「分组名 + cwd」归到已有分组，没有则新建
  const hist = readJson(join(userData, 'tab-history.json'))
  const now = Date.now()
  let seq = 0
  for (const e of asArray(hist?.entries)) {
    const tabId = str(e.tabId)
    const cwd = str(e.cwd)
    const seen = str(e.lastSeenAt)
    if (!tabId || cwd === undefined || !seen) {
      continue
    }
    const ts = Date.parse(seen)
    if (!Number.isFinite(ts) || now - ts > HISTORY_MAX_AGE_MS) {
      continue
    }
    const groupName = str(e.groupName) ?? cwd
    let g = groups.find((x) => x.name === groupName && x.cwd === cwd)
    if (!g) {
      g = { id: `g_mig_${now.toString(36)}_${seq++}`, name: groupName, cwd, collapsed: false, tabIds: [] }
      groups.push(g)
    }
    addTab(g.id, {
      id: tabId,
      name: str(e.tabName) ?? 'A',
      sessions: legacySessions(e.sessions),
      activeSessionId: str(e.activeSessionId),
      autoLaunchCC: e.autoLaunchCC !== false,
      memo: str(e.memo),
      seenAt: seen
    }, seen)
  }

  return {
    version: 1,
    groups: groups.filter((g) => g.tabIds.length > 0),
    tabs: [...tabs.values()].map((t) => ({
      id: t.id,
      groupId: t.groupId,
      name: t.name,
      autoLaunchCC: t.autoLaunchCC,
      memo: t.memo,
      stack: toStack(t),
      openedAt: t.seenAt,
      lastSeenAt: t.seenAt,
      closedAt: t.closedAt
    })),
    sessions: [...sessions.values()].map((s) => ({
      id: s.sessionId,
      source: s.source,
      createdAt: s.createdAt,
      lastTs: s.lastTs,
      userTitle: s.userTitle
    })),
    activeTabId: null
  }
}
