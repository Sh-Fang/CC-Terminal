// 真 claude 相关：在本轮工作目录里造带对话记录的会话、等标签页里的 claude 就绪（新目录首次启动会先问是否信任该目录）
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page } from '@playwright/test'
import { cleanEnv } from './app'
import { runDir, workDir } from './paths'
import { fgIcon, focusTerm, launchScreen, screenText } from './ui'

const TRUST_RE = /trust (this|the files in this) folder/i

/** 会话的对话记录是否已落盘（cc 把它写在 <配置目录>/projects/<编码后的 cwd>/<id>.jsonl） */
export function transcriptExists(sessionId: string): boolean {
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
  if (!existsSync(root)) {
    return false
  }
  return readdirSync(root).some((d) => existsSync(join(root, d, `${sessionId}.jsonl`)))
}

/**
 * 本轮工作目录里带对话记录的会话，按需用 `claude -p` 造（每个会话一轮最短对话，用 haiku 省额度）；
 * 同一轮里多个用例共用，结果缓存在 run 目录的 sessions.json
 */
export function realSessions(count: number): string[] {
  const cache = join(runDir(), 'sessions.json')
  const ids: string[] = existsSync(cache) ? (JSON.parse(readFileSync(cache, 'utf8')) as string[]) : []
  while (ids.length < count) {
    const id = randomUUID()
    execFileSync(
      'claude',
      ['-p', '"Reply with exactly one word: ok"', '--session-id', id, '--model', 'haiku', '--max-turns', '1'],
      {
        cwd: workDir(),
        env: cleanEnv({}),
        encoding: 'utf8',
        timeout: 120_000,
        shell: process.platform === 'win32',
        windowsHide: true
      }
    )
    if (!transcriptExists(id)) {
      throw new Error(`claude -p 跑完后找不到会话 ${id} 的对话记录`)
    }
    ids.push(id)
    writeFileSync(cache, JSON.stringify(ids), 'utf8')
  }
  return ids.slice(0, count)
}

/**
 * 等标签页里的 claude 进入输入框：启动画面已撤、前台程序是 claude、屏上出现输入提示符；
 * 途中出现「是否信任该目录」就选「信任」（默认选中的是「No, exit」）
 */
export async function waitClaudeReady(page: Page, tabId: string, timeout = 90_000): Promise<void> {
  const deadline = Date.now() + timeout
  let last = ''
  while (Date.now() < deadline) {
    last = await screenText(page, tabId)
    const covered = (await launchScreen(page, tabId).count()) > 0
    const fg = await fgIcon(page, tabId).getAttribute('data-fg')
    if (!covered && fg === 'claude' && TRUST_RE.test(last)) {
      // 默认选中的是「No, exit」，往下移到「Yes, I trust this folder」再确认
      await focusTerm(page, tabId)
      await page.keyboard.press('ArrowDown')
      await expect.poll(() => screenText(page, tabId), { timeout: 5_000 }).toMatch(/[❯>]\s*Yes, I trust/)
      await page.keyboard.press('Enter')
      await expect.poll(() => screenText(page, tabId), { timeout: 15_000 }).not.toMatch(TRUST_RE)
      continue
    }
    if (!covered && fg === 'claude' && /^\s*[│|]?\s*[>❯]/m.test(last)) {
      return
    }
    await page.waitForTimeout(300)
  }
  throw new Error(`claude 在 ${tabId} 里没有就绪，屏幕最后的内容：\n${last}`)
}
