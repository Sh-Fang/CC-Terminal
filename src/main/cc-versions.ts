import { app } from 'electron'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentKind } from '../shared/store-types'
import { snapshotCurrentEnv, whereOnCurrentPath } from './sys-env'

// 智能体多版本管理：每版装到 <userData>/<目录>/<version>/（npm install -g --prefix 隔离），
// 切换 = 把 settings.claudePath / codexPath 指向对应可执行文件；登录态在各自家目录全局共享，不用重登。

interface AgentSpec {
  pkg: string
  bin: string
  dir: string
}
const AGENTS: Record<AgentKind, AgentSpec> = {
  claude: { pkg: '@anthropic-ai/claude-code', bin: 'claude', dir: 'cc-versions' },
  codex: { pkg: '@openai/codex', bin: 'codex', dir: 'codex-versions' }
}
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmmirror.com'

const IS_WIN = process.platform === 'win32'

// npm --prefix 产物布局：Windows 在 <dir>/ 根下；类 Unix 在 <dir>/bin 与 <dir>/lib/node_modules
function binPath(agent: AgentKind, prefix: string): string {
  const bin = AGENTS[agent].bin
  return IS_WIN ? join(prefix, `${bin}.cmd`) : join(prefix, 'bin', bin)
}
function pkgJsonPath(agent: AgentKind, prefix: string): string {
  const pkg = AGENTS[agent].pkg
  return IS_WIN
    ? join(prefix, 'node_modules', pkg, 'package.json')
    : join(prefix, 'lib', 'node_modules', pkg, 'package.json')
}
// 从可执行路径反推安装 prefix
function prefixFromBin(path: string): string {
  return IS_WIN ? dirname(path) : dirname(dirname(path))
}

// 用登录 shell 解析命令绝对路径（macOS GUI 进程 PATH 极简）
function whichViaLoginShell(name: string): string | null {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const lines = execFileSync(shell, ['-lic', `command -v ${name}`], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    const line = lines.reverse().find((l) => l.startsWith('/') && existsSync(l))
    return line || null
  } catch {
    return null
  }
}

export interface InstalledVersion {
  version: string
  path: string        // 可执行文件绝对路径
  installedAt: number // 目录 mtime，用于排序兜底
  active: boolean     // 当前 settings 里的路径是否指向这一版
}

export interface InstallResult {
  ok: boolean
  version: string
  path?: string
  error?: string
}


function versionsRoot(agent: AgentKind): string {
  const d = join(app.getPath('userData'), AGENTS[agent].dir)
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

// 版本目录名白名单，挡掉目录穿越
const VERSION_RE = /^[A-Za-z0-9._+-]+$/

// 简易 semver 比较：pre-release 视为更小
function cmpSemver(a: string, b: string): number {
  const [ah, ap = ''] = a.split('-', 2)
  const [bh, bp = ''] = b.split('-', 2)
  const pa = ah.split('.').map((x) => parseInt(x, 10) || 0)
  const pb = bh.split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0
    const db = pb[i] || 0
    if (da !== db) return da - db
  }
  if (ap === bp) return 0
  if (!ap) return 1
  if (!bp) return -1
  // pre-release 按点分段比较，纯数字段按数值比（alpha.12 > alpha.3）
  const sa = ap.split('.')
  const sb = bp.split('.')
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    if (sa[i] === undefined) return -1
    if (sb[i] === undefined) return 1
    if (sa[i] === sb[i]) continue
    const na = /^\d+$/.test(sa[i]) ? Number(sa[i]) : NaN
    const nb = /^\d+$/.test(sb[i]) ? Number(sb[i]) : NaN
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
    return sa[i] < sb[i] ? -1 : 1
  }
  return 0
}

// 找系统 npm；找到的结果缓存到文件被删，找不到每次重查（应用开着时才装 Node 也能找到）
let cachedNpm: string | null = null
export function detectNpm(): string | null {
  if (cachedNpm && existsSync(cachedNpm)) return cachedNpm
  if (!IS_WIN) {
    cachedNpm = whichViaLoginShell('npm')
    return cachedNpm
  }
  const tryOne = (name: string): string | null =>
    whereOnCurrentPath(name).find((l) => existsSync(l)) ?? null
  cachedNpm = tryOne('npm.cmd') || tryOne('npm')
  return cachedNpm
}

// npm 调用形式 spawn(file, [...lead, ...args])。Windows 上 Node 20+ 因 CVE-2024-27980
// 禁止直接 spawn .cmd，改用 node.exe + npm-cli.js 跑（兼容 nvm4w / msi / winget 布局）。
interface NpmInvocation { file: string; lead: string[] }
let cachedInvoke: NpmInvocation | null = null
function resolveNpmInvocation(): NpmInvocation | null {
  if (cachedInvoke && existsSync(cachedInvoke.file)) return cachedInvoke
  cachedInvoke = findNpmInvocation()
  return cachedInvoke
}

function findNpmInvocation(): NpmInvocation | null {
  const npmCmd = detectNpm()
  if (!npmCmd) return null
  if (!IS_WIN) return { file: npmCmd, lead: [] }
  const dir = dirname(npmCmd)
  const candidates: Array<{ node: string; cli: string }> = [
    { node: join(dir, 'node.exe'), cli: join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js') },
    // nvm4w 的 npm.cmd 有时是 shim，真正 npm 在同层 node_modules
    { node: join(dir, 'node.exe'), cli: join(dir, 'node_modules', 'npm', 'lib', 'npm.js') }
  ]
  for (const c of candidates) {
    if (existsSync(c.node) && existsSync(c.cli)) return { file: c.node, lead: [c.cli] }
  }
  const nodeExe = whereOnCurrentPath('node.exe').find((l) => existsSync(l))
  if (nodeExe) {
    const cli = join(dirname(nodeExe), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (existsSync(cli)) return { file: nodeExe, lead: [cli] }
    // PATH 上的 node.exe / npm.exe 可能是转发壳（如 nvm for Windows 2.x 的 .nodejs 目录、volta），
    // 旁边没有 node_modules；让它报出真实 node 路径，再到真实目录下找 npm-cli.js
    const realNode = realNodePath(nodeExe)
    if (realNode) {
      const realCli = join(dirname(realNode), 'node_modules', 'npm', 'bin', 'npm-cli.js')
      if (existsSync(realCli)) return { file: realNode, lead: [realCli] }
    }
  }
  // 兜底：npm 本身是 .exe（转发壳）时可直接 spawn，不受 .cmd 限制
  if (/\.exe$/i.test(npmCmd)) return { file: npmCmd, lead: [] }
  return null
}

function realNodePath(nodeExe: string): string | null {
  try {
    const out = execFileSync(nodeExe, ['-p', 'process.execPath'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
      env: snapshotCurrentEnv()
    }).trim()
    return out && existsSync(out) ? out : null
  } catch {
    return null
  }
}

// registry URL 白名单校验，挡掉 shell 元字符
const REGISTRY_RE = /^https?:\/\/[A-Za-z0-9._~\-/:@%?&=+]+$/
function safeRegistry(reg: string): string {
  const v = (reg || '').trim() || DEFAULT_NPM_REGISTRY
  return REGISTRY_RE.test(v) ? v : DEFAULT_NPM_REGISTRY
}

function readPkgVersion(agent: AgentKind, dir: string): string | null {
  try {
    const p = pkgJsonPath(agent, dir)
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, 'utf8')) as { version?: unknown }
    return typeof j.version === 'string' ? j.version : null
  } catch {
    return null
  }
}

export function listInstalled(agent: AgentKind, activePath: string): InstalledVersion[] {
  const root = versionsRoot(agent)
  const active = (activePath || '').toLowerCase()
  const out: InstalledVersion[] = []
  let entries: string[] = []
  try { entries = readdirSync(root) } catch { return [] }
  for (const name of entries) {
    if (!VERSION_RE.test(name)) continue
    const dir = join(root, name)
    let st
    try { st = statSync(dir) } catch { continue }
    if (!st.isDirectory()) continue
    const pkgVer = readPkgVersion(agent, dir)
    if (!pkgVer) continue
    const cmd = binPath(agent, dir)
    if (!existsSync(cmd)) continue
    out.push({
      version: pkgVer,
      path: cmd,
      installedAt: st.mtimeMs,
      active: cmd.toLowerCase() === active
    })
  }
  out.sort((a, b) => cmpSemver(b.version, a.version))
  return out
}

// 从任意可执行路径反查版本号：先按托管布局反推 prefix 读版本，
// 再向上逐级找同名包的 package.json；找不到返回 null。
export function versionFromPath(agent: AgentKind, path: string): string | null {
  if (!path) return null
  const prefix = prefixFromBin(path)
  const v1 = readPkgVersion(agent, prefix)
  if (v1) return v1
  let cur = path
  for (let i = 0; i < 8; i++) {
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
    try {
      const pkgPath = join(cur, 'package.json')
      if (existsSync(pkgPath)) {
        const j = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown; version?: unknown }
        if (j.name === AGENTS[agent].pkg && typeof j.version === 'string') return j.version
      }
    } catch {}
  }
  return null
}

// codex 把各平台二进制作为同包的「<版本>-<平台>-<架构>」版本发布，不是可装的独立版本
const PLATFORM_BUILD_RE = /-(?:darwin|linux|win32)-(?:x64|arm64)$/

export async function listRemote(agent: AgentKind, registry: string): Promise<string[]> {
  const inv = resolveNpmInvocation()
  if (!inv) throw new Error('未找到 npm，请检查 Node.js 安装')
  const reg = safeRegistry(registry)
  return new Promise((resolve, reject) => {
    execFile(
      inv.file,
      [...inv.lead, 'view', AGENTS[agent].pkg, 'versions', '--json', `--registry=${reg}`],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 20 * 1024 * 1024, env: snapshotCurrentEnv() },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr?.trim() || err.message))
        try {
          const raw = JSON.parse(stdout) as unknown
          const arr = Array.isArray(raw) ? raw.map(String).filter((v) => !PLATFORM_BUILD_RE.test(v)) : []
          arr.sort(cmpSemver).reverse()
          resolve(arr)
        } catch (e) {
          reject(e as Error)
        }
      }
    )
  })
}

// 在跑的安装进程，key = <智能体>:<version>，供 cancel 调用
interface InflightInstall {
  proc: ReturnType<typeof spawn>
  prefix: string
  createdDir: boolean  // 本次安装新建的目录 → 取消/失败时可整目录清理
  cancelled: boolean
}
const inflightInstalls = new Map<string, InflightInstall>()

// 剥离 npm progress 输出里的 ANSI 转义序列
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g

export function install(
  agent: AgentKind,
  version: string,
  registry: string,
  onPhase: (phase: string) => void
): Promise<InstallResult> {
  const ver = version.trim()
  if (!VERSION_RE.test(ver) && ver !== 'latest') {
    return Promise.resolve({ ok: false, version: ver, error: '版本号格式非法' })
  }
  const key = `${agent}:${ver}`
  if (inflightInstalls.has(key)) {
    return Promise.resolve({ ok: false, version: ver, error: '同一版本正在安装中' })
  }
  const inv = resolveNpmInvocation()
  if (!inv) return Promise.resolve({ ok: false, version: ver, error: '未找到 npm' })
  const reg = safeRegistry(registry)
  // latest 先装到临时目录，装完读真实版本改名
  const useTmp = ver === 'latest'
  const dirName = useTmp ? `_pending_${Date.now()}` : ver
  const prefix = join(versionsRoot(agent), dirName)
  const createdDir = !existsSync(prefix)
  if (createdDir) mkdirSync(prefix, { recursive: true })
  const args = [
    ...inv.lead,
    'install', '-g', `${AGENTS[agent].pkg}@${ver}`,
    `--prefix=${prefix}`,
    `--registry=${reg}`,
    '--no-audit', '--no-fund', '--no-package-lock'
  ]
  onPhase('准备…')
  return new Promise((resolve) => {
    const p = spawn(inv.file, args, { windowsHide: true, env: snapshotCurrentEnv() })
    const state: InflightInstall = { proc: p, prefix, createdDir, cancelled: false }
    inflightInstalls.set(key, state)
    const cleanupOnFail = (): void => {
      // 只清理本次新建的目录，已装的同版本不能误删
      if (state.createdDir) { try { rmSync(prefix, { recursive: true, force: true }) } catch {} }
    }
    // 从 npm stdout/stderr（progress 走 stderr）抽取最新一行作为 phase，节流上报
    let lastPhaseSent = ''
    let lastSendTs = 0
    const handleChunk = (buf: Buffer): void => {
      const clean = buf.toString().replace(ANSI_RE, '').replace(/\r/g, '\n')
      const lines = clean.split('\n').map((l) => l.trim()).filter((l) => l && l.length < 200)
      if (!lines.length) return
      const line = lines[lines.length - 1]
      if (line === lastPhaseSent) return
      const now = Date.now()
      if (now - lastSendTs < 250) return
      lastPhaseSent = line
      lastSendTs = now
      onPhase(line)
    }
    p.stdout.on('data', handleChunk)
    p.stderr.on('data', handleChunk)
    p.on('error', (e) => {
      inflightInstalls.delete(key)
      cleanupOnFail()
      resolve({ ok: false, version: ver, error: e.message })
    })
    p.on('exit', (code) => {
      inflightInstalls.delete(key)
      if (state.cancelled) {
        cleanupOnFail()
        return resolve({ ok: false, version: ver, error: '已取消' })
      }
      if (code !== 0) {
        cleanupOnFail()
        return resolve({ ok: false, version: ver, error: `npm 退出码 ${code}` })
      }
      const realVer = readPkgVersion(agent, prefix) ?? ver
      let finalPrefix = prefix
      if (useTmp) {
        finalPrefix = join(versionsRoot(agent), realVer)
        try {
          if (existsSync(finalPrefix)) rmSync(finalPrefix, { recursive: true, force: true })
          renameSync(prefix, finalPrefix)
        } catch {
          finalPrefix = prefix
        }
      }
      const cmd = binPath(agent, finalPrefix)
      if (!existsSync(cmd)) {
        return resolve({ ok: false, version: realVer, error: `未生成 ${AGENTS[agent].bin} 可执行文件（可能包结构变了）` })
      }
      resolve({ ok: true, version: realVer, path: cmd })
    })
  })
}

// 取消正在进行的安装（Windows 上 SIGTERM 被 libuv 翻成 TerminateProcess，可立即中断）
export function cancelInstall(agent: AgentKind, version: string): { ok: boolean; error?: string } {
  const inf = inflightInstalls.get(`${agent}:${version.trim()}`)
  if (!inf) return { ok: false, error: '没有正在进行的安装任务' }
  inf.cancelled = true
  try {
    inf.proc.kill()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function uninstall(agent: AgentKind, version: string): { ok: boolean; error?: string } {
  if (!VERSION_RE.test(version)) return { ok: false, error: '版本号格式非法' }
  const dir = join(versionsRoot(agent), version)
  if (!existsSync(dir)) return { ok: true }
  try {
    rmSync(dir, { recursive: true, force: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

