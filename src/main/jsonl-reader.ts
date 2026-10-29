import { statSync, openSync, readSync, closeSync } from 'node:fs'
import { findSessionJsonl as findJsonl } from './claude-paths'

export interface SessionMeta {
  exists: boolean
  lastTs?: string
  mtime?: number
}

// 从文件尾读最多 N 字节
function tailRead(path: string, maxBytes = 40 * 1024): string {
  let fd = -1
  try {
    fd = openSync(path, 'r')
    const size = statSync(path).size
    const len = Math.min(size, maxBytes)
    const start = size - len
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, start)
    return buf.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd >= 0) try { closeSync(fd) } catch {}
  }
}

function safeParse(line: string): Record<string, unknown> | null {
  try { return JSON.parse(line) as Record<string, unknown> } catch { return null }
}

export function readSessionMeta(sessionId: string): SessionMeta {
  const path = findJsonl(sessionId)
  if (!path) return { exists: false }

  let mtime: number | undefined
  try { mtime = statSync(path).mtimeMs } catch {}

  const raw = tailRead(path)
  if (!raw) return { exists: true, mtime }

  // 末尾可能切到行中间，丢掉首段
  const lines = raw.split(/\r?\n/).slice(1).filter((l) => l.length > 0)

  let lastTs: string | undefined

  // 倒序找最新的真实 user/assistant timestamp（排除 tool_result/command 包装/compact 提示）
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = safeParse(lines[i])
    if (!obj) continue
    const type = typeof obj.type === 'string' ? obj.type : ''
    if ((type === 'user' || type === 'assistant') && typeof obj.timestamp === 'string') {
      if (isRealMessage(obj)) { lastTs = obj.timestamp; break }
    }
  }

  return { exists: true, lastTs, mtime }
}

function isRealMessage(obj: Record<string, unknown>): boolean {
  const msg = obj.message as { content?: unknown; role?: unknown } | undefined
  if (msg && Array.isArray(msg.content)) {
    const first = msg.content[0] as Record<string, unknown> | undefined
    if (first && (first.type === 'tool_result' || first.type === 'tool_use')) return false
  }
  if (obj.isCompactSummary === true) return false
  if (typeof obj.content === 'string' && /<command-name|<local-command|This session is being continued/.test(obj.content)) {
    return false
  }
  return true
}
