// 进程树核对：只认测试自己启动的 electron 主进程及其后代，按 PID + 创建时间识别，绝不按进程名结束进程
import { execFile, execFileSync } from 'node:child_process'

/** 一个进程的快照 */
export interface ProcInfo {
  pid: number
  ppid: number
  name: string
  // 创建时间（FILETIME），用来排除 PID 被复用的情况
  created: string
}

/** 列出本机全部进程 */
export function listProcesses(): ProcInfo[] {
  if (process.platform !== 'win32') {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,lstart=,comm='], { encoding: 'utf8' })
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const m = /^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/.exec(l)
        return m ? { pid: Number(m[1]), ppid: Number(m[2]), created: m[3], name: m[4] } : null
      })
      .filter((x): x is ProcInfo => x != null)
  }
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_LIST], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  })
  return parsePsList(out)
}

// 每行：PID、PPID、创建时间（FILETIME）、进程名，制表符分隔
const PS_LIST =
  'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CreationDate.ToFileTimeUtc())`t$($_.Name)" }'

function parsePsList(out: string): ProcInfo[] {
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [pid, ppid, created, name] = l.split('\t')
      return { pid: Number(pid), ppid: Number(ppid), created, name }
    })
    .filter((p) => Number.isFinite(p.pid) && /^\d+$/.test(p.created ?? ''))
}

/** root 的全部后代（不含 root 本身） */
export function descendantsOf(root: number, procs: ProcInfo[] = listProcesses()): ProcInfo[] {
  const rootInfo = procs.find((p) => p.pid === root)
  const out: ProcInfo[] = []
  const queue = [root]
  const seen = new Set<number>([root])
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const p of procs) {
      // 子进程一定比父进程晚创建；挡掉 PID 复用后挂到旧 PPID 下的无关进程
      if (p.ppid !== cur || seen.has(p.pid)) {
        continue
      }
      if (process.platform === 'win32' && rootInfo && cur === root && BigInt(p.created) < BigInt(rootInfo.created)) {
        continue
      }
      seen.add(p.pid)
      out.push(p)
      queue.push(p.pid)
    }
  }
  return out
}

/** 快照里还活着（PID 与创建时间都对得上）的进程 */
export function stillAlive(snapshot: ProcInfo[], procs: ProcInfo[] = listProcesses()): ProcInfo[] {
  const now = new Map(procs.map((p) => [p.pid, p]))
  return snapshot.filter((p) => now.get(p.pid)?.created === p.created)
}

/** 按 PID 结束进程树 */
export function killPidTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch {
    // 进程已经不在
  }
}

/** 等快照里的进程全部退出；超时返回仍活着的 */
export async function waitAllExit(snapshot: ProcInfo[], timeoutMs: number): Promise<ProcInfo[]> {
  const deadline = Date.now() + timeoutMs
  let alive = stillAlive(snapshot)
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    alive = stillAlive(snapshot)
  }
  return alive
}

/** 异步版 listProcesses：后台采样时不阻塞测试 */
export function listProcessesAsync(): Promise<ProcInfo[]> {
  if (process.platform !== 'win32') {
    return Promise.resolve(listProcesses())
  }
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', PS_LIST],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, out) => resolve(err ? [] : parsePsList(out))
    )
  })
}

/**
 * 持续记录某个根进程派生过的全部进程。中间一层先退出后，孙进程的 PPID 指向已不存在的进程，
 * 退出时再取一次进程树会漏掉它们（例如 claude 拉起的 MCP 服务），所以运行期间定时采样累积
 */
export class ProcTracker {
  private seen = new Map<number, ProcInfo>()
  private timer: NodeJS.Timeout | null = null
  private stopped = false

  constructor(private root: number) {}

  /** 开始定时采样 */
  start(intervalMs = 2500): void {
    const tick = async (): Promise<void> => {
      if (this.stopped) {
        return
      }
      const procs = await listProcessesAsync()
      if (this.stopped || procs.length === 0) {
        return
      }
      this.sample(procs)
      this.timer = setTimeout(() => void tick(), intervalMs)
    }
    this.timer = setTimeout(() => void tick(), intervalMs)
  }

  /** 停止采样 */
  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
    }
  }

  /** 采样一次：根进程和已记录且仍活着的进程，它们的子进程都记下来 */
  sample(procs: ProcInfo[] = listProcesses()): void {
    const alive = new Map(procs.map((p) => [p.pid, p]))
    const parents = new Map<number, ProcInfo>()
    const rootInfo = alive.get(this.root)
    if (rootInfo) {
      parents.set(this.root, rootInfo)
    }
    for (const p of this.seen.values()) {
      if (alive.get(p.pid)?.created === p.created) {
        parents.set(p.pid, p)
      }
    }
    const queue = [...parents.values()]
    while (queue.length > 0) {
      const parent = queue.shift()!
      for (const p of procs) {
        if (p.ppid !== parent.pid || this.seen.has(p.pid) || p.pid === this.root) {
          continue
        }
        // 子进程不会早于父进程创建；挡掉 PID 复用造成的误认
        if (process.platform === 'win32' && BigInt(p.created) < BigInt(parent.created)) {
          continue
        }
        this.seen.set(p.pid, p)
        queue.push(p)
      }
    }
  }

  /** 记录过的全部进程 */
  all(): ProcInfo[] {
    return [...this.seen.values()]
  }
}
