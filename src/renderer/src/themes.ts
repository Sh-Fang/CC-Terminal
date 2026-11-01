import type { ITheme } from '@xterm/xterm'

export type ThemePreset = 'vscode-dark' | 'vercel-dark' | 'one-dark'
export type AppTheme = 'light' | 'dark'
export type CursorStyle = 'block' | 'underline' | 'bar'
export type CloseBehavior = 'quit' | 'tray'
// vertical = 左侧栏分组层级（默认）；horizontal = 隐藏左栏，顶部平铺标签
export type TabBarMode = 'vertical' | 'horizontal'
export type AppLanguage = 'zh' | 'en'

export interface Settings {
  version: 1
  font: { family: string; size: number; lineHeight: number }
  cursor: { style: CursorStyle; blink: boolean }
  terminal: { scrollback: number; theme: ThemePreset }
  appTheme: AppTheme
  defaults: { cwd: string }
  // true = 每次启动 cc（新建与 --resume 都算）都带 --dangerously-skip-permissions
  dangerousSkipPermissions: boolean
  claudePath: string
  npmRegistry: string
  npmMirrorEnabled: boolean    // false = 不用镜像，cc 版本管理走 npm 官方源
  disableAutoupdater: boolean
  lastUsedCwd: string
  sidebarWidth: number
  sidebarCollapsed: boolean
  statusDowngradeSec: number   // done/attention 停留多少秒后降回 idle（1~10）
  closeBehavior: CloseBehavior // 点关闭按钮：quit = 确认后退出；tray = 不确认，收进托盘
  showFloater: boolean         // 开启常驻悬浮窗
  floaterX: number | null
  floaterY: number | null
  tabBarMode: TabBarMode       // 标签栏布局：垂直（左栏分组）/ 水平（顶部平铺）
  language: AppLanguage        // 界面语言：zh = 简体中文（默认）；en = English。重启后生效
  // Ctrl+P 全局搜索的类别开关：分组 / 智能体标签页（含会话）/ 终端标签页 / 路径（工作目录）
  searchScopes: { group: boolean; agent: boolean; terminal: boolean; path: boolean }
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  font: {
    family: '"Sarasa Fixed SC", monospace',
    size: 14,
    lineHeight: 1.2
  },
  cursor: { style: 'block', blink: true },
  terminal: { scrollback: 5000, theme: 'vscode-dark' },
  appTheme: 'light',
  defaults: { cwd: '' },
  dangerousSkipPermissions: false,
  claudePath: '',
  npmRegistry: 'https://registry.npmmirror.com',
  npmMirrorEnabled: true,
  disableAutoupdater: true,
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

// 应用自带的终端字体（styles.css 里 @font-face 声明）
export const BUNDLED_MONO = 'Sarasa Fixed SC'
const GENERIC_FONTS = new Set(['monospace', 'ui-monospace', 'sans-serif', 'serif', 'system-ui'])

// 用户字体后面补上自带字体：用户的英文字体没有中文或符号时也统一用它，不掉到各平台的系统字体。
// 插在末尾的通用字体族之前，否则 monospace 会先接住这些字符
export function terminalFontFamily(family: string): string {
  const parts = family.split(',').map((x) => x.trim()).filter(Boolean)
  const bare = (x: string): string => x.replace(/^["']|["']$/g, '')
  if (parts.some((x) => bare(x) === BUNDLED_MONO)) return family
  let i = parts.length
  while (i > 0 && GENERIC_FONTS.has(bare(parts[i - 1]).toLowerCase())) i--
  parts.splice(i, 0, `"${BUNDLED_MONO}"`)
  return parts.join(', ')
}

// 终端打开前先把自带字体加载好：xterm 在 open 时量格子宽度，字体没到位会按回退字体量错
export async function loadBundledFonts(): Promise<void> {
  try {
    await Promise.all([
      document.fonts.load(`14px "${BUNDLED_MONO}"`, '中a'),
      document.fonts.load(`bold 14px "${BUNDLED_MONO}"`, '中a')
    ])
  } catch {}
}

export const THEMES: Record<ThemePreset, ITheme & { label: string; backgroundCss: string }> = {
  'vscode-dark': {
    label: 'VSCode Dark',
    backgroundCss: '#0a0a0a',
    background: '#0a0a0a',
    foreground: '#e5e5e5',
    cursor: '#e5e5e5',
    cursorAccent: '#0a0a0a',
    selectionBackground: '#264f78',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#ffffff'
  },
  'vercel-dark': {
    label: 'Vercel Dark',
    backgroundCss: '#000000',
    background: '#000000',
    foreground: '#ededed',
    cursor: '#ededed',
    cursorAccent: '#000000',
    selectionBackground: '#333333',
    black: '#000000',
    red: '#ff4444',
    green: '#50e3c2',
    yellow: '#f5a623',
    blue: '#0070f3',
    magenta: '#ff0080',
    cyan: '#79ffe1',
    white: '#ededed',
    brightBlack: '#666666',
    brightRed: '#ff6666',
    brightGreen: '#79ffe1',
    brightYellow: '#f7b955',
    brightBlue: '#3b8eea',
    brightMagenta: '#ff66b3',
    brightCyan: '#a9fff0',
    brightWhite: '#ffffff'
  },
  // 不提供浅色终端主题：cc 的 diff/代码块按深色终端假设绘制，浅色下前景落在深底上看不见
  'one-dark': {
    label: 'One Dark',
    backgroundCss: '#282c34',
    background: '#282c34',
    foreground: '#abb2bf',
    cursor: '#528bff',
    cursorAccent: '#282c34',
    selectionBackground: '#3e4451',
    black: '#282c34',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#abb2bf',
    brightBlack: '#5c6370',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#d19a66',
    brightBlue: '#61afef',
    brightMagenta: '#c678dd',
    brightCyan: '#56b6c2',
    brightWhite: '#ffffff'
  }
}

export function themeForPreset(name: ThemePreset): ITheme {
  const t = THEMES[name] ?? THEMES['vscode-dark']
  // 拆掉 label / backgroundCss，只留 xterm ITheme 字段
  const { label: _l, backgroundCss: _b, ...rest } = t
  void _l; void _b
  return rest
}

export function backgroundFor(name: ThemePreset): string {
  return (THEMES[name] ?? THEMES['vscode-dark']).backgroundCss
}
