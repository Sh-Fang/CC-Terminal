// 每轮结束：删掉工作目录；没有失败用例留下的 userData（ud-*）时整个 run 目录一起删
import { readdirSync, rmSync } from 'node:fs'

export default function globalTeardown(): void {
  const run = process.env.CC_E2E_RUN_DIR
  const work = process.env.CC_E2E_WORK_DIR
  if (!run) {
    return
  }
  if (work) {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
  const left = readdirSync(run).filter((x) => x.startsWith('ud-'))
  if (left.length === 0) {
    rmSync(run, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } else {
    console.log(`[e2e] 保留失败用例的目录：${run}`)
  }
}
