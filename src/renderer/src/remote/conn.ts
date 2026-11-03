// 手机端到电脑的连接：配对或令牌鉴权，断线自动重连，消息分发给订阅者
import { REMOTE_PROTOCOL, type ClientMsg, type ServerMsg } from '../../../shared/remote'

const TOKEN_KEY = 'cc-remote-token'

/** 连接状态：unpaired 没有令牌；denied 令牌失效或被吊销；version 协议不兼容 */
export type ConnState = 'connecting' | 'ready' | 'offline' | 'unpaired' | 'denied' | 'version' | 'pairfail'

type Listener = (m: ServerMsg) => void

/** 设备名：从 UA 里取「机型 · 浏览器」 */
function deviceName(): string {
  const ua = navigator.userAgent
  const dev = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
    ? 'iPad'
    : /Android/.test(ua)
    ? 'Android'
    : /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS X/.test(ua)
    ? 'Mac'
    : /Linux/.test(ua)
    ? 'Linux'
    : 'Browser'
  const browser = /EdgA?\//.test(ua)
    ? 'Edge'
    : /CriOS|Chrome\//.test(ua)
    ? 'Chrome'
    : /FxiOS|Firefox\//.test(ua)
    ? 'Firefox'
    : /Safari\//.test(ua)
    ? 'Safari'
    : ''
  return browser ? `${dev} · ${browser}` : dev
}

export class Conn {
  state: ConnState = 'connecting'
  private ws: WebSocket | null = null
  private listeners = new Set<Listener>()
  private stateListeners = new Set<(s: ConnState) => void>()
  private retryMs = 1000
  private retryTimer: number | null = null
  // 只在本次打开页面时有效的配对码
  private pairCode: string | null = null

  constructor() {
    const m = /[#&]pair=([^&]+)/.exec(location.hash)
    if (m) {
      this.pairCode = decodeURIComponent(m[1])
      history.replaceState(null, '', location.pathname)
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.state === 'offline') {
        this.connect()
      }
    })
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  onState(fn: (s: ConnState) => void): () => void {
    this.stateListeners.add(fn)
    return () => {
      this.stateListeners.delete(fn)
    }
  }

  private setState(s: ConnState): void {
    this.state = s
    for (const fn of this.stateListeners) {
      fn(s)
    }
  }

  send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.state === 'ready') {
      this.ws.send(JSON.stringify(msg))
    }
  }

  connect(): void {
    if (this.retryTimer != null) {
      window.clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    const token = localStorage.getItem(TOKEN_KEY)
    if (!this.pairCode && !token) {
      this.setState('unpaired')
      return
    }
    this.ws?.close()
    this.setState('connecting')
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
    this.ws = ws
    ws.onopen = () => {
      // 已有令牌时先用令牌，令牌失效才用配对码，避免同一浏览器重复扫码变成多台设备
      const hello: ClientMsg = token
        ? { t: 'hello', v: REMOTE_PROTOCOL, token }
        : { t: 'pair', v: REMOTE_PROTOCOL, code: this.pairCode ?? '', name: deviceName() }
      ws.send(JSON.stringify(hello))
    }
    ws.onmessage = (e) => {
      let msg: ServerMsg
      try {
        msg = JSON.parse(String(e.data)) as ServerMsg
      } catch {
        return
      }
      this.onMessage(msg)
    }
    ws.onclose = () => {
      if (this.ws !== ws) {
        return
      }
      this.ws = null
      if (this.state === 'ready' || this.state === 'connecting') {
        this.setState('offline')
        this.scheduleRetry()
      }
    }
  }

  private scheduleRetry(): void {
    this.retryTimer = window.setTimeout(() => this.connect(), this.retryMs)
    this.retryMs = Math.min(this.retryMs * 2, 8000)
  }

  private onMessage(msg: ServerMsg): void {
    if (msg.t === 'paired') {
      localStorage.setItem(TOKEN_KEY, msg.token)
      this.pairCode = null
      return
    }
    if (msg.t === 'ready') {
      this.retryMs = 1000
      this.setState('ready')
    } else if (msg.t === 'err' && (msg.code === 'auth' || msg.code === 'revoked')) {
      localStorage.removeItem(TOKEN_KEY)
      if (msg.code === 'auth' && this.pairCode) {
        // 令牌失效但带着配对码：断开后用配对码重连
        this.setState('connecting')
      } else {
        this.setState('denied')
      }
    } else if (msg.t === 'err' && msg.code === 'pair') {
      this.pairCode = null
      // 已经配对过的设备扫了过期的码：断开后照常用旧令牌重连
      this.setState(localStorage.getItem(TOKEN_KEY) ? 'connecting' : 'pairfail')
    } else if (msg.t === 'err' && msg.code === 'version') {
      this.setState('version')
    } else {
    }
    for (const fn of this.listeners) {
      fn(msg)
    }
  }
}

/** 整个页面共用一条连接 */
export const conn = new Conn()
