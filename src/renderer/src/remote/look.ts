// 手机页的外观跟随桌面：应用主题挂到 <html data-app-theme>，终端配色给终端镜像用
import { useEffect, useState } from 'react'
import type { RemoteLook } from '../../../shared/remote'

// 上次的外观存在本地，下次打开页面时先用它，避免闪一下浅色
const KEY = 'cc-remote-look'

function initial(): RemoteLook {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as RemoteLook | null
    if (saved && (saved.app === 'light' || saved.app === 'dark')) {
      return saved
    }
  } catch {
    localStorage.removeItem(KEY)
  }
  return { app: 'light', term: 'vscode-dark' }
}

let current = initial()
const subs = new Set<(l: RemoteLook) => void>()

function paint(l: RemoteLook): void {
  if (l.app === 'dark') {
    document.documentElement.dataset.appTheme = 'dark'
  } else {
    delete document.documentElement.dataset.appTheme
  }
}

paint(current)

/** 收到桌面的外观 */
export function applyLook(l: RemoteLook): void {
  current = l
  localStorage.setItem(KEY, JSON.stringify(l))
  paint(l)
  for (const fn of subs) {
    fn(l)
  }
}

export function useLook(): RemoteLook {
  const [l, setL] = useState(current)
  useEffect(() => {
    subs.add(setL)
    return () => {
      subs.delete(setL)
    }
  }, [])
  return l
}
