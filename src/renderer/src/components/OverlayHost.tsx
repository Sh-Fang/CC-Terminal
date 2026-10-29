// 浮层宿主：ctx 右键菜单 / modal 弹窗 / confirm 弹窗 / 备注编辑，z 序由 styles.css 保证。
// ToastHost 单独导出：.toast 是 position:absolute（相对 .main），必须由 App 放进 .main 层级。
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as RKeyboardEvent, MouseEvent as RMouseEvent } from 'react'
import {
  useOverlays,
  closeCtxMenu,
  closeModal,
  closeMemoEditor,
  resolveConfirm,
  type MemoEditorOpts,
  type ModalOpts
} from '../state/overlays'
import { t } from '../i18n'

// scrim 关闭手势：mousedown 与 click 都落在 scrim 自身才关闭，防止 modal 内选文字拖出被误判
function useScrimDismiss(onDismiss: () => void): {
  onMouseDown: (e: RMouseEvent<HTMLDivElement>) => void
  onClick: (e: RMouseEvent<HTMLDivElement>) => void
} {
  const downRef = useRef(false)
  return {
    onMouseDown: (e) => {
      downRef.current = e.target === e.currentTarget
    },
    onClick: (e) => {
      if (e.target === e.currentTarget && downRef.current) onDismiss()
      downRef.current = false
    }
  }
}

function CtxMenu() {
  const ctx = useOverlays((s) => s.ctx)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDocClick = (e: globalThis.MouseEvent): void => {
      if (!(e.target as HTMLElement).closest('.ctx')) closeCtxMenu()
    }
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [])

  // 先显示以测尺寸，再夹进屏幕防溢出
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !ctx) return
    const pad = 8
    const w = el.offsetWidth
    const h = el.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    const lx = Math.min(Math.max(pad, ctx.x), vw - w - pad)
    const ly = Math.min(Math.max(pad, ctx.y), vh - h - pad)
    el.style.left = `${lx}px`
    el.style.top = `${ly}px`
  }, [ctx])

  return (
    <div
      className={'ctx' + (ctx ? ' open' : '') + (ctx?.maxHeight != null ? ' ctx-capped' : '')}
      id="ctx"
      ref={ref}
      style={{
        ...(ctx?.minWidth != null ? { minWidth: ctx.minWidth } : null),
        // 固定高度的菜单仍受视口上限约束，避免在小窗口里被顶出屏幕
        ...(ctx?.maxHeight != null ? { maxHeight: ctx.maxHeight } : null)
      }}
    >
      {ctx?.items.map((it, i) => {
        if (it.sep) return <div key={i} className="ctx-sep" />
        if (it.eyebrow) return <div key={i} className="ctx-eyebrow">{it.eyebrow}</div>
        return (
          <div
            key={i}
            className={'ctx-item' + (it.danger ? ' danger' : '')}
            onClick={() => {
              closeCtxMenu()
              it.act?.()
            }}
          >
            <span className="ic" dangerouslySetInnerHTML={{ __html: it.icon ?? '' }} />
            <span>{it.label ?? ''}</span>
            {it.metaHtml != null && (
              <span className="ctx-meta" dangerouslySetInnerHTML={{ __html: it.metaHtml }} />
            )}
          </div>
        )
      })}
    </div>
  )
}

// 取路径最后一段作为默认分组名；磁盘根美化成「D 盘」，取不到回退空串
function basenameOfPath(p: string): string {
  const drive = /^([a-zA-Z]):[\\/]?$/.exec(p.trim())
  if (drive) return t('{0} 盘', drive[1].toUpperCase())
  const segs = p.split(/[\\/]+/).filter(Boolean)
  return segs[segs.length - 1] ?? ''
}

function ModalBody({ cfg }: { cfg: ModalOpts }) {
  // 自动按 cwd 末段填 name，直到用户手动改过 name 为止
  const [name, setName] = useState(() => {
    if (cfg.autoNameFromCwd && cfg.cwd) {
      const base = basenameOfPath(cfg.cwd)
      if (base) return base
    }
    return cfg.name
  })
  const [cwd, setCwd] = useState(cfg.cwd ?? '')
  const [tabName, setTabName] = useState(cfg.tabName ?? 'A')
  const [cc, setCc] = useState(cfg.ccChecked ?? true)
  const [picking, setPicking] = useState(false)
  const nameUserEditedRef = useRef(false)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const id = window.setTimeout(() => {
      nameRef.current?.focus()
      nameRef.current?.select()
    }, 0)
    return () => window.clearTimeout(id)
  }, [])

  const maybeSyncNameFromCwd = (cwdValue: string): void => {
    if (!cfg.autoNameFromCwd || nameUserEditedRef.current) return
    const base = basenameOfPath(cwdValue)
    if (base) setName(base)
  }

  const submit = (): void => {
    const v = {
      name: name.trim(),
      cwd: cfg.kind === 'new-group' || cfg.kind === 'new-tab' ? cwd.trim() : undefined,
      autoLaunchCC: cfg.kind === 'new-group' || cfg.kind === 'new-tab' ? cc : undefined,
      tabName: cfg.showTabName ? tabName.trim() : undefined
    }
    if (!v.name) {
      nameRef.current?.focus()
      return
    }
    closeModal()
    cfg.onOk(v)
  }

  const onKeyDown = (e: RKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') submit()
    else if (e.key === 'Escape') closeModal()
  }

  // Enter 全局兜底：焦点不在文本框（文本框自行处理）时也能直接回车提交，
  // 比如勾完 CC 复选框或点完「浏览」后；按钮聚焦时交给按钮原生行为
  const submitRef = useRef(submit)
  submitRef.current = submit
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter') return
      const el = e.target as HTMLElement | null
      if (el instanceof HTMLButtonElement) return
      if (el instanceof HTMLInputElement && el.type === 'text') return
      submitRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const pickCwd = (): void => {
    const cb = cfg.onPickCwd
    if (!cb) return
    setPicking(true)
    void cb(cwd)
      .then((picked) => {
        if (picked) {
          setCwd(picked)
          maybeSyncNameFromCwd(picked)
        }
      })
      .catch(() => {})
      .finally(() => {
        setPicking(false)
      })
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <h2 id="modal-title">{cfg.title}</h2>
      <p className="sub" id="modal-sub" style={cfg.sub ? undefined : { display: 'none' }}>{cfg.sub}</p>
      <div className="field" id="modal-name-field">
        <label>{t(cfg.kind === 'new-group' ? '分组名称' : '名称')}</label>
        <input
          id="modal-name"
          ref={nameRef}
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={name}
          onChange={(e) => {
            nameUserEditedRef.current = true
            setName(e.target.value)
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      {/* cwd 字段：仅 cfg.cwd !== undefined 时可见（新建场景传 ''，重命名场景不传） */}
      <div className="field" id="modal-cwd-field" style={cfg.cwd !== undefined ? undefined : { display: 'none' }}>
        <label>{t('项目路径')}</label>
        <div className="row-with-btn">
          <input
            id="modal-cwd"
            className="mono"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={cwd}
            onChange={(e) => {
              setCwd(e.target.value)
              maybeSyncNameFromCwd(e.target.value)
            }}
            onKeyDown={onKeyDown}
          />
          <button
            id="modal-cwd-pick"
            className="btn btn-secondary"
            type="button"
            title={t('选择目录')}
            style={cfg.onPickCwd ? undefined : { display: 'none' }}
            disabled={picking}
            onClick={pickCwd}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            <span>{t('浏览')}</span>
          </button>
        </div>
      </div>
      {/* 首个标签名与 CC 开关相互独立，字段是否出现由调用方 showTabName 决定 */}
      <div className="field" id="modal-tabname-field" style={cfg.showTabName ? undefined : { display: 'none' }}>
        <label>{t('标签名')}</label>
        <input
          id="modal-tabname"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={tabName}
          onChange={(e) => setTabName(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="field-check" id="modal-cc-field" style={cfg.showCC ? undefined : { display: 'none' }}>
        <span className="fc-line">
          <input id="modal-cc" type="checkbox" checked={cc} onChange={(e) => setCc(e.target.checked)} />
          <span>{t('启动 Claude Code')}</span>
        </span>
      </div>
      <div className="actions">
        <button id="modal-cancel" className="btn btn-secondary" onClick={closeModal}>
          {t('取消')}
        </button>
        <button id="modal-ok" className="btn btn-primary" onClick={submit}>
          {cfg.okLabel ?? t('创建')}
        </button>
      </div>
    </div>
  )
}

function ModalDialog() {
  const modal = useOverlays((s) => s.modal)
  const seq = useOverlays((s) => s.modalSeq)
  const dismiss = useScrimDismiss(closeModal)
  return (
    <div id="scrim" className="scrim" hidden={!modal} {...dismiss}>
      {/* key=seq：每次 openModal 重置内部输入态 */}
      {modal ? <ModalBody key={seq} cfg={modal} /> : null}
    </div>
  )
}

function ConfirmDialog() {
  const cf = useOverlays((s) => s.confirm)
  const dismiss = useScrimDismiss(() => resolveConfirm(false))
  const testId = cf?.testIdPrefix
  return (
    <div
      id="confirmScrim"
      className="scrim"
      hidden={!cf}
      data-testid={testId ? `${testId}-overlay` : undefined}
      {...dismiss}
    >
      <div className="modal modal-confirm" data-testid={testId ? `${testId}-dialog` : undefined}>
        <h2 id="cf-title" data-testid={testId ? `${testId}-title` : undefined}>{cf?.title ?? ''}</h2>
        {/* message 是调用方拼好的 HTML，调用方负责转义 */}
        {cf?.message ? (
          <div
            className="cf-body"
            id="cf-msg"
            data-testid={testId ? `${testId}-message` : undefined}
            dangerouslySetInnerHTML={{ __html: cf.message }}
          />
        ) : null}
        <div className="actions" data-testid={testId ? `${testId}-actions` : undefined}>
          <button
            id="cf-cancel"
            className="btn btn-secondary"
            data-testid={testId ? `${testId}-cancel-button` : undefined}
            onClick={() => resolveConfirm(false)}
          >
            {cf?.cancelLabel ?? t('取消')}
          </button>
          <button
            id="cf-ok"
            className={`btn ${cf?.danger === false ? 'btn-primary' : 'btn-danger'}`}
            data-testid={testId ? `${testId}-confirm-button` : undefined}
            onClick={() => resolveConfirm(true)}
          >
            {cf?.okLabel ?? t('确认')}
          </button>
        </div>
      </div>
    </div>
  )
}

function UpdateProgressDialog() {
  const progress = useOverlays((state) => state.updateProgress)
  const percent = Math.floor(progress?.percent ?? 0)
  return (
    <div
      id="updateProgressScrim"
      className="scrim"
      hidden={!progress}
      data-testid="update-download-progress-overlay"
    >
      <div
        className="modal modal-update-progress"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-progress-title"
        data-testid="update-download-progress-dialog"
      >
        <h2 id="update-progress-title" data-testid="update-download-progress-title">
          {t('正在下载更新')}
        </h2>
        <div className="update-progress-version" data-testid="update-download-progress-version">
          {progress ? t('新版本 {0}', `v${progress.version}`) : ''}
        </div>
        <progress
          max={100}
          value={progress?.percent ?? 0}
          aria-label={t('更新下载进度')}
          data-testid="update-download-progress-bar"
        />
        <div className="update-progress-status" data-testid="update-download-progress-value">
          {t('下载中… {0}%', percent)}
        </div>
      </div>
    </div>
  )
}

// 会话选择浮层：点「N 会话」徽标弹出的小列表，管理页与勾选弹窗两个恢复入口共用。
// 锚定在徽标下方，越界自动上翻/内收；外部点击 / Esc / 滚动即关闭。
function MemoEditorBody({ opts }: { opts: MemoEditorOpts }) {
  const ref = useRef<HTMLDivElement>(null)
  const textRef = useRef(opts.text)

  useEffect(() => {
    textRef.current = opts.text
    return () => opts.onSave(textRef.current)
  }, [opts])

  // 先显示以测尺寸，再夹进屏幕防溢出（同 CtxMenu）
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const pad = 8
    const lx = Math.min(Math.max(pad, opts.x), window.innerWidth - el.offsetWidth - pad)
    const ly = Math.min(Math.max(pad, opts.y), window.innerHeight - el.offsetHeight - pad)
    el.style.left = `${lx}px`
    el.style.top = `${ly}px`
    const ta = el.querySelector('textarea')
    if (ta) {
      ta.focus()
      ta.setSelectionRange(ta.value.length, ta.value.length)
    }
  }, [opts])

  useEffect(() => {
    const host = ref.current
    if (!host) return
    const onDocDown = (e: globalThis.MouseEvent): void => {
      if (host.contains(e.target as Node)) return
      closeMemoEditor()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeMemoEditor()
      }
    }
    // 弹窗内滚动（textarea 超长）不关；外部滚动锚点会移位，直接关
    const onScroll = (e: Event): void => {
      if (host.contains(e.target as Node)) return
      closeMemoEditor()
    }
    // 延后挂 mousedown，避免打开的这次点击立即关掉它
    const timer = window.setTimeout(() => document.addEventListener('mousedown', onDocDown, true), 0)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('mousedown', onDocDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [opts])

  return (
    <div className="memo-pop" ref={ref}>
      <textarea
        defaultValue={opts.text}
        placeholder={t('输入备注…')}
        spellCheck={false}
        onChange={(e) => {
          textRef.current = e.target.value
        }}
      />
    </div>
  )
}

function MemoEditor() {
  const me = useOverlays((s) => s.memoEdit)
  const seq = useOverlays((s) => s.memoEditSeq)
  // key=seq：每次 open 重挂，旧实例卸载即保存旧文本
  return me ? <MemoEditorBody key={seq} opts={me} /> : null
}

// 备注 hover 气泡：圆角小卡片展示备注开头一段，纯展示不可交互
function MemoTip() {
  const tip = useOverlays((s) => s.memoTip)
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !tip) return
    const pad = 8
    const lx = Math.min(Math.max(pad, tip.x), window.innerWidth - el.offsetWidth - pad)
    const ly = Math.min(Math.max(pad, tip.y), window.innerHeight - el.offsetHeight - pad)
    el.style.left = `${lx}px`
    el.style.top = `${ly}px`
  }, [tip])

  if (!tip) return null
  const text = tip.text.length > 80 ? tip.text.slice(0, 80) + '…' : tip.text
  return (
    <div className="memo-tip" ref={ref}>
      {text}
    </div>
  )
}

// toast：隐藏时保留文字，让淡出动画期间内容不消失
export function ToastHost() {
  const msg = useOverlays((s) => s.toastMsg)
  const show = useOverlays((s) => s.toastShow)
  return (
    <div id="toast" className={'toast' + (show ? ' show' : '')}>
      <span id="toastMsg">{msg}</span>
    </div>
  )
}

export function OverlayHost() {
  return (
    <>
      <CtxMenu />
      <ModalDialog />
      <ConfirmDialog />
      <UpdateProgressDialog />
      <MemoEditor />
      <MemoTip />
    </>
  )
}
