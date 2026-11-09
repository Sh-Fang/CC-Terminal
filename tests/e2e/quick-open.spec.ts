// Ctrl+P 全局搜索：选中已关闭的标签页会重新打开但弹窗不关、焦点留在搜索框，可连续重新打开；
// Esc 关闭后焦点回到当前终端；选中运行中的标签页照旧关弹窗
import type { Page } from '@playwright/test'
import { test, expect } from './helpers/app'
import { freshDir } from './helpers/paths'
import { buildStore, minutesAgo } from './helpers/store-fixture'
import { activeElementInfo, activeTabId, tabRow, waitShellPrompt } from './helpers/ui'

const quickOpen = (page: Page) => page.locator('[data-testid="quick-open"]')
const quickInput = (page: Page) => page.locator('[data-testid="quick-open-input"]')
const quickRows = (page: Page) => page.locator('[data-testid="quick-open-list"] [data-testid^="quick-open-row-"]')

/** 焦点在搜索框里，并且过一会儿也没有被终端抢走 */
async function expectFocusStaysInSearch(page: Page): Promise<void> {
  await expect.poll(async () => (await activeElementInfo(page)).testId).toBe('quick-open-input')
  // 重新打开的标签页激活时会在下一帧聚焦终端，多等几帧确认焦点没被抢走
  await page.waitForTimeout(800)
  expect((await activeElementInfo(page)).testId).toBe('quick-open-input')
}

test('Ctrl+P 连续重新打开已关闭的标签页，Esc 后焦点回到终端；选中运行中的标签页关闭弹窗', async ({ launch }) => {
  const cwd = freshDir('cwd')
  const h = await launch({
    store: buildStore({
      groups: [
        {
          id: 'g_qo',
          name: 'QO',
          cwd,
          tabs: [
            { id: 't_open', name: 'OpenTerm' },
            { id: 't_c1', name: 'Closed1', closedAt: minutesAgo(10) },
            { id: 't_c2', name: 'Closed2', closedAt: minutesAgo(20) },
            { id: 't_c3', name: 'Closed3', closedAt: minutesAgo(30) }
          ]
        }
      ],
      activeTabId: 't_open'
    })
  })
  const { page } = h
  await waitShellPrompt(page, 't_open')

  await page.keyboard.press('Control+p')
  await expect(quickOpen(page)).toBeVisible()
  await expect(quickInput(page)).toBeFocused()
  // 无关键字时列出已关闭的标签页，最近关闭的在前
  await expect(quickRows(page)).toHaveCount(3)
  await expect(quickRows(page).first()).toContainText('Closed1')

  // 第一次回车：重新打开 Closed1，弹窗不关，焦点留在搜索框，该项从列表移走
  await page.keyboard.press('Enter')
  await expect(tabRow(page, 't_c1')).toHaveCount(1)
  await expect(tabRow(page, 't_c1')).toHaveClass(/active/)
  await expect(quickOpen(page)).toBeVisible()
  await expect(quickRows(page)).toHaveCount(2)
  await expectFocusStaysInSearch(page)

  // 接着再选一个
  await page.keyboard.press('Enter')
  await expect(tabRow(page, 't_c2')).toHaveClass(/active/)
  await expect(quickOpen(page)).toBeVisible()
  await expect(quickRows(page)).toHaveCount(1)
  await expectFocusStaysInSearch(page)

  // Esc 关闭弹窗，焦点回到当前标签页的终端
  await page.keyboard.press('Escape')
  await expect(quickOpen(page)).toHaveCount(0)
  await expect
    .poll(async () => activeElementInfo(page))
    .toMatchObject({ cls: expect.stringContaining('xterm-helper-textarea'), hostTabId: 't_c2' })

  // 选中运行中的标签页：弹窗关闭并切过去，焦点在它的终端
  await page.keyboard.press('Control+p')
  await expect(quickInput(page)).toBeFocused()
  await quickInput(page).fill('OpenTerm')
  await expect(quickRows(page).first()).toContainText('OpenTerm')
  await page.keyboard.press('Enter')
  await expect(quickOpen(page)).toHaveCount(0)
  await expect.poll(() => activeTabId(page)).toBe('t_open')
  await expect
    .poll(async () => activeElementInfo(page))
    .toMatchObject({ cls: expect.stringContaining('xterm-helper-textarea'), hostTabId: 't_open' })
  // 剩下的 Closed3 仍是已关闭
  await expect(tabRow(page, 't_c3')).toHaveCount(0)
})
