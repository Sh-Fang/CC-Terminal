import { app } from 'electron'

// 开发隔离实例：TERMINAL_ISOLATE_DIR 指定独立 userData，单实例锁随之隔离；须在其它模块读 userData 前导入
const isolateDir = process.env.TERMINAL_ISOLATE_DIR
export const isIsolated = !!isolateDir

if (isolateDir) {
  app.setPath('userData', isolateDir)
  const port = process.env.TERMINAL_DEBUG_PORT
  if (port) {
    app.commandLine.appendSwitch('remote-debugging-port', port)
  }
  // 窗口放在屏幕外时避免被判定为遮挡而停止绘制
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
}
