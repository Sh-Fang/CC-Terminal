// 终端底部余量与滚动条：.xterm-viewport 背景透明，透出 .term-host 的主题背景色；
// 滚动条滑块三种状态的颜色由主题前景色加透明度得到（src/renderer/src/themes.ts themeForPreset）
import { test, expect } from './helpers/app'
import { freshDir } from './helpers/paths'
import { buildStore } from './helpers/store-fixture'
import { termHost, waitShellPrompt } from './helpers/ui'

// 各主题的前景色与背景色（与 themes.ts 一致）；改主题配色时同步改这里
const THEMES = [
  { name: 'one-dark', fg: '#abb2bf', bg: 'rgb(40, 44, 52)' },
  { name: 'vercel-dark', fg: '#ededed', bg: 'rgb(0, 0, 0)' }
]

for (const th of THEMES) {
  test(`${th.name}：底部余量透出主题背景，滚动条滑块颜色跟随前景色`, async ({ launch }) => {
    const h = await launch({
      settings: { statusDowngradeSec: 0, terminal: { theme: th.name } },
      store: buildStore({ groups: [{ id: 'g_th', name: 'Theme', cwd: freshDir('cwd'), tabs: [{ id: 't_th', name: 'T' }] }] })
    })
    const { page } = h
    await waitShellPrompt(page, 't_th')
    const host = termHost(page, 't_th')

    const bg = await host.evaluate((el) => {
      const vp = el.querySelector('.xterm .xterm-viewport') as HTMLElement
      return { host: getComputedStyle(el).backgroundColor, viewport: getComputedStyle(vp).backgroundColor }
    })
    expect(bg.viewport).toBe('rgba(0, 0, 0, 0)')
    expect(bg.host).toBe(th.bg)

    // 终端底边往上 1px 处（行数取整留下的余量里）看到的是透明的 viewport，下面一层是主题背景
    const hit = await host.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const stack = document.elementsFromPoint(r.left + r.width / 2, r.bottom - 1)
      const firstOpaque = stack.find((x) => getComputedStyle(x).backgroundColor !== 'rgba(0, 0, 0, 0)')
      return firstOpaque === el || (firstOpaque as HTMLElement | undefined)?.classList.contains('xterm-scrollable-element')
        ? getComputedStyle(firstOpaque!).backgroundColor
        : `命中了 ${firstOpaque?.className ?? '无'}`
    })
    expect(hit).toBe(th.bg)

    // xterm 按主题生成的滚动条滑块样式：常态 / 悬停 / 拖动
    const css = await page.evaluate(() =>
      [...document.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n')
    )
    const fg = th.fg.toLowerCase()
    for (const alpha of ['33', '59', '80']) {
      expect(css.toLowerCase(), `滑块颜色 ${fg}${alpha}`).toMatch(new RegExp(`\\.slider[^{]*\\{[^}]*${fg}${alpha}`))
    }
  })
}
