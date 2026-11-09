// 挂起显示与挂起标签页的右键菜单：启动后未恢复的智能体标签页不显示状态、旧状态文件和新事件都不生效；
// 关闭标签页删掉它的状态文件
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './helpers/app'
import { waitClaudeReady } from './helpers/claude'
import { workDir } from './helpers/paths'
import { buildStore, stateDir, writeStateFile } from './helpers/store-fixture'
import {
  answerConfirm,
  clickMenu,
  dismissMenu,
  groupHead,
  launchScreen,
  openTabMenu,
  readConfirm,
  tabIcon,
  tabRow,
  waitShellPrompt
} from './helpers/ui'

// 智能体分组：当前标签 A 与非当前标签 B 都是挂起的智能体标签页；对照用的终端标签页放在另一个分组，免得分组状态点互相干扰
function suspendedStore() {
  return buildStore({
    groups: [
      {
        id: 'g_agent',
        name: 'Agents',
        cwd: workDir(),
        tabs: [
          { id: 't_agA', name: 'AgentA', kind: 'claude' },
          { id: 't_agB', name: 'AgentB', kind: 'claude' }
        ]
      },
      { id: 'g_term', name: 'Terms', cwd: workDir(), tabs: [{ id: 't_term', name: 'Term' }] }
    ],
    activeTabId: 't_agA'
  })
}

const NO_SUSPENDED_ITEMS = ['启动智能体', '标记为待查看', '标记为已查看', '重新加载标签页']

test('挂起的智能体标签页不显示状态，旧状态文件与新事件都不生效，终端标签页照常显示', async ({ launch }) => {
  const h = await launch({
    store: suspendedStore(),
    stateFiles: {
      t_agA: { state: 'done' },
      t_agB: { state: 'error', errorKind: 'server_error' }
    }
  })
  const { page } = h

  for (const id of ['t_agA', 't_agB']) {
    await expect(tabIcon(page, id)).toHaveClass(/\bfg-suspended\b/)
    await expect(tabIcon(page, id)).not.toHaveClass(/\bst-/)
    await expect(tabRow(page, id).locator('.trow-badge')).toHaveCount(0)
  }
  await expect(page.locator('.status-pill')).toHaveCount(0)
  await expect(page.locator('.grp-st')).toHaveCount(0)
  // 当前标签停在启动画面等用户点按钮
  await expect(launchScreen(page, 't_agA').locator('.launch-action')).toBeVisible()
  // 启动恢复时清掉了挂起标签页上次运行留下的状态文件
  await expect.poll(() => existsSync(join(stateDir(h.userData), 't_agA.json'))).toBe(false)
  await expect.poll(() => existsSync(join(stateDir(h.userData), 't_agB.json'))).toBe(false)

  // 之后 hook 再写新状态，挂起的标签页也不显示；终端标签页的状态正常显示，证明监听在工作
  writeStateFile(h.userData, 't_agA', { state: 'done' })
  writeStateFile(h.userData, 't_agB', { state: 'busy' })
  writeStateFile(h.userData, 't_term', { state: 'done' })
  await expect(tabRow(page, 't_term').locator('.trow-badge.bs-done')).toBeVisible()
  await expect(tabIcon(page, 't_term')).toHaveClass(/\bst-done\b/)
  for (const id of ['t_agA', 't_agB']) {
    await expect(tabIcon(page, id)).toHaveClass(/\bfg-suspended\b/)
    await expect(tabRow(page, id).locator('.trow-badge')).toHaveCount(0)
  }
  await expect(groupHead(page, 'g_agent').locator('.grp-st')).toHaveCount(0)
  await expect(groupHead(page, 'g_term').locator('.grp-st')).toHaveCount(1)
  await expect(page.locator('.status-pill')).toHaveCount(0)
})

test('挂起标签页的右键菜单只有「恢复会话」这类操作，点恢复后 claude 运行', async ({ launch }) => {
  const h = await launch({ store: suspendedStore() })
  const { page } = h
  await expect(tabIcon(page, 't_agB')).toHaveClass(/\bfg-suspended\b/)

  // 当前的挂起标签与非当前的挂起标签菜单一致
  for (const id of ['t_agA', 't_agB']) {
    const items = await openTabMenu(page, id)
    expect(items).toContain('恢复会话')
    for (const x of NO_SUSPENDED_ITEMS) {
      expect(items, `${id} 的菜单不应有「${x}」`).not.toContain(x)
    }
    await dismissMenu(page)
  }

  // 对非当前的 B 点「恢复会话」：切过去、启动画面撤掉、claude 跑起来
  await openTabMenu(page, 't_agB')
  await clickMenu(page, '恢复会话')
  await expect(tabRow(page, 't_agB')).toHaveClass(/active/)
  await waitClaudeReady(page, 't_agB')
  await expect(launchScreen(page, 't_agB')).toHaveCount(0)
  await expect(tabIcon(page, 't_agB')).not.toHaveClass(/\bfg-suspended\b/)
  await expect(tabIcon(page, 't_agB')).toHaveAttribute('data-fg', 'claude')
  // A 仍挂起
  await expect(tabIcon(page, 't_agA')).toHaveClass(/\bfg-suspended\b/)
})

test('关闭标签页时删掉它的状态文件', async ({ launch }) => {
  const h = await launch({ store: suspendedStore() })
  const { page } = h
  const file = (id: string) => join(stateDir(h.userData), `${id}.json`)

  // 终端标签页：先让它有状态（文件存在、显示待查看），再关闭
  await tabRow(page, 't_term').click()
  await waitShellPrompt(page, 't_term')
  writeStateFile(h.userData, 't_term', { state: 'done' })
  await expect(tabRow(page, 't_term').locator('.trow-badge.bs-done')).toBeVisible()
  await openTabMenu(page, 't_term')
  await clickMenu(page, '关闭标签')
  await answerConfirm(page, true)
  await expect(tabRow(page, 't_term')).toHaveCount(0)
  await expect.poll(() => existsSync(file('t_term'))).toBe(false)

  // 挂起的智能体标签页：hook 留下的文件同样删掉，别的标签页的文件不动
  writeStateFile(h.userData, 't_agB', { state: 'done' })
  writeStateFile(h.userData, 't_agA', { state: 'done' })
  await openTabMenu(page, 't_agB')
  await clickMenu(page, '关闭标签')
  expect((await readConfirm(page)).title).toBe('关闭标签「AgentB」？')
  await answerConfirm(page, true)
  await expect(tabRow(page, 't_agB')).toHaveCount(0)
  await expect.poll(() => existsSync(file('t_agB'))).toBe(false)
  expect(existsSync(file('t_agA'))).toBe(true)
})
