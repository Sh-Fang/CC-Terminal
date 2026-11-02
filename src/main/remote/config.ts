// 远程访问的持久配置：开关、端口、已配对设备，落在 userData/remote.json。
// 设备令牌只存 sha256，原文只在配对那一刻发给手机。
import { app } from 'electron'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { REMOTE_DEFAULT_PORT } from '../../shared/remote'

/** 一台已配对设备 */
export interface DeviceRec {
  id: string
  name: string
  tokenHash: string
  createdAt: string
  lastSeenAt: string
}

/** 远程访问配置 */
export interface RemoteConfig {
  enabled: boolean
  port: number
  devices: DeviceRec[]
}

const FILE = (): string => join(app.getPath('userData'), 'remote.json')

let cache: RemoteConfig | null = null

/** 校验端口：1024~65535 之外的回到默认 */
export function normPort(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    return REMOTE_DEFAULT_PORT
  }
  return n
}

/** 读配置；坏文件当作未开启 */
export function loadRemoteConfig(): RemoteConfig {
  if (cache) {
    return cache
  }
  let raw: Record<string, unknown> = {}
  try {
    if (existsSync(FILE())) {
      raw = JSON.parse(readFileSync(FILE(), 'utf8')) as Record<string, unknown>
    }
  } catch {
    raw = {}
  }
  const devices: DeviceRec[] = []
  for (const d of Array.isArray(raw.devices) ? raw.devices : []) {
    const o = d as Record<string, unknown>
    if (typeof o?.id === 'string' && typeof o.tokenHash === 'string') {
      devices.push({
        id: o.id,
        name: typeof o.name === 'string' ? o.name : '',
        tokenHash: o.tokenHash,
        createdAt: typeof o.createdAt === 'string' ? o.createdAt : '',
        lastSeenAt: typeof o.lastSeenAt === 'string' ? o.lastSeenAt : ''
      })
    }
  }
  cache = { enabled: raw.enabled === true, port: normPort(raw.port), devices }
  return cache
}

/** 原子写回 */
export function saveRemoteConfig(next: RemoteConfig): void {
  cache = next
  const path = FILE()
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true })
  }
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  renameSync(tmp, path)
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 新增一台设备，返回令牌原文 */
export function addDevice(name: string): { device: DeviceRec; token: string } {
  const token = randomBytes(32).toString('base64url')
  const now = new Date().toISOString()
  const device: DeviceRec = { id: randomUUID(), name: name.slice(0, 80), tokenHash: hashToken(token), createdAt: now, lastSeenAt: now }
  const cfg = loadRemoteConfig()
  saveRemoteConfig({ ...cfg, devices: [...cfg.devices, device] })
  return { device, token }
}

/** 按令牌找设备 */
export function deviceByToken(token: string): DeviceRec | null {
  const h = hashToken(token)
  return loadRemoteConfig().devices.find((d) => d.tokenHash === h) ?? null
}

export function removeDevice(id: string): void {
  const cfg = loadRemoteConfig()
  saveRemoteConfig({ ...cfg, devices: cfg.devices.filter((d) => d.id !== id) })
}

/** 更新最近在线时间 */
export function touchDevice(id: string): void {
  const cfg = loadRemoteConfig()
  saveRemoteConfig({
    ...cfg,
    devices: cfg.devices.map((d) => (d.id === id ? { ...d, lastSeenAt: new Date().toISOString() } : d))
  })
}
