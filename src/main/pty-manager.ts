// PTY 生命周期管理：spawn shell（Windows ConPTY / 类 Unix 原生 pty）、注入 shell-integration、
// 读写/resize/kill。数据与退出事件推给主窗口。
import * as pty from '@lydell/node-pty'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { release } from 'node:os'
import { execSync } from 'node:child_process'
import { snapshotCurrentEnv } from './sys-env'
import { SHELL_READY_TITLE } from '../shared/shell-ready'

const IS_WIN = process.platform === 'win32'
const PWSH_PRIMARY = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'

// Win10（内部版本 < 22000）系统自带的旧 ConPTY 会吞掉程序发的隐藏光标（CSI ?25l），
// cc 自绘光标时真实光标仍显示在输入行首，压住第一格、出现两个光标；
// 改用 node-pty 自带的新版 conpty.dll + OpenConsole.exe，Win11 继续用系统 ConPTY
const USE_BUNDLED_CONPTY = IS_WIN && Number(release().split('.')[2] ?? 0) < 22000

function resolvePwsh(): string {
  if (existsSync(PWSH_PRIMARY)) return PWSH_PRIMARY
  try {
    const out = execSync('where.exe pwsh', { encoding: 'utf8' }).split(/\r?\n/).find(Boolean)
    if (out && existsSync(out)) return out
  } catch {}
  return 'powershell.exe'
}

// profileKey 决定注入哪份 shell-integration 脚本；null = 未知 shell，不注入（终端仍可用）。
type ProfileKey = 'pwsh' | 'zsh' | 'bash'
interface ShellInfo {
  file: string
  args: string[]
  profileKey: ProfileKey | null
}

// Windows 固定 pwsh；类 Unix 跟随 $SHELL 并用 -l -i（macOS GUI 进程 PATH 极简，须靠登录 shell 补全）
function resolveShell(): ShellInfo {
  if (IS_WIN) return { file: resolvePwsh(), args: ['-NoLogo'], profileKey: 'pwsh' }
  const shellPath = process.env.SHELL || '/bin/zsh'
  const base = basename(shellPath).toLowerCase()
  let profileKey: ProfileKey | null = null
  if (base.includes('zsh')) profileKey = 'zsh'
  else if (base.includes('bash')) profileKey = 'bash'
  return { file: shellPath, args: ['-l', '-i'], profileKey }
}

export interface PtySession {
  id: number
  proc: pty.IPty
}

const sessions = new Map<number, PtySession>()
let nextId = 0

export interface CreateOpts {
  cols?: number
  rows?: number
  cwd?: string
  env?: Record<string, string>
  // 重新加载标签时跳过 5s 环境快照缓存，立刻读取当前系统环境变量
  freshEnv?: boolean
  // 各平台 shell-integration 脚本路径（zsh 为 ZDOTDIR 目录）；createPty 按 resolveShell() 选中的 shell 取用。
  profiles?: Partial<Record<ProfileKey, string>>
}

// pwsh 单引号字符串里嵌单引号：写两个单引号转义
function quoteSingle(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

export function createPty(
  opts: CreateOpts,
  onData: (id: number, data: string) => void,
  onExit: (id: number, exitCode: number) => void
): number {
  const id = nextId++
  const cols = opts.cols ?? 80
  const rows = opts.rows ?? 24
  // Windows 兜底 USERPROFILE（不看 HOME，防 Git Bash 设 HOME 改默认目录）；类 Unix 兜底 HOME
  const cwd = opts.cwd || (IS_WIN ? process.env.USERPROFILE : process.env.HOME) || process.cwd()

  // 用 snapshotCurrentEnv：Windows 主进程 env 启动时冻结，感知不到 setx/注册表改动
  const env: Record<string, string> = { ...snapshotCurrentEnv(!!opts.freshEnv), ...(opts.env ?? {}) }
  // 去掉从父进程继承来的防重复注入标记（应用本身从本应用的终端里启动时会带上），否则新 shell 跳过 shell-integration
  delete env.__TERMINAL_SHELL_INTEG

  const shellInfo = resolveShell()
  const profilePath = shellInfo.profileKey ? opts.profiles?.[shellInfo.profileKey] : undefined
  // 类 Unix 用启动文件接入 shell-integration，不往终端里敲命令，屏上不留回显
  let args = shellInfo.args
  if (profilePath && shellInfo.profileKey === 'bash') {
    // --init-file 只对非登录 shell 生效：去掉 -l，由脚本按登录 shell 的顺序补读启动文件
    args = ['--init-file', profilePath, '-i']
    env.__CCT_BASH_LOGIN = '1'
  } else if (profilePath && shellInfo.profileKey === 'zsh') {
    if (env.ZDOTDIR) env.__CCT_USER_ZDOTDIR = env.ZDOTDIR
    env.ZDOTDIR = profilePath
  }

  const spawnOpts: pty.IWindowsPtyForkOptions & pty.IPtyForkOptions = {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env
  }
  if (IS_WIN) {
    const winOpts = spawnOpts as pty.IWindowsPtyForkOptions
    winOpts.useConpty = true
    if (USE_BUNDLED_CONPTY) winOpts.useConptyDll = true
  }

  const proc = pty.spawn(shellInfo.file, args, spawnOpts)

  if (IS_WIN) {
    // chcp 65001 + Input/OutputEncoding 一起置 UTF-8（只设 Output 时中文粘贴按 GBK 解码会乱码）；
    // shell-integration 必须同一行 dot-source，晚了首条命令就不发 OSC 序列。
    // dot-source 前清屏，屏上不留这行注入命令的回显；最后改窗口标题通知渲染层撤掉启动画面
    const profileSuffix = profilePath ? `; . ${quoteSingle(profilePath)}` : ''
    proc.write(
      `chcp 65001 > $null; [Console]::OutputEncoding = [Console]::InputEncoding = [System.Text.Encoding]::UTF8; Clear-Host${profileSuffix}; $Host.UI.RawUI.WindowTitle = '${SHELL_READY_TITLE}'\r`
    )
  }

  proc.onData((d) => onData(id, d))
  proc.onExit(({ exitCode }) => {
    sessions.delete(id)
    onExit(id, exitCode)
  })

  sessions.set(id, { id, proc })
  return id
}

// 每个 PTY 的 shell 进程号，供前台程序识别查进程树
export function shellPids(): Map<number, number> {
  const out = new Map<number, number>()
  for (const s of sessions.values()) {
    out.set(s.id, s.proc.pid)
  }
  return out
}

export function writePty(id: number, data: string): void {
  sessions.get(id)?.proc.write(data)
}

export function resizePty(id: number, cols: number, rows: number): void {
  const s = sessions.get(id)
  if (!s) return
  try {
    s.proc.resize(Math.max(1, cols | 0), Math.max(1, rows | 0))
  } catch {}
}

// 勿用 taskkill /T /F 杀进程树：会切断 node-pty 在用的 ConPTY/pipe 触发 WSAECONNABORTED
// 崩溃主进程；ConPTY 关闭时本就会终止挂在其上的子进程。
export function killPty(id: number): void {
  const s = sessions.get(id)
  if (!s) return
  try {
    s.proc.kill()
  } catch {}
  sessions.delete(id)
}

// 「重新加载标签」用：kill 后等进程真正退出再 resolve，渲染层据此串行化「杀旧 → 建新」。
// 不等的话新 cc 可能与尚未退出的旧 cc 短暂并存、同时 --resume 同一个会话，写坏 transcript。
// 超时（进程卡死收不掉）也照常 resolve，调用方按正常流程继续建新 PTY。
export function killPtyAndWait(id: number, timeoutMs = 3000): Promise<void> {
  const s = sessions.get(id)
  if (!s) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sessions.delete(id)
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    // onExit 里已有的 handler 照常跑（会推 pty:exit 并清路由），这里只额外等一个信号
    try {
      s.proc.onExit(() => done())
    } catch {
      done()
      return
    }
    try {
      s.proc.kill()
    } catch {
      done()
    }
  })
}

export function killAll(): void {
  for (const s of sessions.values()) {
    try {
      s.proc.kill()
    } catch {}
  }
  sessions.clear()
}
