// Ctrl+P 全局搜索：无关键字时列出近 7 天关闭的标签页，有关键字时按搜索类别分组列出结果。
// 输入框下方的类别开关写进设置，下次打开沿用。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as RKeyboardEvent, MouseEvent as RMouseEvent } from 'react'
import { useOverlays, closeQuickOpen } from '../state/overlays'
import { useAppStore } from '../state/store'
import { getQuickHistory, getSettings, quickSearch, updateSettings, type QuickItem } from '../controller'
import { formatTs, highlightRanges } from '../lib/format'
import { icon } from '../svg-icons'
import { t } from '../i18n'

type ScopeKey = 'tabTitle' | 'sessionTitle' | 'path'

const SCOPES: { key: ScopeKey; label: string }[] = [
  { key: 'tabTitle', label: '标签页标题' },
  { key: 'sessionTitle', label: '会话标题' },
  { key: 'path', label: '路径' }
]

const KIND_ICON: Record<QuickItem['kind'], 'layers' | 'clock' | 'folder'> = {
  tab: 'layers',
  session: 'clock',
  path: 'folder'
}

function QuickOpenBody() {
  const rev = useAppStore((s) => s.rev)
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const [scopes, setScopes] = useState(() => getSettings().searchScopes)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const downOnScrimRef = useRef(false)

  // rev 变化（如后台补齐了会话标题）时重算结果
  const groups = useMemo(
    () => (query.trim() ? quickSearch(query, scopes) : getQuickHistory()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, scopes, rev]
  )
  const flat = groups.flatMap((g) => g.items)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setSel(0)
  }, [query, scopes])

  // 选中项滚进可视区
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const run = (item: QuickItem | undefined): void => {
    if (!item) return
    closeQuickOpen()
    item.act()
  }

  const toggleScope = (key: ScopeKey): void => {
    const next = { ...scopes, [key]: !scopes[key] }
    setScopes(next)
    updateSettings({ ...getSettings(), searchScopes: next })
    inputRef.current?.focus()
  }

  const onKeyDown = (e: RKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((v) => (flat.length === 0 ? 0 : (v + 1) % flat.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((v) => (flat.length === 0 ? 0 : (v - 1 + flat.length) % flat.length))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(flat[sel])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeQuickOpen()
    } else {
    }
  }

  // mousedown 与 click 都落在 scrim 自身才关闭，防止框内选文字拖出被误判
  const onScrimDown = (e: RMouseEvent): void => {
    downOnScrimRef.current = e.target === e.currentTarget
  }
  const onScrimClick = (e: RMouseEvent): void => {
    if (e.target === e.currentTarget && downOnScrimRef.current) closeQuickOpen()
    downOnScrimRef.current = false
  }

  let idx = 0
  return (
    <div className="scrim qo-scrim" data-testid="quick-open-scrim" onMouseDown={onScrimDown} onClick={onScrimClick}>
      <div className="qo" role="dialog" aria-modal="true" aria-label={t('全局搜索')} data-testid="quick-open">
        <input
          ref={inputRef}
          className="qo-input"
          data-testid="quick-open-input"
          type="search"
          aria-label={t('全局搜索')}
          placeholder={t('搜索')}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="qo-scopes" role="group" aria-label={t('搜索类别')}>
          {SCOPES.map((sc) => (
            <button
              key={sc.key}
              type="button"
              className={'qo-scope' + (scopes[sc.key] ? ' on' : '')}
              data-testid={`quick-open-scope-${sc.key}`}
              aria-pressed={scopes[sc.key]}
              onClick={() => toggleScope(sc.key)}
            >
              {t(sc.label)}
            </button>
          ))}
        </div>
        <div className="qo-list" ref={listRef} data-testid="quick-open-list">
          {flat.length === 0 && (
            <div className="qo-empty" data-testid="quick-open-empty">
              {query.trim() ? t('没有匹配项') : t('近 7 天没有关闭的标签页')}
            </div>
          )}
          {groups.map((g, gi) => (
            <div key={g.label} className="qo-group" data-testid={`quick-open-group-${gi}`}>
              <div className="qo-group-label">{g.label}</div>
              {g.items.map((it) => {
                const i = idx++
                return (
                  <div
                    key={it.key}
                    className={'qo-row' + (i === sel ? ' sel' : '')}
                    data-idx={i}
                    data-testid={`quick-open-row-${i}`}
                    onMouseMove={() => {
                      if (i !== sel) setSel(i)
                    }}
                    onClick={() => run(it)}
                  >
                    <span className="qo-ic" dangerouslySetInnerHTML={{ __html: icon(KIND_ICON[it.kind], { size: 14 }) }} />
                    <span className="qo-title" dangerouslySetInnerHTML={{ __html: highlightRanges(it.title, it.titleHl) }} />
                    <span className="qo-sub">{it.sub}</span>
                    {it.closedAt && <span className="qo-when">{formatTs(it.closedAt)}</span>}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function QuickOpen() {
  const open = useOverlays((s) => s.quickOpen)
  // 每次打开重新挂载，输入与选中项从空白开始
  return open ? <QuickOpenBody /> : null
}
