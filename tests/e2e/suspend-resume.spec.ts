// 挂起 / 恢复：运行中的智能体标签页右键「挂起会话」回到挂起显示、终端清空、claude 结束；
// 再恢复续上同一个会话；回合进行中挂起要先确认
import { test, expect, appDescendants, type AppHandle } from './helpers/app'
import { realSessions, waitClaudeReady } from './helpers/claude'
import { workDir } from './helpers/paths'
import { buildStore, writeStateFile } from './helpers/store-fixture'
import {
  answerConfirm,
  clickMenu,
  launchScreen,
  openTabMenu,
  readConfirm,
  screenText,
  storeSnapshot,
  tabIcon,
  tabRow,
  waitShellPrompt
} from './helpers/ui'

/** 该实例下还在跑的 claude 进程数 */
function claudeProcs(h: AppHandle): number {
  return appDescendants(h).filter((p) => /^claude(\.exe)?$/i.test(p.name)).length
}

/** 当前在 tabId 里运行的会话 */
async function runningOf(h: AppHandle, tabId: string): Promise<string | null> {
  return (await storeSnapshot(h.page)).running[tabId] ?? null
}

/** 断言标签页处于挂起显示 */
async function expectSuspended(h: AppHandle, tabId: string): Promise<void> {
  const { page } = h
  await expect(tabIcon(page, tabId)).toHaveClass(/\bfg-suspended\b/)
  await expect(tabRow(page, tabId).locator('.trow-badge')).toHaveCount(0)
  await expect(launchScreen(page, tabId).locator('.launch-action')).toHaveText('恢复会话')
}

test('挂起后再恢复续上同一个会话，回合进行中挂起先确认', async ({ launch }) => {
  const [sid] = realSessions(1)
  const h = await launch({
    store: buildStore({
      groups: [{ id: 'g_sr', name: 'SR', cwd: workDir(), tabs: [{ id: 't_sr', name: 'Agent', kind: 'claude', stack: [sid] }] }],
      sessions: [{ id: sid }]
    })
  })
  const { page } = h

  // 启动后挂起：主会话的对话记录在，按钮是「恢复会话」
  await expectSuspended(h, 't_sr')
  await launchScreen(page, 't_sr').locator('.launch-action').click()
  await waitClaudeReady(page, 't_sr')
  await expect.poll(() => runningOf(h, 't_sr')).toBe(sid)
  expect(claudeProcs(h)).toBeGreaterThan(0)

  // 空闲时挂起：不弹确认，回到挂起显示，shell 重开、画面清空，claude 结束
  const items = await openTabMenu(page, 't_sr')
  expect(items).toContain('挂起会话')
  await clickMenu(page, '挂起会话')
  await expect(page.locator('#confirmScrim:not([hidden])')).toHaveCount(0)
  await expectSuspended(h, 't_sr')
  await waitShellPrompt(page, 't_sr')
  // 旧画面（claude 的界面）不留在屏上；新 shell 只有提示符和加载 shell 集成脚本的命令
  expect(await screenText(page, 't_sr')).not.toMatch(/Claude Code|❯|Welcome/)
  await expect.poll(() => runningOf(h, 't_sr')).toBeNull()
  await expect.poll(() => claudeProcs(h), { timeout: 15_000 }).toBe(0)

  // 恢复：续上的是同一个会话
  await launchScreen(page, 't_sr').locator('.launch-action').click()
  await waitClaudeReady(page, 't_sr')
  await expect.poll(() => runningOf(h, 't_sr')).toBe(sid)
  expect((await storeSnapshot(page)).tabs.find((x) => x.id === 't_sr')?.stack[0]).toBe(sid)

  // 回合进行中（hook 报 busy）挂起：先弹确认；取消则什么都不变
  writeStateFile(h.userData, 't_sr', { state: 'busy' })
  await expect(tabIcon(page, 't_sr')).toHaveClass(/\bst-busy\b/)
  await openTabMenu(page, 't_sr')
  await clickMenu(page, '挂起会话')
  const cf = await readConfirm(page)
  expect(cf.title).toBe('挂起标签「Agent」？')
  expect(cf.message).toContain('挂起会中断正在进行的回合')
  await answerConfirm(page, false)
  await expect(tabIcon(page, 't_sr')).toHaveClass(/\bst-busy\b/)
  await expect(launchScreen(page, 't_sr')).toHaveCount(0)
  expect(await runningOf(h, 't_sr')).toBe(sid)
  expect(claudeProcs(h)).toBeGreaterThan(0)

  // 确认挂起
  await openTabMenu(page, 't_sr')
  await clickMenu(page, '挂起会话')
  await readConfirm(page)
  await answerConfirm(page, true)
  await expectSuspended(h, 't_sr')
  await expect.poll(() => claudeProcs(h), { timeout: 15_000 }).toBe(0)
})
