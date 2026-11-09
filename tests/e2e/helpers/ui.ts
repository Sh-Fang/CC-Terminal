// 页面操作与读取：选择器集中在这里，界面结构变了只改这一处
import { expect, type Locator, type Page } from '@playwright/test'
import type { StoreSnapshot } from '../../../src/shared/store-types'

/** 侧栏里的标签页行 */
export function tabRow(page: Page, tabId: string): Locator {
  return page.locator(`#groupList .tab-row[data-t="${tabId}"]`)
}

/** 侧栏标签页行的前台程序图标（挂起时 class 含 fg-suspended，否则含 st-<状态>） */
export function tabIcon(page: Page, tabId: string): Locator {
  return page.locator(`[data-testid="tab-fg-${tabId}"]`)
}

/** 标签页或下一层子标签的前台程序图标 */
export function fgIcon(page: Page, tabId: string): Locator {
  return page.locator(`[data-testid="tab-fg-${tabId}"], [data-testid="child-fg-${tabId}"]`).first()
}

/** 分组头 */
export function groupHead(page: Page, groupId: string): Locator {
  return page.locator(`#groupList .group-head[data-g="${groupId}"]`)
}

/** 标签页的终端宿主元素 */
export function termHost(page: Page, tabId: string): Locator {
  return page.locator(`.term-host[data-tab-id="${tabId}"]`)
}

/** 标签页上的启动画面 */
export function launchScreen(page: Page, tabId: string): Locator {
  return termHost(page, tabId).locator('.launch-screen')
}

/** 当前激活的标签页 id（侧栏里带 active 的行） */
export async function activeTabId(page: Page): Promise<string | null> {
  return page.locator('#groupList .tab-row.active').first().getAttribute('data-t')
}

/** 终端屏幕上当前显示的文字（逐行） */
export async function screenLines(page: Page, tabId: string): Promise<string[]> {
  return termHost(page, tabId)
    .locator('.xterm-rows > div')
    .evaluateAll((rows) => rows.map((r) => (r.textContent ?? '').replace(/\u00a0/g, ' ').trimEnd()))
}

/** 终端屏幕上的全部文字 */
export async function screenText(page: Page, tabId: string): Promise<string> {
  return (await screenLines(page, tabId)).join('\n')
}

/** 等终端屏幕出现匹配的文字 */
export async function waitScreen(page: Page, tabId: string, re: RegExp, timeout = 30_000): Promise<void> {
  await expect.poll(() => screenText(page, tabId), { timeout, message: `等终端 ${tabId} 出现 ${re}` }).toMatch(re)
}

/** 把键盘焦点放进标签页的终端 */
export async function focusTerm(page: Page, tabId: string): Promise<void> {
  await termHost(page, tabId).locator('.xterm-helper-textarea').focus()
}

/** 在 shell 提示符下执行一条命令 */
export async function runInShell(page: Page, tabId: string, cmd: string): Promise<void> {
  await focusTerm(page, tabId)
  await page.keyboard.type(cmd)
  await page.keyboard.press('Enter')
}

/** 等 pwsh 提示符出现 */
export async function waitShellPrompt(page: Page, tabId: string, timeout = 30_000): Promise<void> {
  await waitScreen(page, tabId, process.platform === 'win32' ? /PS [A-Za-z]:\\[^\n]*>/ : /[$%#>] ?$/m, timeout)
}

/** 右键标签页行，返回菜单项文字（不含分隔线） */
export async function openTabMenu(page: Page, tabId: string): Promise<string[]> {
  await tabRow(page, tabId).click({ button: 'right' })
  return menuItems(page)
}

/** 当前打开的右键菜单的项 */
export async function menuItems(page: Page): Promise<string[]> {
  const menu = page.locator('[data-testid="ctx-menu"].open')
  await expect(menu).toBeVisible()
  return menu.locator('.ctx-item').allTextContents()
}

/** 点右键菜单里的某一项 */
export async function clickMenu(page: Page, label: string): Promise<void> {
  await page.locator('[data-testid="ctx-menu"].open .ctx-item', { hasText: label }).first().click()
}

/** 关掉右键菜单：点空白处（不按 Esc，Esc 在挂起的标签页上会取消启动画面） */
export async function dismissMenu(page: Page): Promise<void> {
  await page.evaluate(() => document.body.click())
  await expect(page.locator('[data-testid="ctx-menu"].open')).toHaveCount(0)
}

/** 确认框 */
export function confirmBox(page: Page): Locator {
  return page.locator('#confirmScrim:not([hidden]) .modal-confirm')
}

/** 等确认框出现，返回标题与正文 */
export async function readConfirm(page: Page): Promise<{ title: string; message: string }> {
  const box = confirmBox(page)
  await expect(box).toBeVisible()
  const title = (await box.locator('#cf-title').textContent()) ?? ''
  const msg = box.locator('#cf-msg')
  const message = (await msg.count()) > 0 ? ((await msg.textContent()) ?? '') : ''
  return { title, message }
}

/** 点确认框的确认 / 取消 */
export async function answerConfirm(page: Page, ok: boolean): Promise<void> {
  await confirmBox(page).locator(ok ? '#cf-ok' : '#cf-cancel').click()
  await expect(confirmBox(page)).toHaveCount(0)
}

/** 主进程 store 快照（含不落盘的 running：各标签页此刻在跑的会话） */
export async function storeSnapshot(page: Page): Promise<StoreSnapshot> {
  return page.evaluate(() => (window as unknown as { term: { storeLoad(): Promise<StoreSnapshot> } }).term.storeLoad())
}

/** document.activeElement 的描述：data-testid 或 class */
export async function activeElementInfo(page: Page): Promise<{ testId: string | null; cls: string; hostTabId: string | null }> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    return {
      testId: el?.getAttribute('data-testid') ?? null,
      cls: el?.className ?? '',
      hostTabId: (el?.closest('.term-host') as HTMLElement | null)?.dataset.tabId ?? null
    }
  })
}
