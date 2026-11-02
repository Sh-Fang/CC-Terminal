// 资源占用：状态栏右端显示应用自身的 CPU、内存，点开浮层看各标签页与合计
import { useEffect, useRef, useState } from 'react'
import type { Usage, UsageSample } from '../../../shared/usage'
import { useAppStore } from '../state/store'
import { activateTab, getChildren, getGroupViews } from '../controller'
import type { TerminalTab } from '../terminal-tab'
import { icon } from '../svg-icons'
import { t } from '../i18n'
import { FgIcon } from './FgIcon'

const POLL_MS = 2000

interface Row {
  tab: TerminalTab
  groupName: string
  usage: Usage
}

function fmtCpu(v: number): string {
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}%`
}

function fmtMem(bytes: number): string {
  const mb = bytes / 1024 / 1024
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)} GB`
  }
  return `${Math.round(mb)} MB`
}

// 正在运行的标签页（含下一层打开的会话），按功能区里的顺序
function runningRows(sample: UsageSample): Row[] {
  const out: Row[] = []
  for (const g of getGroupViews()) {
    for (const tab of g.tabs) {
      for (const x of [tab, ...getChildren(tab.id)]) {
        const usage = x.ptyId != null ? sample.ptys[x.ptyId] : undefined
        if (usage) {
          out.push({ tab: x, groupName: g.name, usage })
        }
      }
    }
  }
  return out
}

export function ResourceBar() {
  const rev = useAppStore((s) => s.rev)
  void rev
  const [sample, setSample] = useState<UsageSample | null>(null)
  const [open, setOpen] = useState(false)
  // 浮层打开时按内存排好的标签页 id，打开期间只刷新数字不重排
  const [order, setOrder] = useState<string[]>([])
  const barRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  // 每 2 秒采样一次；窗口最小化（页面不可见）时跳过
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async (): Promise<void> => {
      if (document.visibilityState === 'visible') {
        const r = await window.term.usageSample()
        if (stopped) {
          return
        }
        setSample(r)
      }
      timer = setTimeout(() => void tick(), POLL_MS)
    }
    // 从最小化恢复时立刻补一次，不等下一轮
    const onVis = (): void => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer)
        void tick()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    void tick()
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  // 点浮层外或按 Esc 关闭
  useEffect(() => {
    if (!open) {
      return
    }
    const onDown = (e: MouseEvent): void => {
      const n = e.target as Node
      if (!panelRef.current?.contains(n) && !barRef.current?.contains(n)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const toggle = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    const rows = sample ? runningRows(sample) : []
    setOrder([...rows].sort((a, b) => b.usage.mem - a.usage.mem).map((r) => r.tab.id))
    setOpen(true)
  }

  let rows: Row[] = []
  if (open && sample) {
    const live = new Map(runningRows(sample).map((r) => [r.tab.id, r]))
    // 已排好的在前；浮层打开后新跑起来的标签页接在末尾
    rows = order.map((id) => live.get(id)).filter((r): r is Row => !!r)
    for (const r of live.values()) {
      if (!order.includes(r.tab.id)) {
        rows.push(r)
      }
    }
  }
  const total = rows.reduce(
    (acc, r) => ({ cpu: acc.cpu + r.usage.cpu, mem: acc.mem + r.usage.mem }),
    sample ? { ...sample.app } : { cpu: 0, mem: 0 }
  )
  const rect = open ? barRef.current?.getBoundingClientRect() : undefined
  // 浮层右端与状态栏右端对齐，宽度不超出状态栏
  const host = open ? barRef.current?.parentElement?.getBoundingClientRect() : undefined

  return (
    <>
      <div
        ref={barRef}
        className={'res-bar' + (open ? ' open' : '')}
        role="button"
        tabIndex={0}
        aria-label={t('资源占用')}
        aria-expanded={open}
        title={t('资源占用')}
        data-testid="res-bar"
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggle()
          }
        }}
      >
        <span className="res-item" data-testid="res-bar-cpu">
          <span
            className="res-ic"
            role="img"
            aria-label="CPU"
            title="CPU"
            data-testid="res-bar-cpu-ic"
            dangerouslySetInnerHTML={{ __html: icon('cpu', { size: 12 }) }}
          />
          {sample ? fmtCpu(sample.app.cpu) : '–'}
        </span>
        <span className="res-item" data-testid="res-bar-mem">
          <span
            className="res-ic"
            role="img"
            aria-label={t('内存')}
            title={t('内存')}
            data-testid="res-bar-mem-ic"
            dangerouslySetInnerHTML={{ __html: icon('memory-stick', { size: 12 }) }}
          />
          {sample ? fmtMem(sample.app.mem) : '–'}
        </span>
      </div>

      {open && sample && rect && (
        <div
          ref={panelRef}
          className="res-panel"
          role="dialog"
          aria-label={t('资源占用')}
          data-testid="res-panel"
          style={{
            right: window.innerWidth - rect.right + 6,
            bottom: window.innerHeight - rect.top + 6,
            maxWidth: host ? host.width - 12 : undefined
          }}
        >
          <div className="res-row res-head" data-testid="res-head">
            <span className="res-name" data-testid="res-head-name"></span>
            <span className="res-num" data-testid="res-head-cpu">CPU</span>
            <span className="res-num" data-testid="res-head-mem">{t('内存')}</span>
          </div>
          <div className="res-row res-app" data-testid="res-row-app">
            <span className="res-name" data-testid="res-row-app-name">{t('应用自身')}</span>
            <span className="res-num" data-testid="res-row-app-cpu">{fmtCpu(sample.app.cpu)}</span>
            <span className="res-num" data-testid="res-row-app-mem">{fmtMem(sample.app.mem)}</span>
          </div>
          <div className="res-list" data-testid="res-list">
            {rows.map((r, i) => (
              <div
                key={r.tab.id}
                className="res-row res-tab"
                data-testid={`res-row-${i}`}
                title={`${r.groupName} / ${r.tab.name}`}
                onClick={() => {
                  activateTab(r.tab.id)
                  setOpen(false)
                }}
              >
                <span className="res-name" data-testid={`res-row-${i}-name`}>
                  <FgIcon tab={r.tab} status="idle" title="" testId={`res-row-${i}-fg`} />
                  <span className="res-group" data-testid={`res-row-${i}-group`}>{r.groupName}</span>
                  <span className="res-tabname" data-testid={`res-row-${i}-tab`}>{r.tab.name}</span>
                </span>
                <span className="res-num" data-testid={`res-row-${i}-cpu`}>{fmtCpu(r.usage.cpu)}</span>
                <span className="res-num" data-testid={`res-row-${i}-mem`}>{fmtMem(r.usage.mem)}</span>
              </div>
            ))}
          </div>
          <div className="res-row res-total" data-testid="res-row-total">
            <span className="res-name" data-testid="res-row-total-name">{t('合计')}</span>
            <span className="res-num" data-testid="res-row-total-cpu">{fmtCpu(Math.min(100, total.cpu))}</span>
            <span className="res-num" data-testid="res-row-total-mem">{fmtMem(total.mem)}</span>
          </div>
        </div>
      )}
    </>
  )
}
