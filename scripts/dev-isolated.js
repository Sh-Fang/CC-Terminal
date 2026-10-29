// 隔离启动：独立 userData + 远程调试端口 + 透明不可交互窗口，不影响正在运行的实例
const { spawn } = require('node:child_process')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const env = {
  ...process.env,
  TERMINAL_ISOLATE_DIR: process.env.TERMINAL_ISOLATE_DIR || join(tmpdir(), 'cc-terminal-isolated'),
  TERMINAL_DEBUG_PORT: process.env.TERMINAL_DEBUG_PORT || '9333'
}
// 从 Claude Code 会话里启动时，去掉继承来的 cc 会话标记，否则实例内的 cc 会关闭对话记录保存
for (const k of Object.keys(env)) {
  if (['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT'].includes(k) || k.startsWith('CLAUDE_CODE_')) {
    delete env[k]
  }
}

console.log(`userData=${env.TERMINAL_ISOLATE_DIR} debugPort=${env.TERMINAL_DEBUG_PORT}`)
const child = spawn('npx', ['electron-vite', 'preview'], { env, stdio: 'inherit', shell: true })
child.on('exit', (code) => {
  process.exit(code ?? 0)
})
