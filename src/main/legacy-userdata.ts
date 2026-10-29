import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isIsolated } from './dev-isolate'

// 改名 Claude Terminal → CC Terminal 后 userData 目录随之改名：新目录还没有数据时，从旧目录拷一次。
// 须在其它模块读 userData 前导入；只拷数据文件，hook 脚本等启动时会重新生成
const FILES = ['store.json', 'settings.json', 'claude-accounts.json']

if (!isIsolated) {
  const dir = app.getPath('userData')
  const legacy = join(app.getPath('appData'), app.isPackaged ? 'Claude Terminal' : 'claude-terminal')
  if (!existsSync(join(dir, 'store.json')) && existsSync(join(legacy, 'store.json'))) {
    try {
      mkdirSync(dir, { recursive: true })
      for (const f of FILES) {
        if (existsSync(join(legacy, f))) {
          copyFileSync(join(legacy, f), join(dir, f))
        }
      }
    } catch {}
  }
}
