// 会话记录解码：把 Claude 的 jsonl 和 Codex 的 rollout jsonl 逐行解成对话视图用的消息。
// 一轮里 agent 的多段文字和工具调用合进同一条消息；工具结果按调用 id 回填到对应的工具块。
// 解码器有状态，可以先喂历史再逐行喂新内容，返回这次改动过的消息。
import type { ChatBlock, ChatMessage } from '../../shared/remote'

type ToolBlock = Extract<ChatBlock, { type: 'tool' }>

// 工具输入、输出截断长度，对比最多保留的行数
const MAX_TEXT = 4000
const MAX_DIFF_LINES = 400

function clip(s: string, n = MAX_TEXT): string {
  return s.length > n ? `${s.slice(0, n)}\n…` : s
}

function firstLine(s: string): string {
  const line = s.split('\n').find((x) => x.trim()) ?? ''
  return line.length > 160 ? `${line.slice(0, 160)}…` : line
}

/** 从各种 content 形态里取纯文字：字符串、[{type:'text',text}]、{text} */
function textOf(v: unknown): string {
  if (typeof v === 'string') {
    return v
  }
  if (Array.isArray(v)) {
    return v.map(textOf).filter(Boolean).join('\n')
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.text === 'string') {
      return o.text
    }
    if (o.content !== undefined) {
      return textOf(o.content)
    }
  }
  return ''
}

/** 对比行数统计 */
function countDiff(diff: string[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of diff) {
    if (l.startsWith('+')) {
      added += 1
    } else if (l.startsWith('-')) {
      removed += 1
    } else {
    }
  }
  return { added, removed }
}

function capDiff(diff: string[]): string[] {
  return diff.length > MAX_DIFF_LINES ? [...diff.slice(0, MAX_DIFF_LINES), '@…'] : diff
}

/** Claude 编辑结果里的 structuredPatch → 单栏对比行；多段之间插 '@' 分隔行 */
function diffFromStructuredPatch(patch: unknown): string[] | undefined {
  if (!Array.isArray(patch) || patch.length === 0) {
    return undefined
  }
  const out: string[] = []
  for (const h of patch as Array<Record<string, unknown>>) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines}`)
    for (const l of Array.isArray(h.lines) ? h.lines : []) {
      if (typeof l === 'string') {
        out.push(l)
      }
    }
  }
  return out
}

/** Codex apply_patch 的补丁文本 → 单栏对比行与涉及的文件 */
export function diffFromApplyPatch(text: string): { files: string[]; diff: string[] } {
  const files: string[] = []
  const diff: string[] = []
  for (const line of text.split('\n')) {
    const m = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line)
    if (m) {
      files.push(m[2].trim())
      diff.push(`@@ ${m[2].trim()}`)
      continue
    }
    if (line.startsWith('*** ')) {
      continue
    }
    if (line.startsWith('@@')) {
      if (line.trim() !== '@@') {
        diff.push(line)
      }
    } else if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
      diff.push(line)
    } else {
    }
  }
  return { files, diff }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Claude 工具调用折叠时的一行摘要 */
function claudeSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
      return firstLine(str(input.description) || str(input.command))
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
      return str(input.file_path) || str(input.notebook_path)
    case 'Grep':
    case 'Glob':
      return str(input.pattern)
    case 'WebFetch':
      return str(input.url)
    case 'WebSearch':
      return str(input.query)
    case 'Task':
    case 'Agent':
      return str(input.description)
    default: {
      const s = JSON.stringify(input)
      return s && s !== '{}' ? firstLine(s) : ''
    }
  }
}

/** Codex 工具调用的命令行：cmd / command 可能是字符串或数组 */
function codexCommand(args: Record<string, unknown>): string {
  const c = args.cmd ?? args.command
  if (Array.isArray(c)) {
    // ["bash","-lc","..."] 这种只取真正的命令
    const last = c[c.length - 1]
    return firstLine(typeof last === 'string' ? last : c.join(' '))
  }
  return firstLine(str(c))
}

function parseJson(s: unknown): Record<string, unknown> {
  if (typeof s !== 'string') {
    return s && typeof s === 'object' ? (s as Record<string, unknown>) : {}
  }
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Claude 用户消息里不该显示的内部文字 */
function claudeHiddenUserText(s: string): boolean {
  const t = s.trimStart()
  return (
    t.startsWith('<local-command') ||
    t.startsWith('<system-reminder>') ||
    t.startsWith('<task-notification>') ||
    t.startsWith('<bash-stdout>') ||
    t.startsWith('<bash-stderr>') ||
    t.startsWith('Caveat:') ||
    t.startsWith('This session is being continued')
  )
}

/** 斜杠命令记录 → "/命令 参数"；! 开头的 shell 命令 → "! 命令" */
function claudeSlashCommand(s: string): string | null {
  const bash = /^<bash-input>([\s\S]*?)<\/bash-input>/.exec(s.trimStart())
  if (bash) {
    return `! ${bash[1].trim()}`
  }
  const m = /<command-name>([\s\S]*?)<\/command-name>/.exec(s)
  if (!m) {
    return null
  }
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(s)?.[1]?.trim()
  return args ? `${m[1].trim()} ${args}` : m[1].trim()
}

/** 有状态的解码器：消息按顺序累积，工具结果回填 */
export class TranscriptDecoder {
  readonly messages: ChatMessage[] = []
  private tools = new Map<string, ToolBlock>()
  // 工具块所在的消息，回填结果时标记改动
  private toolOwner = new Map<string, ChatMessage>()
  private changed = new Set<ChatMessage>()
  // Codex 分页模式下用户、agent 的文字只认 item_completed
  private codexPaginated = false

  constructor(private readonly agent: 'claude' | 'codex') {}

  /** 喂入若干行，返回这次新增或改动的消息 */
  feed(lines: string[]): ChatMessage[] {
    this.changed.clear()
    for (const line of lines) {
      if (!line.trim()) {
        continue
      }
      let rec: Record<string, unknown>
      try {
        rec = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (this.agent === 'claude') {
        this.claude(rec)
      } else {
        this.codex(rec)
      }
    }
    return [...this.changed]
  }

  // ─── 公共 ─────────────────────────────
  private push(role: ChatMessage['role'], id: string, ts: string, block: ChatBlock): void {
    this.messages.push({ id, role, ts, blocks: [block] })
    this.changed.add(this.messages[this.messages.length - 1])
  }

  /** agent 这一轮的消息；上一条不是 agent 的就新开一条 */
  private turn(id: string, ts: string): ChatMessage {
    const last = this.messages[this.messages.length - 1]
    if (last && last.role === 'assistant') {
      this.changed.add(last)
      return last
    }
    const m: ChatMessage = { id, role: 'assistant', ts, blocks: [] }
    this.messages.push(m)
    this.changed.add(m)
    return m
  }

  private addText(id: string, ts: string, text: string): void {
    if (!text.trim()) {
      return
    }
    this.turn(id, ts).blocks.push({ type: 'text', text })
  }

  private addTool(id: string, ts: string, tool: ToolBlock): void {
    const m = this.turn(id, ts)
    m.blocks.push(tool)
    this.tools.set(tool.id, tool)
    this.toolOwner.set(tool.id, m)
  }

  private toolResult(callId: string, output: string, isError: boolean): ToolBlock | null {
    const tool = this.tools.get(callId)
    if (!tool) {
      return null
    }
    tool.output = clip(output)
    tool.isError = isError
    const owner = this.toolOwner.get(callId)
    if (owner) {
      this.changed.add(owner)
    }
    return tool
  }

  // ─── Claude ─────────────────────────────
  private claude(rec: Record<string, unknown>): void {
    const type = rec.type
    if ((type !== 'user' && type !== 'assistant') || rec.isSidechain === true) {
      return
    }
    const id = str(rec.uuid) || `c${this.messages.length}`
    const ts = str(rec.timestamp)
    const msg = (rec.message ?? {}) as Record<string, unknown>
    if (type === 'assistant') {
      for (const b of Array.isArray(msg.content) ? (msg.content as Array<Record<string, unknown>>) : []) {
        if (b.type === 'text') {
          this.addText(id, ts, str(b.text))
        } else if (b.type === 'tool_use') {
          const name = str(b.name)
          const input = (b.input ?? {}) as Record<string, unknown>
          this.addTool(id, ts, {
            type: 'tool',
            id: str(b.id),
            name,
            summary: claudeSummary(name, input),
            input: name === 'Bash' ? clip(str(input.command)) : undefined
          })
        } else {
        }
      }
      return
    }
    if (rec.isMeta === true || rec.isCompactSummary === true) {
      return
    }
    const content = msg.content
    if (typeof content === 'string') {
      this.claudeUserText(id, ts, content)
      return
    }
    for (const b of Array.isArray(content) ? (content as Array<Record<string, unknown>>) : []) {
      if (b.type === 'tool_result') {
        const tool = this.toolResult(str(b.tool_use_id), textOf(b.content), b.is_error === true)
        const result = (rec.toolUseResult ?? {}) as Record<string, unknown>
        if (tool && (tool.name === 'Edit' || tool.name === 'MultiEdit' || tool.name === 'Write')) {
          let diff = diffFromStructuredPatch(result.structuredPatch)
          // 新建文件没有 structuredPatch，整份内容都算新增
          if (!diff && tool.name === 'Write' && typeof result.content === 'string') {
            diff = result.content.split('\n').map((l) => `+${l}`)
          }
          if (diff) {
            Object.assign(tool, countDiff(diff), { diff: capDiff(diff) })
          }
        }
      } else if (b.type === 'text') {
        this.claudeUserText(id, ts, str(b.text))
      } else {
      }
    }
  }

  private claudeUserText(id: string, ts: string, text: string): void {
    const cmd = claudeSlashCommand(text)
    if (cmd) {
      this.push('user', id, ts, { type: 'text', text: cmd })
      return
    }
    if (claudeHiddenUserText(text) || !text.trim()) {
      return
    }
    if (text.startsWith('[Request interrupted')) {
      this.push('system', id, ts, { type: 'text', text: 'interrupted' })
      return
    }
    this.push('user', id, ts, { type: 'text', text })
  }

  // ─── Codex ─────────────────────────────
  private codex(rec: Record<string, unknown>): void {
    const p = (rec.payload ?? {}) as Record<string, unknown>
    const ts = str(rec.timestamp)
    const id = `x${str(rec.ordinal) || this.messages.length}-${str(p.call_id) || str(p.id) || ts}`
    if (rec.type === 'session_meta') {
      this.codexPaginated = p.history_mode === 'paginated'
      return
    }
    if (rec.type === 'event_msg') {
      this.codexEvent(id, ts, p)
      return
    }
    if (rec.type !== 'response_item') {
      return
    }
    if (p.type === 'message') {
      if (this.codexPaginated) {
        return
      }
      const text = textOf(p.content)
      if (p.role === 'user') {
        this.codexUserText(id, ts, text)
      } else if (p.role === 'assistant') {
        this.addText(id, ts, text)
      } else {
      }
    } else if (p.type === 'function_call' || p.type === 'local_shell_call') {
      const args = parseJson(p.arguments ?? p.action)
      const name = str(p.name) || 'shell'
      const cmd = codexCommand(args)
      this.addTool(id, ts, {
        type: 'tool',
        id: str(p.call_id) || id,
        name,
        summary: cmd || firstLine(JSON.stringify(args)),
        input: cmd ? clip(cmd) : undefined
      })
    } else if (p.type === 'custom_tool_call') {
      const name = str(p.name)
      const input = str(p.input)
      const tool: ToolBlock = { type: 'tool', id: str(p.call_id) || id, name, summary: firstLine(input) }
      if (name === 'apply_patch') {
        const { files, diff } = diffFromApplyPatch(input)
        Object.assign(tool, countDiff(diff), { summary: files.join(', '), diff: capDiff(diff) })
      }
      this.addTool(id, ts, tool)
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const out = p.output
      const o = parseJson(out)
      const text = typeof o.output === 'string' ? o.output : typeof out === 'string' ? out : textOf(out)
      const meta = (o.metadata ?? {}) as Record<string, unknown>
      this.toolResult(str(p.call_id), text, typeof meta.exit_code === 'number' && meta.exit_code !== 0)
    } else {
    }
  }

  private codexEvent(id: string, ts: string, p: Record<string, unknown>): void {
    if (p.type === 'turn_aborted') {
      this.push('system', id, ts, { type: 'text', text: 'interrupted' })
      return
    }
    if (!this.codexPaginated) {
      return
    }
    if (p.type === 'item_completed') {
      const item = (p.item ?? {}) as Record<string, unknown>
      const text = textOf(item.content ?? item.text)
      if (item.type === 'UserMessage') {
        this.codexUserText(id, ts, text)
      } else if (item.type === 'AgentMessage') {
        this.addText(id, ts, text)
      } else {
      }
    }
  }

  private codexUserText(id: string, ts: string, text: string): void {
    const t = text.trimStart()
    if (!t || t.startsWith('<environment_context>') || t.startsWith('<user_instructions>') || t.startsWith('<skill')) {
      return
    }
    this.push('user', id, ts, { type: 'text', text })
  }
}
