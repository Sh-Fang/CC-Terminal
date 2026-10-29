import { statSync, openSync, readSync, closeSync } from 'node:fs'
import { findSessionJsonl as findJsonl } from './claude-paths'

export interface SessionMeta {
  exists: boolean
  lastTs?: string
  mtime?: number
  // cc 里 /rename（或启动时 --name）写入的标题，取最后一次
  customTitle?: string
  // 第一条用户消息原文（截断）
  firstPrompt?: string
}

const FIRST_PROMPT_MAX = 200

// 从文件头读最多 N 字节
function headRead(path: string, maxBytes: number): string {
  let fd = -1
  try {
    fd = openSync(path, 'r')
    const len = Math.min(statSync(path).size, maxBytes)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, 0)
    return buf.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd >= 0) try { closeSync(fd) } catch {}
  }
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

  const firstPrompt = readFirstPrompt(path)
  // cc 会周期性重写 custom-title 行，尾部 256KB 内基本都能找到最后一次
  const raw = tailRead(path, 256 * 1024)
  if (!raw) return { exists: true, mtime, firstPrompt }

  // 末尾可能切到行中间，丢掉首段
  const lines = raw.split(/\r?\n/).slice(1).filter((l) => l.length > 0)

  let lastTs: string | undefined
  let customTitle: string | undefined

  // 倒序找最新的真实 user/assistant timestamp（排除 tool_result/command 包装/compact 提示）
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lastTs && customTitle !== undefined) break
    const obj = safeParse(lines[i])
    if (!obj) continue
    const type = typeof obj.type === 'string' ? obj.type : ''
    if (customTitle === undefined && type === 'custom-title' && typeof obj.customTitle === 'string') {
      customTitle = obj.customTitle.trim()
      continue
    }
    if (!lastTs && (type === 'user' || type === 'assistant') && typeof obj.timestamp === 'string') {
      if (isRealMessage(obj)) lastTs = obj.timestamp
    }
  }

  return { exists: true, lastTs, mtime, customTitle: customTitle || undefined, firstPrompt }
}

// 第一条真实用户消息的文本：跳过 meta、命令包装、工具结果
function readFirstPrompt(path: string): string | undefined {
  const raw = headRead(path, 256 * 1024)
  for (const line of raw.split(/\r?\n/)) {
    const obj = safeParse(line)
    if (!obj || obj.type !== 'user' || obj.isMeta === true || !isRealMessage(obj)) continue
    const content = (obj.message as { content?: unknown } | undefined)?.content
    let text = ''
    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      const part = content.find((c) => (c as { type?: string })?.type === 'text') as { text?: string } | undefined
      text = part?.text ?? ''
    }
    text = text.replace(/\s+/g, ' ').trim()
    if (!text || text.startsWith('<') || text.startsWith('Caveat:')) continue
    return text.slice(0, FIRST_PROMPT_MAX)
  }
  return undefined
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
