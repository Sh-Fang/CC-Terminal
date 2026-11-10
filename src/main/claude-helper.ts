import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { AgentKind } from '../shared/store-types'
import { loadSettings } from './settings'
import { whereOnCurrentPath } from './sys-env'

export { sessionExists } from './claude-paths'

const IS_WIN = process.platform === 'win32'

// 用登录+交互 shell 解析命令候选路径（macOS GUI 进程 PATH 极简，-lic 让 rc 文件里的 PATH 生效）
export function whichAllViaLoginShell(name: string): string[] {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const out = execFileSync(shell, ['-lic', `which -a ${name} 2>/dev/null || command -v ${name}`], {
      encoding: 'utf8'
    })
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('/') && existsSync(l))
  } catch {
    return []
  }
}

// 返回 PATH 上的可执行路径；找不到返回 null。
// Windows 按扩展名优先级挑：.cmd > .ps1 > .exe > 其他；类 Unix 取 which 首条。
export function detectAgentPath(agent: AgentKind): string | null {
  if (!IS_WIN) {
    const cands = whichAllViaLoginShell(agent)
    return cands[0] ?? null
  }
  const cands = whereOnCurrentPath(agent)
  if (cands.length === 0) return null
  const score = (p: string): number => {
    const ext = p.toLowerCase().match(/\.[a-z]+$/)?.[0] ?? ''
    if (ext === '.cmd') return 3
    if (ext === '.ps1') return 2
    if (ext === '.exe') return 1
    return 0
  }
  cands.sort((a, b) => score(b) - score(a))
  return cands[0]
}

// PATH 查找结果短时缓存：打开设置、新建标签页、右键菜单会连着问，类 Unix 走登录 shell 较慢
const PATH_CACHE_MS = 3000
const pathCache = new Map<AgentKind, { at: number; path: string | null }>()

function detectAgentPathCached(agent: AgentKind): string | null {
  const hit = pathCache.get(agent)
  if (hit && Date.now() - hit.at < PATH_CACHE_MS) {
    return hit.path
  }
  const path = detectAgentPath(agent)
  pathCache.set(agent, { at: Date.now(), path })
  return path
}

export function agentPathSetting(agent: AgentKind): string {
  const s = loadSettings()
  return (agent === 'codex' ? s.codexPath : s.claudePath).trim()
}

// 找得到 = 设置里选定的可执行文件存在，或 PATH 上有
export function isAgentAvailable(agent: AgentKind): boolean {
  const p = agentPathSetting(agent)
  if (p && existsSync(p)) {
    return true
  }
  return detectAgentPathCached(agent) != null
}
