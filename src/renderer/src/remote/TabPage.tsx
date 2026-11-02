// 手机网页里的单个标签页：智能体标签页默认对话视图，可切到终端镜像；普通终端只有终端镜像
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChatBlock, ChatMessage, RemoteTab } from '../../../shared/remote'
import { t } from '../i18n'
import { icon } from '../svg-icons'
import { THEMES } from '../themes'
import { conn } from './conn'
import { useLook } from './look'
import { renderMarkdown } from './markdown'
import { cardKeys, KEY_ESC, parsePrompt, shortSummary, termKeys, toolLabel, type KeyDef } from './ui'

type ToolBlock = Extract<ChatBlock, { type: 'tool' }>

// 等待卡片显示屏幕末尾多少行
const CARD_LINES = 14
// 离底部多近算「在底部」，新消息到来时才自动滚到底
const STICK_PX = 120
// 滚到离顶部多近时加载更早的消息
const OLDER_PX = 80

function sendKey(tabId: string, data: string): void {
  conn.send({ t: 'input', tabId, data })
}

/** 智能体是否正在这个标签页的终端里运行 */
function agentRunning(tab: RemoteTab): boolean {
  return tab.fg === 'claude' || tab.fg === 'codex'
}

/** 发一段文字再回车；智能体在跑时用括号粘贴，多行文字不会被拆成多次提交 */
function sendText(tab: RemoteTab, text: string): void {
  if (agentRunning(tab)) {
    sendKey(tab.id, `\x1b[200~${text}\x1b[201~`)
    window.setTimeout(() => sendKey(tab.id, '\r'), 60)
  } else {
    sendKey(tab.id, `${text}\r`)
  }
}

function KeyRow(props: { tab: RemoteTab; keys: KeyDef[]; testId: string; grid?: boolean }) {
  return (
    <div className={'rm-keys' + (props.grid ? ' grid' : '')} data-testid={props.testId}>
      {props.keys.map((k) => (
        <button
          key={k.id}
          type="button"
          className="rm-key"
          data-testid={`${props.testId}-${k.id}`}
          onClick={() => sendKey(props.tab.id, k.data)}
        >
          {k.label}
        </button>
      ))}
    </div>
  )
}

/** 订阅屏幕快照；want 为 false 时退订 */
function useScreen(tabId: string, want: boolean): string[] {
  const [lines, setLines] = useState<string[]>([])
  useEffect(() => {
    if (!want) {
      return
    }
    const sub = (): void => conn.send({ t: 'screen.sub', tabId })
    sub()
    const off = conn.on((m) => {
      if (m.t === 'ready') {
        sub()
      } else if (m.t === 'screen' && m.tabId === tabId) {
        setLines(m.lines)
      } else {
      }
    })
    return () => {
      off()
      conn.send({ t: 'screen.sub', tabId: null })
    }
  }, [tabId, want])
  return lines
}

function Composer(props: { tab: RemoteTab; testId: string }) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement | null>(null)

  // 输入框随内容长高，最多 6 行
  useLayoutEffect(() => {
    const el = ref.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 140)}px`
    }
  }, [text])

  const submit = (): void => {
    if (!text.trim()) {
      return
    }
    sendText(props.tab, text)
    setText('')
  }

  return (
    <div className="rm-composer" data-testid={props.testId}>
      <textarea
        ref={ref}
        rows={1}
        value={text}
        aria-label={t('输入')}
        data-testid={`${props.testId}-input`}
        onChange={(e) => setText(e.target.value)}
      />
      <button
        type="button"
        className="rm-send"
        aria-label={t('发送')}
        disabled={!text.trim()}
        data-testid={`${props.testId}-send`}
        onClick={submit}
        dangerouslySetInnerHTML={{ __html: icon('arrow-up', { size: 18, stroke: 2.2 }) }}
      />
    </div>
  )
}

/** 智能体没在运行：不能发消息，给一个恢复会话的按钮 */
function ResumeBar(props: { tab: RemoteTab }) {
  const { tab } = props
  const [sent, setSent] = useState(false)
  const name = tab.agent === 'codex' ? 'Codex' : 'Claude Code'
  return (
    <div className="rm-resume" data-testid="rm-resume">
      <span className="rm-resume-text" data-testid="rm-resume-text">{t('{0} 未运行', name)}</span>
      <button
        type="button"
        className="rm-btn"
        disabled={sent}
        data-testid="rm-resume-btn"
        onClick={() => {
          setSent(true)
          conn.send({ t: 'resume', tabId: tab.id })
        }}
      >
        {sent ? t('正在启动…') : tab.sessionId ? t('恢复会话') : t('启动 {0}', name)}
      </button>
    </div>
  )
}

function Diff(props: { lines: string[]; testId: string }) {
  return (
    <div className="rm-diff" data-testid={props.testId}>
      {props.lines.map((l, i) => {
        const kind = l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@') ? 'hunk' : 'ctx'
        const body = kind === 'hunk' ? l.replace(/^@+\s*/, '') : l.slice(1)
        return (
          <div className={`rm-diff-line ${kind}`} key={i} data-testid={`${props.testId}-${i}`}>
            {kind === 'hunk' ? body || '…' : body || ' '}
          </div>
        )
      })}
    </div>
  )
}

function ToolRow(props: { tool: ToolBlock; testId: string }) {
  const { tool } = props
  const [open, setOpen] = useState(false)
  const hasDetail = !!(tool.diff || tool.input || tool.output)
  return (
    <div className={'rm-tool' + (tool.isError ? ' err' : '')} data-testid={props.testId}>
      <button
        type="button"
        className="rm-tool-head"
        aria-expanded={open}
        disabled={!hasDetail}
        data-testid={`${props.testId}-head`}
        onClick={() => setOpen(!open)}
      >
        <span className="rm-tool-verb" data-testid={`${props.testId}-verb`}>{toolLabel(tool.name)}</span>
        <span className="rm-tool-sum" data-testid={`${props.testId}-sum`}>{shortSummary(tool.name, tool.summary)}</span>
        {tool.diff && (
          <span className="rm-tool-stat" data-testid={`${props.testId}-stat`}>
            <span className="add">+{tool.added ?? 0}</span> <span className="del">−{tool.removed ?? 0}</span>
          </span>
        )}
        {tool.output === undefined && <span className="rm-tool-wait" data-testid={`${props.testId}-wait`}>…</span>}
      </button>
      {open && (
        <div className="rm-tool-body" data-testid={`${props.testId}-body`}>
          {tool.diff ? (
            <Diff lines={tool.diff} testId={`${props.testId}-diff`} />
          ) : (
            <>
              {tool.input && <pre className="rm-pre" data-testid={`${props.testId}-input`}>{tool.input}</pre>}
              {tool.output && <pre className="rm-pre out" data-testid={`${props.testId}-output`}>{tool.output}</pre>}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Message(props: { m: ChatMessage; testId: string }) {
  const { m } = props
  if (m.role === 'system') {
    return (
      <div className="rm-msg sys" data-testid={props.testId}>
        {t('已中断')}
      </div>
    )
  }
  if (m.role === 'user') {
    return (
      <div className="rm-msg user" data-testid={props.testId}>
        <div className="rm-bubble" data-testid={`${props.testId}-text`}>
          {m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n')}
        </div>
      </div>
    )
  }
  return (
    <div className="rm-msg agent" data-testid={props.testId}>
      {m.blocks.map((b, i) =>
        b.type === 'text' ? (
          <div
            key={i}
            className="rm-md"
            data-testid={`${props.testId}-b${i}`}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(b.text) }}
          />
        ) : (
          <ToolRow key={b.id || i} tool={b} testId={`${props.testId}-b${i}`} />
        )
      )}
    </div>
  )
}

function ChatView(props: { tab: RemoteTab }) {
  const { tab } = props
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [before, setBefore] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const loadingOlder = useRef(false)
  // 渲染后要做的滚动：到底，或保持翻页前的位置
  const pendingScroll = useRef<{ kind: 'bottom' } | { kind: 'keep'; height: number; top: number } | null>(null)

  useEffect(() => {
    const open = (): void => conn.send({ t: 'chat.open', tabId: tab.id })
    open()
    const off = conn.on((m) => {
      const el = scrollRef.current
      if (m.t === 'ready') {
        open()
      } else if (m.t === 'chat.page' && m.tabId === tab.id) {
        if (m.older) {
          pendingScroll.current = el ? { kind: 'keep', height: el.scrollHeight, top: el.scrollTop } : null
          setMessages((prev) => [...m.messages, ...prev])
          loadingOlder.current = false
        } else {
          pendingScroll.current = { kind: 'bottom' }
          setMessages(m.messages)
        }
        setBefore(m.before)
        setLoaded(true)
      } else if (m.t === 'chat.append' && m.tabId === tab.id) {
        const atBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
        if (atBottom) {
          pendingScroll.current = { kind: 'bottom' }
        }
        setMessages((prev) => {
          const next = [...prev]
          for (const msg of m.messages) {
            const i = next.findIndex((x) => x.id === msg.id)
            if (i >= 0) {
              next[i] = msg
            } else {
              next.push(msg)
            }
          }
          return next
        })
      } else {
      }
    })
    return () => {
      off()
      conn.send({ t: 'chat.close' })
    }
  }, [tab.id])

  useLayoutEffect(() => {
    const el = scrollRef.current
    const p = pendingScroll.current
    pendingScroll.current = null
    if (!el || !p) {
      return
    }
    if (p.kind === 'bottom') {
      el.scrollTop = el.scrollHeight
    } else {
      el.scrollTop = p.top + (el.scrollHeight - p.height)
    }
  }, [messages])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (el && el.scrollTop < OLDER_PX && before != null && !loadingOlder.current) {
      loadingOlder.current = true
      conn.send({ t: 'chat.open', tabId: tab.id, before })
    }
  }

  return (
    <div className="rm-chat" ref={scrollRef} onScroll={onScroll} data-testid="rm-chat">
      {before != null && <div className="rm-more" data-testid="rm-chat-more">…</div>}
      {loaded && messages.length === 0 && (
        <div className="rm-empty" data-testid="rm-chat-empty">{t('还没有对话')}</div>
      )}
      {messages.map((m, i) => (
        <Message key={m.id} m={m} testId={`rm-msg-${i}`} />
      ))}
    </div>
  )
}

// 整行都是横线、框线的分隔线：手机上换行后会变成好几行，缩成一小段
const RULE_RE = /^[\s─━╌╍┄┅┈┉═\-_=~]{12,}$/

/** 等待你操作时的卡片：认出选择题就每个选项一个按钮，认不出退回屏幕原文 + 按键 */
function WaitCard(props: { tab: RemoteTab; lines: string[] }) {
  const prompt = parsePrompt(props.lines)
  if (prompt) {
    return (
      <div className="rm-card" role="region" aria-label={t('等待你操作')} data-testid="rm-card">
        {prompt.question && (
          <div className="rm-card-q" data-testid="rm-card-q">{prompt.question}</div>
        )}
        <div className="rm-opts" data-testid="rm-card-opts">
          {prompt.options.map((o, i) => (
            <button
              key={o.n}
              type="button"
              className={'rm-opt' + (o.selected ? ' sel' : '')}
              data-testid={`rm-card-opt-${i}`}
              onClick={() => sendKey(props.tab.id, String(o.n))}
            >
              <span className="rm-opt-n" data-testid={`rm-card-opt-${i}-n`}>{o.n}</span>
              <span className="rm-opt-label" data-testid={`rm-card-opt-${i}-label`}>{o.label}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="rm-opt-esc"
          data-testid="rm-card-esc"
          onClick={() => sendKey(props.tab.id, KEY_ESC.data)}
        >
          {t('取消')}
        </button>
      </div>
    )
  }
  return <RawCard tab={props.tab} lines={props.lines} />
}

/** 认不出选项时：屏幕末尾原文 + 按键 */
function RawCard(props: { tab: RemoteTab; lines: string[] }) {
  const tail = props.lines.slice(-CARD_LINES).map((l) => (RULE_RE.test(l) ? '────────' : l.trimEnd()))
  const ref = useRef<HTMLPreElement | null>(null)
  // 选项在屏幕最下面，内容更新后滚到底
  useLayoutEffect(() => {
    const el = ref.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [props.lines])
  return (
    <div className="rm-card" role="region" aria-label={t('等待你操作')} data-testid="rm-card">
      <div className="rm-card-title" data-testid="rm-card-title">{t('等待你操作')}</div>
      <pre className="rm-card-screen" ref={ref} data-testid="rm-card-screen">{tail.join('\n')}</pre>
      <KeyRow tab={props.tab} keys={cardKeys()} testId="rm-card-keys" />
    </div>
  )
}

/** 终端镜像：配色跟桌面终端主题，内容贴底 */
function TermView(props: { tab: RemoteTab; lines: string[] }) {
  const ref = useRef<HTMLPreElement | null>(null)
  const look = useLook()
  const theme = THEMES[look.term] ?? THEMES['vscode-dark']
  useLayoutEffect(() => {
    const el = ref.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [props.lines])
  return (
    <div className="rm-term-wrap" style={{ background: theme.backgroundCss }} data-testid="rm-term-wrap">
      <pre className="rm-term" ref={ref} style={{ color: theme.foreground }} data-testid="rm-term">
        {props.lines.join('\n')}
      </pre>
    </div>
  )
}

export function TabPage(props: { tab: RemoteTab; onBack: () => void }) {
  const { tab } = props
  const isAgent = tab.agent != null
  const [view, setView] = useState<'chat' | 'term'>(isAgent ? 'chat' : 'term')
  const waiting = isAgent && view === 'chat' && tab.status === 'attention'
  const lines = useScreen(tab.id, view === 'term' || waiting)

  return (
    <div className="rm-page" data-testid="rm-tab">
      <header className="rm-head" data-testid="rm-tab-head">
        <button
          type="button"
          className="rm-icon-btn"
          aria-label={t('返回')}
          data-testid="rm-back"
          onClick={props.onBack}
          dangerouslySetInnerHTML={{ __html: icon('arrow-left', { size: 18 }) }}
        />
        <span className="rm-head-main" data-testid="rm-tab-title">
          <span className="rm-head-name" data-testid="rm-tab-name">{tab.name}</span>
          <span className={`rm-dot st-${tab.status}`} data-testid="rm-tab-dot" />
        </span>
        {isAgent && tab.status === 'busy' && (
          <button
            type="button"
            className="rm-stop"
            data-testid="rm-stop"
            onClick={() => sendKey(tab.id, KEY_ESC.data)}
          >
            <span
              className="rm-stop-ic"
              data-testid="rm-stop-ic"
              dangerouslySetInnerHTML={{ __html: icon('circle-stop', { size: 15 }) }}
            />
            {t('停止')}
          </button>
        )}
        {isAgent && (
          <button
            type="button"
            className="rm-icon-btn"
            aria-label={view === 'chat' ? t('切到终端') : t('切到对话')}
            title={view === 'chat' ? t('切到终端') : t('切到对话')}
            data-testid="rm-view-toggle"
            onClick={() => setView(view === 'chat' ? 'term' : 'chat')}
            dangerouslySetInnerHTML={{ __html: icon(view === 'chat' ? 'square-terminal' : 'message-square', { size: 18 }) }}
          />
        )}
      </header>
      {view === 'chat' ? <ChatView tab={tab} /> : <TermView tab={tab} lines={lines} />}
      <footer className="rm-foot" data-testid="rm-foot">
        {waiting && <WaitCard tab={tab} lines={lines} />}
        {view === 'term' && <KeyRow tab={tab} keys={termKeys()} testId="rm-term-keys" grid />}
        {isAgent && view === 'chat' && !agentRunning(tab) ? (
          <ResumeBar key={tab.fg} tab={tab} />
        ) : (
          <Composer tab={tab} testId="rm-composer" />
        )}
      </footer>
    </div>
  )
}
