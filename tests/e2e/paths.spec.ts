// 路径统一：新建分组时 d:/x/ 风格的路径存成本机格式（Windows 上 D:\x），盘符根保留 D:\；
// 「在此处打开」遇到 cwd 还是旧格式的已有分组时并进去，不新建分组
import { spawn } from 'node:child_process'
import { parse } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect, cleanEnv } from './helpers/app'
import { REPO_ROOT, freshDir, legacyPathOf } from './helpers/paths'
import { killPidTree } from './helpers/proc'
import { buildStore, readStore } from './helpers/store-fixture'
import { tabRow, waitShellPrompt } from './helpers/ui'

test.skip(process.platform !== 'win32', '路径规范化的断言按 Windows 写')

/** 点「新建分组」，填路径，类型选终端，提交；返回提交前名称框里的值 */
async function newGroupVia(page: Page, cwd: string): Promise<string> {
  await page.locator('#newGroupBtn').click()
  await expect(page.locator('#modal-cwd')).toBeVisible()
  await page.locator('#modal-cwd').fill(cwd)
  const kindTerm = page.locator('[data-testid="modal-kind-terminal"]')
  if ((await kindTerm.count()) > 0) {
    await kindTerm.click()
  }
  const name = await page.locator('#modal-name').inputValue()
  await page.locator('#modal-ok').click()
  await expect(page.locator('#scrim:not([hidden])')).toHaveCount(0)
  return name
}

test('新建分组：旧格式路径存成本机格式，盘符根保留为 D:\\', async ({ launch }) => {
  const dir = freshDir('cwd')
  const h = await launch({ store: buildStore({ groups: [] }) })
  const { page } = h

  // d:/.../cwd-xxx/ → D:\...\cwd-xxx（dir 本身就是 path.resolve 出来的本机格式，盘符大写）
  const legacy = legacyPathOf(dir)
  expect(legacy).toMatch(/^[a-z]:\/.*\/$/)
  const name = await newGroupVia(page, legacy)
  expect(name).toBe(parse(dir).base)
  await expect.poll(() => readStore(h.userData).groups.map((g) => g.cwd)).toContain(dir)
  const g1 = readStore(h.userData).groups.find((g) => g.cwd === dir)!
  await waitShellPrompt(page, g1.tabIds[0])

  // 盘符根：d:/ → D:\，分组名「D 盘」
  const drive = parse(dir).root.slice(0, 1)
  const rootName = await newGroupVia(page, `${drive.toLowerCase()}:/`)
  expect(rootName).toBe(`${drive.toUpperCase()} 盘`)
  await expect.poll(() => readStore(h.userData).groups.map((g) => g.cwd)).toContain(`${drive.toUpperCase()}:\\`)
  const g2 = readStore(h.userData).groups.find((g) => g.cwd === `${drive.toUpperCase()}:\\`)!
  expect(g2.name).toBe(`${drive.toUpperCase()} 盘`)
})

test('在此处打开：并进 cwd 为旧格式路径的已有分组（第二实例参数与 Ctrl+P 路径项两个入口）', async ({ launch }) => {
  const dir = freshDir('cwd')
  const legacy = legacyPathOf(dir)
  const h = await launch({
    // 打开「路径」搜索类别
    settings: { statusDowngradeSec: 0, searchScopes: { group: true, agent: true, terminal: true, path: true } },
    store: buildStore({ groups: [{ id: 'g_old', name: 'Old', cwd: legacy, tabs: [{ id: 't_old', name: 'A' }] }] })
  })
  const { page } = h
  await waitShellPrompt(page, 't_old')
  const oldGroup = () => readStore(h.userData).groups.find((g) => g.id === 'g_old')!

  // 入口一：第二个实例带 --open-here=<本机格式路径> 启动（右键「在此处打开」的链路），它把路径转给主实例后自己退出
  const electronExe = require('electron') as unknown as string
  const second = spawn(electronExe, [REPO_ROOT, `--open-here=${dir}`], {
    cwd: REPO_ROOT,
    env: cleanEnv({ TERMINAL_ISOLATE_DIR: h.userData }),
    stdio: 'ignore',
    windowsHide: true
  })
  const secondExit = new Promise<number | null>((r) => second.once('exit', (code) => r(code)))
  try {
    await expect.poll(() => oldGroup().tabIds.length, { timeout: 30_000 }).toBe(2)
    expect(await Promise.race([secondExit, new Promise((r) => setTimeout(() => r('timeout'), 15_000))])).toBe(0)
  } finally {
    if (second.exitCode == null && second.pid) {
      killPidTree(second.pid)
    }
  }
  expect(readStore(h.userData).groups).toHaveLength(1)
  const viaArg = oldGroup().tabIds[1]
  await expect(tabRow(page, viaArg)).toHaveClass(/active/)
  await waitShellPrompt(page, viaArg)

  // 入口二：Ctrl+P 搜路径，选中旧分组的路径项
  await page.keyboard.press('Control+p')
  const input = page.locator('[data-testid="quick-open-input"]')
  await expect(input).toBeFocused()
  await input.fill(parse(dir).base)
  const pathRow = page.locator('[data-testid="quick-open-list"] [data-testid^="quick-open-row-"]', { hasText: legacy })
  await expect(pathRow).toHaveCount(1)
  await pathRow.click()
  await expect(page.locator('[data-testid="quick-open"]')).toHaveCount(0)
  await expect.poll(() => oldGroup().tabIds.length).toBe(3)
  expect(readStore(h.userData).groups).toHaveLength(1)
  await waitShellPrompt(page, oldGroup().tabIds[2])

  // 旧分组自己的 cwd 不被改写
  expect(oldGroup().cwd).toBe(legacy)
})
