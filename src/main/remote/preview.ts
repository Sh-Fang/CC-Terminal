// 手机首页每行的摘要：智能体标签页取会话记录里最后一条消息，按文件修改时间缓存
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import type { ChatBlock, RemotePreview, RemoteTab } from '../../shared/remote'
import { findSessionJsonl } from '../claude-paths'
import { codexSessionPath } from '../codex-helper'
import { TranscriptDecoder } from './transcript'

// 只读文件末尾这么多字节
const TAIL_BYTES = 256 * 1024
// 首行最多读这么多字节：Codex 的 session_meta 决定后面怎么解码
const HEAD_BYTES = 64 * 1024
// 摘要最长字数
const PREVIEW_CHARS = 120

interface Entry {
  path: string
  mtimeMs: number
  size: number
  preview: RemotePreview | null
}

const cache = new Map<string, Entry>()
// 会话 id → 记录文件路径；查不到的不缓存，下次再找
const paths = new Map<string, string>()

function readRange(path: string, start: number, len: number): string {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(len)
    const n = readSync(fd, buf, 0, len, start)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function pathOf(tab: RemoteTab): string | null {
  const sid = tab.sessionId
  if (!sid || !tab.agent) {
    return null
  }
  const hit = paths.get(sid)
  if (hit) {
    return hit
  }
  const p = tab.agent === 'codex' ? codexSessionPath(sid) : findSessionJsonl(sid)
  if (p) {
    paths.set(sid, p)
  }
  return p
}

function blockPreview(role: 'user' | 'assistant', b: ChatBlock): RemotePreview {
  if (b.type === 'tool') {
    return { role, text: b.summary.slice(0, PREVIEW_CHARS), tool: b.name }
  }
  // 去掉 Markdown 符号：代码围栏、行内代码、标题、引用、列表、加粗
  const plain = b.text
    .replace(/```[^\n]*/g, '')
    .replace(/`/g, '')
    .replace(/^\s*(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\*\*|__/g, '')
  const line = plain.replace(/\s+/g, ' ').trim()
  return { role, text: line.slice(0, PREVIEW_CHARS) }
}

function decode(tab: RemoteTab, path: string, size: number): RemotePreview | null {
  const lines: string[] = []
  // 首行单独读，保证 Codex 能认出记录格式
  const head = readRange(path, 0, Math.min(size, HEAD_BYTES))
  const nl = head.indexOf('\n')
  if (nl > 0) {
    lines.push(head.slice(0, nl))
  }
  const start = Math.max(0, size - TAIL_BYTES)
  const tail = readRange(path, start, size - start).split('\n')
  // 从中间截断的第一行不完整，丢掉
  if (start > 0) {
    tail.shift()
  }
  lines.push(...tail)
  const dec = new TranscriptDecoder(tab.agent === 'codex' ? 'codex' : 'claude')
  dec.feed(lines)
  for (let i = dec.messages.length - 1; i >= 0; i--) {
    const m = dec.messages[i]
    if (m.role === 'system') {
      continue
    }
    const b = m.blocks[m.blocks.length - 1]
    if (b) {
      return blockPreview(m.role === 'user' ? 'user' : 'assistant', b)
    }
  }
  return null
}

/** 取标签页的摘要与最后活动时间；文件没变就用缓存 */
export function previewOf(tab: RemoteTab): { preview: RemotePreview | null; at: number | null } {
  const path = pathOf(tab)
  if (!path) {
    return { preview: null, at: null }
  }
  let st
  try {
    st = statSync(path)
  } catch {
    paths.delete(tab.sessionId ?? '')
    return { preview: null, at: null }
  }
  const old = cache.get(tab.id)
  if (old && old.path === path && old.mtimeMs === st.mtimeMs && old.size === st.size) {
    return { preview: old.preview, at: st.mtimeMs }
  }
  let preview: RemotePreview | null = null
  try {
    preview = decode(tab, path, st.size)
  } catch {
    preview = null
  }
  cache.set(tab.id, { path, mtimeMs: st.mtimeMs, size: st.size, preview })
  return { preview, at: st.mtimeMs }
}

/** 标签页关掉后清缓存 */
export function prunePreviews(alive: Set<string>): void {
  for (const id of cache.keys()) {
    if (!alive.has(id)) {
      cache.delete(id)
    }
  }
}
