// 每轮开始：建本轮 run 目录和智能体工作目录，经环境变量传给 worker
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { e2eRoot } from './paths'

export default function globalSetup(): void {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  const run = join(e2eRoot(), `run-${stamp}-${Math.random().toString(36).slice(2, 6)}`)
  const work = join(run, `work-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(work, { recursive: true })
  process.env.CC_E2E_RUN_DIR = run
  process.env.CC_E2E_WORK_DIR = work
  console.log(`[e2e] run 目录 ${run}`)
}
