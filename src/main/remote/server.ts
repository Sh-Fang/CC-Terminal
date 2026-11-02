// 远程访问服务：同一端口上提供手机网页（http）和数据通道（WebSocket /ws）。
// 开关关闭时不监听任何端口。手机先用一次性配对码换设备令牌，之后每次连接用令牌鉴权。
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { hostname, networkInterfaces } from 'node:os'
import { extname, join, normalize, sep } from 'node:path'
import QRCode from 'qrcode'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  REMOTE_PROTOCOL,
  type ClientMsg,
  type RemoteAddress,
  type RemoteBrief,
  type RemoteGroup,
  type RemoteInfo,
  type RemoteLook,
  type RemoteTab,
  type ServerMsg
} from '../../shared/remote'
import { writePty } from '../pty-manager'
import { loadSettings } from '../settings'
import { sendToMain } from '../windows'
import { addDevice, deviceByToken, loadRemoteConfig, normPort, removeDevice, saveRemoteConfig, touchDevice } from './config'
import { ChatFeed } from './chat-feed'
import { previewOf, prunePreviews } from './preview'

/** 一条手机连接 */
interface Client {
  ws: WebSocket
  deviceId: string | null
  chat: ChatFeed | null
  // 订阅了屏幕快照的标签页
  screenTab: string | null
}

// 配对码有效期
const PAIR_TTL_MS = 5 * 60 * 1000
// 未鉴权的连接多久断开
const AUTH_TIMEOUT_MS = 10 * 1000

let server: Server | null = null
let wss: WebSocketServer | null = null
let listenPort = 0
let listenError: string | null = null
const clients = new Set<Client>()
let pair: { code: string; expiresAt: number } | null = null
// 桌面推来的原始列表；发给手机的是补上摘要后的
let groups: RemoteGroup[] = []
let groupsJson = '[]'
let sent: RemoteGroup[] = []
// 有手机在线时定期检查会话记录，摘要变了就重发列表
const PREVIEW_MS = 3000
let previewTimer: ReturnType<typeof setInterval> | null = null
let tailscaleName: string | null = null

// ─── 静态页 ─────────────────────────────
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.json': 'application/json'
}

/** 开发模式把请求转给 electron-vite 的开发服务器 */
function proxyDev(req: IncomingMessage, res: ServerResponse, base: string): void {
  const path = req.url === '/' || req.url?.startsWith('/?') ? '/remote.html' : req.url ?? '/'
  const up = httpRequest(new URL(path, base), { method: req.method, headers: { ...req.headers, host: new URL(base).host } }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers)
    r.pipe(res)
  })
  up.on('error', () => {
    res.writeHead(502)
    res.end()
  })
  req.pipe(up)
}

/** 只放行手机页和它引用的资源 */
function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const dev = process.env.ELECTRON_RENDERER_URL
  if (dev) {
    proxyDev(req, res, dev)
    return
  }
  const root = join(__dirname, '../renderer')
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204)
    res.end()
    return
  }
  let rel = decodeURIComponent(url.pathname)
  if (rel === '/' || rel === '/remote.html') {
    rel = '/remote.html'
  } else if (!rel.startsWith('/assets/') && !rel.startsWith('/fonts/')) {
    res.writeHead(404)
    res.end()
    return
  } else {
  }
  const file = normalize(join(root, rel))
  if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': rel === '/remote.html' ? 'no-cache' : 'max-age=31536000, immutable'
  })
  createReadStream(file).pipe(res)
}

// ─── 地址 ─────────────────────────────
/** 100.64.0.0/10 是 Tailscale 分配的地址段 */
function isTailscaleIp(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number)
  return a === 100 && b >= 64 && b <= 127
}

/** 后台查一次 Tailscale 的机器名（MagicDNS），查不到就只用 IP */
function refreshTailscaleName(): void {
  execFile('tailscale', ['status', '--json'], { timeout: 3000, windowsHide: true }, (err, stdout) => {
    if (err) {
      return
    }
    try {
      const name = (JSON.parse(stdout) as { Self?: { DNSName?: string } }).Self?.DNSName
      tailscaleName = name ? name.replace(/\.$/, '') : null
    } catch {
      tailscaleName = null
    }
  })
}

// 虚拟网卡（虚拟机、WSL、容器）的地址手机连不上，不列出来
const VIRTUAL_NIC = /vEthernet|VirtualBox|VMware|Hyper-V|WSL|docker|vmnet|veth|br-|Loopback|Bluetooth/i
// 网卡名看不出来时按 MAC 前缀认：VirtualBox、VMware、Hyper-V、TAP 类 VPN（深信服、OpenVPN 等）
const VIRTUAL_MAC = /^(0a:00:27|08:00:27|00:50:56|00:0c:29|00:05:69|00:15:5d|00:ff:)/i

function addresses(port: number): RemoteAddress[] {
  const lan: RemoteAddress[] = []
  const ts: RemoteAddress[] = []
  for (const [nic, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) {
        continue
      }
      if (isTailscaleIp(a.address)) {
        ts.push({ kind: 'tailscale', url: `http://${a.address}:${port}` })
      } else if (VIRTUAL_NIC.test(nic) || VIRTUAL_MAC.test(a.mac)) {
        continue
      } else {
        lan.push({ kind: 'lan', url: `http://${a.address}:${port}` })
      }
    }
  }
  if (ts.length > 0 && tailscaleName) {
    ts.unshift({ kind: 'tailscale', url: `http://${tailscaleName}:${port}` })
  }
  return [...lan, ...ts]
}

// ─── 推送 ─────────────────────────────
function send(c: Client, msg: ServerMsg): void {
  if (c.ws.readyState === c.ws.OPEN) {
    c.ws.send(JSON.stringify(msg))
  }
}

function authed(): Client[] {
  return [...clients].filter((c) => c.deviceId)
}

function brief(): RemoteBrief {
  const online = new Set(authed().map((c) => c.deviceId))
  return { enabled: loadRemoteConfig().enabled, online: online.size }
}

/** 在线设备数或设备列表变了，通知桌面（状态栏、设置页） */
function notifyDesktop(): void {
  sendToMain('remote:brief', brief())
}

export function findTab(tabId: string): RemoteTab | null {
  for (const g of groups) {
    const t = g.tabs.find((x) => x.id === tabId)
    if (t) {
      return t
    }
  }
  return null
}

/** 给智能体标签页补上最后一条消息的摘要和时间 */
function enrich(): RemoteGroup[] {
  const alive = new Set<string>()
  const out = groups.map((g) => ({
    ...g,
    tabs: g.tabs.map((t) => {
      alive.add(t.id)
      if (!t.agent) {
        return t
      }
      const { preview, at } = previewOf(t)
      return { ...t, preview, at }
    })
  }))
  prunePreviews(alive)
  return out
}

/** 重新补摘要，有变化才发给手机 */
function broadcastTabs(tabsChanged: boolean): void {
  if (authed().length === 0) {
    return
  }
  const next = enrich()
  const json = JSON.stringify(next)
  if (json === JSON.stringify(sent) && !tabsChanged) {
    return
  }
  sent = next
  for (const c of authed()) {
    send(c, { t: 'tabs', groups: sent })
    if (tabsChanged) {
      c.chat?.onTabsChanged()
    }
  }
}

/** 有手机在线时才轮询摘要 */
function syncPreviewTimer(): void {
  const want = authed().length > 0
  if (want && !previewTimer) {
    previewTimer = setInterval(() => broadcastTabs(false), PREVIEW_MS)
  } else if (!want && previewTimer) {
    clearInterval(previewTimer)
    previewTimer = null
  } else {
  }
}

/** 桌面渲染层推来的标签页列表；有变化才转发给手机 */
export function setRemoteTabs(next: RemoteGroup[]): void {
  const json = JSON.stringify(next)
  if (json === groupsJson) {
    return
  }
  groups = next
  groupsJson = json
  broadcastTabs(true)
}

function look(): RemoteLook {
  const s = loadSettings()
  return { app: s.appTheme, term: s.terminal.theme }
}

/** 桌面改了设置：外观变了就通知手机 */
export function remoteSettingsChanged(): void {
  for (const c of authed()) {
    send(c, { t: 'look', look: look() })
  }
}

/** 屏幕快照推给订阅了该标签页的手机 */
export function pushScreen(tabId: string, lines: string[]): void {
  for (const c of authed()) {
    if (c.screenTab === tabId) {
      send(c, { t: 'screen', tabId, lines })
    }
  }
}

// 屏幕快照节流：pty 有输出后最多每 SCREEN_MS 向桌面要一次
const SCREEN_MS = 300
const screenTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** pty 有输出：若有手机订阅了这个标签页的屏幕，节流后向桌面要一份快照 */
export function remotePtyData(ptyId: number): void {
  if (clients.size === 0) {
    return
  }
  for (const c of authed()) {
    const tabId = c.screenTab
    if (!tabId || findTab(tabId)?.ptyId !== ptyId || screenTimers.has(tabId)) {
      continue
    }
    screenTimers.set(
      tabId,
      setTimeout(() => {
        screenTimers.delete(tabId)
        sendToMain('remote:screen-req', { tabId })
      }, SCREEN_MS)
    )
  }
}

/** 手机打开了一个还没起终端的标签页（启动后桌面没点开过）：让桌面把它拉起来 */
function wake(tab: RemoteTab): void {
  if (tab.ptyId == null) {
    sendToMain('remote:wake', { tabId: tab.id })
  }
}

// ─── 连接 ─────────────────────────────
function onReady(c: Client, deviceId: string): void {
  c.deviceId = deviceId
  touchDevice(deviceId)
  send(c, { t: 'ready', lang: loadSettings().language, host: hostname(), look: look() })
  sent = enrich()
  send(c, { t: 'tabs', groups: sent })
  syncPreviewTimer()
  notifyDesktop()
}

function onMessage(c: Client, raw: string): void {
  let msg: ClientMsg
  try {
    msg = JSON.parse(raw) as ClientMsg
  } catch {
    return
  }
  if (!c.deviceId) {
    onAuthMessage(c, msg)
    return
  }
  if (msg.t === 'input') {
    const tab = findTab(msg.tabId)
    if (tab?.ptyId != null && typeof msg.data === 'string') {
      writePty(tab.ptyId, msg.data)
    }
  } else if (msg.t === 'chat.open') {
    const tab = findTab(msg.tabId)
    if (!tab) {
      send(c, { t: 'err', code: 'notab' })
      return
    }
    if (!c.chat || c.chat.tabId !== tab.id) {
      c.chat?.close()
      c.chat = new ChatFeed(tab.id, findTab, (m) => send(c, m))
    }
    c.chat.open(typeof msg.before === 'number' ? msg.before : undefined)
    wake(tab)
  } else if (msg.t === 'resume') {
    if (typeof msg.tabId === 'string' && findTab(msg.tabId)) {
      sendToMain('remote:resume', { tabId: msg.tabId })
    }
  } else if (msg.t === 'chat.close') {
    c.chat?.close()
    c.chat = null
  } else if (msg.t === 'screen.sub') {
    c.screenTab = typeof msg.tabId === 'string' ? msg.tabId : null
    const tab = c.screenTab ? findTab(c.screenTab) : null
    if (tab) {
      sendToMain('remote:screen-req', { tabId: tab.id })
      wake(tab)
    }
  } else {
  }
}

/** 未鉴权时只认配对和令牌两种消息 */
function onAuthMessage(c: Client, msg: ClientMsg): void {
  if ((msg.t === 'pair' || msg.t === 'hello') && msg.v !== REMOTE_PROTOCOL) {
    send(c, { t: 'err', code: 'version' })
    c.ws.close()
    return
  }
  if (msg.t === 'pair') {
    if (!pair || Date.now() > pair.expiresAt || typeof msg.code !== 'string' || msg.code !== pair.code) {
      send(c, { t: 'err', code: 'pair' })
      c.ws.close()
      return
    }
    // 配对码一次有效
    pair = null
    const { device, token } = addDevice(typeof msg.name === 'string' ? msg.name : '')
    send(c, { t: 'paired', token })
    onReady(c, device.id)
  } else if (msg.t === 'hello') {
    const d = typeof msg.token === 'string' ? deviceByToken(msg.token) : null
    if (!d) {
      send(c, { t: 'err', code: 'auth' })
      c.ws.close()
      return
    }
    onReady(c, d.id)
  } else {
  }
}

function onConnection(ws: WebSocket): void {
  const c: Client = { ws, deviceId: null, chat: null, screenTab: null }
  clients.add(c)
  const timer = setTimeout(() => {
    if (!c.deviceId) {
      ws.close()
    }
  }, AUTH_TIMEOUT_MS)
  ws.on('message', (data) => onMessage(c, data.toString()))
  ws.on('close', () => {
    clearTimeout(timer)
    c.chat?.close()
    clients.delete(c)
    if (c.deviceId) {
      touchDevice(c.deviceId)
      notifyDesktop()
    }
    syncPreviewTimer()
  })
  ws.on('error', () => ws.terminate())
}

// ─── 启停 ─────────────────────────────
function stop(): void {
  for (const c of clients) {
    c.chat?.close()
    c.ws.terminate()
  }
  clients.clear()
  syncPreviewTimer()
  wss?.close()
  wss = null
  server?.close()
  server = null
  listenPort = 0
}

function start(port: number): void {
  listenError = null
  const srv = createServer(serveStatic)
  const ws = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  ws.on('connection', onConnection)
  srv.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/ws') {
      socket.destroy()
      return
    }
    ws.handleUpgrade(req, socket, head, (s) => ws.emit('connection', s, req))
  })
  srv.on('error', (e: NodeJS.ErrnoException) => {
    listenError = e.code ?? e.message
    stop()
    notifyDesktop()
  })
  srv.listen(port, '0.0.0.0', () => {
    listenPort = port
    notifyDesktop()
  })
  server = srv
  wss = ws
  refreshTailscaleName()
}

/** 按配置启动或停止服务；配置变化后调用 */
export function applyRemote(): void {
  const cfg = loadRemoteConfig()
  if (!cfg.enabled) {
    stop()
    pair = null
    notifyDesktop()
    return
  }
  if (server && listenPort === cfg.port) {
    return
  }
  stop()
  start(cfg.port)
}

export function stopRemote(): void {
  stop()
}

// ─── 设置页 ─────────────────────────────
function freshPair(): { code: string; expiresAt: number } {
  if (!pair || Date.now() > pair.expiresAt) {
    pair = { code: randomBytes(24).toString('base64url'), expiresAt: Date.now() + PAIR_TTL_MS }
  }
  return pair
}

/** 设置页取信息；base 为用户选中的地址，二维码按它生成 */
export async function remoteInfo(base?: string): Promise<RemoteInfo> {
  const cfg = loadRemoteConfig()
  const online = new Set(authed().map((c) => c.deviceId))
  const devices = cfg.devices.map((d) => ({
    id: d.id,
    name: d.name,
    createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt,
    online: online.has(d.id)
  }))
  const listening = !!server && listenPort === cfg.port
  const addrs = listening ? addresses(cfg.port) : []
  let pairUrl: string | null = null
  let pairSvg: string | null = null
  let pairExpiresAt: number | null = null
  if (listening && addrs.length > 0) {
    const p = freshPair()
    const host = addrs.find((a) => a.url === base)?.url ?? addrs[0].url
    pairUrl = `${host}/#pair=${p.code}`
    pairSvg = await QRCode.toString(pairUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
    pairExpiresAt = p.expiresAt
  }
  return {
    enabled: cfg.enabled,
    port: cfg.port,
    listening,
    error: listenError,
    addresses: addrs,
    pairUrl,
    pairSvg,
    pairExpiresAt,
    devices
  }
}

export function remoteBrief(): RemoteBrief {
  return brief()
}

export function setRemoteEnabled(on: boolean): void {
  saveRemoteConfig({ ...loadRemoteConfig(), enabled: on })
  applyRemote()
}

export function setRemotePort(port: unknown): void {
  saveRemoteConfig({ ...loadRemoteConfig(), port: normPort(port) })
  applyRemote()
}

/** 作废当前配对码，下次取信息时生成新的 */
export function regenPair(): void {
  pair = null
}

/** 吊销设备并断开它的连接 */
export function revokeDevice(id: string): void {
  removeDevice(id)
  for (const c of clients) {
    if (c.deviceId === id) {
      send(c, { t: 'err', code: 'revoked' })
      c.ws.close()
    }
  }
  notifyDesktop()
}
