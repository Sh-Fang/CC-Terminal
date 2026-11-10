// cc 输入框里中英文混输与输入法组字：屏上内容与输入一致，组字框贴在输入位置。
// Win10 系统自带的旧 ConPTY 会把 cc 放好的真实光标挪走、按错的宽度重绘中文，
// 表现为组字框跑到状态栏、已输入的字被覆盖、输入行首被光标挡住
import { test, expect } from './helpers/app'
import { waitClaudeReady } from './helpers/claude'
import { workDir } from './helpers/paths'
import { buildStore } from './helpers/store-fixture'
import { focusTerm, runInShell, waitShellPrompt } from './helpers/ui'

test('cc 输入框中英文混输与输入法组字：内容不错位，组字框在输入行', async ({ launch }) => {
  const h = await launch({
    store: buildStore({ groups: [{ id: 'g_ime', name: 'Ime', cwd: workDir(), tabs: [{ id: 't_ime', name: 'Ime' }] }] })
  })
  const { page } = h
  await waitShellPrompt(page, 't_ime')
  await runInShell(page, 't_ime', 'claude')
  await waitClaudeReady(page, 't_ime')
  await focusTerm(page, 't_ime')

  // 输入行：cc 的提示符 > / ❯ 开头的那一行，返回去掉提示符后的内容与所在行号
  const inputLine = (): Promise<{ text: string; row: number }> =>
    page.evaluate(() => {
      const t = (window as unknown as { __activeTerm: import('@xterm/xterm').Terminal }).__activeTerm
      const b = t.buffer.active
      for (let y = 0; y < t.rows; y++) {
        const s = b.getLine(b.viewportY + y)?.translateToString(true) ?? ''
        const m = /^\s*[>❯]\s?(.*)$/.exec(s)
        if (m) return { text: m[1].trim(), row: y }
      }
      return { text: '', row: -1 }
    })

  await page.keyboard.insertText('测试')
  await expect.poll(async () => (await inputLine()).text).toBe('测试')
  await page.keyboard.insertText('ab')
  await expect.poll(async () => (await inputLine()).text).toBe('测试ab')

  // 改几次窗口大小：旧 ConPTY 在 resize 后整屏重绘，真实光标位置与宽字符宽度就此错乱
  for (const [w, ht] of [[1000, 700], [1300, 850], [900, 650]]) {
    await h.app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setSize(s[0], s[1]), [w, ht])
    await page.waitForTimeout(1200)
  }
  await expect.poll(async () => (await inputLine()).text).toBe('测试ab')

  // 输入法组字中：组字框与输入行在同一行
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 })
  const view = page.locator('.term-host[data-tab-id="t_ime"] .composition-view')
  await expect(view).toBeVisible()
  const { row } = await inputLine()
  const viewRow = await page.evaluate(() => {
    const t = (window as unknown as { __activeTerm: import('@xterm/xterm').Terminal }).__activeTerm
    const screen = t.element!.querySelector('.xterm-screen')!.getBoundingClientRect()
    const v = t.element!.querySelector('.composition-view')!.getBoundingClientRect()
    return Math.floor(((v.top + v.bottom) / 2 - screen.top) / (screen.height / t.rows))
  })
  expect(viewRow, '组字框应在输入行').toBe(row)

  // 提交组字：已输入的内容不被覆盖
  await cdp.send('Input.insertText', { text: '你好' })
  await expect.poll(async () => (await inputLine()).text).toBe('测试ab你好')
})
