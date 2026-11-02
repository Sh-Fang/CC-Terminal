// 一部手机打开的一个对话视图：找到标签页当前会话的记录文件，解码后分页发送，
// 之后盯着文件增量读取，把新增或改动的消息推过去。标签页换了会话（如 /clear）就整页重发。
import { closeSync, openSync, readFileSync, readSync, statSync, unwatchFile, watchFile } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import type { RemoteTab, ServerMsg } from '../../shared/remote'
import { findSessionJsonl } from '../claude-paths'
import { codexSessionPath } from '../codex-helper'
import { TranscriptDecoder } from './transcript'

// 每页消息数
const PAGE = 50
// 记录文件轮询间隔；还没找到文件时的重试间隔
const POLL_MS = 700
const RETRY_MS = 2000

export class ChatFeed {
  private sessionId: string | null = null
  private path: string | null = null
  private decoder: TranscriptDecoder | null = null
  // 已读到的字节位置，以及末尾不完整的半行
  private offset = 0
  private rest = ''
  private utf8 = new StringDecoder('utf8')
  private listener: (() => void) | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(
    readonly tabId: string,
    private readonly lookup: (tabId: string) => RemoteTab | null,
    private readonly send: (m: ServerMsg) => void
  ) {}

  /** 打开或翻页：before 为空时发最新一页 */
  open(before?: number): void {
    const tab = this.lookup(this.tabId)
    if (before !== undefined && this.decoder && tab?.sessionId === this.sessionId) {
      this.sendPage(before, true)
      return
    }
    this.load()
  }

  /** 标签页列表变了：会话换了就重新加载 */
  onTabsChanged(): void {
    const tab = this.lookup(this.tabId)
    if (tab && tab.sessionId !== this.sessionId) {
      this.load()
    }
  }

  close(): void {
    this.closed = true
    this.unwatch()
  }

  private unwatch(): void {
    if (this.retry) {
      clearTimeout(this.retry)
      this.retry = null
    }
    if (this.path && this.listener) {
      unwatchFile(this.path, this.listener)
    }
    this.listener = null
  }

  private load(): void {
    this.unwatch()
    const tab = this.lookup(this.tabId)
    this.sessionId = tab?.sessionId ?? null
    this.path = null
    this.decoder = null
    this.offset = 0
    this.rest = ''
    this.utf8 = new StringDecoder('utf8')
    if (tab?.agent && this.sessionId) {
      this.path = tab.agent === 'codex' ? codexSessionPath(this.sessionId) : findSessionJsonl(this.sessionId)
    }
    if (!this.path) {
      this.send({ t: 'chat.page', tabId: this.tabId, sessionId: this.sessionId, messages: [], before: null, older: false })
      // 新会话的记录文件要等第一条消息才创建，过一会儿再找
      if (tab?.agent && this.sessionId && !this.closed) {
        this.retry = setTimeout(() => this.load(), RETRY_MS)
      }
      return
    }
    this.decoder = new TranscriptDecoder(tab?.agent === 'codex' ? 'codex' : 'claude')
    const buf = readFileSync(this.path)
    this.offset = buf.length
    this.decoder.feed(this.split(this.utf8.write(buf)))
    this.sendPage(this.decoder.messages.length, false)
    const path = this.path
    this.listener = () => this.readMore(path)
    watchFile(path, { interval: POLL_MS }, this.listener)
  }

  /** 把新读到的文字切成整行，末尾的半行留到下次 */
  private split(text: string): string[] {
    const lines = (this.rest + text).split('\n')
    this.rest = lines.pop() ?? ''
    return lines
  }

  private readMore(path: string): void {
    if (this.closed || path !== this.path || !this.decoder) {
      return
    }
    let size: number
    try {
      size = statSync(path).size
    } catch {
      return
    }
    // 文件被重写变短：整个重新加载
    if (size < this.offset) {
      this.load()
      return
    }
    if (size === this.offset) {
      return
    }
    const buf = Buffer.alloc(size - this.offset)
    const fd = openSync(path, 'r')
    try {
      readSync(fd, buf, 0, buf.length, this.offset)
    } finally {
      closeSync(fd)
    }
    this.offset = size
    const changed = this.decoder.feed(this.split(this.utf8.write(buf)))
    if (changed.length > 0) {
      this.send({ t: 'chat.append', tabId: this.tabId, messages: changed })
    }
  }

  /** 发 end 之前的一页 */
  private sendPage(end: number, older: boolean): void {
    const all = this.decoder?.messages ?? []
    const stop = Math.max(0, Math.min(end, all.length))
    const start = Math.max(0, stop - PAGE)
    this.send({
      t: 'chat.page',
      tabId: this.tabId,
      sessionId: this.sessionId,
      messages: all.slice(start, stop),
      before: start > 0 ? start : null,
      older
    })
  }
}
