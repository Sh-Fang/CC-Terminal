// 远程访问：主进程、桌面渲染层与手机网页共用的数据结构和消息协议
import type { AgentKind } from './store-types'
import type { ForegroundProgram } from './foreground'

export const REMOTE_PROTOCOL = 1
export const REMOTE_DEFAULT_PORT = 6768

export type RemoteStatus = 'busy' | 'attention' | 'done' | 'idle' | 'error'

/** 桌面渲染层推给主进程的一个标签页（含下一层的临时会话） */
export interface RemoteTab {
  id: string
  name: string
  status: RemoteStatus
  // 出错时的说明
  note?: string
  fg: ForegroundProgram
  // 智能体标签页才有；普通终端为 null
  agent: AgentKind | null
  sessionId: string | null
  ptyId: number | null
  // 下一层的临时会话
  child: boolean
  // 以下由主进程补上：最后一条消息的摘要、最后活动时间（毫秒）；普通终端的摘要是屏幕最后一行
  preview?: RemotePreview | null
  at?: number | null
}

/** 首页一行里的摘要：tool 有值时 text 是工具的摘要 */
export interface RemotePreview {
  role: 'user' | 'assistant' | 'term'
  text: string
  tool?: string
}

/** 手机页跟随桌面的外观：应用主题、终端配色方案 */
export interface RemoteLook {
  app: 'light' | 'dark'
  term: 'vscode-dark' | 'vercel-dark' | 'one-dark'
}

export interface RemoteGroup {
  id: string
  name: string
  tabs: RemoteTab[]
}

export interface RemoteDevice {
  id: string
  name: string
  createdAt: string
  lastSeenAt: string
  online: boolean
}

export interface RemoteAddress {
  kind: 'lan' | 'tailscale'
  url: string
}

/** 设置页展示用 */
export interface RemoteInfo {
  enabled: boolean
  port: number
  listening: boolean
  // 监听失败的原因，如端口被占用
  error: string | null
  addresses: RemoteAddress[]
  // 二维码里的配对链接与 SVG；未开启时为空
  pairUrl: string | null
  pairSvg: string | null
  pairExpiresAt: number | null
  devices: RemoteDevice[]
}

/** 状态栏用：是否开启、在线设备数 */
export interface RemoteBrief {
  enabled: boolean
  online: number
}

/** 对话视图里的一条消息 */
export interface ChatMessage {
  id: string
  // notice：会话里别的 agent（子 agent、队友、其他会话）发来的消息，不是用户打的字
  role: 'user' | 'assistant' | 'system' | 'notice'
  // notice 的发送方，取不到时为空
  from?: string
  ts: string
  blocks: ChatBlock[]
}

export type ChatBlock =
  | { type: 'text'; text: string }
  | {
      type: 'tool'
      id: string
      name: string
      // 折叠时显示的一行，如文件路径、命令
      summary: string
      // 编辑类工具的单栏对比：每行以 ' ' / '+' / '-' 开头
      diff?: string[]
      added?: number
      removed?: number
      input?: string
      output?: string
      isError?: boolean
    }

// ─── 手机 → 电脑 ─────────────────────────────
export type ClientMsg =
  | { t: 'pair'; v: number; code: string; name: string }
  | { t: 'hello'; v: number; token: string }
  | { t: 'chat.open'; tabId: string; before?: number }
  | { t: 'chat.close' }
  | { t: 'screen.sub'; tabId: string | null }
  | { t: 'input'; tabId: string; data: string }
  // 智能体没在运行时：恢复会话或重新启动
  | { t: 'resume'; tabId: string }

// ─── 电脑 → 手机 ─────────────────────────────
export type ServerMsg =
  | { t: 'paired'; token: string }
  | { t: 'ready'; lang: 'zh' | 'en'; host: string; look: RemoteLook }
  | { t: 'look'; look: RemoteLook }
  | { t: 'tabs'; groups: RemoteGroup[] }
  | {
      t: 'chat.page'
      tabId: string
      sessionId: string | null
      messages: ChatMessage[]
      // 更早一页的游标；null 表示已到开头
      before: number | null
      // true 表示这是更早的一页，接在已有消息前面
      older: boolean
    }
  | { t: 'chat.append'; tabId: string; messages: ChatMessage[] }
  | { t: 'screen'; tabId: string; lines: string[] }
  | { t: 'err'; code: 'version' | 'pair' | 'auth' | 'revoked' | 'notab' }
