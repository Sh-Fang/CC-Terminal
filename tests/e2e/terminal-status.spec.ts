// 终端标签页的状态点：跑普通命令时显示运行中，命令结束后回到空闲
import { test, expect } from './helpers/app'
import { freshDir } from './helpers/paths'
import { buildStore } from './helpers/store-fixture'
import { runInShell, tabIcon, waitShellPrompt } from './helpers/ui'

test('终端标签页跑命令时状态点为运行中，结束后回到空闲', async ({ launch }) => {
  const cwd = freshDir('cwd')
  const h = await launch({
    store: buildStore({ groups: [{ id: 'g_st', name: 'Status', cwd, tabs: [{ id: 't_st', name: 'Status' }] }] })
  })
  const { page } = h
  await waitShellPrompt(page, 't_st')
  await expect(tabIcon(page, 't_st')).toHaveClass(/st-idle/)

  const cmd = process.platform === 'win32' ? 'Start-Sleep 4' : 'sleep 4'
  await runInShell(page, 't_st', cmd)
  await expect(tabIcon(page, 't_st')).toHaveClass(/st-busy/, { timeout: 3000 })
  await expect(tabIcon(page, 't_st')).toHaveClass(/st-idle/, { timeout: 10_000 })
})
