// 基础冒烟：启动无报错、新建终端标签页能起 shell 并回显、关闭标签页 / 关闭分组的确认框
import { test, expect } from './helpers/app'
import { freshDir } from './helpers/paths'
import { buildStore, readStore } from './helpers/store-fixture'
import {
  answerConfirm,
  clickMenu,
  groupHead,
  menuItems,
  openTabMenu,
  readConfirm,
  runInShell,
  tabRow,
  waitScreen,
  waitShellPrompt
} from './helpers/ui'

test('启动后新建终端标签页，shell 能回显命令输出', async ({ launch }) => {
  const cwd = freshDir('cwd')
  const h = await launch({
    store: buildStore({ groups: [{ id: 'g_smoke', name: 'Smoke', cwd, tabs: [{ id: 't_first', name: 'First' }] }] })
  })
  const { page } = h
  await waitShellPrompt(page, 't_first')

  // 分组头上的「+」新建标签页，类型选终端
  await groupHead(page, 'g_smoke').hover()
  await page.locator('[data-addtab="g_smoke"]').click()
  await expect(page.locator('#modal-name')).toBeVisible()
  await page.locator('#modal-name').fill('Echo')
  const kindTerm = page.locator('[data-testid="modal-kind-terminal"]')
  if ((await kindTerm.count()) > 0) {
    await kindTerm.click()
  }
  await page.locator('#modal-ok').click()

  const findEcho = () => readStore(h.userData).tabs.find((x) => x.name === 'Echo' && !x.closedAt)
  await expect.poll(() => findEcho()?.id ?? null).not.toBeNull()
  const rec = findEcho()!
  expect(rec.autoLaunchCC).toBe(false)
  await expect(tabRow(page, rec.id)).toHaveClass(/active/)
  await waitShellPrompt(page, rec.id)
  await runInShell(page, rec.id, 'echo ("e2e-" + (40 + 2))')
  // 输出行只有 e2e-42，命令行本身是 echo (...)
  await waitScreen(page, rec.id, /^e2e-42$/m)
})

test('关闭标签页与关闭分组都先弹确认框', async ({ launch }) => {
  const cwd = freshDir('cwd')
  const h = await launch({
    store: buildStore({
      groups: [
        {
          id: 'g_close',
          name: 'CloseMe',
          cwd,
          tabs: [
            { id: 't_keep', name: 'Keep' },
            { id: 't_drop', name: 'Drop' }
          ]
        }
      ]
    })
  })
  const { page } = h
  await waitShellPrompt(page, 't_keep')

  // 关闭标签页：取消后仍在，确认后从侧栏消失、store 里记下关闭时间
  await openTabMenu(page, 't_drop')
  await clickMenu(page, '关闭标签')
  expect((await readConfirm(page)).title).toBe('关闭标签「Drop」？')
  await answerConfirm(page, false)
  await expect(tabRow(page, 't_drop')).toHaveCount(1)
  await openTabMenu(page, 't_drop')
  await clickMenu(page, '关闭标签')
  await answerConfirm(page, true)
  await expect(tabRow(page, 't_drop')).toHaveCount(0)
  await expect.poll(() => readStore(h.userData).tabs.find((x) => x.id === 't_drop')?.closedAt ?? null).not.toBeNull()

  // 关闭分组：右键分组头
  await groupHead(page, 'g_close').click({ button: 'right' })
  expect(await menuItems(page)).toContain('关闭分组')
  await clickMenu(page, '关闭分组')
  expect((await readConfirm(page)).title).toBe('关闭分组「CloseMe」？')
  await answerConfirm(page, false)
  await expect(groupHead(page, 'g_close')).toHaveCount(1)
  await groupHead(page, 'g_close').click({ button: 'right' })
  await clickMenu(page, '关闭分组')
  await answerConfirm(page, true)
  await expect(groupHead(page, 'g_close')).toHaveCount(0)
  await expect.poll(() => readStore(h.userData).groups.find((x) => x.id === 'g_close')?.closed).toBe(true)
})
