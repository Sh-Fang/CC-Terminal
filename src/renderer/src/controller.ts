// controller.ts —— 业务核心。分组 / 标签页 / 会话栈的持久数据由主进程 store 持有（见 docs/adr/0001），
// 这里只保留一份只读镜像：写操作一律发 storeOp，主进程推回快照后 applySnapshot 同步到运行中的标签。
// 进程态（PTY、状态点、cc 是否活跃）只在渲染层；改动后调 refreshUI() 触发订阅 rev 的组件重渲染。
import { TerminalTab, type SessionRecord } from './terminal-tab'
import { DEFAULT_SETTINGS, type Settings } from './themes'
import { fuzzySearch, sessionTitle, type Range } from './lib/format'
import {
  confirmDialog,
  isConfirmOpen,
  openMemoEditor,
  openModal,
  openSearchOverlay,
  closeSearchOverlay,
  closeSearchOverlayIfOpen,
  toggleQuickOpen,
  showCtxMenu,
  toast,
  type CtxItem
} from './state/overlays'
import { icon } from './svg-icons'
import { setLanguage, t } from './i18n'
import { bump } from './state/store'
import type { GroupView, HistoryEntry, QuickGroup, QuickItem } from './app-types'
import type { AgentKind, StoreOp, StoreSnapshot, TabRec } from '../../shared/store-types'
import type { ForegroundInfo, ForegroundProgram } from '../../shared/foreground'

export type { GroupView, HistoryEntry, QuickGroup, QuickItem } from './app-types'

// hosts 元素：xterm 命令式挂载的宿主容器。initApp 开头 await hostsReady，保证恢复标签时 hostsEl 可用。
let hostsEl: HTMLDivElement | null = null
let hostsReadyResolve: (() => void) | null = null
const hostsReady = new Promise<void>((resolve) => {
  hostsReadyResolve = resolve
})

export function setHostsEl(el: HTMLDivElement | null): void {
  // 卸载（null）不清引用：已 mount 的 xterm DOM 还挂在旧元素上，清了反而拿不回
  if (!el) return
  hostsEl = el
  hostsReadyResolve?.()
  hostsReadyResolve = null
}

export interface Group {
  id: string
  name: string
  cwd: string
  collapsed: boolean
  tabs: TerminalTab[]
}

// 标签是否"承载 cc"：勾了自动启动，或实际起过会话——cct 手动起的 autoLaunchCC=false 但有真实会话，也算。
export function isCcTab(t: TerminalTab): boolean {
  return t.autoLaunchCC || t.sessions.length > 0
}

// 运行中的分组（至少有一个打开的标签页）；顺序与 store.groups 一致
const groups: Group[] = []
// 标签页下一层的临时会话终端：父标签页 id → 子终端（只在运行时存在，重启不恢复）
const children = new Map<string, TerminalTab[]>()
let childSeq = 0
const CHILD_SEP = '__c'

function isChildId(id: string): boolean {
  return id.includes(CHILD_SEP)
}

// 所有运行中的终端：标签页 + 其下一层临时会话
function allTabs(): TerminalTab[] {
  return groups.flatMap((g) => g.tabs.flatMap((t) => [t, ...(children.get(t.id) ?? [])]))
}

export function getChildren(tabId: string): TerminalTab[] {
  return children.get(tabId) ?? []
}

// 会话标题按所属标签页计算：下一层的临时会话借用父标签页的会话栈与名字
export function sessionTitleIn(tab: TerminalTab, sess: SessionRecord): string {
  const parent = isChildId(tab.id) ? findTab(tab.id.slice(0, tab.id.indexOf(CHILD_SEP)))?.tab : undefined
  const owner = parent ?? tab
  return sessionTitle(sess, owner.sessions, owner.name)
}
let store: StoreSnapshot = { version: 1, groups: [], tabs: [], sessions: [], activeTabId: null, running: {} }
let activeTabId: string | null = null
let settings: Settings = DEFAULT_SETTINGS
let settingsSaveTimer: number | null = null

export function getSettings(): Settings {
  return settings
}

function pushFloaterCounts(): void {
  if (!settings.showFloater) return
  let done = 0, attention = 0, busy = 0, total = 0
  for (const g of groups) {
    for (const t of g.tabs.flatMap((x) => [x, ...(children.get(x.id) ?? [])])) {
      total++
      const st = t.status ?? 'idle'
      if (st === 'done') done++
      else if (st === 'attention') attention++
      else if (st === 'busy') busy++
    }
  }
  window.term.floaterPush({ done, attention, busy, total })
}

// 统一刷新入口：bump 触发订阅 rev 的组件重渲染，悬浮窗计数一并跟着刷。
function refreshUI(): void {
  bump()
  pushFloaterCounts()
}

function applySettingsToAll(): void {
  for (const t of allTabs()) t.applySettings(settings)
}

export function updateSettings(s: Settings): void {
  const prevFloater = settings.showFloater
  const prevTabBar = settings.tabBarMode
  settings = s
  applySettingsToAll()
  refreshUI()
  // 垂直/水平布局切换改变终端可用宽度 —— 布局稳定后重排一次
  if (prevTabBar !== settings.tabBarMode) {
    setTimeout(() => activeContext()?.tab.refit(), 60)
  }
  if (prevFloater !== settings.showFloater) {
    window.term.floaterSetEnabled(settings.showFloater)
  }
  if (settings.showFloater) pushFloaterCounts()
  persistSettings()
}

// 就地合并（不落盘不刷新）：拖拽过程高频调用，拖完由调用方自己 persistSettings。
export function patchSettingsLive(p: Partial<Settings>): void {
  settings = { ...settings, ...p }
}

export function persistSettings(): void {
  if (settingsSaveTimer != null) window.clearTimeout(settingsSaveTimer)
  settingsSaveTimer = window.setTimeout(() => {
    settingsSaveTimer = null
    // 合并而非整体替换：旧构建主进程的归一化会把新字段悄悄抹掉
    void window.term.saveSettings(settings).then((normed) => { settings = { ...settings, ...normed } })
  }, 300)
}

function uid(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

const IS_WIN_PLATFORM = window.term.platform === 'win32'

// shell = 'cmd' 时按 cmd 语法用双引号（cmd 不认单引号）
function quoteShell(s: string, shell?: ForegroundProgram): string {
  if (shell === 'cmd') return `"${s}"`
  return IS_WIN_PLATFORM
    ? `'${s.replace(/'/g, "''")}'`
    : `'${s.replace(/'/g, "'\\''")}'`
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// 判断命令行是否「启动智能体」（claude / cct / codex / claudePath basename）：命中则跳过 shell-busy，交给 hooks 驱动状态。
function commandLineIsCcInvocation(cmd: string | undefined, claudePath: string): boolean {
  if (!cmd) return false
  const m = /^\s*(?:&\s+)?(?:'([^']*)'|"([^"]*)"|(\S+))/.exec(cmd)
  if (!m) return false
  const exe = (m[1] ?? m[2] ?? m[3] ?? '').toLowerCase()
  if (!exe) return false
  const base = exe.split(/[\\/]/).pop()!.replace(/\.(exe|cmd|ps1|bat)$/i, '')
  if (base === 'claude') return true
  if (base === 'cct') return true
  if (base === 'codex') return true
  if (claudePath) {
    const cpBase = claudePath.toLowerCase().split(/[\\/]/).pop()?.replace(/\.(exe|cmd|ps1|bat)$/i, '') || ''
    if (cpBase && base === cpBase) return true
  }
  return false
}

let cachedHookJson: string | null = null
async function hookSettingsArg(shell?: ForegroundProgram): Promise<string> {
  if (!cachedHookJson) cachedHookJson = (await window.term.hookPaths()).ccHooksJson
  return ` --settings ${quoteShell(cachedHookJson, shell)}`
}

// 前台程序：按 ptyId 记主进程推来的结果；还没推到时按平台默认 shell、视为不在提示符
const fgByPty = new Map<number, ForegroundInfo>()
const DEFAULT_SHELL: ForegroundProgram = IS_WIN_PLATFORM ? 'pwsh' : 'sh'

export function foregroundOf(tab: TerminalTab): ForegroundInfo {
  const info = tab.ptyId != null ? fgByPty.get(tab.ptyId) : undefined
  return info ?? { program: DEFAULT_SHELL, atPrompt: false }
}

function findTab(tabId: string): { group: Group; tab: TerminalTab } | null {
  for (const g of groups) {
    for (const t of g.tabs) {
      if (t.id === tabId) return { group: g, tab: t }
      const c = children.get(t.id)?.find((x) => x.id === tabId)
      if (c) return { group: g, tab: c }
    }
  }
  return null
}
export function activeContext(): { group: Group; tab: TerminalTab } | null {
  return activeTabId ? findTab(activeTabId) : null
}
function findGroup(groupId: string): Group | undefined {
  return groups.find((g) => g.id === groupId)
}

export function getActiveTabId(): string | null {
  return activeTabId
}

export function refitActive(): void {
  activeContext()?.tab.refit()
}

export function getToolbarCtx(): { tab: TerminalTab; groupName: string; groupCwd: string } | null {
  const ctx = activeContext()
  if (!ctx) return null
  return { tab: ctx.tab, groupName: ctx.group.name, groupCwd: ctx.group.cwd }
}

export function getSessionInfoCtx(): { sessionId: string | null; cwd: string; ptyId: number | null; tabId: string } | null {
  const ctx = activeContext()
  if (!ctx) return null
  return { sessionId: ctx.tab.activeSessionId ?? null, cwd: ctx.group.cwd, ptyId: ctx.tab.ptyId, tabId: ctx.tab.id }
}

// ── store 镜像 ────────────────────────────────────────────────────

// 会话栈（栈顶在前）→ 标签上沿用的 sessions 数组（末尾为栈顶）
function sessionsOfStack(stack: string[]): SessionRecord[] {
  const out: SessionRecord[] = []
  for (const id of [...stack].reverse()) {
    const s = store.sessions.find((x) => x.id === id)
    out.push({
      sessionId: id,
      source: s?.source ?? 'startup',
      agent: s?.agent,
      createdAt: s?.createdAt ?? new Date().toISOString(),
      userTitle: s?.userTitle,
      ccTitle: s?.ccTitle,
      firstPrompt: s?.firstPrompt,
      lastTs: s?.lastTs
    })
  }
  return out
}

function tabRec(id: string): TabRec | undefined {
  return store.tabs.find((t) => t.id === id)
}

// 主进程快照 → 运行中的分组/标签：名称、折叠、顺序、备注、会话栈全部以快照为准
function applySnapshot(snap: StoreSnapshot): void {
  store = snap
  for (const g of groups) {
    const rec = snap.groups.find((x) => x.id === g.id)
    if (!rec) continue
    g.name = rec.name
    g.collapsed = rec.collapsed
    g.tabs.sort((a, b) => rec.tabIds.indexOf(a.id) - rec.tabIds.indexOf(b.id))
    for (const tab of g.tabs) {
      const tr = tabRec(tab.id)
      if (!tr) continue
      tab.name = tr.name
      tab.memo = tr.memo
      tab.autoLaunchCC = tr.autoLaunchCC
      tab.sessions = sessionsOfStack(tr.stack)
      tab.activeSessionId = tr.stack[0]
      for (const c of children.get(tab.id) ?? []) {
        const cs = tab.sessions.find((x) => x.sessionId === c.activeSessionId)
        if (cs) {
          c.sessions = [cs]
          c.name = sessionTitle(cs, tab.sessions, tab.name)
        }
      }
    }
  }
  const order = snap.groups.map((x) => x.id)
  groups.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
  refreshUI()
}

async function op(o: StoreOp): Promise<void> {
  applySnapshot(await window.term.storeOp(o))
}

// ── cc 启动并发闸门 ──────────────────────────────────────────────
// 恢复多个标签会在一瞬间为每个标签触发 launchCC，十几个 claude(node) 同时冷启动
// 会打满磁盘 IO + Defender 扫描，整机卡顿（CPU/内存都不高）。闸门限制同时启动数
//（每轮突发随机 2 或 3），其余排队；占位在该 tab 的 SessionStart hook 到达（cc 已
// 起来）或 500~1000ms 随机兜底超时后释放，先到先释放。
let ccGateActive = 0
let ccGateLimit = 3
const ccGateQueue: (() => void)[] = []
const ccGateHeld = new Set<string>()

function ccGateAcquire(tabId: string): Promise<void> {
  return new Promise((resolve) => {
    const grant = (): void => {
      ccGateActive++
      ccGateHeld.add(tabId)
      // 兜底释放：hook 丢失/cc 启动失败也不许永久占坑
      window.setTimeout(() => ccGateRelease(tabId), 500 + Math.floor(Math.random() * 500))
      resolve()
    }
    if (ccGateActive === 0 && ccGateQueue.length === 0) {
      ccGateLimit = 2 + (Math.random() < 0.5 ? 0 : 1)
    }
    if (ccGateActive < ccGateLimit) grant()
    else ccGateQueue.push(grant)
  })
}

function ccGateRelease(tabId: string): void {
  if (!ccGateHeld.delete(tabId)) return // 未占坑或已释放（超时与 hook 双触发）
  ccGateActive = Math.max(0, ccGateActive - 1)
  const next = ccGateQueue.shift()
  if (next) next()
}

// 「重新加载标签」重建 PTY 后要恢复手动起的 cc（autoLaunchCC=false 但 reload 前 cc 正活跃）：
// 这些 tabId 的下一次 onPtyStarted 破例走一次 launchCC，用完即消费。
const resumeCcOnNextStart = new Set<string>()

// shell：要把命令发进哪种 shell，决定引号与调用语法；不传则是标签页自己起的 shell
// pick：右键选的智能体；不传则跟随主会话所属的智能体（没有主会话按 Claude Code）
async function launchCC(tab: TerminalTab, shell?: ForegroundProgram, pick?: AgentKind): Promise<void> {
  const forced = resumeCcOnNextStart.delete(tab.id)
  if (!tab.autoLaunchCC && !forced) return
  if (tab.ptyId == null) return
  await ccGateAcquire(tab.id)
  // 排队期间 tab 可能已关闭 / pty 已退出
  if (tab.ptyId == null) {
    ccGateRelease(tab.id)
    return
  }

  const top = tab.activeSessionId
  const topAgent = top ? (tab.sessions.find((x) => x.sessionId === top)?.agent ?? 'claude') : undefined
  const agent = pick ?? topAgent ?? 'claude'
  // 主会话属于这个智能体：还在就续上；对话记录已不在则从栈里移除，新开会话（hook 上报后成为栈顶）。
  // 主会话属于另一个智能体：保留它，直接新开
  let resumeId: string | null = null
  if (top && topAgent === agent && UUID_RE.test(top)) {
    const exists = agent === 'codex'
      ? await window.term.codexSessionExists(top)
      : await window.term.claudeSessionExists(top)
    if (exists) {
      resumeId = top
    } else {
      await op({ op: 'removeSession', tabId: tab.id, sessionId: top })
    }
  }
  const cmd = agent === 'codex'
    ? await codexCommand(tab, resumeId)
    : await claudeCommand(tab, shell, resumeId)
  if (cmd == null || tab.ptyId == null) {
    ccGateRelease(tab.id)
    return
  }
  window.term.send(tab.ptyId, cmd + '\r')
}

// 拼 claude 启动命令；claude 不可用时在终端里提示并返回 null
async function claudeCommand(tab: TerminalTab, shell: ForegroundProgram | undefined, resumeId: string | null): Promise<string | null> {
  const claudeBin = settings.claudePath.trim()
  if (claudeBin) {
    if (!(await window.term.pathExists(claudeBin))) {
      tab.term.writeln(`\x1b[33m${t('[claude 路径不存在：{0}，跳过自动启动]', claudeBin)}\x1b[0m`)
      tab.term.writeln(`\x1b[90m${t('请到设置 → Claude Code 中重新选择 claude 可执行文件。')}\x1b[0m`)
      return null
    }
  } else {
    const available = await window.term.claudeAvailable()
    if (!available) {
      tab.term.writeln(`\x1b[90m${t('[claude 未在 PATH 中，跳过自动启动 Claude Code]')}\x1b[0m`)
      return null
    }
  }
  const claudeCmd = claudeBin ? quoteShell(claudeBin, shell) : 'claude'
  // pwsh 里引号包住的绝对路径要加 & 调用操作符才执行；cmd 和 POSIX 不用
  const invoker = claudeBin && IS_WIN_PLATFORM && shell !== 'cmd' ? '& ' : ''

  const settingsArg = await hookSettingsArg(shell)
  // 每次起 cc 都现读设置：改完开关再「重新加载标签」，新进程就按新模式起（不必重开 app）
  const dangerArg = settings.dangerousSkipPermissions ? ' --dangerously-skip-permissions' : ''
  if (resumeId) {
    return `${invoker}${claudeCmd} --resume ${resumeId}${dangerArg}${settingsArg}`
  }
  return `${invoker}${claudeCmd} --session-id ${crypto.randomUUID()}${dangerArg}${settingsArg}`
}

// 拼 codex 启动命令：-p 叠加 app 写好的 hooks profile；会话 id 由 codex 自己生成，经 SessionStart hook 上报
async function codexCommand(tab: TerminalTab, resumeId: string | null): Promise<string | null> {
  if (!(await window.term.codexAvailable())) {
    tab.term.writeln(`\x1b[90m${t('[codex 未在 PATH 中，跳过启动 Codex]')}\x1b[0m`)
    return null
  }
  const dangerArg = settings.dangerousSkipPermissions ? ' --dangerously-bypass-approvals-and-sandbox' : ''
  const sub = resumeId ? ` resume ${resumeId}` : ''
  return `codex${sub} -p cc-terminal --dangerously-bypass-hook-trust${dangerArg}`
}

// 右键「启动智能体」：标签页转为 Claude 标签页，在当前 shell 里起选中的智能体（主会话属于它就续上）
export async function launchAgentInTab(tabId: string, agent: AgentKind): Promise<void> {
  const ctx = findTab(tabId)
  if (!ctx || ctx.tab.ptyId == null) return
  const { tab } = ctx
  const fg = foregroundOf(tab)
  if (!fg.atPrompt) return
  if (!tab.autoLaunchCC) {
    tab.autoLaunchCC = true
    await op({ op: 'setAutoLaunch', id: tabId, autoLaunchCC: true })
  }
  await launchCC(tab, fg.program, agent)
  tab.term.focus()
}

// 为一条已在 store 里的标签页记录建运行中的标签（xterm + 回调），不起 PTY
function mountTab(group: Group, rec: TabRec): TerminalTab {
  const tab = buildTab(group, {
    id: rec.id,
    name: rec.name,
    sessions: sessionsOfStack(rec.stack),
    activeSessionId: rec.stack[0],
    autoLaunchCC: rec.autoLaunchCC,
    memo: rec.memo
  })
  group.tabs.push(tab)
  return tab
}

// 标签页下一层打开一个临时会话：独立终端，挂在父标签页下，--resume 该会话
function mountChild(group: Group, parent: TerminalTab, sessionId: string): TerminalTab {
  const sess = parent.sessions.find((x) => x.sessionId === sessionId)
  const child = buildTab(group, {
    id: `${parent.id}${CHILD_SEP}${++childSeq}`,
    name: sess ? sessionTitle(sess, parent.sessions, parent.name) : sessionId.slice(0, 8),
    sessions: sess ? [sess] : [],
    activeSessionId: sessionId,
    autoLaunchCC: true
  })
  children.set(parent.id, [...(children.get(parent.id) ?? []), child])
  return child
}

function buildTab(group: Group, opts: {
  id: string
  name: string
  sessions: SessionRecord[]
  activeSessionId?: string
  autoLaunchCC: boolean
  memo?: string
}): TerminalTab {
  const id = opts.id
  let tabRef!: TerminalTab
  tabRef = new TerminalTab(
    {
      ...opts,
      cwd: group.cwd,
      settings
    },
    {
      copySelectionAsAnswer: () => false,
      openSearch: openSearchOverlay,
      // Esc 优先收搜索浮层（清高亮/选区，与 SearchBar 显式关闭一致），消费掉则不透传给 cc
      onEscapeCloseSearch: () => {
        if (!closeSearchOverlayIfOpen()) return false
        tabRef.search.clearDecorations()
        tabRef.term.clearSelection()
        return true
      },
      onRequestNewTab: () => promptNewTabInGroup(group.id),
      onRequestCloseSelf: () => closeTab(id),
      onPtyStarted: () => void launchCC(tabRef),
      onUserAbort: () => {
        if (tabRef.status !== 'busy') return
        tabRef.status = 'idle'
        tabRef.note = undefined
        refreshUI()
      },
      // 扫文本命中的 API Error（老版本 cc 兜底路径；新版走 StopFailure hook → onStateEvent）：
      // terminal-tab 已置 status=error，这里补 note 并刷新。红点不自动降级，需手动清除。
      onErrorDetected: (note) => {
        tabRef.note = note
        refreshUI()
      },
      onShellCommand: (kind, cmd) => {
        // shell integration OSC 触发 → pwsh 一定在前台（cc 全屏 TUI 会屏蔽这些序列），据此翻回 ccActive
        if (tabRef.ccActive) {
          tabRef.ccActive = false
          // cc 刚退回 pwsh：无条件复位鼠标/焦点追踪，防 cc 异常退出漏关模式后鼠标移动狂刷乱码
          tabRef.resetInputTrackingModes()
          // 不再有会话在跑，免得之后误报「同一会话重复打开」
          void op({ op: 'clearRunning', tabId: id })
          refreshUI()
        }
        // cc tab 状态完全交给 cc hooks，shell 事件不参与
        if (tabRef.autoLaunchCC) return
        if (kind === 'start' && commandLineIsCcInvocation(cmd, settings.claudePath)) return
        if (kind === 'start') {
          if (tabRef.status === 'busy') return
          tabRef.status = 'busy'
          tabRef.note = undefined
        } else {
          // 只把「自己刚起的 busy」降回 idle，不覆盖 error 之类
          if (tabRef.status !== 'busy') return
          tabRef.status = 'idle'
          tabRef.note = undefined
        }
        refreshUI()
      }
    }
  )
  tabRef.mount(hostsEl!)
  return tabRef
}

// 运行中的分组：没有就按 store 记录建一个并按 store 顺序插入
function liveGroup(groupId: string): Group | null {
  const existing = findGroup(groupId)
  if (existing) return existing
  const rec = store.groups.find((g) => g.id === groupId)
  if (!rec) return null
  const g: Group = { id: rec.id, name: rec.name, cwd: rec.cwd, collapsed: rec.collapsed, tabs: [] }
  groups.push(g)
  const order = store.groups.map((x) => x.id)
  groups.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
  return g
}

// 新建标签页：先写 store，再按记录建运行中的标签
async function createTab(groupId: string, name: string, autoLaunchCC: boolean, stack?: string[]): Promise<TerminalTab | null> {
  const id = uid('t_')
  await op({ op: 'createTab', id, groupId, name, autoLaunchCC, stack })
  const g = liveGroup(groupId)
  const rec = tabRec(id)
  if (!g || !rec) return null
  return mountTab(g, rec)
}

async function createGroup(name: string, cwd: string): Promise<string> {
  const id = uid('g_')
  await op({ op: 'createGroup', id, name, cwd })
  return id
}

async function spawnTabPty(tab: TerminalTab): Promise<void> {
  // 等 setActive 的 rAF 跑完（fit 已算出真实 cols/rows）再 startPty；
  // 否则 PTY 以 display:none 时的 80×24 启动，cc splash 画到一半收 SIGWINCH 会整屏错位。
  if (window.__termDebug) console.log(`[term] +${performance.now().toFixed(1)}ms`, tab.id, 'spawnTabPty: awaiting rAF before startPty')
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  if (window.__termDebug) console.log(`[term] +${performance.now().toFixed(1)}ms`, tab.id, 'spawnTabPty: rAF done, calling startPty')
  await tab.startPty()
  void refreshSessionMeta(tab)
}

// 每帧只起一小批 PTY，批间让出一帧，避免恢复多标签时长任务卡死 UI 线程。
const RESTORE_BATCH = 2
async function spawnTabsBatched(tabs: TerminalTab[]): Promise<void> {
  for (let i = 0; i < tabs.length; i += RESTORE_BATCH) {
    if (i > 0) await new Promise<void>((r) => requestAnimationFrame(() => r()))
    await Promise.all(tabs.slice(i, i + RESTORE_BATCH).map((t) => spawnTabPty(t)))
  }
}

// 从 cc 对话记录补会话的最后活跃时间与标题来源（主进程读文件）
async function refreshSessionMeta(tab: TerminalTab): Promise<void> {
  const owner = isChildId(tab.id) ? findTab(tab.id.slice(0, tab.id.indexOf(CHILD_SEP)))?.tab ?? tab : tab
  const ids = owner.sessions.map((s) => s.sessionId)
  if (ids.length > 0) {
    await op({ op: 'refreshMeta', ids })
  }
}

function rememberCwd(cwd: string): void {
  if (cwd && cwd !== settings.lastUsedCwd) {
    settings = { ...settings, lastUsedCwd: cwd }
    void window.term.saveSettings(settings)
  }
}

async function openNewTab(tab: TerminalTab | null): Promise<void> {
  if (!tab) return
  activeTabId = tab.id
  activateUI(tab.id)
  void op({ op: 'setActiveTab', id: tab.id })
  await spawnTabPty(tab)
}

export async function newGroup(): Promise<void> {
  const prefilledCwd = settings.lastUsedCwd || settings.defaults.cwd
  openModal({
    kind: 'new-group',
    title: t('新建分组'),
    sub: '',
    name: t('新分组'),
    cwd: prefilledCwd,
    showCC: true,
    ccChecked: settings.defaults.autoLaunchCC,
    showTabName: true,
    tabName: 'A',
    okLabel: t('创建'),
    autoNameFromCwd: true,
    onPickCwd: (cur) => window.term.pickDirectory(cur || prefilledCwd),
    onOk: async (v) => {
      const cwd = v.cwd?.trim() || ''
      const gid = await createGroup(v.name, cwd)
      const tab = await createTab(gid, v.tabName?.trim() || 'A', v.autoLaunchCC === true)
      await openNewTab(tab)
      rememberCwd(cwd)
    }
  })
}

// 磁盘根（D:\ 等）没有"最后一段"，美化成「D 盘」
function basenameOfPath(p: string): string {
  const drive = /^([a-zA-Z]):[\\/]?$/.exec(p.trim())
  if (drive) return t('{0} 盘', drive[1].toUpperCase())
  const segs = p.split(/[\\/]+/).filter(Boolean)
  return segs[segs.length - 1] ?? p
}

// 右键"在此处打开"：同 cwd 的运行中分组直接加标签，否则新建分组
async function openHereWithPath(rawPath: string): Promise<void> {
  const p = (rawPath || '').trim()
  if (!p) return
  const exists = await window.term.pathExists(p)
  if (!exists) {
    toast(t('路径不存在：{0}', p))
    return
  }
  const live = groups.find((x) => x.cwd === p)
  const gid = live ? live.id : await createGroup(basenameOfPath(p) || p, p)
  const count = live ? live.tabs.length : 0
  const tab = await createTab(gid, String.fromCharCode(65 + count), settings.defaults.autoLaunchCC)
  await openNewTab(tab)
  rememberCwd(p)
}

export async function promptNewTabInGroup(groupId: string): Promise<void> {
  const g = findGroup(groupId)
  if (!g) return
  const nm = String.fromCharCode(65 + g.tabs.length)
  openModal({
    kind: 'new-tab',
    title: t('在「{0}」新建标签', g.name),
    sub: '',
    name: nm,
    cwd: undefined,
    showCC: true,
    ccChecked: settings.defaults.autoLaunchCC,
    okLabel: t('创建'),
    onOk: async (v) => {
      await openNewTab(await createTab(groupId, v.name, v.autoLaunchCC === true))
    }
  })
}

function activateUI(tabId: string): void {
  for (const t of allTabs()) t.setActive(t.id === tabId)
  refreshUI()
}

// 查看降级：切到 done 标签且主窗口有焦点，停留 N 秒后降回 idle；失焦暂停、回焦重新计满 N 秒。
// attention 不参与降级：只能由 cc 发新状态或手动"标记为已查看"清除。
let downgradeTimer: number | null = null
let downgradeTabId: string | null = null
let downgradeFromStatus: TerminalTab['status'] | null = null
// StopFailure 的 error 分类 → 中文短句。cc 原文是英文长句（"API Error: Connection refused — a
// firewall or proxy may be blocking it (ConnectionRefused)"），标签上放不下，能归类的一律出短句。
const CC_ERROR_KIND_NOTE: Record<string, string> = {
  rate_limit: '触发限流',
  overloaded: '服务端过载',
  authentication_failed: '认证失败',
  oauth_org_not_allowed: '组织未授权',
  account_on_hold: '账号被冻结',
  billing_error: '计费异常',
  invalid_request: '请求不合法',
  model_not_found: '模型不存在',
  server_error: '服务端异常',
  max_output_tokens: '输出长度超限',
  cloud_credential_error: '云凭据加载失败',
  unknown: '接口异常'
}
const ERROR_NOTE_MAX = 60

function errorNote(kind: string | undefined, message: string | undefined): string {
  const mapped = kind ? CC_ERROR_KIND_NOTE[kind] : undefined
  if (mapped) return t(mapped)
  const raw = (message ?? '').trim()
  if (!raw) return t('接口异常')
  return raw.length > ERROR_NOTE_MAX ? raw.slice(0, ERROR_NOTE_MAX - 1) + '…' : raw
}

function clearDowngradeTimer(): void {
  if (downgradeTimer != null) { window.clearTimeout(downgradeTimer); downgradeTimer = null }
  downgradeTabId = null
  downgradeFromStatus = null
}
function maybeStartDowngrade(tabId: string, st: TerminalTab['status']): void {
  if (activeTabId !== tabId) return
  if (st !== 'done') return
  // 主窗口失焦时不启动倒计时；focus 事件回来时 resumeDowngradeIfNeeded 会再调一次
  if (!document.hasFocus()) return
  clearDowngradeTimer()
  downgradeTabId = tabId
  downgradeFromStatus = st
  downgradeTimer = window.setTimeout(() => {
    downgradeTimer = null
    const c = findTab(tabId)
    const from = downgradeFromStatus
    downgradeTabId = null
    downgradeFromStatus = null
    if (!c) return
    if (activeTabId !== tabId) return
    if (c.tab.status !== from) return
    c.tab.status = 'idle'
    c.tab.note = undefined
    refreshUI()
  }, settings.statusDowngradeSec * 1000)
}

function resumeDowngradeIfNeeded(): void {
  if (!activeTabId) return
  const ctx = findTab(activeTabId)
  if (!ctx) return
  maybeStartDowngrade(activeTabId, ctx.tab.status)
}

export function activateTab(tabId: string): void {
  if (activeTabId === tabId) return
  const ctx = findTab(tabId)
  if (!ctx) return
  if (window.__termDebug) console.log(`[term] +${performance.now().toFixed(1)}ms`, `activateTab ${activeTabId} -> ${tabId}`)
  activeTabId = tabId
  clearDowngradeTimer()
  maybeStartDowngrade(tabId, ctx.tab.status)
  activateUI(tabId)
  if (!isChildId(tabId)) {
    void op({ op: 'setActiveTab', id: tabId })
  }
}

// 从运行中摘除一批标签（销毁 xterm/PTY），空分组一并移除，并挑下一个激活
function unmountTabs(ids: string[]): void {
  let nextActive: TerminalTab | null = null
  for (const g of [...groups]) {
    const idx = g.tabs.findIndex((x) => ids.includes(x.id))
    for (const tab of g.tabs.filter((x) => ids.includes(x.id))) {
      for (const c of children.get(tab.id) ?? []) {
        c.dispose()
      }
      children.delete(tab.id)
      tab.dispose()
      if (downgradeTabId === tab.id) clearDowngradeTimer()
    }
    if (activeTabId && isChildId(activeTabId) && ids.some((x) => activeTabId!.startsWith(x + CHILD_SEP))) {
      activeTabId = activeTabId.slice(0, activeTabId.indexOf(CHILD_SEP))
    }
    g.tabs = g.tabs.filter((x) => !ids.includes(x.id))
    if (activeTabId && ids.includes(activeTabId) && idx >= 0) {
      nextActive = g.tabs[idx] || g.tabs[idx - 1] || null
    }
    if (g.tabs.length === 0) {
      groups.splice(groups.indexOf(g), 1)
    }
  }
  if (activeTabId && ids.includes(activeTabId)) {
    const next = nextActive ?? groups.flatMap((x) => x.tabs)[0] ?? null
    activeTabId = next?.id ?? null
    if (next) {
      activateUI(next.id)
      void op({ op: 'setActiveTab', id: next.id })
    }
  }
  refreshUI()
}

async function closeTabsNow(ids: string[]): Promise<void> {
  unmountTabs(ids)
  await op({ op: 'closeTabs', ids })
}

function busyCountOf(tabs: TerminalTab[]): number {
  return tabs.filter((x) => x.status === 'busy' || x.status === 'attention').length
}

// 关闭下一层临时会话：只销毁终端，会话仍在父标签页的会话栈里
function closeChild(childId: string): void {
  const parentId = childId.slice(0, childId.indexOf(CHILD_SEP))
  const list = children.get(parentId) ?? []
  const child = list.find((x) => x.id === childId)
  if (!child) return
  child.dispose()
  children.set(parentId, list.filter((x) => x !== child))
  void op({ op: 'clearRunning', tabId: childId })
  if (activeTabId === childId) {
    activeTabId = parentId
    activateUI(parentId)
  }
  refreshUI()
}

export function closeTab(tabId: string): void {
  const ctx = findTab(tabId)
  if (!ctx) return
  const { tab } = ctx
  const busy = busyCountOf([tab]) > 0
  if (isChildId(tabId)) {
    confirmDialog({
      title: t('关闭「{0}」？', tab.name),
      message: busy ? t('该会话正在运行或待决策，关闭会立即中断。') : '',
      okLabel: t('关闭'),
      onOk: () => closeChild(tabId)
    })
    return
  }
  confirmDialog({
    title: t('关闭标签「{0}」？', tab.name),
    message: busy ? t('该标签正在运行或待决策，关闭会立即中断。') : '',
    okLabel: t('关闭标签'),
    onOk: () => void closeTabsNow([tabId])
  })
}

function closeGroup(groupId: string): void {
  const g = findGroup(groupId)
  if (!g) return
  const ids = g.tabs.map((x) => x.id)
  const busyCount = busyCountOf(g.tabs)
  confirmDialog({
    title: t('关闭分组「{0}」？', g.name),
    message: busyCount > 0 ? t('其中 <b>{0}</b> 个标签正在运行或待决策，关闭会立即中断。', busyCount) : '',
    okLabel: t('关闭分组'),
    onOk: () => void closeTabsNow(ids)
  })
}

// ── 重新加载标签 ────────────────────────────────────────────────
// 等价于「就地关掉再原样恢复」：标签本身、分组、顺序、会话栈、备注全部保留，
// 只把 PTY 连同其中的前台进程换成新的 —— 于是新 shell 重新继承系统环境变量，
// 新起的 cc 也重新读 ~/.claude 配置（改完配置不必手动 Ctrl+C 再敲 --resume）。
const reloadingTabs = new Set<string>()

async function doReloadTab(tabId: string): Promise<void> {
  const ctx = findTab(tabId)
  if (!ctx || reloadingTabs.has(tabId)) return
  const { tab } = ctx
  // reload 前 cc 活跃（含手敲 cct 起的）→ 新 PTY 里按主会话续上
  if (tab.autoLaunchCC || tab.ccActive) resumeCcOnNextStart.add(tab.id)
  reloadingTabs.add(tabId)
  // 进程态全部归零：旧 PTY 的 busy/报错说明和 cc 活跃标记都不该带到新进程
  tab.status = 'idle'
  tab.note = undefined
  tab.ccActive = false
  refreshUI()
  try {
    await tab.reloadPty()
  } catch (e) {
    console.error('[reload] failed', e)
  } finally {
    reloadingTabs.delete(tabId)
    if (!findTab(tabId)) resumeCcOnNextStart.delete(tabId)
    refreshUI()
  }
}

export function reloadTab(tabId: string): void {
  const ctx = findTab(tabId)
  if (!ctx) return
  if (reloadingTabs.has(tabId)) {
    toast(t('标签「{0}」正在重新加载', ctx.tab.name))
    return
  }
  const { tab } = ctx
  // 空闲的纯 shell 直接重来；正在跑东西（cc 回合中/待决策，或前台命令）先确认，重载会打断它
  const busyish = tab.status === 'busy' || tab.status === 'attention'
  if (!busyish) {
    void doReloadTab(tabId)
    return
  }
  confirmDialog({
    title: t('重新加载标签「{0}」？', tab.name),
    message: isCcTab(tab)
      ? t('重新加载会中断正在进行的回合。')
      : t('重新加载会中断正在运行的命令。'),
    okLabel: t('重新加载'),
    onOk: () => void doReloadTab(tabId)
  })
}

export function renameTab(tabId: string, newName: string): void {
  if (!newName.trim()) return
  void op({ op: 'renameTab', id: tabId, name: newName.trim() })
}

export function toggleGroupCollapse(groupId: string): void {
  const g = findGroup(groupId)
  if (!g) return
  void op({ op: 'setCollapsed', ids: [groupId], collapsed: !g.collapsed })
}

export function setAllGroupsCollapsed(collapsed: boolean): void {
  const ids = groups.filter((g) => g.collapsed !== collapsed).map((g) => g.id)
  if (ids.length === 0) return
  void op({ op: 'setCollapsed', ids, collapsed })
}

export async function locateActiveTab(): Promise<void> {
  const ctx = activeContext()
  if (!ctx) {
    toast(t('当前没有活动标签'))
    return
  }
  if (ctx.group.collapsed) {
    await op({ op: 'setCollapsed', ids: [ctx.group.id], collapsed: false })
  }
  // React 渲染异步：刚展开分组的行元素要等下次 commit 才存在，DOM 查询延迟到 rAF
  requestAnimationFrame(() => {
    const row = document.querySelector<HTMLElement>(
      `#groupList .tab-row[data-t="${CSS.escape(ctx.tab.id)}"]`
    )
    if (!row) return
    row.scrollIntoView({ block: 'center', behavior: 'smooth' })
    // 先移除再强制 reflow：连续点击时也能重新触发闪烁动画
    row.classList.remove('locate-flash')
    void row.offsetWidth
    row.classList.add('locate-flash')
    row.addEventListener('animationend', () => row.classList.remove('locate-flash'), { once: true })
  })
}

function renameGroup(groupId: string): void {
  const g = findGroup(groupId)
  if (!g) return
  openModal({
    kind: 'rename',
    title: t('重命名分组'),
    sub: '',
    name: g.name,
    okLabel: t('保存'),
    onOk: async (v) => {
      await op({ op: 'renameGroup', id: groupId, name: v.name })
    }
  })
}

// 该会话此刻在哪个终端里运行（排除 exceptId）
function runningTabOf(sessionId: string, exceptId?: string): TerminalTab | null {
  for (const [tabId, sid] of Object.entries(store.running)) {
    if (sid !== sessionId || tabId === exceptId) continue
    const c = findTab(tabId)
    if (c) return c.tab
  }
  return null
}

// 已在别处运行就切过去，不开第二份；返回是否已处理
function focusIfRunning(sessionId: string): boolean {
  const other = runningTabOf(sessionId)
  if (!other) return false
  activateTab(other.id)
  toast(t('该会话已在「{0}」中运行', other.name))
  return true
}

// 在标签页下一层打开会话：父标签页不受影响；已有同会话的子终端就直接切过去
export async function openSessionNested(parentId: string, sessionId: string): Promise<void> {
  if (focusIfRunning(sessionId)) return
  const ctx = findTab(parentId)
  if (!ctx || isChildId(parentId)) return
  const existing = (children.get(parentId) ?? []).find((x) => x.activeSessionId === sessionId)
  if (existing) {
    activateTab(existing.id)
    return
  }
  const child = mountChild(ctx.group, ctx.tab, sessionId)
  activeTabId = child.id
  activateUI(child.id)
  await spawnTabPty(child)
}

// ─── 栈内会话右键菜单（重命名 / 删除） ──────
export function openSessionCtx(sessionId: string, x: number, y: number): void {
  const ctx = activeContext()
  if (!ctx) return
  const sess = ctx.tab.sessions.find((s) => s.sessionId === sessionId)
  if (!sess) return
  const onlyOne = ctx.tab.sessions.length <= 1
  const items: CtxItem[] = []
  // 栈顶会话就是标签页本身，不提供下一层打开
  if (sessionId !== ctx.tab.activeSessionId) {
    items.push(
      { label: t('在标签页下一层打开'), icon: icon('external-link'), act: () => void openSessionNested(ctx.tab.id, sessionId) },
      { sep: true }
    )
  }
  items.push({ label: t('重命名会话'), icon: icon('edit'), act: () => renameSession(sessionId) })
  if (sess.userTitle) {
    items.push({ label: t('清除自定义标题'), icon: icon('rotate-ccw'), act: () => renameSession(sessionId, '') })
  }
  items.push({ sep: true })
  if (onlyOne) {
    items.push({ label: t('删除（至少保留一条）'), icon: icon('trash'), act: () => toast(t('至少保留一条会话')) })
  } else {
    items.push({ label: t('删除会话'), icon: icon('trash'), danger: true, act: () => void deleteSession(sessionId) })
  }
  showCtxMenu(items, x, y)
}

function renameSession(sessionId: string, forceText?: string): void {
  const ctx = activeContext()
  if (!ctx) return
  const sess = ctx.tab.sessions.find((s) => s.sessionId === sessionId)
  if (!sess) return
  // 显式清除分支：右键「清除自定义标题」时跳过 modal
  if (forceText === '') {
    void op({ op: 'renameSession', id: sessionId, title: null })
    return
  }
  openModal({
    kind: 'rename',
    title: t('重命名会话'),
    sub: '',
    name: sess.userTitle ?? '',
    okLabel: t('保存'),
    onOk: (v) => void op({ op: 'renameSession', id: sessionId, title: v.name })
  })
}

async function deleteSession(sessionId: string): Promise<void> {
  const ctx = activeContext()
  if (!ctx) return
  const { tab } = ctx
  if (tab.sessions.length <= 1) return
  const sess = tab.sessions.find((s) => s.sessionId === sessionId)
  if (!sess) return
  const wasTop = tab.activeSessionId === sessionId
  const title = sessionTitle(sess, tab.sessions, tab.name)
  confirmDialog({
    title: t('删除会话「{0}」？', title),
    message: t('会话记录仍保留在磁盘。'),
    okLabel: t('删除'),
    onOk: async () => {
      await op({ op: 'removeSession', tabId: tab.id, sessionId })
      if (wasTop) {
        await tab.restartPty()
      }
    }
  })
}

// 切换会话：设为栈顶后重启 PTY，launchCC 按新栈顶 --resume
export async function switchSession(sessionId: string): Promise<void> {
  const ctx = activeContext()
  if (!ctx) return
  const { tab } = ctx
  if (!tab.sessions.some((s) => s.sessionId === sessionId)) return
  if (runningTabOf(sessionId, tab.id)) {
    focusIfRunning(sessionId)
    return
  }
  await op({ op: 'setTop', tabId: tab.id, sessionId })
  await tab.restartPty()
  refreshUI()
}

export function openGroupCtx(groupId: string, x: number, y: number): void {
  const g = findGroup(groupId)
  if (!g) return
  showCtxMenu(
    [
      { label: t('新建标签'), icon: icon('plus'), act: () => promptNewTabInGroup(g.id) },
      { label: t('重命名分组'), icon: icon('edit'), act: () => renameGroup(g.id) },
      { sep: true },
      { label: t('关闭分组'), icon: icon('close'), danger: true, act: () => closeGroup(g.id) }
    ],
    x,
    y
  )
}

// 手动标成 done（绿点）：不启动倒计时，下次切回该 tab 才开始降级计时。
export function markTabPending(tabId: string): void {
  const ctx = findTab(tabId)
  if (!ctx) return
  ctx.tab.status = 'done'
  ctx.tab.note = undefined
  if (downgradeTabId === tabId) clearDowngradeTimer()
  refreshUI()
}

// "标记为已查看"：手动清点（done/attention/error → idle）；busy 不清——cc 真在跑。
export function markTabViewed(tabId: string): void {
  const ctx = findTab(tabId)
  if (!ctx) return
  const s = ctx.tab.status
  if (s === 'idle' || s === 'busy') return
  ctx.tab.status = 'idle'
  ctx.tab.note = undefined
  if (downgradeTabId === tabId) clearDowngradeTimer()
  refreshUI()
}

export function openTabCtx(tabId: string, x: number, y: number): void {
  const ctx = findTab(tabId)
  if (!ctx) return
  // idle → 可标"待查看"；done/attention/error → 可标"已查看"；busy 都不给
  const s = ctx.tab.status ?? 'idle'
  const items: CtxItem[] = []
  if (s === 'idle') {
    items.push({ label: t('标记为待查看'), icon: icon('check-square'), act: () => markTabPending(tabId) })
  } else if (s === 'done' || s === 'attention' || s === 'error') {
    items.push({ label: t('标记为已查看'), icon: icon('square'), act: () => markTabViewed(tabId) })
  }
  if (items.length > 0) {
    items.push({ sep: true })
  }
  // 前台程序是 shell 本身（底下没有子程序）才能启动智能体
  if (!isChildId(tabId) && foregroundOf(ctx.tab).atPrompt) {
    items.push(
      {
        label: t('启动智能体'),
        icon: icon('bot'),
        children: [
          { label: 'Claude Code', icon: icon('claude'), act: () => void launchAgentInTab(tabId, 'claude') },
          { label: 'Codex', icon: icon('codex'), act: () => void launchAgentInTab(tabId, 'codex') }
        ]
      },
      { sep: true }
    )
  }
  showCtxMenu(
    [
      ...items,
      {
        label: t('重命名标签'),
        icon: icon('edit'),
        act: () => {
          openModal({
            kind: 'rename',
            title: t('重命名标签'),
            sub: '',
            name: ctx.tab.name,
            okLabel: t('保存'),
            onOk: (v) => renameTab(tabId, v.name)
          })
        }
      },
      // 添加/删除备注互斥：没备注给「添加」，有备注给「删除」（备注只能在这里删）
      ctx.tab.memo == null
        ? { label: t('添加备注'), icon: icon('sticky-note'), act: () => openTabMemoEditor(tabId, x, y) }
        : { label: t('删除备注'), icon: icon('sticky-note'), danger: true, act: () => void op({ op: 'setMemo', id: tabId, memo: null }) },
      { label: t('在本组新建标签'), icon: icon('plus'), act: () => promptNewTabInGroup(ctx.group.id) },
      // 环境变量/cc 配置改完后就地换个新 PTY 生效，标签与会话都不动
      { label: t('重新加载标签页'), icon: icon('rotate-ccw'), act: () => reloadTab(tabId) },
      { sep: true },
      { label: t('关闭标签'), icon: icon('close'), danger: true, act: () => closeTab(tabId) }
    ],
    x,
    y
  )
}

// 备注编辑弹窗：关闭即保存（含首次添加的空文本——空备注也算"有备注"，图标照常显示，删除只走右键）
export function openTabMemoEditor(tabId: string, x: number, y: number): void {
  const ctx = findTab(tabId)
  if (!ctx) return
  openMemoEditor({
    x,
    y,
    text: ctx.tab.memo ?? '',
    onSave: (text) => {
      const c = findTab(tabId)
      // 没改动不动状态；首次添加时 memo 还是 undefined，空文本也会落成空备注（右键项随之切到「删除备注」）
      if (!c || c.tab.memo === text) return
      void op({ op: 'setMemo', id: tabId, memo: text })
    }
  })
}

export function getGroupViews(): GroupView[] {
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    cwd: g.cwd,
    collapsed: g.collapsed,
    tabs: g.tabs
  }))
}

export function reorderGroups(ids: string[]): void {
  void op({ op: 'reorderGroups', ids })
}

// 历史标签页：近 7 天关闭的标签，按关闭时间倒序
const HISTORY_DAYS = 7

function historyEntryOf(x: TabRec): HistoryEntry {
  const g = store.groups.find((y) => y.id === x.groupId)
  return {
    tabId: x.id,
    tabName: x.name,
    groupName: g?.name ?? '',
    cwd: g?.cwd ?? '',
    autoLaunchCC: x.autoLaunchCC,
    sessions: sessionsOfStack(x.stack),
    activeSessionId: x.stack[0],
    memo: x.memo,
    openedAt: x.openedAt,
    lastSeenAt: x.closedAt ?? x.lastSeenAt
  }
}


// 重新打开历史标签页：沿用原 id、原分组与会话栈
export async function restoreFromHistory(entry: HistoryEntry): Promise<void> {
  if (findTab(entry.tabId)) {
    activateTab(entry.tabId)
    return
  }
  await op({ op: 'reopenTab', id: entry.tabId })
  const rec = tabRec(entry.tabId)
  const g = rec ? liveGroup(rec.groupId) : null
  if (!rec || !g) return
  await openNewTab(mountTab(g, rec))
}

// ── Ctrl+P 全局搜索 ────────────────────────────────────────────────

const QUICK_LIMIT = 50

function groupLabelOf(rec: TabRec): string {
  return store.groups.find((g) => g.id === rec.groupId)?.name ?? ''
}

function tabItem(rec: TabRec, hl?: Range[]): QuickItem {
  return {
    key: 'tab:' + rec.id,
    kind: 'tab',
    title: rec.name,
    titleHl: hl,
    sub: groupLabelOf(rec),
    closedAt: rec.closedAt,
    act: () => {
      if (rec.closedAt) {
        void restoreFromHistory(historyEntryOf(rec))
      } else {
        activateTab(rec.id)
      }
    }
  }
}

/** 未输入关键字时：今天 / 昨天 / 近 7 天关闭的标签页 */
export function getQuickHistory(): QuickGroup[] {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterday = today - 86_400_000
  const since = Date.now() - HISTORY_DAYS * 86_400_000
  const buckets: QuickGroup[] = [
    { label: t('今天'), items: [] },
    { label: t('昨天'), items: [] },
    { label: t('近 7 天'), items: [] }
  ]
  const closed = store.tabs
    .filter((x) => x.closedAt && Date.parse(x.closedAt) >= since)
    .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
  for (const rec of closed) {
    const ts = Date.parse(rec.closedAt!)
    const b = ts >= today ? 0 : ts >= yesterday ? 1 : 2
    buckets[b].items.push(tabItem(rec))
  }
  return buckets.filter((b) => b.items.length > 0)
}

// 从搜索结果打开会话：在跑就切过去；在打开的标签页里且是栈顶就切到该标签页，否则在下一层打开；
// 属于历史标签页就重开该标签页并设为主会话
async function openSessionFromSearch(sessionId: string, rec: TabRec): Promise<void> {
  if (focusIfRunning(sessionId)) return
  if (!rec.closedAt) {
    if (rec.stack[0] === sessionId) {
      activateTab(rec.id)
    } else {
      await openSessionNested(rec.id, sessionId)
    }
    return
  }
  await op({ op: 'reopenTab', id: rec.id, top: sessionId })
  const fresh = tabRec(rec.id)
  const g = fresh ? liveGroup(fresh.groupId) : null
  if (!fresh || !g) return
  await openNewTab(mountTab(g, fresh))
}

/** 输入关键字后：按搜索类别分组列出结果 */
export function quickSearch(query: string, scopes: Settings['searchScopes']): QuickGroup[] {
  const q = query.trim()
  if (!q) return []
  const out: QuickGroup[] = []
  const rank = <T,>(list: { v: T; score: number }[]): T[] =>
    list.sort((a, b) => b.score - a.score).slice(0, QUICK_LIMIT).map((x) => x.v)

  if (scopes.tabTitle) {
    const hits: { v: QuickItem; score: number }[] = []
    for (const rec of store.tabs) {
      const r = fuzzySearch(q, [rec.name])
      if (r) hits.push({ v: tabItem(rec, r.highlights[0]), score: r.score })
    }
    if (hits.length > 0) out.push({ label: t('标签页'), items: rank(hits) })
  }

  if (scopes.sessionTitle) {
    const hits: { v: QuickItem; score: number }[] = []
    const seen = new Set<string>()
    // 打开的标签页优先认领会话，同一会话只列一次
    const ordered = [...store.tabs].sort((a, b) => Number(!!a.closedAt) - Number(!!b.closedAt))
    for (const rec of ordered) {
      const sessions = sessionsOfStack(rec.stack)
      for (const sess of sessions) {
        if (seen.has(sess.sessionId)) continue
        seen.add(sess.sessionId)
        const title = sessionTitle(sess, sessions, rec.name)
        const r = fuzzySearch(q, [title])
        if (!r) continue
        hits.push({
          v: {
            key: 'sess:' + sess.sessionId,
            kind: 'session',
            title,
            titleHl: r.highlights[0],
            sub: `${groupLabelOf(rec)} · ${rec.name}`,
            closedAt: rec.closedAt,
            act: () => void openSessionFromSearch(sess.sessionId, rec)
          },
          score: r.score
        })
      }
    }
    if (hits.length > 0) out.push({ label: t('会话'), items: rank(hits) })
  }

  if (scopes.path) {
    const hits: { v: QuickItem; score: number }[] = []
    const seen = new Set<string>()
    for (const g of store.groups) {
      // 同一目录的正反斜杠、大小写写法只列一次
      const key = g.cwd.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
      if (!g.cwd || seen.has(key)) continue
      seen.add(key)
      const r = fuzzySearch(q, [g.cwd])
      if (!r) continue
      hits.push({
        v: {
          key: 'path:' + g.cwd,
          kind: 'path',
          title: g.cwd,
          titleHl: r.highlights[0],
          sub: g.name,
          act: () => void openHereWithPath(g.cwd)
        },
        score: r.score
      })
    }
    if (hits.length > 0) out.push({ label: t('目录'), items: rank(hits) })
  }
  return out
}

// 标签拖拽（Sidebar/Toolbar 共用）：自定义 MIME 传 tabId，只用于同分组内排序
export const TAB_DND_MIME = 'application/x-claude-tab'

export function setTabDragData(e: { dataTransfer: DataTransfer | null }, tabId: string): void {
  if (!e.dataTransfer) {
    return
  }
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData(TAB_DND_MIME, tabId)
}

// 同分组内标签拖动排序；跨分组不支持（标签 cwd 跟随分组）。
export function moveTabWithinGroup(tabId: string, targetTabId: string, before: boolean): void {
  if (tabId === targetTabId) return
  const src = findTab(tabId)
  const dst = findTab(targetTabId)
  if (!src || !dst || src.group !== dst.group) return
  const ids = src.group.tabs.map((x) => x.id).filter((x) => x !== tabId)
  const toIdx = ids.indexOf(targetTabId) + (before ? 0 : 1)
  ids.splice(toIdx, 0, tabId)
  void op({ op: 'reorderTabs', groupId: src.group.id, ids })
}

export async function preBoot(): Promise<void> {
  settings = await window.term.loadSettings()
  // 语言尽早定死：后续动态渲染的 t() 都依赖它
  setLanguage(settings.language)
  // macOS 红绿灯 / 自绘窗口按钮的显隐由 body.platform-* 的 CSS 适配
  document.body.classList.add(window.term.platform === 'darwin' ? 'platform-mac' : 'platform-win')
}

// 启动恢复：按 store 重建上次打开的分组与标签页，并起 PTY（cc 标签按主会话 --resume）
async function restoreOpenTabs(): Promise<void> {
  const tabs: TerminalTab[] = []
  for (const gr of store.groups) {
    for (const id of gr.tabIds) {
      const rec = tabRec(id)
      if (!rec || rec.closedAt) continue
      const g = liveGroup(gr.id)
      if (g) tabs.push(mountTab(g, rec))
    }
  }
  if (tabs.length === 0) return
  const want = store.activeTabId && tabs.some((x) => x.id === store.activeTabId) ? store.activeTabId : tabs[0].id
  activeTabId = want
  activateUI(want)
  // 当前标签先起，其余分批跟上
  const first = tabs.find((x) => x.id === want)!
  await spawnTabPty(first)
  await spawnTabsBatched(tabs.filter((x) => x !== first))
}

// initApp：组件树挂载后跑一次。
export async function initApp(): Promise<void> {
  await hostsReady

  // ─── PTY 全局路由 ───────────────────────────────────────────────
  const offData = window.term.onData((id, data) => {
    for (const t of allTabs()) if (t.ptyId === id) return t.writeFromPty(data)
  })
  const offExit = window.term.onExit((id, exitCode) => {
    fgByPty.delete(id)
    for (const t of allTabs()) if (t.ptyId === id) return t.handlePtyExit(exitCode)
  })
  const offForeground = window.term.onForeground((id, info) => {
    const prev = fgByPty.get(id)
    fgByPty.set(id, info)
    // 智能体退回提示符时还挂着「运行中」（如 Codex 请求出错不发 Stop）→ 降回空闲
    if (info.atPrompt && (prev?.program === 'claude' || prev?.program === 'codex')) {
      const tab = allTabs().find((t) => t.ptyId === id)
      if (tab && tab.status === 'busy') {
        tab.status = 'idle'
        tab.note = undefined
      }
    }
    refreshUI()
  })
  // 渲染层重新加载后，主进程只推变化，先拉一次全量
  for (const [id, info] of Object.entries(await window.term.foregroundAll())) fgByPty.set(Number(id), info)

  // ─── store 快照（会话栈由主进程按会话事件维护后推过来） ───────────
  const offStore = window.term.onStoreChanged((snap) => applySnapshot(snap))

  // ─── 会话事件：只做渲染层收尾 ─────────────────────────────────────
  const offSession = window.term.onSessionEvent((ev) => {
    // cc 已起来 → 提前释放启动闸门坑位（晚于兜底超时到达则为 no-op）
    ccGateRelease(ev.tabId)
    const ctx = findTab(ev.tabId)
    if (!ctx) return
    // SessionStart 到达即 cc 刚起了会话 → 标记活跃。cc 退出后由 onShellCommand 翻回 false。
    ctx.tab.ccActive = true
    refreshUI()
    void refreshSessionMeta(ctx.tab)
    // cc 里 /resume 了一个正在别处运行的会话：事后提醒，不强制关闭
    const other = runningTabOf(ev.sessionId, ev.tabId)
    if (other && !isConfirmOpen()) {
      confirmDialog({
        title: t('该会话已在「{0}」中运行', other.name),
        message: t('两处同时运行同一会话会交替写入同一份对话记录。'),
        okLabel: t('切过去'),
        onOk: () => activateTab(other.id)
      })
    }
  })

  // ─── 状态徽标事件 ───────────────────────────────────────────────
  const offState = window.term.onStateEvent((ev) => {
    const ctx = findTab(ev.tabId)
    if (!ctx) return
    // StopFailure 的错误分类优先出中文短句；分类缺失/不认识时退回 cc 原文（英文长句，截断显示）
    if (ev.state === 'error') {
      ctx.tab.status = 'error'
      ctx.tab.note = errorNote(ev.errorKind, ev.message)
      if (ev.tabId === downgradeTabId) clearDowngradeTimer()
      refreshUI()
      return
    }
    // 外部 hook 不许把 done/attention 盖成 idle——降级是渲染层倒计时的独占权；
    // 否则 cc 的 idle_prompt 会把绿点静默盖成灰点（历史翻过车，此闸防回归）
    if (ev.state === 'idle' && (ctx.tab.status === 'done' || ctx.tab.status === 'attention')) {
      return
    }
    ctx.tab.status = ev.state
    ctx.tab.note = ev.message
    // 一轮结束：首条消息、/rename 标题可能刚写进对话记录
    if (ev.state === 'done') {
      void refreshSessionMeta(ctx.tab)
    }
    // 状态变了 → 重置该 tab 之前未触发的降级；若仍是当前 tab 且新态需降级，重启倒计时
    if (ev.tabId === downgradeTabId) clearDowngradeTimer()
    if (activeTabId === ev.tabId) maybeStartDowngrade(ev.tabId, ev.state)
    refreshUI()
  })

  // 查看降级的焦点门（见 maybeStartDowngrade 注释）
  window.addEventListener('blur', clearDowngradeTimer)
  window.addEventListener('focus', resumeDowngradeIfNeeded)

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSearchOverlay()
    }
    // Ctrl+P：全局搜索；终端里 xterm 已放行该键，事件照常冒泡到这里
    if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault()
      toggleQuickOpen()
    }
    // Ctrl+F 兜底：终端聚焦时由 TerminalTab 键处理器开搜索，这里补焦点在侧栏等处的情况
    if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      const t = e.target as HTMLElement
      if (!(t instanceof HTMLInputElement) && !t.closest?.('[contenteditable="true"]')) {
        e.preventDefault()
        openSearchOverlay()
      }
    }
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault()
      const all = allTabs()
      if (all.length < 2) return
      const idx = all.findIndex((t) => t.id === activeTabId)
      const next = e.shiftKey ? all[(idx - 1 + all.length) % all.length] : all[(idx + 1) % all.length]
      activateTab(next.id)
    }
  })

  window.addEventListener('beforeunload', () => {
    offData()
    offExit()
    offForeground()
    offStore()
    offSession()
    offState()
    for (const t of allTabs()) t.dispose()
  })

  window.term.onWindowCloseRequest(() => {
    if (isConfirmOpen()) return // 已有确认弹窗在显示，忽略重复触发
    const busy = busyCountOf(allTabs())
    confirmDialog({
      title: t('确认关闭 CC Terminal？'),
      message: busy > 0
        ? t('其中 <b>{0}</b> 个标签正在运行或待决策，关闭会立即中断。', busy)
        : '',
      okLabel: t('关闭'),
      onOk: () => window.term.winConfirmClose()
    })
  })

  // ─── 启动恢复 ───────────────────────────────────────────────────
  applySnapshot(await window.term.storeLoad())
  await restoreOpenTabs()
  refreshUI()
  window.term.floaterSetEnabled(settings.showFloater)
  if (settings.showFloater) pushFloaterCounts()
  // 悬浮窗右键"隐藏"后主进程已落盘 showFloater=false，这里同步内存副本
  window.term.onFloaterHidden(() => {
    if (!settings.showFloater) return
    settings = { ...settings, showFloater: false }
  })
  // second-instance 的 open-here：主进程解析 argv 后推 path 过来
  window.term.onOpenHere((p) => {
    void openHereWithPath(p)
  })
  // 首次启动的 --open-here 用 invoke 主动拉：send 推送会在监听器注册前送达被丢
  try {
    const pending = await window.term.consumePendingOpenHere()
    for (const p of pending) void openHereWithPath(p)
  } catch {}
}
