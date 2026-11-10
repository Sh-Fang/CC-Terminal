// 应用启动时继承的 PATH 是旧的（启动后才装 Node）：检测 claude、npm 与钩子用的 node 要按注册表当前的 PATH 找
import { readFileSync } from 'fs'
import { join } from 'path'
import { test, expect } from './helpers/app'
import { freshDir } from './helpers/paths'
import { buildStore } from './helpers/store-fixture'
import { waitShellPrompt } from './helpers/ui'

test('启动时 PATH 里没有 Node，仍能按注册表 PATH 找到 claude、npm 和 node', async ({ launch }) => {
  test.skip(process.platform !== 'win32', '只校验 Windows')
  // 只留系统目录，模拟 Node 装在应用启动之后
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'Path'
  const sysRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const stalePath = [join(sysRoot, 'System32'), sysRoot, join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(';')

  const cwd = freshDir('cwd')
  const h = await launch({
    store: buildStore({ groups: [{ id: 'g_path', name: 'Path', cwd, tabs: [{ id: 't_path', name: 'Path' }] }] }),
    settings: { claudePath: '' },
    env: { [pathKey]: stalePath }
  })
  await waitShellPrompt(h.page, 't_path')

  const available = await h.page.evaluate(() => window.term.agentAvailable('claude'))
  expect(available).toBe(true)

  // 拉远端版本可能因网络失败，但不能是找不到 npm
  const remote = await h.page.evaluate(() => window.term.verListRemote('claude'))
  expect(remote.error ?? '').not.toContain('未找到 npm')

  // 钩子用的 node 是绝对路径
  const settings = JSON.parse(readFileSync(join(h.userData, 'cc-hooks.json'), 'utf8'))
  const command = settings.hooks.Stop[0].hooks[0].command as string
  expect(command).toMatch(/node\.exe$/i)
})
