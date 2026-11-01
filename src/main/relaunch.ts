// 重启应用。Linux 上 app.relaunch 经 Chromium base::LaunchProcess 拉起新进程，默认置 PR_SET_NO_NEW_PRIVS 且不可撤销：
// 新实例里所有 shell 都继承该标志，sudo/pkexec 全部失效。改用 Node spawn（不置该位），
// 由 sh 等当前进程退出后再 exec，避开单实例锁。
import { app } from 'electron'
import { spawn } from 'node:child_process'

export function relaunchApp(): void {
  if (process.platform !== 'linux') {
    app.relaunch()
    return
  }
  const exe = process.env.APPIMAGE || process.execPath
  const script = 'p=$1; shift; while kill -0 "$p" 2>/dev/null; do sleep 0.1; done; exec "$@"'
  spawn('/bin/sh', ['-c', script, 'sh', String(process.pid), exe, ...process.argv.slice(1)], {
    detached: true,
    stdio: 'ignore'
  }).unref()
}
