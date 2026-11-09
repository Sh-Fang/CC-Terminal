// 启动 / 关闭隔离的应用实例，并把它包成 Playwright fixture：
// 每次启动用全新的临时 userData（TERMINAL_ISOLATE_DIR），窗口透明不打扰；用例结束时退出应用、核对进程树、检查 console 报错
import { _electron, test as base, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StoreData } from '../../../src/shared/store-types'
import { REPO_ROOT, freshDir } from './paths'
import { ProcTracker, descendantsOf, killPidTree, listProcesses, waitAllExit, type ProcInfo } from './proc'
import { writeSettings, writeStateFile, writeStore } from './store-fixture'

/** 启动参数 */
export interface LaunchOptions {
  // 预置 store.json；省略则让应用按空数据启动
  store?: StoreData
  // 预置 settings.json 的字段；默认关掉「查看后自动清除完成标记」，免得状态点被计时器清掉
  settings?: Record<string, unknown>
  // 启动前就放好的状态文件：标签页 id → 文件内容
  stateFiles?: Record<string, Record<string, unknown>>
  // 追加给应用的命令行参数
  args?: string[]
  // 沿用已有的 userData（第二次启动同一份数据时用）
  userData?: string
}

/** 一个运行中的应用实例 */
export interface AppHandle {
  app: ElectronApplication
  page: Page
  userData: string
  pid: number
  // 收集到的 console error 与页面未捕获异常
  errors: string[]
  // 这些模式的报错不算失败（用例自己制造的报错）
  allowedErrors: RegExp[]
  close(): Promise<void>
}

/** 从 Claude Code 里跑测试时继承来的会话标记要去掉，否则实例里的 cc 不保存对话记录 */
export function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) {
      continue
    }
    if (['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT'].includes(k) || k.startsWith('CLAUDE_CODE_')) {
      continue
    }
    // 隔离实例相关的变量全部由这里决定
    if (k.startsWith('TERMINAL_') || k === 'ELECTRON_RENDERER_URL' || k === 'ELECTRON_RUN_AS_NODE') {
      continue
    }
    env[k] = v
  }
  return { ...env, ...extra }
}

const DEFAULT_SETTINGS = { statusDowngradeSec: 0 }

/** 记录退出时没有跟着应用一起结束的进程（随后由测试按 PID 结束） */
const orphanLog: string[] = []

/** 启动一个隔离实例，等到主界面渲染出来 */
export async function launchApp(opts: LaunchOptions = {}): Promise<AppHandle> {
  const userData = opts.userData ?? freshDir('ud')
  if (opts.store) {
    writeStore(userData, opts.store)
  }
  if (!opts.userData || opts.settings) {
    writeSettings(userData, { ...DEFAULT_SETTINGS, ...(opts.settings ?? {}) })
  }
  for (const [tabId, st] of Object.entries(opts.stateFiles ?? {})) {
    writeStateFile(userData, tabId, st)
  }
  const app = await _electron.launch({
    args: [REPO_ROOT, ...(opts.args ?? [])],
    cwd: REPO_ROOT,
    env: cleanEnv({ TERMINAL_ISOLATE_DIR: userData }),
    timeout: 60_000
  })
  const errors: string[] = []
  // context 级监听在窗口创建前就挂上，首屏的报错也收得到
  app.context().on('console', (m) => {
    if (m.type() === 'error') {
      errors.push(`console.error: ${m.text()}`)
    }
  })
  app.context().on('weberror', (e) => errors.push(`pageerror: ${e.error().message}`))
  const pid = app.process().pid!
  const tracker = new ProcTracker(pid)
  tracker.start()
  const page = await app.firstWindow()
  await page.waitForSelector('#groupList', { state: 'attached', timeout: 30_000 })
  let closed = false
  const handle: AppHandle = {
    app,
    page,
    userData,
    pid,
    errors,
    allowedErrors: [],
    close: async () => {
      if (closed) {
        return
      }
      closed = true
      await quitApp(app, pid, tracker)
    }
  }
  return handle
}

/** 退出应用：走「确认关闭」之后的同一条退出路径，再核对进程树，没退干净的按 PID 结束 */
async function quitApp(app: ElectronApplication, pid: number, tracker: ProcTracker): Promise<void> {
  const proc = app.process()
  tracker.stop()
  tracker.sample()
  const tree = tracker.all()
  if (process.env.CC_E2E_DEBUG_PROCS) {
    console.log(`[e2e] 记录到的后代进程：${tree.map((p) => `${p.name}(${p.pid}<-${p.ppid})`).join(' ')}`)
  }
  const exited = new Promise<void>((resolve) => {
    if (proc.exitCode != null) {
      resolve()
      return
    }
    proc.once('exit', () => resolve())
  })
  // 等价于用户在关闭确认框里点了「关闭」：主进程 fastQuit → 自身 SIGKILL，ConPTY 句柄随之关闭
  await app
    .evaluate(({ ipcMain }) => {
      setTimeout(() => ipcMain.emit('window:closeConfirmed'), 0)
    })
    .catch(() => {})
  const ok = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10_000))])
  if (!ok) {
    orphanLog.push(`electron 主进程 ${pid} 10s 内没有退出，已按 PID 结束`)
    killPidTree(pid)
    await exited
  }
  const left = await waitAllExit(tree, 8_000)
  for (const p of left) {
    orphanLog.push(`应用退出 8s 后仍在：${p.name} pid=${p.pid} ppid=${p.ppid}`)
    killPidTree(p.pid)
  }
  const still = await waitAllExit(left, 5_000)
  if (still.length > 0) {
    throw new Error(`进程未能结束：${still.map((p) => `${p.name}(${p.pid})`).join(', ')}`)
  }
}

/** 已启动实例的 fixture：用例里调 launch()，结束时统一退出并检查 */
export const test = base.extend<{ launch: (opts?: LaunchOptions) => Promise<AppHandle> }>({
  launch: async ({}, use, testInfo) => {
    const handles: AppHandle[] = []
    const before = orphanLog.length
    await use(async (opts) => {
      const h = await launchApp(opts)
      handles.push(h)
      return h
    })
    const errors: string[] = []
    for (const h of handles) {
      errors.push(...h.errors.filter((e) => !h.allowedErrors.some((re) => re.test(e))))
      await h.close()
    }
    const orphans = orphanLog.slice(before)
    if (orphans.length > 0) {
      const text = orphans.join('; ')
      testInfo.annotations.push({ type: 'orphan', description: text })
      mkdirSync(testInfo.outputDir, { recursive: true })
      writeFileSync(join(testInfo.outputDir, 'orphans.txt'), text, { flag: 'a' })
      console.log(`[e2e] ${testInfo.title} 退出后残留进程：${text}`)
    }
    // 通过的用例删掉临时 userData，失败的留着排查
    if (testInfo.status === testInfo.expectedStatus) {
      for (const h of handles) {
        rmSync(h.userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
      }
    }
    expect(errors, 'console error / pageerror').toEqual([])
  }
})

export { expect }

/** 当前时刻的完整进程表里，某实例下的后代进程 */
export function appDescendants(h: AppHandle): ProcInfo[] {
  return descendantsOf(h.pid, listProcesses())
}
