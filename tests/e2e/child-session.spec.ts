// 挂起不影响下一层临时会话：栈内会话「在标签页下一层打开」生成子标签；挂起父标签页后子标签仍在、可输入；
// 关闭父标签页时子标签一起关闭
import { test, expect, appDescendants, type AppHandle } from './helpers/app'
import { realSessions, waitClaudeReady } from './helpers/claude'
import { workDir } from './helpers/paths'
import { buildStore } from './helpers/store-fixture'
import {
  answerConfirm,
  clickMenu,
  focusTerm,
  launchScreen,
  menuItems,
  openTabMenu,
  readConfirm,
  storeSnapshot,
  tabIcon,
  termHost,
  waitScreen
} from './helpers/ui'

const CHILD = 't_par__c1'

function claudeProcs(h: AppHandle): number {
  return appDescendants(h).filter((p) => /^claude(\.exe)?$/i.test(p.name)).length
}

test('挂起父标签页后下一层的临时会话仍在可用，关闭父标签页时一起关闭', async ({ launch }) => {
  const [top, second] = realSessions(2)
  const h = await launch({
    store: buildStore({
      groups: [
        {
          id: 'g_par',
          name: 'Parent',
          cwd: workDir(),
          tabs: [{ id: 't_par', name: 'PAgent', kind: 'claude', stack: [top, second] }]
        }
      ],
      sessions: [{ id: top, userTitle: 'e2e-top' }, { id: second, userTitle: 'e2e-second' }]
    })
  })
  const { page } = h
  const childRow = page.locator(`[data-testid="child-row-${CHILD}"]`)

  // 恢复父标签页
  await launchScreen(page, 't_par').locator('.launch-action').click()
  await waitClaudeReady(page, 't_par')

  // 会话下拉里右键非栈顶的会话 →「在标签页下一层打开」
  await page.locator('#sessionSelect').click()
  const item = page.locator(`.sess-item[data-session-id="${second}"]`)
  await expect(item).toBeVisible()
  await item.click({ button: 'right' })
  expect(await menuItems(page)).toContain('在标签页下一层打开')
  await clickMenu(page, '在标签页下一层打开')
  await expect(termHost(page, CHILD)).toHaveCount(1)
  await expect(childRow).toBeVisible()
  await waitClaudeReady(page, CHILD)
  await expect.poll(async () => (await storeSnapshot(page)).running[CHILD] ?? null).toBe(second)

  // 挂起父标签页（此时子标签是当前标签）：子标签不受影响
  const items = await openTabMenu(page, 't_par')
  expect(items).toContain('挂起会话')
  await clickMenu(page, '挂起会话')
  await expect(tabIcon(page, 't_par')).toHaveClass(/\bfg-suspended\b/)
  await expect(childRow).toBeVisible()
  await expect(termHost(page, CHILD)).toHaveCount(1)
  await expect(page.locator(`[data-testid="child-fg-${CHILD}"]`)).toHaveAttribute('data-fg', 'claude')
  expect((await storeSnapshot(page)).running[CHILD]).toBe(second)

  // 子标签可输入：往 claude 输入框敲字（不回车，不产生对话）
  await childRow.click()
  await focusTerm(page, CHILD)
  await page.keyboard.type('e2e-typed-zq')
  await waitScreen(page, CHILD, /e2e-typed-zq/)

  // 关闭父标签页：子标签一起关掉，claude 全部结束
  await openTabMenu(page, 't_par')
  await clickMenu(page, '关闭标签')
  expect((await readConfirm(page)).title).toBe('关闭标签「PAgent」？')
  await answerConfirm(page, true)
  await expect(page.locator('#groupList .tab-row[data-t="t_par"]')).toHaveCount(0)
  await expect(childRow).toHaveCount(0)
  await expect(termHost(page, CHILD)).toHaveCount(0)
  await expect.poll(() => claudeProcs(h), { timeout: 15_000 }).toBe(0)
})
