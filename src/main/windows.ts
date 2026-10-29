// 主窗口引用：供其它主进程模块拿主窗口做 IPC 推送
import type { BrowserWindow, WebContents } from 'electron'

let getMainWindow: () => BrowserWindow | null = () => null

export function setMainWindowGetter(fn: () => BrowserWindow | null): void {
  getMainWindow = fn
}

export function mainWindow(): BrowserWindow | null {
  return getMainWindow()
}

// 主窗口仍存活时返回其 webContents，否则 null
export function mainWc(): WebContents | null {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) {
    return null
  }
  const wc = win.webContents
  return wc && !wc.isDestroyed() ? wc : null
}

// 向主窗口推送；窗口已销毁时静默丢弃
export function sendToMain(channel: string, payload: unknown): void {
  const wc = mainWc()
  if (!wc) {
    return
  }
  try {
    wc.send(channel, payload)
  } catch {}
}
