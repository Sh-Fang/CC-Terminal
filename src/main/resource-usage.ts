// 资源占用采样：按进程树汇总应用自身与各标签页 shell 的 CPU、内存。
// CPU 取两次采样间累计 CPU 时间的差值，换算成占整机的百分比；内存 Windows 取独占工作集，类 Unix 取 RSS。
// Windows 用 koffi 调系统接口；Linux 读 /proc；macOS 用 ps。
import { execFile } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { listWinProcs } from './foreground'
import type { Usage, UsageSample } from '../shared/usage'

interface ProcStat {
  pid: number
  ppid: number
  // 累计 CPU 时间（毫秒）
  cpuMs: number
  // 内存（字节）
  mem: number
}

// 距上次采样超过这个间隔就先补采一次，避免拿长时间的平均值充当当前值
const STALE_MS = 5000
const PRIME_MS = 300

// ─── Windows ─────────────────────────────
interface WinStat {
  // 进程创建时刻（FILETIME，100 纳秒）
  created: number
  cpuMs: number
  mem: number
}
interface WinUsageApi {
  stat: (pid: number) => WinStat | null
}
let winApi: WinUsageApi | null = null

function loadWinApi(): WinUsageApi {
  if (winApi) {
    return winApi
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi = require('koffi') as typeof import('koffi')
  const k32 = koffi.load('kernel32.dll')
  const PMC = koffi.struct('PROCESS_MEMORY_COUNTERS_EX2', {
    cb: 'uint32_t',
    PageFaultCount: 'uint32_t',
    PeakWorkingSetSize: 'size_t',
    WorkingSetSize: 'size_t',
    QuotaPeakPagedPoolUsage: 'size_t',
    QuotaPagedPoolUsage: 'size_t',
    QuotaPeakNonPagedPoolUsage: 'size_t',
    QuotaNonPagedPoolUsage: 'size_t',
    PagefileUsage: 'size_t',
    PeakPagefileUsage: 'size_t',
    PrivateUsage: 'size_t',
    PrivateWorkingSetSize: 'size_t',
    SharedCommitUsage: 'size_t'
  })
  const open = k32.func('void * __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)')
  const close = k32.func('bool __stdcall CloseHandle(void *h)')
  const times = k32.func(
    'bool __stdcall GetProcessTimes(void *h, _Out_ uint64_t *create, _Out_ uint64_t *exit, _Out_ uint64_t *kernel, _Out_ uint64_t *user)'
  )
  const memInfo = k32.func(
    'bool __stdcall K32GetProcessMemoryInfo(void *h, _Out_ PROCESS_MEMORY_COUNTERS_EX2 *pmc, uint32_t cb)'
  )
  const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
  const sizeEx2 = koffi.sizeof(PMC)
  // 旧系统不认 EX2，退回 EX（少末尾两个字段），内存改取工作集
  const sizeEx = sizeEx2 - 2 * koffi.sizeof('size_t')

  winApi = {
    stat: (pid) => {
      const h = open(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
      if (!h) {
        return null
      }
      try {
        const c = [0]
        const e = [0]
        const k = [0]
        const u = [0]
        if (!times(h, c, e, k, u)) {
          return null
        }
        // FILETIME 单位为 100 纳秒
        const cpuMs = (Number(k[0]) + Number(u[0])) / 10000
        const pmc = {} as Record<string, unknown>
        let mem = 0
        if (memInfo(h, pmc, sizeEx2)) {
          // Win10 22H2 之前的系统会接受 EX2 大小但不填末尾字段，读到 0 时改取工作集
          mem = Number(pmc.PrivateWorkingSetSize) || Number(pmc.WorkingSetSize)
        } else if (memInfo(h, pmc, sizeEx)) {
          mem = Number(pmc.WorkingSetSize)
        } else {
        }
        return { created: Number(c[0]), cpuMs, mem }
      } finally {
        close(h)
      }
    }
  }
  return winApi
}

function listWin(): ProcStat[] {
  const out: ProcStat[] = []
  for (const p of listWinProcs()) {
    out.push({ pid: p.pid, ppid: p.ppid, cpuMs: 0, mem: 0 })
  }
  return out
}

// ─── Linux：/proc ─────────────────────────────
function listLinux(): ProcStat[] {
  const out: ProcStat[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) {
      continue
    }
    let raw: string
    try {
      raw = readFileSync(`/proc/${name}/stat`, 'utf8')
    } catch {
      continue
    }
    // 进程名可能含空格和括号，从最后一个 ')' 之后开始按空格切
    const f = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
    // f[1] 父 pid；f[11] / f[12] 用户态 / 内核态时钟滴答（按 100Hz）；f[21] 常驻页数（按 4KB）
    out.push({
      pid: Number(name),
      ppid: Number(f[1]),
      cpuMs: (Number(f[11]) + Number(f[12])) * 10,
      mem: Number(f[21]) * 4096
    })
  }
  return out
}

// ─── macOS：ps ─────────────────────────────
// ps 的 time 列形如 [dd-]hh:mm:ss 或 m:ss.cc
function parsePsTime(s: string): number {
  const [d, rest] = s.includes('-') ? s.split('-') : ['0', s]
  let sec = 0
  for (const part of rest.split(':')) {
    sec = sec * 60 + Number(part)
  }
  return (Number(d) * 86400 + sec) * 1000
}

function listMac(): Promise<ProcStat[]> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,rss=,time='], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const out: ProcStat[] = []
      if (err) {
        resolve(out)
        return
      }
      for (const line of stdout.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/.exec(line)
        if (m) {
          out.push({ pid: Number(m[1]), ppid: Number(m[2]), cpuMs: parsePsTime(m[4]), mem: Number(m[3]) * 1024 })
        }
      }
      resolve(out)
    })
  })
}

// ─── 汇总 ─────────────────────────────
// 上一轮每个进程的累计 CPU 时间，及上一轮的采样时刻
let prevCpu = new Map<number, number>()
let prevAt = 0

async function listProcs(): Promise<ProcStat[]> {
  if (process.platform === 'win32') {
    return listWin()
  }
  if (process.platform === 'linux') {
    return listLinux()
  }
  return listMac()
}

// root 及其子孙；遇到 stop 里的 pid 不往下走；isChild 不认的父子关系跳过
function subtree(
  root: number,
  kids: Map<number, number[]>,
  stop: Set<number>,
  isChild: (parent: number, child: number) => boolean
): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  const queue = [root]
  while (queue.length > 0) {
    const pid = queue.shift()!
    if (seen.has(pid)) {
      continue
    }
    seen.add(pid)
    out.push(pid)
    for (const c of kids.get(pid) ?? []) {
      if (!stop.has(c) && isChild(pid, c)) {
        queue.push(c)
      }
    }
  }
  return out
}

async function sampleOnce(shellPids: Map<number, number>): Promise<UsageSample> {
  const procs = await listProcs()
  const kids = new Map<number, number[]>()
  for (const p of procs) {
    // pid 0 的父进程也是 0，跳过免得自环
    if (p.pid === p.ppid) {
      continue
    }
    const arr = kids.get(p.ppid)
    if (arr) {
      arr.push(p.pid)
    } else {
      kids.set(p.ppid, [p.pid])
    }
  }

  // Windows 的父 pid 在父进程退出后不会更新，pid 被复用时会把无关的老进程认成子进程；
  // 所以 Windows 下逐个读进程信息，只认创建时刻不早于父进程的子进程。类 Unix 父进程退出会过继给 init，不需要
  let isChild = (_parent: number, _child: number): boolean => true
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  if (process.platform === 'win32') {
    const api = loadWinApi()
    const cache = new Map<number, WinStat | null>()
    const statOf = (pid: number): WinStat | null => {
      if (!cache.has(pid)) {
        const st = api.stat(pid)
        cache.set(pid, st)
        const p = byPid.get(pid)
        if (st && p) {
          p.cpuMs = st.cpuMs
          p.mem = st.mem
        }
      }
      return cache.get(pid) ?? null
    }
    isChild = (parent, child) => {
      const a = statOf(parent)
      const b = statOf(child)
      return !!a && !!b && b.created >= a.created
    }
    for (const pid of [process.pid, ...shellPids.values()]) {
      statOf(pid)
    }
  }

  // 应用自身 = 主进程整棵树，但各标签页的 shell 子树切出去单算
  const shells = new Set(shellPids.values())
  const appPids = subtree(process.pid, kids, shells, isChild)
  const ptyPids = new Map<number, number[]>()
  for (const [id, pid] of shellPids) {
    ptyPids.set(id, subtree(pid, kids, new Set(), isChild))
  }

  const now = Date.now()
  const span = (now - prevAt) * cpus().length
  const nextCpu = new Map<number, number>()
  const sum = (pids: number[]): Usage => {
    let cpu = 0
    let mem = 0
    for (const pid of pids) {
      const p = byPid.get(pid)
      if (!p) {
        continue
      }
      nextCpu.set(pid, p.cpuMs)
      mem += p.mem
      const before = prevCpu.get(pid)
      if (before != null && span > 0) {
        cpu += Math.max(0, p.cpuMs - before)
      }
    }
    return { cpu: span > 0 ? Math.min(100, (cpu / span) * 100) : 0, mem }
  }

  const app = sum(appPids)
  const ptys: Record<number, Usage> = {}
  for (const [id, pids] of ptyPids) {
    ptys[id] = sum(pids)
  }
  prevCpu = nextCpu
  prevAt = now
  return { app, ptys }
}

// 渲染层轮询调用；距上次太久（或首次）先补采一次，让 CPU 有一个短区间的差值可算
export async function sampleUsage(shellPids: Map<number, number>): Promise<UsageSample> {
  if (Date.now() - prevAt > STALE_MS) {
    await sampleOnce(shellPids)
    await new Promise((r) => setTimeout(r, PRIME_MS))
  }
  return sampleOnce(shellPids)
}
