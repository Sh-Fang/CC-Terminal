import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type ThemePreset = 'vscode-dark' | 'vercel-dark' | 'one-dark'
export type AppTheme = 'light' | 'dark'
export type CursorStyle = 'block' | 'underline' | 'bar'
export type CloseBehavior = 'quit' | 'tray'
export type TabBarMode = 'vertical' | 'horizontal'
export type AppLanguage = 'zh' | 'en'

export interface Settings {
  version: 1
  font: {
    family: string
    size: number
    lineHeight: number
  }
  cursor: {
    style: CursorStyle
    blink: boolean
  }
  terminal: {
    scrollback: number
    theme: ThemePreset
  }
  appTheme: AppTheme  // 应用主题，与终端主题相互独立
  defaults: {
    cwd: string
  }
  // true = 每次启动 cc（新建会话与 --resume 都算）都带 --dangerously-skip-permissions
  dangerousSkipPermissions: boolean
  claudePath: string  // 留空 = 直接调 'claude'；填 = 用这个绝对路径（多版本切换写这里）
  disableAutoupdater: boolean  // true = spawn pwsh 时注入 DISABLE_AUTOUPDATER=1
  // true = 每次启动 codex 都带 --dangerously-bypass-approvals-and-sandbox
  codexDangerousSkipPermissions: boolean
  codexPath: string  // 留空 = 直接调 'codex'；填 = 用这个绝对路径
  codexDisableAutoupdater: boolean  // true = 启动 codex 时关掉启动检查更新
  npmRegistry: string  // 安装智能体版本用的 npm 源
  lastUsedCwd: string  // 最近一次新建分组选择的 cwd，下次预填用
  sidebarWidth: number
  sidebarCollapsed: boolean
  statusDowngradeSec: number   // 查看已完成的标签页多少秒后清掉绿点：1 / 3 / 5；0 = 不自动清除
  closeBehavior: CloseBehavior // 点关闭按钮：quit = 二次确认后退出（默认）；tray = 不确认，收进托盘
  showFloater: boolean         // 开启常驻悬浮窗（显示待查看 / 待决策 / 运行中 数）
  floaterX: number | null      // 悬浮窗最近一次屏幕位置（null = 未持久化，走默认位）
  floaterY: number | null
  tabBarMode: TabBarMode       // 标签栏布局：vertical = 左栏分组（默认）；horizontal = 顶部平铺
  language: AppLanguage        // 界面语言：zh = 简体中文（默认）；en = English。重启后生效
  // Ctrl+P 全局搜索的类别开关：分组 / 智能体标签页（含会话）/ 终端标签页 / 路径（工作目录）
  searchScopes: { group: boolean; agent: boolean; terminal: boolean; path: boolean }
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  font: {
    family: '"JetBrains Maple Mono", monospace',
    size: 14,
    lineHeight: 1.2
  },
  cursor: { style: 'block', blink: true },
  terminal: { scrollback: 5000, theme: 'vscode-dark' },
  appTheme: 'light',
  defaults: { cwd: '' },
  dangerousSkipPermissions: false,
  claudePath: '',
  disableAutoupdater: true,
  codexDangerousSkipPermissions: false,
  codexPath: '',
  codexDisableAutoupdater: true,
  npmRegistry: 'https://registry.npmmirror.com',
  lastUsedCwd: '',
  sidebarWidth: 268,
  sidebarCollapsed: false,
  statusDowngradeSec: 5,
  closeBehavior: 'quit',
  showFloater: false,
  floaterX: null,
  floaterY: null,
  tabBarMode: 'vertical',
  language: 'zh',
  searchScopes: { group: true, agent: true, terminal: true, path: false }
}

const FILE = (): string => join(app.getPath('userData'), 'settings.json')

const THEMES: ThemePreset[] = ['vscode-dark', 'vercel-dark', 'one-dark']
const APP_THEMES: AppTheme[] = ['light', 'dark']
const CURSORS: CursorStyle[] = ['block', 'underline', 'bar']
const CLOSE_BEHAVIORS: CloseBehavior[] = ['quit', 'tray']
const TABBAR_MODES: TabBarMode[] = ['vertical', 'horizontal']
const LANGUAGES: AppLanguage[] = ['zh', 'en']
const NPM_OFFICIAL_REGISTRY = 'https://registry.npmjs.org'

function pick<T extends string>(v: unknown, allow: T[], fallback: T): T {
  return typeof v === 'string' && (allow as string[]).includes(v) ? (v as T) : fallback
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}
// 清除完成标记只有 1 / 3 / 5 秒和 0（不自动清除）四档；旧版 1~10 的任意值就近归档
function downgradeSec(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.statusDowngradeSec
  if (n <= 0) return 0
  if (n <= 2) return 1
  if (n <= 4) return 3
  return 5
}
function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
// 悬浮窗坐标：null = 未持久化。必须允许负值（副屏在主屏左/上时 Windows 虚拟屏坐标为负）；
// 旧版哨兵 -1 归一成 null。
function coord(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n === -1) return null
  return Math.min(100000, Math.max(-100000, n))
}

// 历代默认字体：仍是其中之一的设置换成当前自带字体，用户自己改过的不动
const LEGACY_FONT_FAMILIES = new Set([
  '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
  '"Sarasa Fixed SC", monospace'
])

function normalize(raw: unknown): Settings {
  if (!raw || typeof raw !== 'object') return DEFAULT_SETTINGS
  const r = raw as Record<string, unknown>
  const font = (r.font as Record<string, unknown>) || {}
  const cursor = (r.cursor as Record<string, unknown>) || {}
  const term = (r.terminal as Record<string, unknown>) || {}
  const def = (r.defaults as Record<string, unknown>) || {}
  const scopes = (r.searchScopes as Record<string, unknown>) || {}
  return {
    version: 1,
    font: {
      family:
        typeof font.family === 'string' && font.family.trim() && !LEGACY_FONT_FAMILIES.has(font.family.trim())
          ? font.family
          : DEFAULT_SETTINGS.font.family,
      size: clampNum(font.size, 8, 40, DEFAULT_SETTINGS.font.size),
      lineHeight: clampNum(font.lineHeight, 1.0, 2.0, DEFAULT_SETTINGS.font.lineHeight)
    },
    cursor: {
      style: pick(cursor.style, CURSORS, DEFAULT_SETTINGS.cursor.style),
      blink: typeof cursor.blink === 'boolean' ? cursor.blink : DEFAULT_SETTINGS.cursor.blink
    },
    terminal: {
      scrollback: clampNum(term.scrollback, 100, 100000, DEFAULT_SETTINGS.terminal.scrollback),
      // 已下线的 one-light 迁移到 one-dark
      theme: pick(term.theme === 'one-light' ? 'one-dark' : term.theme, THEMES, DEFAULT_SETTINGS.terminal.theme)
    },
    appTheme: pick(r.appTheme, APP_THEMES, DEFAULT_SETTINGS.appTheme),
    defaults: {
      cwd: typeof def.cwd === 'string' ? def.cwd : DEFAULT_SETTINGS.defaults.cwd
    },
    dangerousSkipPermissions:
      typeof r.dangerousSkipPermissions === 'boolean'
        ? r.dangerousSkipPermissions
        : DEFAULT_SETTINGS.dangerousSkipPermissions,
    claudePath: typeof r.claudePath === 'string' ? r.claudePath : DEFAULT_SETTINGS.claudePath,
    disableAutoupdater:
      typeof r.disableAutoupdater === 'boolean'
        ? r.disableAutoupdater
        : DEFAULT_SETTINGS.disableAutoupdater,
    // 拆分前 Claude、Codex 共用 dangerousSkipPermissions，没有独立值时沿用它
    codexDangerousSkipPermissions: bool(
      r.codexDangerousSkipPermissions,
      bool(r.dangerousSkipPermissions, DEFAULT_SETTINGS.codexDangerousSkipPermissions)
    ),
    codexPath: typeof r.codexPath === 'string' ? r.codexPath : DEFAULT_SETTINGS.codexPath,
    codexDisableAutoupdater: bool(r.codexDisableAutoupdater, DEFAULT_SETTINGS.codexDisableAutoupdater),
    // 旧版「不用镜像」开关并入下载源：关着的等同选了 npm 官方源
    npmRegistry:
      r.npmMirrorEnabled === false
        ? NPM_OFFICIAL_REGISTRY
        : typeof r.npmRegistry === 'string' && r.npmRegistry.trim()
        ? r.npmRegistry.trim()
        : DEFAULT_SETTINGS.npmRegistry,
    lastUsedCwd: typeof r.lastUsedCwd === 'string' ? r.lastUsedCwd : DEFAULT_SETTINGS.lastUsedCwd,
    sidebarWidth: clampNum(r.sidebarWidth, 180, 520, DEFAULT_SETTINGS.sidebarWidth),
    sidebarCollapsed: typeof r.sidebarCollapsed === 'boolean' ? r.sidebarCollapsed : DEFAULT_SETTINGS.sidebarCollapsed,
    statusDowngradeSec: downgradeSec(r.statusDowngradeSec),
    closeBehavior: pick(r.closeBehavior, CLOSE_BEHAVIORS, DEFAULT_SETTINGS.closeBehavior),
    showFloater:
      typeof r.showFloater === 'boolean' ? r.showFloater : DEFAULT_SETTINGS.showFloater,
    floaterX: coord(r.floaterX),
    floaterY: coord(r.floaterY),
    tabBarMode: pick(r.tabBarMode, TABBAR_MODES, DEFAULT_SETTINGS.tabBarMode),
    language: pick(r.language, LANGUAGES, DEFAULT_SETTINGS.language),
    searchScopes: {
      group: bool(scopes.group, DEFAULT_SETTINGS.searchScopes.group),
      agent: bool(scopes.agent, DEFAULT_SETTINGS.searchScopes.agent),
      terminal: bool(scopes.terminal, DEFAULT_SETTINGS.searchScopes.terminal),
      path: bool(scopes.path, DEFAULT_SETTINGS.searchScopes.path)
    }
  }
}

export function loadSettings(): Settings {
  try {
    const path = FILE()
    if (!existsSync(path)) return DEFAULT_SETTINGS
    return normalize(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(s: unknown): Settings {
  const normed = normalize(s)
  const path = FILE()
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(normed, null, 2), 'utf8')
  renameSync(tmp, path)
  return normed
}
