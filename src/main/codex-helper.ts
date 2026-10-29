// Codex CLI 相关：安装检测、会话记录查找、hooks profile 名
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { whichAllViaLoginShell } from './claude-helper'
import { UUID_RE } from './claude-paths'

const IS_WIN = process.platform === 'win32'

// 启动 codex 时 -p 指定的 profile；文件由 hook-assets 写到 $CODEX_HOME/<名>.config.toml
export const CODEX_PROFILE = 'claude-terminal'

export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

let cachedAvailable: boolean | null = null

export function isCodexAvailable(): boolean {
  if (cachedAvailable != null) {
    return cachedAvailable
  }
  if (!IS_WIN) {
    cachedAvailable = whichAllViaLoginShell('codex').length > 0
    return cachedAvailable
  }
  try {
    const out = execFileSync('where.exe', ['codex'], { encoding: 'utf8', windowsHide: true })
    cachedAvailable = out.split(/\r?\n/).some((l) => l.trim().length > 0)
  } catch {
    cachedAvailable = false
  }
  return cachedAvailable
}

// 会话记录落在 sessions/YYYY/MM/DD/rollout-<时间>-<id>.jsonl；从新到旧逐日找
export function codexSessionExists(sessionId: string): boolean {
  if (!UUID_RE.test(sessionId)) {
    return false
  }
  const root = join(codexHome(), 'sessions')
  if (!existsSync(root)) {
    return false
  }
  const suffix = `-${sessionId.toLowerCase()}.jsonl`
  const desc = (dir: string): string[] => {
    try {
      return readdirSync(dir).sort().reverse()
    } catch {
      return []
    }
  }
  for (const y of desc(root)) {
    for (const m of desc(join(root, y))) {
      for (const d of desc(join(root, y, m))) {
        if (desc(join(root, y, m, d)).some((f) => f.toLowerCase().endsWith(suffix))) {
          return true
        }
      }
    }
  }
  return false
}
