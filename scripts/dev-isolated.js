// 隔离启动：独立 userData + 远程调试端口 + 窗口放屏幕外，不影响正在运行的实例
const { spawn } = require('node:child_process')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const env = {
  ...process.env,
  TERMINAL_ISOLATE_DIR: process.env.TERMINAL_ISOLATE_DIR || join(tmpdir(), 'claude-terminal-isolated'),
  TERMINAL_DEBUG_PORT: process.env.TERMINAL_DEBUG_PORT || '9333'
}

console.log(`userData=${env.TERMINAL_ISOLATE_DIR} debugPort=${env.TERMINAL_DEBUG_PORT}`)
const child = spawn('npx', ['electron-vite', 'preview'], { env, stdio: 'inherit', shell: true })
child.on('exit', (code) => {
  process.exit(code ?? 0)
})
