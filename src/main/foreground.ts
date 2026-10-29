// 前台程序识别：按进程树找出每个 PTY 的 shell 底下此刻在跑什么，变化时推给渲染层。
// Windows 用 koffi 调 Toolhelp32 枚举进程、NtQueryInformationProcess 读命令行；
// 类 Unix 用 ps 取 shell 所在终端的前台进程组。
import { execFile } from 'node:child_process'
import type { ForegroundInfo, ForegroundProgram } from '../shared/foreground'

const IS_WIN = process.platform === 'win32'
// 兜底轮询间隔；PTY 有输出时另按防抖提前查一次
const POLL_MS = 1500
const DEBOUNCE_MS = 300

interface Proc {
  pid: number
  ppid: number
  name: string
}

// 智能体登记表：按 exe 名或命令行认程序，后续加 Codex 等在这里加一项
interface AgentEntry {
  program: ForegroundProgram
  exe?: RegExp
  cmdline?: RegExp
}
const AGENTS: AgentEntry[] = [
  {
    program: 'claude',
    exe: /^claude(\.exe)?$/i,
    cmdline: /@anthropic-ai[\\/]claude-code|[\\/]claude(\.cmd|\.js)?["'\s]|^claude(\s|$)/i
  },
  {
    program: 'codex',
    exe: /^codex(\.exe)?$/i,
    cmdline: /@openai[\\/]codex|[\\/]codex(\.js)?(["'\s]|$)|^codex(\s|$)/i
  }
]

function matchAgent(name: string, cmdline: () => string): ForegroundProgram | null {
  for (const a of AGENTS) {
    if (a.exe?.test(name)) {
      return a.program
    }
    // 只有 node 这类解释器才读命令行，省掉多余的系统调用
    if (a.cmdline && /^node(\.exe)?$/i.test(name) && a.cmdline.test(cmdline())) {
      return a.program
    }
  }
  return null
}

// ─── Windows：koffi 直接调系统接口 ─────────────────────────────
interface WinApi {
  list: () => Proc[]
  cmdline: (pid: number) => string
}
let winApi: WinApi | null = null

function loadWinApi(): WinApi {
  if (winApi) {
    return winApi
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi = require('koffi') as typeof import('koffi')
  const k32 = koffi.load('kernel32.dll')
  const ntdll = koffi.load('ntdll.dll')
  const PE = koffi.struct('PROCESSENTRY32W', {
    dwSize: 'uint32_t',
    cntUsage: 'uint32_t',
    th32ProcessID: 'uint32_t',
    th32DefaultHeapID: 'uintptr_t',
    th32ModuleID: 'uint32_t',
    cntThreads: 'uint32_t',
    th32ParentProcessID: 'uint32_t',
    pcPriClassBase: 'int32_t',
    dwFlags: 'uint32_t',
    szExeFile: koffi.array('char16_t', 260, 'String')
  })
  const snapshot = k32.func('void * __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)')
  const first = k32.func('bool __stdcall Process32FirstW(void *h, _Inout_ PROCESSENTRY32W *pe)')
  const next = k32.func('bool __stdcall Process32NextW(void *h, _Inout_ PROCESSENTRY32W *pe)')
  const close = k32.func('bool __stdcall CloseHandle(void *h)')
  const open = k32.func('void * __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)')
  const query = ntdll.func(
    'int32_t __stdcall NtQueryInformationProcess(void *h, int cls, _Out_ uint8_t *buf, uint32_t len, _Out_ uint32_t *ret)'
  )
  const TH32CS_SNAPPROCESS = 2
  const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
  const ProcessCommandLineInformation = 60
  const peSize = koffi.sizeof(PE)
  const buf = Buffer.alloc(32768)

  winApi = {
    list: () => {
      const out: Proc[] = []
      const h = snapshot(TH32CS_SNAPPROCESS, 0)
      if (!h) {
        return out
      }
      try {
        const pe = { dwSize: peSize } as Record<string, unknown>
        if (first(h, pe)) {
          do {
            out.push({ pid: pe.th32ProcessID as number, ppid: pe.th32ParentProcessID as number, name: pe.szExeFile as string })
          } while (next(h, pe))
        }
      } finally {
        close(h)
      }
      return out
    },
    cmdline: (pid) => {
      const h = open(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
      if (!h) {
        return ''
      }
      try {
        const ret = [0]
        if (query(h, ProcessCommandLineInformation, buf, buf.length, ret) !== 0) {
          return ''
        }
        // 结果是 UNICODE_STRING（Length 占 2 字节，x64 下结构体共 16 字节），字符串紧跟其后
        const len = buf.readUInt16LE(0)
        return buf.toString('utf16le', 16, 16 + len)
      } finally {
        close(h)
      }
    }
  }
  return winApi
}

// 交互式 shell：pwsh 不带 -c/-File、cmd 不带 /c；带了的是一次性包装（如 npm 的 claude.cmd），往下穿透
function winShellKind(p: Proc, cmdline: () => string): ForegroundProgram | null {
  const n = p.name.toLowerCase()
  if (n === 'pwsh.exe' || n === 'powershell.exe') {
    return /\s-(c|command|f|file|encodedcommand)\b/i.test(cmdline()) ? null : 'pwsh'
  }
  if (n === 'cmd.exe') {
    return /\s\/c\b/i.test(cmdline()) ? null : 'cmd'
  }
  return null
}

function resolveWin(shellPid: number, kids: Map<number, Proc[]>, cmdline: (pid: number) => string): ForegroundInfo {
  const childrenOf = (pid: number): Proc[] =>
    (kids.get(pid) ?? []).filter((p) => p.name.toLowerCase() !== 'conhost.exe')

  // 先在子孙里找智能体，找到即止（不往智能体自己的子进程里找）
  const queue = childrenOf(shellPid).map((p) => ({ p, depth: 1 }))
  while (queue.length > 0) {
    const { p, depth } = queue.shift()!
    const agent = matchAgent(p.name, () => cmdline(p.pid))
    if (agent) {
      return { program: agent, atPrompt: false }
    }
    if (depth < 6) {
      queue.push(...childrenOf(p.pid).map((c) => ({ p: c, depth: depth + 1 })))
    }
  }

  // 没有智能体：沿交互式 shell 往下走到最里层，其余程序显示所在 shell
  let pid = shellPid
  let program: ForegroundProgram = 'pwsh'
  for (;;) {
    const cs = childrenOf(pid)
    if (cs.length === 0) {
      return { program, atPrompt: true }
    }
    const shell = cs.map((c) => ({ c, kind: winShellKind(c, () => cmdline(c.pid)) })).find((x) => x.kind)
    if (!shell) {
      return { program, atPrompt: false }
    }
    pid = shell.c.pid
    program = shell.kind!
  }
}

function queryWin(shellPids: Map<number, number>): Map<number, ForegroundInfo> {
  const api = loadWinApi()
  const kids = new Map<number, Proc[]>()
  for (const p of api.list()) {
    const arr = kids.get(p.ppid)
    if (arr) {
      arr.push(p)
    } else {
      kids.set(p.ppid, [p])
    }
  }
  // 同一轮里命令行只读一次
  const cache = new Map<number, string>()
  const cmdline = (pid: number): string => {
    let s = cache.get(pid)
    if (s == null) {
      s = api.cmdline(pid)
      cache.set(pid, s)
    }
    return s
  }
  const out = new Map<number, ForegroundInfo>()
  for (const [id, pid] of shellPids) {
    out.set(id, resolveWin(pid, kids, cmdline))
  }
  return out
}

// ─── 类 Unix：ps 取前台进程组 ─────────────────────────────
function queryUnix(shellPids: Map<number, number>): Promise<Map<number, ForegroundInfo>> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,tpgid=,args='], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const out = new Map<number, ForegroundInfo>()
      if (err) {
        resolve(out)
        return
      }
      const procs = new Map<number, { tpgid: number; args: string }>()
      for (const line of stdout.split('\n')) {
        const m = /^\s*(\d+)\s+(-?\d+)\s+(.*)$/.exec(line)
        if (m) {
          procs.set(Number(m[1]), { tpgid: Number(m[2]), args: m[3] })
        }
      }
      for (const [id, pid] of shellPids) {
        const sh = procs.get(pid)
        // 前台进程组就是 shell 自己 → 停在提示符
        if (!sh || sh.tpgid <= 0 || sh.tpgid === pid) {
          out.set(id, { program: 'sh', atPrompt: true })
          continue
        }
        const fg = procs.get(sh.tpgid)
        const args = fg?.args ?? ''
        const name = args.split(/\s+/)[0]?.split('/').pop() ?? ''
        const agent = matchAgent(name, () => args)
        out.set(id, { program: agent ?? 'sh', atPrompt: false })
      }
      resolve(out)
    })
  })
}

// ─── 调度：防抖 + 兜底轮询，只推变化 ─────────────────────────────
let getShellPids: () => Map<number, number> = () => new Map()
let push: (id: number, info: ForegroundInfo) => void = () => {}
const last = new Map<number, ForegroundInfo>()
let pollTimer: NodeJS.Timeout | null = null
let debounceTimer: NodeJS.Timeout | null = null
let running = false

async function tick(): Promise<void> {
  if (running) {
    return
  }
  running = true
  try {
    const pids = getShellPids()
    for (const id of [...last.keys()]) {
      if (!pids.has(id)) {
        last.delete(id)
      }
    }
    if (pids.size === 0) {
      return
    }
    const res = IS_WIN ? queryWin(pids) : await queryUnix(pids)
    for (const [id, info] of res) {
      const prev = last.get(id)
      if (!prev || prev.program !== info.program || prev.atPrompt !== info.atPrompt) {
        last.set(id, info)
        push(id, info)
      }
    }
  } catch (e) {
    console.error('[foreground] query failed', e)
  } finally {
    running = false
  }
}

export function startForegroundWatch(
  shellPids: () => Map<number, number>,
  onChange: (id: number, info: ForegroundInfo) => void
): void {
  getShellPids = shellPids
  push = onChange
  if (!pollTimer) {
    pollTimer = setInterval(() => void tick(), POLL_MS)
  }
}

// PTY 有输出时调用：输出停下 DEBOUNCE_MS 后查一次
export function pokeForeground(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void tick()
  }, DEBOUNCE_MS)
}

// 渲染层刷新后拉一次当前全部结果
export function currentForeground(): Record<number, ForegroundInfo> {
  return Object.fromEntries(last)
}

export function stopForegroundWatch(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
}
