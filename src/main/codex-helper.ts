// Codex CLI 相关：会话记录查找、hooks profile 名
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { UUID_RE } from './claude-paths'

// 启动 codex 时 -p 指定的 profile；文件由 hook-assets 写到 $CODEX_HOME/<名>.config.toml
export const CODEX_PROFILE = 'cc-terminal'

export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
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
