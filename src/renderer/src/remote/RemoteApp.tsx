// 手机网页：连接状态页、标签页列表、单个标签页（对话视图 / 终端镜像）
import { useEffect, useState } from 'react'
import type { RemoteGroup, RemoteTab } from '../../../shared/remote'
import { setLanguage, t } from '../i18n'
import { icon } from '../svg-icons'
import { conn, type ConnState } from './conn'
import { applyLook } from './look'
import { TabPage } from './TabPage'
import { fgIcon, previewLine, relTime, statusText } from './ui'

// 置顶的状态：需要关注、出错
const PINNED = new Set(['attention', 'error'])

/** 连不上时的整页提示 */
function StatusScreen(props: { state: ConnState }) {
  const text: Record<string, string> = {
    connecting: t('正在连接…'),
    offline: t('正在重新连接…'),
    unpaired: t('在电脑上打开「设置 → 远程访问」，用手机扫描二维码'),
    denied: t('这台设备已被吊销，请重新扫码配对'),
    pairfail: t('二维码已失效，请在电脑上点「重新生成」后重新扫码'),
    version: t('电脑端版本与此页面不一致，请刷新页面')
  }
  return (
    <div className="rm-status" data-testid="rm-status" data-state={props.state}>
      <span
        className="rm-status-ic"
        data-testid="rm-status-ic"
        dangerouslySetInnerHTML={{ __html: icon('smartphone', { size: 28, stroke: 1.5 }) }}
      />
      <p data-testid="rm-status-text">{text[props.state] ?? ''}</p>
      {props.state === 'version' && (
        <button type="button" className="rm-btn" data-testid="rm-status-reload" onClick={() => location.reload()}>
          {t('刷新')}
        </button>
      )}
    </div>
  )
}

// 这几种状态在摘要位置直接显示状态文字
const LOUD = new Set(['busy', 'attention', 'error'])

function TabRow(props: { tab: RemoteTab; group?: string; now: number; testId: string; onOpen: () => void }) {
  const { tab } = props
  const loud = LOUD.has(tab.status)
  // 出错时优先显示原因
  const sub = loud ? (tab.status === 'error' && tab.note ? tab.note : statusText(tab.status)) : tab.preview ? previewLine(tab.preview) : ''
  return (
    <button type="button" className={'rm-row' + (tab.child ? ' child' : '')} data-testid={props.testId} onClick={props.onOpen}>
      <span
        className={`rm-fg st-${tab.status}`}
        data-testid={`${props.testId}-fg`}
        dangerouslySetInnerHTML={{ __html: icon(fgIcon(tab.fg), { size: 18 }) }}
      />
      <span className="rm-row-main" data-testid={`${props.testId}-main`}>
        <span className="rm-row-top" data-testid={`${props.testId}-top`}>
          <span className="rm-row-name" data-testid={`${props.testId}-name`}>
            {tab.name}
          </span>
          {props.group && (
            <span className="rm-row-group" data-testid={`${props.testId}-group`}>{props.group}</span>
          )}
          {tab.at != null && (
            <span className="rm-row-time" data-testid={`${props.testId}-time`}>{relTime(tab.at, props.now)}</span>
          )}
        </span>
        {sub && (
          <span className={'rm-row-sub' + (loud ? ` st-${tab.status}` : '')} data-testid={`${props.testId}-sub`}>
            {sub}
          </span>
        )}
      </span>
    </button>
  )
}

/** 每分钟刷新一次，让「n 分钟前」跟着走 */
function useNow(): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

function TabList(props: { groups: RemoteGroup[]; host: string; onOpen: (id: string) => void }) {
  const pinned: Array<{ tab: RemoteTab; group: string }> = []
  for (const g of props.groups) {
    for (const tab of g.tabs) {
      if (PINNED.has(tab.status)) {
        pinned.push({ tab, group: g.name })
      }
    }
  }
  const total = props.groups.reduce((n, g) => n + g.tabs.length, 0)
  const now = useNow()
  return (
    <div className="rm-page" data-testid="rm-list">
      <header className="rm-head" data-testid="rm-list-head">
        <span className="rm-head-title" data-testid="rm-list-host">{props.host}</span>
      </header>
      <div className="rm-scroll" data-testid="rm-list-scroll">
        {pinned.length > 0 && (
          <section className="rm-group rm-pinned" data-testid="rm-pinned">
            <div className="rm-group-name" data-testid="rm-pinned-title">{t('需要处理')}</div>
            {pinned.map((p, i) => (
              <TabRow
                key={p.tab.id}
                tab={p.tab}
                group={p.group}
                now={now}
                testId={`rm-pinned-${i}`}
                onOpen={() => props.onOpen(p.tab.id)}
              />
            ))}
          </section>
        )}
        {props.groups.map((g, gi) => {
          const tabs = g.tabs.filter((x) => !PINNED.has(x.status))
          if (tabs.length === 0) {
            return null
          }
          return (
            <section className="rm-group" key={g.id} data-testid={`rm-group-${gi}`}>
              <div className="rm-group-name" data-testid={`rm-group-${gi}-name`}>{g.name}</div>
              {tabs.map((tab, ti) => (
                <TabRow key={tab.id} tab={tab} now={now} testId={`rm-group-${gi}-tab-${ti}`} onOpen={() => props.onOpen(tab.id)} />
              ))}
            </section>
          )
        })}
        {total === 0 && (
          <div className="rm-empty" data-testid="rm-list-empty">{t('电脑上没有打开的标签页')}</div>
        )}
      </div>
    </div>
  )
}

export function RemoteApp() {
  const [state, setState] = useState<ConnState>(conn.state)
  const [groups, setGroups] = useState<RemoteGroup[]>([])
  const [host, setHost] = useState('')
  const [, setLangTick] = useState(0)
  const [tabId, setTabId] = useState<string | null>(null)

  useEffect(() => {
    const offState = conn.onState(setState)
    const offMsg = conn.on((m) => {
      if (m.t === 'ready') {
        setLanguage(m.lang)
        document.documentElement.lang = m.lang === 'en' ? 'en' : 'zh-CN'
        setHost(m.host)
        applyLook(m.look)
        setLangTick((n) => n + 1)
      } else if (m.t === 'look') {
        applyLook(m.look)
      } else if (m.t === 'tabs') {
        setGroups(m.groups)
      } else {
      }
    })
    conn.connect()
    // 手机返回键回到列表
    const onPop = (): void => setTabId(null)
    window.addEventListener('popstate', onPop)
    return () => {
      offState()
      offMsg()
      window.removeEventListener('popstate', onPop)
    }
  }, [])

  const open = (id: string): void => {
    history.pushState({ tab: id }, '')
    setTabId(id)
  }

  const everReady = host !== ''
  if (!everReady) {
    return <StatusScreen state={state} />
  }
  if (state === 'denied' || state === 'version' || state === 'unpaired') {
    return <StatusScreen state={state} />
  }

  let tab: RemoteTab | null = null
  for (const g of groups) {
    const hit = g.tabs.find((x) => x.id === tabId)
    if (hit) {
      tab = hit
    }
  }

  return (
    <>
      {state !== 'ready' && (
        <div className="rm-offline" role="status" data-testid="rm-offline">{t('正在重新连接…')}</div>
      )}
      {tab ? (
        <TabPage key={tab.id} tab={tab} onBack={() => history.back()} />
      ) : (
        <TabList groups={groups} host={host} onOpen={open} />
      )}
    </>
  )
}
