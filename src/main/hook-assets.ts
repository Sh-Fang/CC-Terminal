import { app } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export interface HookPaths {
  ccHooksJson: string
  sessionProbeJs: string
  stateProbeJs: string
  eventsDir: string
  stateDir: string
  pwshProfilePs1: string  // Windows: pwsh shell-integration
  zshProfile: string      // macOS: zsh shell-integration
  bashProfile: string     // macOS: bash shell-integration
}

// 解析 node 绝对路径（cc 跑 hook 的 shell 不一定有 PATH）；
// macOS GUI 进程 PATH 极简，需借登录+交互 shell 解析。
function detectNodePath(): string {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('where', ['node'], { encoding: 'utf8', windowsHide: true })
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
      if (out[0]) return out[0]
    } catch {}
    return 'node'
  }
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const lines = execFileSync(shell, ['-lic', 'command -v node'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    // 交互 shell 可能先吐别的内容 → 从末尾找绝对路径行
    const line = lines.reverse().find((l) => l.startsWith('/'))
    if (line) return line
  } catch {}
  return 'node'
}

// SessionStart hook（node）。必须用 node 而非 pwsh：PS 冷启动慢 + 并发 IO 异常会导致
// 非零退出、jsonl 丢行。出错路径全部 swallow + 始终 exit 0，hook 失败不影响 cc 主流程。
const SESSION_PROBE_JS = `// Claude Terminal · SessionStart hook
const fs = require('fs'); const path = require('path');
const dir = process.argv[2];
const tab = process.env.TERMINAL_TAB_ID || '';
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('error', () => {});
process.stdin.on('end', () => {
  try {
    if (!dir || !tab) return;
    if (!raw) return;
    const j = JSON.parse(raw);
    const sid = (j && j.session_id) || '';
    if (!sid) return;
    const row = {
      sessionId: sid,
      cwd: (j && j.cwd) || '',
      source: (j && j.source) || 'startup',
      ts: new Date().toISOString()
    };
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    fs.appendFileSync(path.join(dir, tab + '.jsonl'), JSON.stringify(row) + '\\n', 'utf8');
  } catch (e) {}
});
`

// 状态 hook（node）：state 走 argv[3]，dir 走 argv[2]；先写 .tmp 再 rename 避免 watcher 读到半截 JSON。
const STATE_PROBE_JS = `// Claude Terminal · 状态 hook
const fs = require('fs'); const path = require('path');
const dir = process.argv[2];
const state = process.argv[3] || 'idle';
const tab = process.env.TERMINAL_TAB_ID || '';
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('error', () => {});
process.stdin.on('end', () => {
  try {
    if (!dir || !tab) return;
    let msg = null; let errorKind = null;
    if (raw) {
      try {
        const j = JSON.parse(raw);
        if (j && typeof j.message === 'string') msg = j.message;
        // StopFailure 不带 message：错误文案在 last_assistant_message，错误分类在 error
        else if (j && typeof j.last_assistant_message === 'string') msg = j.last_assistant_message;
        if (j && typeof j.error === 'string') errorKind = j.error;
      } catch (e) {}
    }
    const obj = { state: state, message: msg, errorKind: errorKind, ts: new Date().toISOString() };
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    const out = path.join(dir, tab + '.json');
    const tmp = out + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, out);
  } catch (e) {}
});
`

// pwsh shell-integration：仿 VS Code 输出 OSC 133;A/B/C/D 与 633;E，渲染层据此做非 cc 命令的
// 运行态检测（cc 状态仍由 hooks 主导）。[Console]::Write 直写绕开 pwsh buffering；不改用户 profile。
const PWSH_PROFILE_PS1 = `# Claude Terminal · pwsh shell integration
if ($env:__TERMINAL_SHELL_INTEG -ne '1') {
    $env:__TERMINAL_SHELL_INTEG = '1'
    $Global:__TerminalInFlight = $false

    # 保留原 prompt，包一层：命令结束(D) + 提示开始(A) + 提示结束(B)
    $Global:__TerminalOrigPrompt = $function:prompt
    function Global:prompt {
        $code = 0
        if ($null -ne $LASTEXITCODE) { $code = $LASTEXITCODE }
        elseif (-not $?) { $code = 1 }
        if ($Global:__TerminalInFlight) {
            [Console]::Write("\`e]133;D;$code\`a")
            $Global:__TerminalInFlight = $false
        }
        [Console]::Write("\`e]133;A\`a")
        $out = & $Global:__TerminalOrigPrompt
        [Console]::Write("\`e]133;B\`a")
        return $out
    }

    # 命令开始(C) + 命令行(E) 通过 PSReadLine 的 AddToHistoryHandler 触发。
    # 该 handler 在用户按 Enter、命令进入 history 时被调用，正好在命令实际执行之前。
    # \`n / \`r / ESC 都要清掉，避免破坏 OSC 序列或把控制符注入进 renderer 的 parser。
    # 用 $Global: 保存原 handler：ScriptBlock 默认按运行时 scope 查变量，脚本退出后
    # 局部 $prev 就没了；套 Global 保证 handler 每次调用都能取到。
    try {
        $Global:__TerminalPrevAddHistory = (Get-PSReadLineOption).AddToHistoryHandler
        Set-PSReadLineOption -AddToHistoryHandler {
            param([string]$line)
            if ($line) {
                $esc = $line -replace "\`e", '' -replace "\`n", ' ' -replace "\`r", ''
                [Console]::Write("\`e]633;E;$esc\`a")
                [Console]::Write("\`e]133;C\`a")
                $Global:__TerminalInFlight = $true
            }
            if ($null -ne $Global:__TerminalPrevAddHistory) {
                return & $Global:__TerminalPrevAddHistory $line
            }
            return $true
        }
    } catch {}
}

# cct: 手动启动一次能被 app 接管的 cc 会话。
# - 复用 pty:create 时注入的 env：
#   TERMINAL_TAB_ID / TERMINAL_HOOK_SETTINGS_JSON / TERMINAL_CLAUDE_PATH
# - 无参 → --session-id <新 uuid>：新会话，hook 上报后 app 压栈
# - -r / --resume → --resume：cc 自己弹选择器让用户选历史会话
# - 其余参数原样透传给 claude（可 cct --model xxx 等）
function Global:cct {
    if (-not $env:TERMINAL_TAB_ID) {
        Write-Host "cct: 需要在 Claude Terminal 的 tab 里运行" -ForegroundColor Yellow
        return
    }
    if (-not $env:TERMINAL_HOOK_SETTINGS_JSON -or -not (Test-Path $env:TERMINAL_HOOK_SETTINGS_JSON)) {
        Write-Host "cct: 缺少 cc-hooks.json (TERMINAL_HOOK_SETTINGS_JSON)" -ForegroundColor Red
        return
    }
    $isResume = $false
    $passArgs = @()
    foreach ($a in $args) {
        if ($a -eq '-r' -or $a -eq '--resume') { $isResume = $true; continue }
        $passArgs += $a
    }
    $claudeBin = if ($env:TERMINAL_CLAUDE_PATH) { $env:TERMINAL_CLAUDE_PATH } else { 'claude' }
    $settingsArg = @('--settings', $env:TERMINAL_HOOK_SETTINGS_JSON)
    # app 设置里开了「默认危险模式」→ pty:create 注入 TERMINAL_CC_DANGEROUS=1
    if ($env:TERMINAL_CC_DANGEROUS -eq '1') { $settingsArg += '--dangerously-skip-permissions' }
    if ($isResume) {
        & $claudeBin @settingsArg --resume @passArgs
    } else {
        $sid = [guid]::NewGuid().ToString()
        & $claudeBin @settingsArg --session-id $sid @passArgs
    }
}
`

// cct（POSIX 版，zsh/bash 通用）：手动启动可被 app 接管的 cc 会话，语义与 pwsh 版一致。
const CCT_SH = `cct() {
  if [ -z "$TERMINAL_TAB_ID" ]; then
    printf '%s\\n' "cct: 需要在 Claude Terminal 的 tab 里运行"; return 1
  fi
  if [ -z "$TERMINAL_HOOK_SETTINGS_JSON" ] || [ ! -f "$TERMINAL_HOOK_SETTINGS_JSON" ]; then
    printf '%s\\n' "cct: 缺少 cc-hooks.json (TERMINAL_HOOK_SETTINGS_JSON)"; return 1
  fi
  local is_resume=0
  local pass=()
  local a
  for a in "$@"; do
    if [ "$a" = "-r" ] || [ "$a" = "--resume" ]; then is_resume=1; continue; fi
    pass+=("$a")
  done
  local claude_bin=\${TERMINAL_CLAUDE_PATH:-claude}
  # app 设置里开了「默认危险模式」→ pty:create 注入 TERMINAL_CC_DANGEROUS=1
  local danger=()
  [ "$TERMINAL_CC_DANGEROUS" = "1" ] && danger=(--dangerously-skip-permissions)
  if [ "$is_resume" -eq 1 ]; then
    "$claude_bin" --settings "$TERMINAL_HOOK_SETTINGS_JSON" "\${danger[@]}" --resume "\${pass[@]}"
  else
    local sid
    sid=$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z')
    [ -z "$sid" ] && sid=$(node -e 'console.log(require("crypto").randomUUID())' 2>/dev/null)
    "$claude_bin" --settings "$TERMINAL_HOOK_SETTINGS_JSON" "\${danger[@]}" --session-id "$sid" "\${pass[@]}"
  fi
}
`

// zsh shell-integration：preexec/precmd hook 发同一套 OSC 序列；__TERMINAL_SHELL_INTEG 防重复注入。
const ZSH_PROFILE = `# Claude Terminal · zsh shell integration
if [ -z "$__TERMINAL_SHELL_INTEG" ]; then
  export __TERMINAL_SHELL_INTEG=1
  typeset -g __terminal_in_flight=0
  __terminal_osc() { printf '\\033]%s\\007' "$1"; }
  __terminal_preexec() {
    local cmd=\${1//[$'\\n\\r']/ }
    __terminal_osc "633;E;$cmd"
    __terminal_osc "133;C"
    __terminal_in_flight=1
  }
  __terminal_precmd() {
    local code=$?
    if (( __terminal_in_flight )); then
      __terminal_osc "133;D;$code"
      __terminal_in_flight=0
    fi
    __terminal_osc "133;A"
  }
  autoload -Uz add-zsh-hook 2>/dev/null
  if (( $+functions[add-zsh-hook] )); then
    add-zsh-hook preexec __terminal_preexec
    add-zsh-hook precmd __terminal_precmd
  else
    preexec_functions+=(__terminal_preexec)
    precmd_functions+=(__terminal_precmd)
  fi
fi

${CCT_SH}`

// bash shell-integration：无内建 preexec/precmd，用 DEBUG trap + PROMPT_COMMAND 近似（best-effort）。
const BASH_PROFILE = `# Claude Terminal · bash shell integration (best-effort)
if [ -z "$__TERMINAL_SHELL_INTEG" ] && [[ "$-" == *i* ]]; then
  export __TERMINAL_SHELL_INTEG=1
  __terminal_in_flight=0
  __terminal_preexec_done=0
  __terminal_osc() { printf '\\033]%s\\007' "$1"; }
  __terminal_preexec() {
    __terminal_osc "633;E;$1"
    __terminal_osc "133;C"
    __terminal_in_flight=1
  }
  __terminal_precmd() {
    local code=$1
    if (( __terminal_in_flight )); then
      __terminal_osc "133;D;$code"
      __terminal_in_flight=0
    fi
    __terminal_osc "133;A"
    __terminal_preexec_done=0
  }
  __terminal_debug() {
    [[ "$BASH_COMMAND" == "__terminal_prompt_cmd" ]] && return
    (( __terminal_preexec_done )) && return
    __terminal_preexec_done=1
    __terminal_preexec "$BASH_COMMAND"
  }
  __terminal_orig_pc="$PROMPT_COMMAND"
  __terminal_prompt_cmd() {
    local ec=$?
    if [ -n "$__terminal_orig_pc" ]; then eval "$__terminal_orig_pc"; fi
    __terminal_precmd "$ec"
  }
  PROMPT_COMMAND=__terminal_prompt_cmd
  trap '__terminal_debug' DEBUG
fi

${CCT_SH}`

export function ensureHookAssets(): HookPaths {
  const userData = app.getPath('userData')
  if (!existsSync(userData)) mkdirSync(userData, { recursive: true })

  const eventsDir = join(userData, 'session-events')
  const stateDir = join(userData, 'session-state')
  if (!existsSync(eventsDir)) mkdirSync(eventsDir, { recursive: true })
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })

  const sessionProbeJs = join(userData, 'session-probe.cjs')
  const stateProbeJs = join(userData, 'state-probe.cjs')
  const pwshProfilePs1 = join(userData, 'shell-integration.ps1')
  const zshProfile = join(userData, 'shell-integration.zsh')
  const bashProfile = join(userData, 'shell-integration.bash')
  writeFileSync(sessionProbeJs, SESSION_PROBE_JS, 'utf8')
  writeFileSync(stateProbeJs, STATE_PROBE_JS, 'utf8')
  writeFileSync(pwshProfilePs1, PWSH_PROFILE_PS1, 'utf8')
  writeFileSync(zshProfile, ZSH_PROFILE, 'utf8')
  writeFileSync(bashProfile, BASH_PROFILE, 'utf8')

  const nodePath = detectNodePath()
  const sessionCmd = `"${nodePath}" "${sessionProbeJs}" "${eventsDir}"`
  const stateCmd = (st: string): string =>
    `"${nodePath}" "${stateProbeJs}" "${stateDir}" ${st}`

  const settings = {
    // app 自己管理标签页与会话；cc 的 Agent view 会把会话转到后台进程，丢掉 TERMINAL_TAB_ID 导致状态失联
    disableAgentView: true,
    hooks: {
      SessionStart: [
        { matcher: '', hooks: [{ type: 'command', command: sessionCmd }] }
      ],
      UserPromptSubmit: [
        { matcher: '', hooks: [{ type: 'command', command: stateCmd('busy') }] }
      ],
      Stop: [
        { matcher: '', hooks: [{ type: 'command', command: stateCmd('done') }] }
      ],
      // 本轮因 API 错误结束 → 红点。这是判定 API 出错的唯一可靠信号：cc 内部重试
      // （实测最多 10 次、可长达 3 分钟）全程不发任何 hook，重试成功也不会发本事件，
      // 所以挂上它之后，重试中间态不再被误判成错误（那是 terminal-tab 扫文本的老毛病）。
      // stdin 带 error（错误分类）与 last_assistant_message（错误文案），state-probe 都取走。
      StopFailure: [
        { matcher: '', hooks: [{ type: 'command', command: stateCmd('error') }] }
      ],
      PostToolUse: [
        { matcher: '', hooks: [{ type: 'command', command: stateCmd('busy') }] }
      ],
      Notification: [
        { matcher: 'permission_prompt', hooks: [{ type: 'command', command: stateCmd('attention') }] },
        { matcher: 'elicitation_dialog', hooks: [{ type: 'command', command: stateCmd('attention') }] }
        // 不挂 idle_prompt：它会把绿点（done）静默盖回灰点；idle 只由 renderer 降级倒计时产生
      ]
    }
  }
  const ccHooksJson = join(userData, 'cc-hooks.json')
  writeFileSync(ccHooksJson, JSON.stringify(settings, null, 2), 'utf8')

  return { ccHooksJson, sessionProbeJs, stateProbeJs, eventsDir, stateDir, pwshProfilePs1, zshProfile, bashProfile }
}
