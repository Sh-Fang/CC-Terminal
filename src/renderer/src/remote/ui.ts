// 手机网页的小工具：图标、按键字节、工具名
import type { ForegroundProgram } from '../../../shared/foreground'
import type { RemotePreview, RemoteStatus } from '../../../shared/remote'
import type { IconName } from '../svg-icons'
import { t } from '../i18n'

const FG_ICON: Record<ForegroundProgram, IconName> = {
  claude: 'claude',
  codex: 'codex',
  pwsh: 'square-terminal',
  cmd: 'terminal',
  sh: 'square-terminal'
}

export function fgIcon(p: ForegroundProgram): IconName {
  return FG_ICON[p] ?? 'square-terminal'
}

/** 快捷键行上的一个键 */
export interface KeyDef {
  id: string
  label: string
  data: string
}

export const KEY_ESC: KeyDef = { id: 'esc', label: 'Esc', data: '\x1b' }

/** 等待卡片上的按键 */
export function cardKeys(): KeyDef[] {
  return [
    { id: '1', label: '1', data: '1' },
    { id: '2', label: '2', data: '2' },
    { id: '3', label: '3', data: '3' },
    { id: 'up', label: '↑', data: '\x1b[A' },
    { id: 'down', label: '↓', data: '\x1b[B' },
    { id: 'enter', label: '⏎', data: '\r' },
    KEY_ESC
  ]
}

/** 终端镜像下的快捷键行 */
export function termKeys(): KeyDef[] {
  return [
    KEY_ESC,
    { id: 'tab', label: 'Tab', data: '\t' },
    { id: 'stab', label: '⇧Tab', data: '\x1b[Z' },
    { id: 'up', label: '↑', data: '\x1b[A' },
    { id: 'down', label: '↓', data: '\x1b[B' },
    { id: 'left', label: '←', data: '\x1b[D' },
    { id: 'right', label: '→', data: '\x1b[C' },
    { id: 'enter', label: '⏎', data: '\r' },
    { id: 'ctrlc', label: '^C', data: '\x03' }
  ]
}

/** 工具调用折叠行前面的动词 */
export function toolLabel(name: string): string {
  switch (name) {
    case 'Bash':
    case 'exec_command':
    case 'shell':
    case 'local_shell':
      return t('运行')
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'apply_patch':
      return t('编辑')
    case 'Write':
      return t('写入')
    case 'Read':
      return t('读取')
    case 'Grep':
      return t('搜索')
    case 'Glob':
      return t('查找文件')
    case 'WebFetch':
      return t('打开网页')
    case 'WebSearch':
      return t('网页搜索')
    case 'Task':
    case 'Agent':
      return t('子任务')
    case 'TodoWrite':
      return t('更新待办')
    default:
      return name
  }
}

/** 只显示路径里的文件名，太长的命令截断 */
export function shortSummary(name: string, summary: string): string {
  if (['Edit', 'MultiEdit', 'Write', 'Read', 'NotebookEdit'].includes(name)) {
    const parts = summary.split(/[\\/]/)
    return parts[parts.length - 1] || summary
  }
  return summary
}

/** 状态文字，与桌面侧栏一致 */
export function statusText(status: RemoteStatus): string {
  switch (status) {
    case 'busy':
      return t('运行中')
    case 'attention':
      return t('需要你决策')
    case 'done':
      return t('完成，待查看')
    case 'error':
      return t('出错')
    default:
      return t('空闲')
  }
}

/** 首页行尾的时间：一小时内按分钟，今天显示时刻，昨天，更早显示月/日 */
export function relTime(at: number, now = Date.now()): string {
  const min = Math.floor((now - at) / 60000)
  if (min < 1) {
    return t('刚刚')
  }
  if (min < 60) {
    return t('{0} 分钟前', String(min))
  }
  const d = new Date(at)
  const today = new Date(now)
  if (d.toDateString() === today.toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const y = new Date(now - 86400000)
  if (d.toDateString() === y.toDateString()) {
    return t('昨天')
  }
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** 首页摘要的一行文字 */
export function previewLine(p: RemotePreview): string {
  if (p.tool) {
    return `${toolLabel(p.tool)} ${shortSummary(p.tool, p.text)}`
  }
  if (p.role === 'user') {
    return t('你：') + p.text
  }
  return p.text
}

/** 识别出的一个选项 */
export interface PromptOption {
  n: number
  label: string
  selected: boolean
}

/** 从屏幕末尾识别出的选择题 */
export interface Prompt {
  question: string
  options: PromptOption[]
}

// 选项行：可带 ❯ › > 等选中标记，接序号和点
const OPTION_RE = /^\s*([❯›>▶→]\s*)?(\d{1,2})[.)]\s+(.+?)\s*$/
// 分隔线或框线
const RULE_LINE = /^[\s─━╌╍┄┅┈┉═│┃╭╮╰╯\-_=~]*$/
// 去掉两侧的框线字符
const BOX_EDGE = /^[\s│┃|]+|[\s│┃|]+$/g

/** 识别终端末尾的「问题 + 1. 2. 3. 选项」，认不出返回 null */
export function parsePrompt(lines: string[]): Prompt | null {
  const tail = lines.slice(-40)
  let options: PromptOption[] = []
  let first = -1
  // 上一个选项还在接续行里，缩进的下一行算它的一部分
  let open: PromptOption | null = null
  for (let i = 0; i < tail.length; i++) {
    const line = tail[i].replace(/[│┃]/g, ' ')
    const m = OPTION_RE.exec(line)
    if (m && Number(m[2]) === options.length + 1) {
      if (options.length === 0) {
        first = i
      }
      open = { n: Number(m[2]), label: m[3], selected: !!m[1] }
      options.push(open)
    } else if (m && Number(m[2]) === 1) {
      first = i
      open = { n: 1, label: m[3], selected: !!m[1] }
      options = [open]
    } else if (open && /^\s{2,}\S/.test(line) && !RULE_LINE.test(line)) {
      open.label += ' ' + line.trim()
    } else {
      open = null
    }
  }
  if (options.length < 2) {
    return null
  }
  let question = ''
  for (let i = first - 1; i >= 0; i--) {
    const text = tail[i].replace(BOX_EDGE, '').trim()
    if (text && !RULE_LINE.test(text)) {
      question = text
      break
    }
  }
  return { question, options }
}
