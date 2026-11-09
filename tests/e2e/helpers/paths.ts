// 测试用的临时目录：每轮一个 run 目录，下面放各用例的 userData 和智能体工作目录
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** 仓库根目录 */
export const REPO_ROOT = resolve(__dirname, '..', '..', '..')

/** 所有轮次的根目录；CC_E2E_ROOT 可覆盖 */
export function e2eRoot(): string {
  if (process.env.CC_E2E_ROOT) {
    return resolve(process.env.CC_E2E_ROOT)
  }
  // Windows 上放 D:/temp 下，路径里没有空格和中文，cc 的项目目录编码也短
  return process.platform === 'win32' ? resolve('D:/temp/cc-terminal-e2e') : join(tmpdir(), 'cc-terminal-e2e')
}

/** 本轮的 run 目录，由 global-setup 建好后经环境变量传给 worker */
export function runDir(): string {
  const dir = process.env.CC_E2E_RUN_DIR
  if (!dir) {
    throw new Error('CC_E2E_RUN_DIR 未设置：请经 playwright test 运行（global-setup 会创建）')
  }
  return dir
}

/** 本轮智能体用例共用的工作目录（work-<随机>） */
export function workDir(): string {
  const dir = process.env.CC_E2E_WORK_DIR
  if (!dir) {
    throw new Error('CC_E2E_WORK_DIR 未设置')
  }
  return dir
}

/** 在 run 目录下新建一个唯一子目录 */
export function freshDir(prefix: string): string {
  const dir = join(runDir(), `${prefix}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 把本机路径写成旧格式：正斜杠、小写盘符、末尾带分隔符，例如 d:/temp/x/ */
export function legacyPathOf(p: string): string {
  const fwd = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return fwd.replace(/^([A-Za-z]):/, (_m, d: string) => `${d.toLowerCase()}:`) + '/'
}
